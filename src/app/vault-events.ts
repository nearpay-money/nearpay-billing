/**
 * Forwarded vault events (`evt.rails.vault.event`, lld/billing.md v1.7 §6, §7.1, §14 d1, d6, d10). Rails
 * forwards only events of successful, final receipts executed by the configured vault (rails §8.6); billing
 * still checks the vault account and mode, dedupes on `receipt_id:log_index`, and never blocks the stream: an
 * event that fails validation or storage is parked (`vault_events_parked`, `ALERT`) and the stream goes on;
 * retriable ones (peer unavailable, mandate row not there yet) are retried by a recurring job.
 *
 * Mandate rows exist only from `mandate_created` whose `ext_ref` names a subscription (§14 d1). An invoice
 * is paid by auto-debit only from a `collected` event (INV-2), with `Invoice.mandate_collection` as evidence.
 */

import type { VaultEvent } from "@nearpay-money/spec";
import { type Invoice, markPaidByCollection, newDraft, voidAfterShortCollection } from "../domain/invoice/invoice.js";
import { classifyCollection, evidenceOf, switchToAutoDebit } from "../domain/mandate/collection.js";
import { afterCollectFailed } from "../domain/mandate/keeper.js";
import {
  applyCanceled,
  applyCollected,
  applyCollectFailed,
  applyExhausted,
  applyToppedUp,
  applyWithdrawn,
  type Collection,
  type CreatedData,
  type EventMeta,
  expectedShare,
  fromCreated,
  isCollecting,
  type Mandate,
  nsToUnix,
} from "../domain/mandate/mandate.js";
import { decideLink, tokenAssetId } from "../domain/mandate/terms.js";
import type { Scope } from "../domain/shared.js";
import { withMandate } from "../domain/subscription/subscription.js";

/**
 * The fields billing reads from `evt.rails.vault.event` (spec `VaultEventRecord`, parsed with the spec schema
 * by the consumer adapter), with the precise `VaultEvent` union (`Omit` over the loose schema type would
 * erase the known keys).
 */
export interface VaultEventRecord {
  readonly vault_contract: string;
  readonly tx_hash: string;
  readonly receipt_id: string;
  readonly log_index: number;
  readonly block_height: number;
  readonly block_hash: string;
  readonly block_timestamp: string;
  readonly event: VaultEvent;
}

import { saveInvoice, saveMandate, saveSubscription } from "./commit.js";
import { clockS, finalizeInTx, liveCustomer, nowS, renderPdfLater } from "./invoices.js";
import { destinationsOf, fallbackInvoice, latestInvoicePayable, perPeriodTotal, tokenDecimals } from "./mandates.js";
import { subscriptionAfterPaid } from "./payment-events.js";
import type { Billing, BillingTx, CustomerFacts, MerchantFacts } from "./ports.js";

const SYSTEM = "service:rails";
/** Retry spacing of parked retriable events (seconds); given up (alert) after `PARK_MAX_ATTEMPTS`. */
export const PARK_RETRY_S = 60;
export const PARK_MAX_ATTEMPTS = 60;

export interface VaultEventInput {
  /** The envelope's mode (true = mainnet vault, false = stand-in). */
  readonly livemode: boolean;
  readonly record: VaultEventRecord;
}

export type VaultEventResult = "applied" | "duplicate" | "parked";

/** A refusal that parks the event: `retriable` ones are retried later. */
export class Park extends Error {
  constructor(
    readonly reason: string,
    readonly retriable: boolean,
    detail?: string,
  ) {
    super(detail ?? reason);
    this.name = "Park";
  }
}

export const dedupeKeyOf = (r: Pick<VaultEventRecord, "receipt_id" | "log_index">): string =>
  `${r.receipt_id}:${r.log_index}`;

const metaOf = (i: VaultEventInput): EventMeta => ({
  vaultContract: i.record.vault_contract,
  livemode: i.livemode,
  blockHeight: i.record.block_height,
  blockTime: nsToUnix(BigInt(i.record.block_timestamp)),
  txHash: i.record.tx_hash,
  receiptId: i.record.receipt_id,
});

const onchainIdOf = (r: VaultEventRecord): number => r.event.data[0].mandate_id;

