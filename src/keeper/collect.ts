/**
 * The keeper (lld/billing.md v1.7 §7 `mandate.collect`, §7.1). One job per (mandate, invoice, attempt):
 * decide from billing state and the vault's `next_collect_at` whether a period is due, sign `collect` with
 * the keeper's gas-only key (250 Tgas, unused gas refunded; INV-1: the key can only pay gas for the
 * permissionless `collect`), store the transaction hash BEFORE broadcasting, send, and act on a failure per
 * §7.1. A success does not pay anything here: the forwarded `collected` / `collect_failed` event does
 * (`app/vault-events.ts`, INV-2). While a sent `collect` awaits its forwarded outcome no other is sent.
 */

import { saveMandate } from "../app/commit.js";
import { nowS } from "../app/invoices.js";
import { fallbackInvoice } from "../app/mandates.js";
import type { Billing, BillingTx, CollectTxResult } from "../app/ports.js";
import { enqueueCollect } from "../app/vault-events.js";
import type { Invoice } from "../domain/invoice/invoice.js";
import {
  clearPending,
  dueCheck,
  markSent,
  onTxFailure,
  PENDING_ALERT_S,
  PENDING_RECHECK_S,
  planCollect,
} from "../domain/mandate/keeper.js";
import type { Mandate } from "../domain/mandate/mandate.js";
import type { Scope } from "../domain/shared.js";

export interface CollectJob {
  readonly mandate: string;
  readonly invoice: string;
  readonly scope: Scope;
}

const SYSTEM = "system:keeper";
/** Retry while the keeper key is not configured for the mode (alert each time). */
const NO_KEY_RETRY_S = 600;

type Loaded = { readonly m: Mandate; readonly inv: Invoice };

async function load(b: Billing, tx: BillingTx, j: CollectJob, lock = false): Promise<Loaded | null> {
  const m = await tx.mandates.get(j.scope, j.mandate, { lock });
  const inv = await tx.invoices.get(j.scope, j.invoice, { lock });
  if (!m || !inv) {
    b.log.warn({ mandate: j.mandate, invoice: j.invoice }, "keeper job for a missing mandate or invoice");
    return null;
  }
  return { m, inv };
}

const later = (b: Billing, m: Mandate, inv: Invoice, at: number, reason: string) =>
  b.store.transaction(async (tx) => {
    b.log.info({ mandate: m.id, invoice: inv.id, at, reason }, "keeper: collect later");
    await enqueueCollect(tx, m, inv, at, `t${at}`);
  });

async function fallback(
  b: Billing,
  j: CollectJob,
  reason: string,
  o: { insufficient?: boolean; caseKind?: "keeper_errors" } = {},
) {
  await b.store.transaction(async (tx) => {
    const l = await load(b, tx, j, true);
    if (l?.inv.collectionMethod !== "auto_debit" || (l.inv.status !== "open" && l.inv.status !== "uncollectible"))
      return;
    await fallbackInvoice(b, tx, l.inv, { actor: SYSTEM, cause: reason });
    const m = { ...l.m, keeper: { ...l.m.keeper, collectingInvoiceId: null }, updated: nowS(b) };
    await saveMandate(
      tx,
      l.m,
      m,
      { actor: SYSTEM, cause: reason },
      o.insufficient ? ["evt.billing.mandate.insufficient_funds"] : [],
    );
    if (o.caseKind)
      await tx.openCase({ scope: m, mandateId: m.id, invoiceId: l.inv.id, kind: o.caseKind, detail: { reason } });
  });
}

