/**
 * Mandate use cases (lld/billing.md v1.7 §5, §14 d1–d12): prepare (side-effect free; `msg` built with the
 * spec helpers and checked against the vault rules), merchant cancel instructions, reads, the hosted
 * invoice page's funding and payer view (invoice secret), the test-mode payer simulations on the sandbox
 * vault stand-in, the notification context, and the subscription hooks (release, amount lock, auto-debit
 * invoices). Mandate rows are created only from forwarded vault events (`./vault-events.ts`).
 */

import { EVENT_JSON_PREFIX, ONE_YOCTO, parseVaultEventLog, VAULT_GAS, vaultErrorCodeOf } from "@nearpay/spec";
import { type Invoice, isPayable } from "../domain/invoice/invoice.js";
import { priceLines } from "../domain/invoice/lines.js";
import { fallbackToSendInvoice } from "../domain/mandate/collection.js";
import {
  cancelTx,
  type Funding,
  fundingInstructions,
  type NearTx,
  topUpMsg,
  withdrawTx,
} from "../domain/mandate/funding.js";
import { isCollecting, type Mandate, onchainActive, release } from "../domain/mandate/mandate.js";
import {
  computeTerms,
  type DestinationFacts,
  type TermsInput,
  tokenAssetId,
  tokenOfAsset,
  vaultPricingProblem,
} from "../domain/mandate/terms.js";
import { DomainError, missing, type Pricing, type Scope, stateConflict } from "../domain/shared.js";
import {
  hasEnded,
  periodLines,
  periodOf,
  type Subscription,
  withMandate,
} from "../domain/subscription/subscription.js";
import { type Ctx, type Meta, saveInvoice, saveMandate, saveSubscription } from "./commit.js";
import { checkSecret, getPublicInvoice, type PublicInvoiceData } from "./hosted.js";
import { clockS, loadCatalog, nowS } from "./invoices.js";
import type { AssetFacts, Billing, BillingTx, MandateListQuery, MerchantFacts, Page } from "./ports.js";

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

/**
 * The per-period total of the next renewal invoice with current items and tax rates (pricing units; §14 d2,
 * = `SubscriptionNotificationContext.next_amount`).
 */
export async function perPeriodTotal(tx: BillingTx, sub: Subscription): Promise<bigint> {
  const catalog = await loadCatalog(tx, sub, {
    priceIds: sub.items.map((i) => i.priceId),
    taxRateIds: [...sub.defaultTaxRateIds, ...sub.items.flatMap((i) => i.taxRateIds ?? [])],
  });
  const drafts = periodLines(sub, periodOf(sub, sub.nextPeriodIndex), catalog, () => "il_preview");
  return priceLines(drafts, sub.defaultTaxRateIds, { scope: sub, taxRates: catalog.taxRates, requireActive: false })
    .totals.total;
}

/** Whether the subscription's latest invoice is open (payable): the first collection pays it (§14 d4). */
export async function latestInvoicePayable(tx: BillingTx, sub: Subscription): Promise<boolean> {
  if (!sub.latestInvoiceId) return false;
  const inv = await tx.invoices.get(sub, sub.latestInvoiceId);
  return inv !== undefined && isPayable(inv);
}

/** NEAR RPC failures answer `rail_unavailable` (§14 d4); rule refusals pass through. */
export async function rpc<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof DomainError) throw e;
    throw new DomainError("rail_unavailable", { rail: "near" });
  }
}

/** Decimals of the candidate tokens of a pricing (USD stablecoins, or the pricing asset's token). */
export async function tokenDecimals(
  b: Billing,
  pricing: Pricing,
  requested: string | undefined,
): Promise<Map<string, number>> {
  const tokens = new Set<string>(requested ? [requested] : []);
  if (pricing.currency === "usd") for (const t of b.settings.vaultUsdTokens) tokens.add(t);
  const t = tokenOfAsset(pricing.assetId);
  if (t) tokens.add(t);
  const out = new Map<string, number>();
  for (const tok of tokens) {
    const a: AssetFacts | undefined = await b.assets.asset(tokenAssetId(tok));
    if (a) out.set(tok, a.decimals);
  }
  return out;
}