/** Applies one forwarded vault event; parks it on any failure (never throws for the bus). */
export async function onVaultEvent(b: Billing, i: VaultEventInput, attempt = 1): Promise<VaultEventResult> {
  const key = dedupeKeyOf(i.record);
  try {
    const vault = b.vault.contract(i.livemode);
    if (i.record.vault_contract !== vault)
      throw new Park(
        "wrong_vault",
        false,
        vault === null
          ? `${i.record.vault_contract}: no live vault is configured (NP_VAULT_CONTRACT)`
          : `${i.record.vault_contract} is not the ${i.livemode ? "live" : "test"} vault`,
      );
    const r = i.record.event.event === "mandate_created" ? await onCreated(b, i) : await onMandateEvent(b, i);
    if (attempt > 1 || r === "applied")
      await b.store.transaction((tx) => tx.vaultEvents.resolveParked(key)).catch(() => undefined);
    if (r === "applied" && i.record.event.event === "mandate_created") await replayParkedFor(b, i);
    return r;
  } catch (e) {
    const park = e instanceof Park ? e : new Park("error", true, e instanceof Error ? e.message : String(e));
    const retry = park.retriable && attempt < PARK_MAX_ATTEMPTS;
    b.log.error(
      { dedupe_key: key, event: i.record.event.event, reason: park.reason, error: park.message, attempt, retry },
      "ALERT vault event parked",
    );
    await b.store.transaction((tx) =>
      tx.vaultEvents.park({
        dedupeKey: key,
        vaultContract: i.record.vault_contract,
        livemode: i.livemode,
        onchainId: onchainIdOf(i.record),
        event: i.record.event.event,
        reason: park.reason,
        error: park.message.slice(0, 1000),
        payload: { livemode: i.livemode, record: i.record },
        retryAt: retry ? nowS(b) + PARK_RETRY_S : null,
      }),
    );
    return "parked";
  }
}

/** Re-applies parked retriable events that are due (recurring job `vault.parked_retry`). */
export async function retryParkedVaultEvents(b: Billing, limit = 100): Promise<number> {
  const due = await b.store.transaction((tx) => tx.vaultEvents.dueParked(nowS(b), limit));
  for (const p of due) {
    const input = p.payload as VaultEventInput;
    await onVaultEvent(b, input, p.attempts + 1);
  }
  return due.length;
}

/** Events of a mandate that arrived before its `mandate_created` are applied right after it. */
async function replayParkedFor(b: Billing, i: VaultEventInput): Promise<void> {
  const parked = await b.store.transaction((tx) =>
    tx.vaultEvents.parkedFor(i.record.vault_contract, onchainIdOf(i.record)),
  );
  for (const p of parked) await onVaultEvent(b, p.payload as VaultEventInput, p.attempts + 1);
}

// ---------------------------------------------------------------------------------------------
// mandate_created → row + linkage
// ---------------------------------------------------------------------------------------------

export function createdData(r: VaultEventRecord): CreatedData {
  const e = r.event;
  if (e.event !== "mandate_created") throw new Park("bad_event", false);
  const d = e.data[0];
  return {
    onchainId: d.mandate_id,
    payer: d.payer,
    merchantReceiver: d.merchant_receiver,
    token: d.token,
    amountPerPeriod: BigInt(d.amount_per_period),
    periodSecs: d.period_secs,
    startAtNs: BigInt(d.start_at),
    maxPeriods: d.max_periods,
    feeBps: d.fee_bps,
    extRef: d.ext_ref,
    receiverKind: d.receiver_kind,
    balance: BigInt(d.balance),
  };
}