/** `mandate.collect` job handler (re-entrant; every decision re-reads the rows). */
export async function collectJob(b: Billing, j: CollectJob): Promise<void> {
  const l = await b.store.transaction((tx) => load(b, tx, j));
  if (!l) return;
  const now = nowS(b);
  const plan = planCollect(l.m, l.inv, now);
  if (plan.kind === "done") return;
  if (plan.kind === "fallback") return fallback(b, j, plan.reason);
  if (plan.kind === "wait") {
    if (l.m.keeper.pendingTxHash !== null) return recheckPending(b, j, l);
    return later(b, l.m, l.inv, plan.at, plan.reason);
  }
  const livemode = l.m.livemode;
  if (!b.vault.keeperEnabled(livemode)) {
    b.log.error({ mandate: l.m.id, livemode }, "ALERT keeper key not configured for this mode: cannot collect");
    return later(b, l.m, l.inv, now + NO_KEY_RETRY_S, "keeper key missing");
  }
  // due? (`next_collect_at` view against the chain's own clock; calendar renewals drift ≤ ~3 days, §14 d3)
  let due: ReturnType<typeof dueCheck>;
  try {
    due = dueCheck(await b.vault.nextCollectAt(livemode, l.m.onchainId), await b.vault.blockTimeNs(livemode));
  } catch (e) {
    return rpcError(b, j, l, String(e));
  }
  if (due.kind === "wait") return later(b, l.m, l.inv, due.at, due.reason);
  if (due.kind === "fallback") return reconcile(b, j, l, due.reason);
  let signed: Awaited<ReturnType<Billing["vault"]["signCollect"]>>;
  try {
    signed = await b.vault.signCollect(livemode, l.m.onchainId);
  } catch (e) {
    return rpcError(b, j, l, String(e));
  }
  // store the hash first: a crash after broadcasting never loses it and never sends a second collect
  const stored = await b.store.transaction(async (tx) => {
    const cur = await load(b, tx, j, true);
    if (!cur || planCollect(cur.m, cur.inv, nowS(b)).kind !== "send") return false;
    await saveMandate(tx, cur.m, markSent(cur.m, cur.inv.id, signed.txHash, nowS(b)), {
      actor: SYSTEM,
      cause: `collect sent ${signed.txHash}`,
    });
    return true;
  });
  if (!stored) return;
  const result = await b.vault
    .send(livemode, signed)
    .catch((e: unknown): CollectTxResult => ({ kind: "unknown", txHash: signed.txHash, error: String(e) }));
  return onResult(b, j, result);
}

/** Acts on a final (or unknown) result of the mandate's pending `collect`. */
async function onResult(b: Billing, j: CollectJob, r: CollectTxResult): Promise<void> {
  const now = nowS(b);
  if (r.kind === "success") {
    // the forwarded `collected` / `collect_failed` decides; re-check later in case rails is slow
    const l = await b.store.transaction((tx) => load(b, tx, j));
    if (l) await later(b, l.m, l.inv, now + PENDING_RECHECK_S, "awaiting the forwarded outcome");
    return;
  }
  if (r.kind === "unknown") {
    const l = await b.store.transaction((tx) => load(b, tx, j));
    if (l) await later(b, l.m, l.inv, now + 60, `collect status unknown: ${r.error.slice(0, 200)}`);
    return;
  }
  // final failure: no forwarded outcome will come
  const l = await b.store.transaction(async (tx) => {
    const cur = await load(b, tx, j, true);
    if (!cur || cur.m.keeper.pendingTxHash !== r.txHash) return null;
    const m = await saveMandate(tx, cur.m, clearPending(cur.m, now, r.code), {
      actor: SYSTEM,
      cause: `collect failed: ${r.code ?? r.message.slice(0, 200)}`,
    });
    return { m, inv: cur.inv, errorsBefore: cur.m.keeper.keeperErrors };
  });
  if (!l) return;
  const action = onTxFailure(r.code, l.errorsBefore, now);
  switch (action.kind) {
    case "fallback_insufficient":
      return fallback(b, j, "ERR_INSUFFICIENT_BALANCE", { insufficient: true });
    case "retry_at_next_collect_at": {
      let at = now + 60;
      try {
        const next = await b.vault.nextCollectAt(l.m.livemode, l.m.onchainId);
        if (next !== null) at = Math.max(at, Number(next / 1_000_000_000n) + 1);
      } catch {
        // keep the short retry
      }
      return later(b, l.m, l.inv, at, "ERR_NOT_DUE");
    }
    case "await_outcome":
      return later(b, l.m, l.inv, action.at, "ERR_IN_FLIGHT: another collect is pending");
    case "alert_gas":
      b.log.error(
        { mandate: l.m.id, message: r.message },
        "ALERT keeper collect refused with ERR_GAS (gas misconfigured)",
      );
      return later(b, l.m, l.inv, action.at, "ERR_GAS");
    case "reconcile":
      return reconcile(b, j, l, r.code ?? "vault error");
    case "retry":
      b.log.warn({ mandate: l.m.id, error: r.message.slice(0, 300) }, "keeper collect failed; retrying");
      return later(b, l.m, l.inv, action.at, "keeper error");
    case "case":
      b.log.error({ mandate: l.m.id, error: r.message.slice(0, 300) }, "ALERT keeper gives up after repeated errors");
      return fallback(b, j, action.reason, { caseKind: "keeper_errors" });
  }
}