export const destinationsOf = (m: MerchantFacts): DestinationFacts[] =>
  m.destinations.map((d) => ({ id: d.id, assetId: d.assetId, type: d.type, address: d.address }));

/** Fallback of a payable `auto_debit` invoice to `send_invoice`, emailed (§7.1, §14 d6). */
export async function fallbackInvoice(b: Billing, tx: BillingTx, inv: Invoice, meta: Meta): Promise<Invoice> {
  const now = clockS(b, inv);
  const next = fallbackToSendInvoice(inv, now);
  const sendable = next.sentAt === null || now - next.sentAt >= 600;
  return saveInvoice(
    tx,
    inv,
    sendable ? { ...next, sentAt: now } : next,
    { ...meta, cause: `${meta.cause}: falls back to send_invoice` },
    sendable ? ["evt.billing.invoice.sent"] : [],
  );
}

/**
 * Collection stops for good when the subscription ended or left `auto_debit` (§14 d7): the linked mandate is
 * released (`mandate.released`; notify asks the payer to cancel and take the balance back — NearPay holds
 * no key that could, INV-1), and its payable auto-debit invoices fall back to `send_invoice`.
 * `sub` must be the stored (locked) row; returns it as stored afterwards.
 */
export async function releaseIfEnded(b: Billing, tx: BillingTx, sub: Subscription, meta: Meta): Promise<Subscription> {
  if (!hasEnded(sub) && sub.collectionMethod === "auto_debit") return sub;
  const m = await tx.mandates.collectingFor(sub, sub.id, { lock: true });
  let cur = sub;
  if (m) {
    const released = release(m, nowS(b));
    if (released)
      await saveMandate(tx, m, released, { ...meta, cause: `${meta.cause}: mandate released` }, [
        "evt.billing.mandate.released",
      ]);
  }
  for (const inv of await tx.mandateInvoices.payableAutoDebitOfSubscription(sub, sub.id))
    await fallbackInvoice(b, tx, inv, { ...meta, cause: "subscription no longer collects by auto-debit" });
  if (cur.mandateId !== null) cur = await saveSubscription(tx, cur, withMandate(cur, null, clockS(b, cur)), meta);
  return cur;
}

// ---------------------------------------------------------------------------------------------
// Prepare (merchant API and hosted page)
// ---------------------------------------------------------------------------------------------

export interface FundingInput {
  readonly payer?: string | undefined;
  readonly token?: string | undefined;
  readonly periods?: number | undefined;
}

export interface FundingData {
  readonly livemode: boolean;
  readonly subscriptionId: string;
  readonly funding: Funding;
}

/**
 * `prepareMandate` / hosted-page funding: the same computation, no side effects (§14 d1, d4, d8). The
 * subscription must be `auto_debit`, not canceled and without a linked active mandate (`state_conflict`).
 */