async function onCreated(b: Billing, i: VaultEventInput): Promise<VaultEventResult> {
  const d = createdData(i.record);
  const meta = metaOf(i);
  if (!/^sub_[0-9a-z]{26}$/.test(d.extRef)) throw new Park("unknown_subscription", false, `ext_ref ${d.extRef}`);
  // the subscription named by `ext_ref`, in its own scope (the event carries no account; INV-8 below)
  const pre = await b.store.transaction(async (tx) => {
    if (await tx.mandates.byOnchain(i.record.vault_contract, d.onchainId)) return null;
    return tx.subscriptions.getByIdUnscoped(d.extRef);
  });
  if (pre === null) return markOnly(b, i, "duplicate_create");
  if (!pre) throw new Park("unknown_subscription", false, `ext_ref ${d.extRef} names no subscription`);
  // peers outside the transaction (a failure parks the event for a retry)
  const merchant = await b.merchant.context(pre);
  const decimals = await tokenDecimals(b, pre, d.token);
  return b.store.transaction(async (tx) => {
    if (!(await markApplied(tx, i, "applied"))) return "duplicate";
    if (await tx.mandates.byOnchain(i.record.vault_contract, d.onchainId)) return "duplicate";
    const sub = await tx.subscriptions.get(pre, pre.id, { lock: true });
    if (!sub) throw new Park("unknown_subscription", false);
    const now = nowS(b);
    const already = await tx.mandates.collectingFor(sub, sub.id, { lock: true });
    const payable = await latestInvoicePayable(tx, sub);
    const link = decideLink(d, {
      subscription: sub,
      perPeriodTotal: await perPeriodTotal(tx, sub),
      tokenDecimals: (t) => decimals.get(t),
      usdTokens: b.settings.vaultUsdTokens,
      allowedTokens: b.settings.vaultTokens,
      maxFeeBps: b.settings.vaultMaxFeeBps,
      feeBps: merchant.vaultFeeBps,
      destinations: destinationsOf(merchant),
      defaults: merchant.defaults,
      latestInvoicePayable: payable,
      vaultLivemode: i.livemode,
      alreadyLinked: already !== undefined,
      now,
    });
    const m = fromCreated(
      { id: b.newId("md"), accountId: sub.accountId, subscriptionId: sub.id, customerId: sub.customerId, link, now },
      d,
      meta,
    );
    const evidence = { receipt_id: meta.receiptId, tx_hash: meta.txHash };
    const saved = await saveMandate(
      tx,
      null,
      m,
      {
        actor: SYSTEM,
        cause: link.linked ? "mandate_created (linked)" : `mandate_created (unlinked: ${link.reason})`,
        evidence,
      },
      [link.linked ? "evt.billing.mandate.activated" : "evt.billing.mandate.unlinked"],
    );
    if (!link.linked) {
      b.log.warn({ mandate: saved.id, subscription: sub.id, reason: link.reason }, "vault mandate recorded unlinked");
      return "applied";
    }
    // linked: renewals are collected from it; the open latest invoice is paid by the first collection
    const linkedSub = await saveSubscription(
      tx,
      sub,
      withMandate(sub, saved.id, clockS(b, sub)),
      { actor: SYSTEM, cause: `mandate ${saved.id} linked` },
      ["evt.billing.subscription.updated"],
    );
    if (payable && linkedSub.latestInvoiceId) {
      const inv = await tx.invoices.get(linkedSub, linkedSub.latestInvoiceId, { lock: true });
      if (inv && inv.collectionMethod === "send_invoice") {
        const switched = await saveInvoice(tx, inv, switchToAutoDebit(inv, saved.id, clockS(b, inv)), {
          actor: SYSTEM,
          cause: `collected from mandate ${saved.id}`,
        });
        await enqueueCollect(tx, saved, switched, now);
      }
    }
    return "applied";
  });
}

// ---------------------------------------------------------------------------------------------
// Events of an existing mandate
// ---------------------------------------------------------------------------------------------

async function markApplied(tx: BillingTx, i: VaultEventInput, outcome: string): Promise<boolean> {
  return tx.vaultEvents.markApplied({
    dedupeKey: dedupeKeyOf(i.record),
    vaultContract: i.record.vault_contract,
    livemode: i.livemode,
    onchainId: onchainIdOf(i.record),
    event: i.record.event.event,
    blockHeight: i.record.block_height,
    outcome,
  });
}

async function markOnly(b: Billing, i: VaultEventInput, outcome: string): Promise<VaultEventResult> {
  return (await b.store.transaction((tx) => markApplied(tx, i, outcome))) ? "applied" : "duplicate";
}

/** The `mandate.collect` job of an auto-debit invoice (§7; dedupe per mandate × invoice × tag). */
export async function enqueueCollect(
  tx: BillingTx,
  m: Mandate,
  inv: Invoice,
  runAt: number,
  tag = "first",
): Promise<void> {
  await tx.enqueue({
    kind: "mandate.collect",
    dedupeKey: `mandate.collect:${m.id}:${inv.id}:${tag}`,
    runAt,
    payload: { mandate: m.id, invoice: inv.id, account_id: m.accountId, livemode: m.livemode },
  });
}

interface CollectedPeers {
  readonly decimals: number;
  readonly merchant: MerchantFacts;
  readonly customer: CustomerFacts;
}