/** RPC unavailable before sending (nothing was sent): count it as a keeper error and back off. */
async function rpcError(b: Billing, j: CollectJob, l: Loaded, error: string): Promise<void> {
  const now = nowS(b);
  const action = onTxFailure(null, l.m.keeper.keeperErrors, now);
  await b.store.transaction(async (tx) => {
    const cur = await load(b, tx, j, true);
    if (cur)
      await saveMandate(tx, cur.m, clearPending(cur.m, now, null), {
        actor: SYSTEM,
        cause: `rpc: ${error.slice(0, 200)}`,
      });
  });
  if (action.kind === "case") {
    b.log.error({ mandate: l.m.id, error }, "ALERT keeper cannot reach NEAR RPC; invoice falls back");
    return fallback(b, j, action.reason, { caseKind: "keeper_errors" });
  }
  b.log.warn({ mandate: l.m.id, error: error.slice(0, 300) }, "keeper: NEAR RPC error, retrying");
  if (action.kind === "retry") return later(b, l.m, l.inv, action.at, "rpc error");
}

/**
 * `ERR_NOT_ACTIVE` / `ERR_MAX_PERIODS` / `ERR_NOT_FOUND` (or no next period): the mandate cannot pay; the
 * invoice falls back. The mirror changes only through events (INV-2); a view disagreeing is alerted.
 */
async function reconcile(b: Billing, j: CollectJob, l: Loaded, reason: string): Promise<void> {
  try {
    const v = await b.vault.mandateView(l.m.livemode, l.m.onchainId);
    if (v?.status === "active")
      b.log.error({ mandate: l.m.id, reason, view: v.status }, "ALERT vault view disagrees with the collect failure");
    else
      b.log.warn(
        { mandate: l.m.id, reason, view: v?.status ?? null },
        "keeper: mandate cannot collect; waiting for its events",
      );
  } catch {
    // the view is informational only
  }
  return fallback(b, j, `mandate cannot collect (${reason})`);
}

/** A sent `collect` without forwarded outcome: re-check its status; alert when rails seems not to forward. */
async function recheckPending(b: Billing, j: CollectJob, l: Loaded): Promise<void> {
  const now = nowS(b);
  const hash = l.m.keeper.pendingTxHash as string;
  const age = now - (l.m.keeper.pendingSince ?? now);
  let r: CollectTxResult;
  try {
    r = await b.vault.status(l.m.livemode, hash);
  } catch (e) {
    r = { kind: "unknown", txHash: hash, error: String(e) };
  }
  if (r.kind === "failure") return onResult(b, j, r);
  if (r.kind === "success" && age >= PENDING_ALERT_S)
    b.log.error(
      { mandate: l.m.id, tx: hash, age },
      "ALERT collect succeeded but no forwarded vault event yet (rails forwarding?)",
    );
  if (r.kind === "unknown" && age >= PENDING_ALERT_S) {
    // never landed (dropped or expired): forget it and retry (a late landing is still accounted per period)
    b.log.error({ mandate: l.m.id, tx: hash, age }, "ALERT sent collect unknown to NEAR RPC; retrying");
    await b.store.transaction(async (tx) => {
      const cur = await load(b, tx, j, true);
      if (cur && cur.m.keeper.pendingTxHash === hash)
        await saveMandate(tx, cur.m, clearPending(cur.m, now, null), {
          actor: SYSTEM,
          cause: `collect ${hash} unknown`,
        });
    });
    return later(b, l.m, l.inv, now + 60, "pending collect unknown");
  }
  return later(b, l.m, l.inv, now + PENDING_RECHECK_S, "awaiting the forwarded outcome");
}