async function computeFunding(
  b: Billing,
  scope: Scope,
  subscriptionId: string,
  input: FundingInput,
): Promise<FundingData> {
  const read = await b.store.transaction(async (tx) => {
    const sub = await tx.subscriptions.get(scope, subscriptionId);
    if (!sub) throw missing("subscription", subscriptionId, "subscription");
    if (sub.collectionMethod !== "auto_debit") throw stateConflict("subscription", "not auto_debit");
    if (sub.status === "canceled") throw stateConflict("subscription", sub.status);
    if (await tx.mandates.collectingFor(sub, sub.id))
      throw stateConflict("subscription", "with a linked active mandate");
    return { sub, total: await perPeriodTotal(tx, sub), payable: await latestInvoicePayable(tx, sub) };
  });
  const sub = read.sub;
  const merchant = await b.merchant.context(sub);
  if (sub.livemode && !merchant.liveEnabled)
    throw new DomainError("account_not_live", { missing: merchant.liveMissing ?? "live mode" });
  const decimals = await tokenDecimals(b, sub, input.token);
  const config = await rpc(() => b.vault.config(sub.livemode));
  const base: TermsInput = {
    subscription: sub,
    perPeriodTotal: read.total,
    token: input.token,
    tokenDecimals: (t) => decimals.get(t),
    usdTokens: b.settings.vaultUsdTokens,
    allowedTokens: config.allowedTokens,
    maxFeeBps: config.maxFeeBps,
    feeBps: merchant.vaultFeeBps,
    destinations: destinationsOf(merchant),
    defaults: merchant.defaults,
    latestInvoicePayable: read.payable,
    now: nowS(b),
  };
  const terms = computeTerms(base);
  const cap = config.caps.get(terms.token);
  const tvl = await rpc(() => b.vault.tokenTvl(sub.livemode, terms.token));
  if (!cap || !tvl)
    throw new DomainError("auto_debit_unavailable", {
      subscription: sub.id,
      reason: `${terms.token} has no vault cap`,
    });
  const payer = input.payer ?? null;
  const storage = payer ? await rpc(() => b.vault.storageBalanceOf(sub.livemode, payer)) : undefined;
  const funding = fundingInstructions({
    terms,
    vaultContract: b.vault.contract(sub.livemode),
    periods: input.periods,
    caps: { mandateCap: cap.mandateCap, tvlCap: tvl.cap, tvl: tvl.tvl },
    payer,
    storage,
    subscriptionId: sub.id,
  });
  return { livemode: sub.livemode, subscriptionId: sub.id, funding };
}

export function prepareMandate(
  b: Billing,
  c: Ctx,
  input: FundingInput & { readonly subscriptionId: string },
): Promise<FundingData> {
  return computeFunding(b, c.scope, input.subscriptionId, input);
}

/** The invoice behind a hosted-page mandate request, with its subscription id (paid/void → not payable). */
async function hostedSubscription(b: Billing, invoiceId: string, secret: string): Promise<Invoice> {
  const inv = checkSecret(await b.store.transaction((tx) => tx.invoices.getByIdUnscoped(invoiceId)), invoiceId, secret);
  return inv;
}

/** `createPublicInvoiceMandateFunding` (invoice secret; §14 d8). */
export async function createPublicInvoiceMandateFunding(
  b: Billing,
  invoiceId: string,
  secret: string,
  input: FundingInput,
): Promise<FundingData> {
  const inv = await hostedSubscription(b, invoiceId, secret);
  if (!isPayable(inv)) throw new DomainError("invoice_not_payable", { invoice: inv.id, status: inv.status });
  if (!inv.subscriptionId) throw stateConflict("invoice", "not a subscription invoice");
  return computeFunding(b, inv, inv.subscriptionId, input);
}

// ---------------------------------------------------------------------------------------------
// Reads, merchant cancel, payer view
// ---------------------------------------------------------------------------------------------

export function getMandate(b: Billing, c: Ctx, id: string): Promise<Mandate> {
  return b.store.transaction(
    async (tx) => (await tx.mandates.get(c.scope, id)) ?? Promise.reject(missing("mandate", id)),
  );
}

export function listMandates(b: Billing, c: Ctx, q: MandateListQuery): Promise<Page<Mandate>> {
  return b.store.transaction((tx) => tx.mandates.list(c.scope, q));
}

/** `prepareMandateCancel`: the `cancel` the merchant receiver signs (§14 d9); closed mandates → `state_conflict`. */
export async function prepareMandateCancel(
  b: Billing,
  c: Ctx,
  id: string,
): Promise<{ mandate: Mandate; transaction: NearTx }> {
  const m = await getMandate(b, c, id);
  if (!onchainActive(m)) throw stateConflict("mandate", m.status);
  return { mandate: m, transaction: cancelTx(m.vaultContract, m.onchainId, m.merchantReceiver) };
}

export interface PayerTransactions {
  readonly cancel: NearTx | null;
  readonly withdraw: NearTx | null;
  readonly topUpMsg: string | null;
}