async function onMandateEvent(b: Billing, i: VaultEventInput): Promise<VaultEventResult> {
  const onchainId = onchainIdOf(i.record);
  const pre = await b.store.transaction((tx) => tx.mandates.byOnchain(i.record.vault_contract, onchainId));
  if (!pre) throw new Park("unknown_mandate", true, `no mandate ${i.record.vault_contract}#${onchainId} yet`);
  if (pre.livemode !== i.livemode) throw new Park("mode_mismatch", false);
  let peers: CollectedPeers | null = null;
  if (i.record.event.event === "collected") {
    const decimals = (await tokenDecimals(b, { currency: "asset", assetId: tokenAssetId(pre.token) }, pre.token)).get(
      pre.token,
    );
    if (decimals === undefined) throw new Park("token_unknown", true, `${pre.token} unknown to the asset registry`);
    const sub = await b.store.transaction((tx) => tx.subscriptions.get(pre, pre.subscriptionId));
    peers = {
      decimals,
      merchant: await b.merchant.context(pre),
      customer: sub
        ? await liveCustomer(b, sub, sub.customerId).catch(() => ({
            id: sub.customerId,
            email: null,
            name: null,
            deleted: true,
          }))
        : { id: pre.customerId, email: null, name: null, deleted: true },
    };
  }
  return b.store.transaction(async (tx) => {
    if (!(await markApplied(tx, i, "applied"))) return "duplicate";
    const m = await tx.mandates.byOnchain(i.record.vault_contract, onchainId, { lock: true });
    if (!m) throw new Park("unknown_mandate", true);
    const meta = metaOf(i);
    const now = nowS(b);
    const why = {
      actor: SYSTEM,
      cause: i.record.event.event,
      evidence: { receipt_id: meta.receiptId, tx_hash: meta.txHash },
    };
    const e = i.record.event;
    switch (e.event) {
      case "topped_up": {
        const next = applyToppedUp(m, BigInt(e.data[0].balance), meta, now);
        await saveMandate(tx, m, next, why, ["evt.billing.mandate.updated"]);
        return "applied";
      }
      case "withdrawn": {
        const next = applyWithdrawn(m, BigInt(e.data[0].amount), meta, now);
        await saveMandate(tx, m, next, why, ["evt.billing.mandate.updated"]);
        return "applied";
      }
      case "collect_failed":
        await onCollectFailed(b, tx, m, meta, now, why);
        b.metrics?.keeperCollect("collect_failed", m.livemode);
        return "applied";
      case "collected":
        await onCollected(b, tx, m, e.data[0], meta, now, why, peers as CollectedPeers);
        b.metrics?.keeperCollect("collected", m.livemode);
        return "applied";
      case "canceled": {
        const next = applyCanceled(m, e.data[0].by, BigInt(e.data[0].refunded), meta, now);
        const saved = await saveMandate(tx, m, next, why, ["evt.billing.mandate.canceled"]);
        await afterClosed(b, tx, m, saved, why);
        return "applied";
      }
      case "exhausted": {
        const next = applyExhausted(m, meta, now);
        const saved = await saveMandate(tx, m, next, why, ["evt.billing.mandate.exhausted"]);
        await afterClosed(b, tx, m, saved, why);
        return "applied";
      }
      default:
        throw new Park("bad_event", false, `unexpected ${e.event}`);
    }
  });
}

/** A canceled/exhausted mandate collects no more: its auto-debit invoices fall back, the subscription unlinks. */
async function afterClosed(
  b: Billing,
  tx: BillingTx,
  before: Mandate,
  m: Mandate,
  why: { actor: string; cause: string },
): Promise<void> {
  if (!isCollecting(before)) return;
  for (const inv of await tx.mandateInvoices.payableAutoDebit(m))
    await fallbackInvoice(b, tx, inv, { ...why, cause: `mandate ${m.status}` });
  const sub = await tx.subscriptions.get(m, m.subscriptionId, { lock: true });
  if (sub && sub.mandateId === m.id)
    await saveSubscription(tx, sub, withMandate(sub, null, clockS(b, sub)), { ...why, cause: `mandate ${m.status}` }, [
      "evt.billing.subscription.updated",
    ]);
}