/** What the payer may sign for this mandate: cancel/top up while active, withdraw a remaining balance after. */
export function payerTransactions(m: Mandate): PayerTransactions {
  const active = onchainActive(m);
  return {
    cancel: active ? cancelTx(m.vaultContract, m.onchainId, m.payer) : null,
    withdraw: !active && m.balance > 0n ? withdrawTx(m.vaultContract, m.onchainId, m.payer) : null,
    topUpMsg: active ? topUpMsg(m.onchainId) : null,
  };
}

export interface PublicMandateData {
  readonly mandate: Mandate;
  readonly collecting: boolean;
  readonly tx: PayerTransactions;
}

/** `getPublicInvoiceMandate`: the newest mandate of the invoice's subscription (invoice secret; §14 d8). */
export async function getPublicInvoiceMandate(
  b: Billing,
  invoiceId: string,
  secret: string,
): Promise<PublicMandateData> {
  const inv = await hostedSubscription(b, invoiceId, secret);
  const subId = inv.subscriptionId;
  const m = subId ? await b.store.transaction((tx) => tx.mandates.newestFor(inv, subId)) : undefined;
  if (!m) throw missing("mandate", invoiceId);
  return { mandate: m, collecting: isCollecting(m), tx: payerTransactions(m) };
}

/** `getPublicInvoice` with `PublicInvoice.auto_debit` (the hosted page offers auto-debit setup, §14 d6, d8). */
export async function getHostedInvoice(b: Billing, id: string, secret: string): Promise<PublicInvoiceData> {
  const d = await getPublicInvoice(b, id, secret);
  return { ...d, autoDebit: await publicAutoDebit(b, d.invoice) };
}