/** The invoice a collection applies to: the one the keeper is collecting, else the oldest payable one. */
async function targetInvoice(tx: BillingTx, m: Mandate): Promise<Invoice | null> {
  if (m.keeper.collectingInvoiceId) {
    const inv = await tx.invoices.get(m, m.keeper.collectingInvoiceId, { lock: true });
    if (inv && inv.collectionMethod === "auto_debit" && inv.mandateId === m.id && inv.status !== "draft") return inv;
  }
  if (m.linkStatus !== "linked") return null;
  const [first] = await tx.mandateInvoices.payableAutoDebit(m);
  return first ? ((await tx.invoices.get(m, first.id, { lock: true })) ?? null) : null;
}

async function onCollected(
  b: Billing,
  tx: BillingTx,
  m: Mandate,
  d: { period: number; amount: string; merchant_share: string; fee: string; balance: string },
  meta: EventMeta,
  now: number,
  why: { actor: string; cause: string; evidence: unknown },
  peers: CollectedPeers,
): Promise<void> {
  const inv = await targetInvoice(tx, m);
  const base: Collection = {
    period: d.period,
    amount: BigInt(d.amount),
    merchantShare: BigInt(d.merchant_share),
    fee: BigInt(d.fee),
    short: false,
    invoiceId: inv?.id ?? null,
    txHash: meta.txHash,
    receiptId: meta.receiptId,
    collectedAt: meta.blockTime,
  };
  const outcome = classifyCollection(m, base, inv, peers.decimals);
  const c: Collection = { ...base, short: outcome.kind === "short" };
  const ev = evidenceOf(m, c);
  const caseOf = (kind: Parameters<BillingTx["openCase"]>[0]["kind"], detail: Record<string, unknown>) =>
    tx.openCase({
      scope: m,
      mandateId: m.id,
      invoiceId: inv?.id ?? null,
      kind,
      detail: { period: c.period, receipt_id: c.receiptId, ...detail },
    });
  switch (outcome.kind) {
    case "paid": {
      const invoice = inv as Invoice;
      if (!(await tx.mandates.recordCollection(m, c, "paid"))) break;
      const saved = await saveInvoice(
        tx,
        invoice,
        markPaidByCollection(invoice, clockS(b, invoice), ev),
        {
          actor: SYSTEM,
          cause: `collected period ${c.period} of mandate ${m.id}`,
          evidence: { receipt_id: c.receiptId, tx_hash: c.txHash, mandate: m.id },
        },
        ["evt.billing.invoice.paid"],
      );
      await renderPdfLater(tx, saved);
      await subscriptionAfterPaid(b, tx, saved, SYSTEM);
      if (outcome.feeLegFailed) {
        b.log.error(
          { mandate: m.id, receipt: c.receiptId },
          "ALERT vault fee leg failed (treasury not registered or blocklisted)",
        );
        await caseOf("fee_leg_failed", { fee_bps: m.feeBps });
      }
      break;
    }
    case "short": {
      const invoice = inv as Invoice;
      if (!(await tx.mandates.recordCollection(m, c, "short"))) break;
      const voided = await saveInvoice(
        tx,
        invoice,
        voidAfterShortCollection(invoice, clockS(b, invoice), ev),
        {
          actor: SYSTEM,
          cause: `short collection of period ${c.period}: balance invoiced`,
          evidence: { receipt_id: c.receiptId },
        },
        ["evt.billing.invoice.voided"],
      );
      await renderPdfLater(tx, voided);
      const balance = await issueBalanceInvoice(b, tx, voided, outcome.shortfall, peers);
      b.log.error(
        {
          mandate: m.id,
          invoice: invoice.id,
          balance_invoice: balance?.id ?? null,
          shortfall: outcome.shortfall.toString(),
        },
        "ALERT short vault collection",
      );
      await caseOf("short_share", {
        expected_share: expectedShare(m).toString(),
        merchant_share: c.merchantShare.toString(),
        shortfall: outcome.shortfall.toString(),
        balance_invoice: balance?.id ?? null,
      });
      break;
    }
    case "late":
    case "mismatch": {
      if (!(await tx.mandates.recordCollection(m, c, "late"))) break;
      b.log.error(
        { mandate: m.id, invoice: inv?.id, status: inv?.status, kind: outcome.kind },
        "ALERT vault collection for a closed invoice (merchant refunds the payer)",
      );
      await caseOf("late_collection", { invoice_status: inv?.status ?? null, kind: outcome.kind });
      break;
    }
    case "unapplied": {
      if (!(await tx.mandates.recordCollection(m, c, "unapplied"))) break;
      if (m.linkStatus !== "linked") {
        b.log.error({ mandate: m.id, period: c.period }, "ALERT an unlinked mandate was collected");
        await caseOf("late_collection", { unlinked: true });
      } else
        b.log.warn(
          { mandate: m.id, period: c.period },
          "vault collection ahead of billing: applied to the next invoice",
        );
      break;
    }
  }
  await saveMandate(tx, m, applyCollected(m, c, BigInt(d.balance), meta, now), why, ["evt.billing.mandate.collected"]);
}

/** A `send_invoice` balance invoice for the shortfall of a short collection (§7.1), finalized and sent. */
async function issueBalanceInvoice(
  b: Billing,
  tx: BillingTx,
  voided: Invoice,
  shortfall: bigint,
  peers: CollectedPeers,
): Promise<Invoice | null> {
  if (shortfall <= 0n) return null;
  const now = clockS(b, voided);
  const draft = newDraft(voided as Scope, b.newId("in"), now, {
    currency: voided.currency,
    assetId: voided.assetId,
    customerId: voided.customerId,
    subscriptionId: voided.subscriptionId,
    billingReason: "manual",
    lines: [
      {
        id: b.newId("il"),
        type: "invoiceitem",
        priceId: null,
        productId: null,
        subscriptionItemId: null,
        description: `Balance of invoice ${voided.number ?? voided.id} (auto-debit collected only part)`,
        quantity: 1,
        unitAmount: shortfall,
        amount: shortfall,
        amountExcludingTax: shortfall,
        taxRateIds: [],
        taxRatesExplicit: true,
        taxAmounts: [],
        period: voided.period,
      },
    ],
    totals: { subtotal: shortfall, tax: 0n, total: shortfall, totalExcludingTax: shortfall, totalTaxAmounts: [] },
    description: voided.description,
    daysUntilDue: voided.daysUntilDue ?? 7,
    reminderDays: voided.reminderDays,
    settlementDestinationId: voided.settlementDestinationId,
    metadata: voided.metadata,
    clockOffset: voided.clockOffset ?? 0,
  });
  const meta = { actor: SYSTEM, cause: `balance of ${voided.id}` };
  const created = await saveInvoice(tx, null, draft, meta, ["evt.billing.invoice.created"]);
  const open = await finalizeInTx(b, tx, created, { merchant: peers.merchant, customer: peers.customer, meta });
  return saveInvoice(tx, open, { ...open, sentAt: now, updated: now }, { ...meta, cause: "balance invoice sent" }, [
    "evt.billing.invoice.sent",
  ]);
}

async function onCollectFailed(
  b: Billing,
  tx: BillingTx,
  m: Mandate,
  meta: EventMeta,
  now: number,
  why: { actor: string; cause: string; evidence: unknown },
): Promise<void> {
  const next = applyCollectFailed(m, meta, now);
  const saved = await saveMandate(tx, m, next, why, ["evt.billing.mandate.updated"]);
  const inv = await targetInvoice(tx, saved);
  if (inv?.collectionMethod !== "auto_debit" || inv.status === "paid" || inv.status === "void") return;
  const d = afterCollectFailed(saved.keeper, now);
  if (d.fallback) {
    // §7.1: after N failures (or 24 h) the invoice falls back; `mandate.insufficient_funds` is not emitted
    await fallbackInvoice(b, tx, inv, { actor: SYSTEM, cause: `${saved.keeper.collectFailures} collect failures` });
    await saveMandate(
      tx,
      saved,
      { ...saved, keeper: { ...saved.keeper, collectingInvoiceId: null }, updated: now },
      why,
    );
    await tx.openCase({
      scope: m,
      mandateId: m.id,
      invoiceId: inv.id,
      kind: "collect_failures",
      detail: {
        failures: saved.keeper.collectFailures,
        merchant_receiver: m.merchantReceiver,
        since: saved.keeper.collectFailuresSince,
      },
    });
    b.log.error(
      { mandate: m.id, invoice: inv.id, failures: saved.keeper.collectFailures },
      "ALERT vault merchant leg keeps failing; invoice falls back to send_invoice",
    );
    return;
  }
  const jitter = (b.randomBytes(1)[0] ?? 0) % 16;
  await enqueueCollect(tx, saved, inv, d.retryAt + jitter, `f${saved.keeper.collectFailures}`);
}