/** `PublicInvoice.auto_debit` for invoices of `auto_debit` subscriptions (null otherwise). */
export async function publicAutoDebit(
  b: Billing,
  inv: Invoice,
): Promise<{ available: boolean; mandate: string | null; collecting: boolean } | null> {
  const subId = inv.subscriptionId;
  if (!subId) return null;
  return b.store.transaction(async (tx) => {
    const sub = await tx.subscriptions.get(inv, subId);
    if (sub?.collectionMethod !== "auto_debit") return null;
    const collecting = await tx.mandates.collectingFor(sub, sub.id);
    const newest = await tx.mandates.newestFor(sub, sub.id);
    return {
      available: !collecting && sub.status !== "canceled" && isPayable(inv),
      mandate: newest?.id ?? null,
      collecting: collecting !== undefined && inv.collectionMethod === "auto_debit" && inv.mandateId === collecting.id,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Test helpers (test mode; the sandbox vault stand-in, §14 d12)
// ---------------------------------------------------------------------------------------------

export interface SimulationData {
  readonly action: "fund" | "top_up" | "cancel" | "withdraw";
  readonly txHash: string;
  readonly accepted: boolean;
  readonly rejection: string | null;
  readonly onchainId: number | null;
  readonly logs: readonly string[];
}

/** Accepted unless the call failed (`ERR_…` panic) or the vault logged a rejection line (refunded deposit). */
export function simulationResult(
  action: SimulationData["action"],
  o: { readonly txHash: string; readonly failure: string | null; readonly vaultLogs: readonly string[] },
  onchainId: number | null,
): SimulationData {
  const rejectionLine = o.vaultLogs.find((l) => !l.startsWith(EVENT_JSON_PREFIX) && vaultErrorCodeOf(l) !== null);
  const failure = o.failure === null ? null : (/(ERR_[A-Z_]+(?:: [a-z]+)?)/.exec(o.failure)?.[1] ?? o.failure);
  let id = onchainId;
  for (const l of o.vaultLogs) {
    const e = parseVaultEventLog(l);
    if (e?.event === "mandate_created") id = e.data[0].mandate_id;
  }
  const rejection = failure ?? rejectionLine ?? null;
  return { action, txHash: o.txHash, accepted: rejection === null, rejection, onchainId: id, logs: [...o.vaultLogs] };
}

/** `simulateMandateFunding`: prepare, then storage + `ft_transfer_call` as the simulated payer. */
export async function simulateMandateFunding(
  b: Billing,
  c: Ctx,
  input: FundingInput & { readonly subscriptionId: string },
): Promise<SimulationData> {
  if (c.scope.livemode) throw new DomainError("livemode_forbidden");
  const payer = input.payer ?? b.settings.simulatedPayer;
  const { funding } = await computeFunding(b, c.scope, input.subscriptionId, { ...input, payer });
  if (funding.storageDeposit > 0n) {
    const s = await rpc(() =>
      b.sandbox.call({
        signer: payer,
        method: "storage_deposit",
        args: {},
        gas: VAULT_GAS.storage_deposit,
        deposit: funding.storageDeposit.toString(),
      }),
    );
    if (s.failure) return simulationResult("fund", s, null);
  }
  const out = await rpc(() =>
    b.sandbox.ftTransferCall({ payer, token: funding.terms.token, amount: funding.amount, msg: funding.msg }),
  );
  return simulationResult("fund", out, null);
}

/** `simulateMandatePayerAction`: `top_up` (periods × amount, default 1), `cancel`, `withdraw` as the payer. */
export async function simulateMandatePayerAction(
  b: Billing,
  c: Ctx,
  id: string,
  input: { readonly action: "top_up" | "cancel" | "withdraw"; readonly periods?: number | undefined },
): Promise<SimulationData> {
  if (c.scope.livemode) throw new DomainError("livemode_forbidden");
  const m = await getMandate(b, c, id);
  if (input.action === "top_up") {
    const periods = input.periods ?? 1;
    if (!Number.isInteger(periods) || periods < 1 || periods > 36)
      throw new DomainError("invalid_request", { detail: "periods must be 1–36" }, "periods");
    const out = await rpc(() =>
      b.sandbox.ftTransferCall({
        payer: m.payer,
        token: m.token,
        amount: BigInt(periods) * m.amountPerPeriod,
        msg: topUpMsg(m.onchainId),
      }),
    );
    return simulationResult("top_up", out, m.onchainId);
  }
  const method = input.action;
  const out = await rpc(() =>
    b.sandbox.call({
      signer: m.payer,
      method,
      args: { mandate_id: m.onchainId },
      gas: VAULT_GAS.exit,
      deposit: ONE_YOCTO,
    }),
  );
  return simulationResult(input.action, out, m.onchainId);
}

// ---------------------------------------------------------------------------------------------
// Subscription hooks
// ---------------------------------------------------------------------------------------------

/** `auto_debit` needs vault-compatible pricing, checked up front without RPC (§14 d2). */
export function assertAutoDebitPricing(b: Billing, sub: Pick<Subscription, "currency" | "assetId">, id: string): void {
  const problem = vaultPricingProblem(sub, b.settings.vaultUsdTokens, b.settings.vaultTokens);
  if (problem)
    throw new DomainError("auto_debit_unavailable", { subscription: id, reason: problem }, "collection_method");
}

/**
 * The amount lock (§14 d6): while a linked mandate is active, a change of items or default tax rates that
 * changes the per-period total is `state_conflict` (the payer authorised a fixed amount).
 */
export async function assertAmountUnchanged(tx: BillingTx, cur: Subscription, next: Subscription): Promise<void> {
  if (cur.collectionMethod !== "auto_debit" || next.collectionMethod !== "auto_debit") return;
  if (!(await tx.mandates.collectingFor(cur, cur.id))) return;
  const [before, after] = [await perPeriodTotal(tx, cur), await perPeriodTotal(tx, next)];
  if (before !== after) throw stateConflict("subscription", "with an active mandate for a fixed amount per period");
}

/** Advances the stand-in clock of the subscription's linked mandate with the billing clock (§14 d12). */
export async function advanceMandateClock(b: Billing, sub: Subscription, delta: number): Promise<void> {
  const m = await b.store.transaction((tx) => tx.mandates.collectingFor(sub, sub.id));
  if (!m || m.livemode) return;
  try {
    await b.sandbox.advance(m.onchainId, delta);
  } catch (e) {
    b.log.error({ mandate: m.id, err: String(e) }, "could not advance the sandbox vault clock of the linked mandate");
  }
}
