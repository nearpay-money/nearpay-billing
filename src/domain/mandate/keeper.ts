/**
 * Keeper decisions (lld/billing.md v1.7 §7, §7.1; spec `VAULT_KEEPER_ON_TX_FAILURE`, `VAULT_KEEPER_RULES`).
 * The keeper only ever triggers the vault's permissionless `collect` with its own gas-only key (INV-1); an
 * invoice is paid only by the forwarded `collected` event (INV-2). While a sent `collect` has no forwarded
 * outcome yet, no other is sent for the mandate: a second one could collect a further period. Pure.
 */
import { VAULT_KEEPER_ON_TX_FAILURE, VAULT_KEEPER_RULES, type VaultErrorCode } from "../../spec-0.4.0.js";
import { type Invoice, isPayable } from "../invoice/invoice.js";
import { isCollecting, type KeeperState, type Mandate } from "./mandate.js";

export const RULES = VAULT_KEEPER_RULES;
/** How often a pending `collect` (sent, outcome not forwarded yet) is re-checked; alert after `PENDING_ALERT_S`. */
export const PENDING_RECHECK_S = 300;
export const PENDING_ALERT_S = 900;
/** Retry after `ERR_GAS` (misconfiguration: alert, fix gas). */
export const GAS_RETRY_S = 600;

export type CollectPlan =
  /** Nothing to do: the invoice is paid/void, not auto-debit, or belongs to another mandate. */
  | { readonly kind: "done"; readonly reason: string }
  /** The mandate cannot collect any more: the invoice falls back to `send_invoice`. */
  | { readonly kind: "fallback"; readonly reason: string }
  /** Try again at `at` (unix seconds). */
  | { readonly kind: "wait"; readonly at: number; readonly reason: string }
  /** Sign and send `collect` now. */
  | { readonly kind: "send" };

/** Whether to attempt a `collect` for `invoice` now (before the `next_collect_at` view). */
export function planCollect(m: Mandate, invoice: Invoice, now: number): CollectPlan {
  if (!isPayable(invoice)) return { kind: "done", reason: `invoice is ${invoice.status}` };
  if (invoice.collectionMethod !== "auto_debit") return { kind: "done", reason: "invoice is send_invoice" };
  if (invoice.mandateId !== m.id) return { kind: "done", reason: "invoice is collected from another mandate" };
  if (!isCollecting(m)) return { kind: "fallback", reason: `mandate is not collecting (${m.status})` };
  const k = m.keeper;
  if (k.pendingTxHash !== null)
    return { kind: "wait", at: now + PENDING_RECHECK_S, reason: "a sent collect awaits its forwarded outcome" };
  if (k.lastAttemptAt !== null && now - k.lastAttemptAt < RULES.min_attempt_spacing_secs)
    return { kind: "wait", at: k.lastAttemptAt + RULES.min_attempt_spacing_secs, reason: "attempt spacing" };
  return { kind: "send" };
}

/** `next_collect_at` (ns, from the view) against the chain's time: wait until due, else send. */
export function dueCheck(nextCollectAtNs: bigint | null, blockTimeNs: bigint): CollectPlan {
  if (nextCollectAtNs === null) return { kind: "fallback", reason: "the vault reports no next period" };
  if (nextCollectAtNs > blockTimeNs)
    return { kind: "wait", at: Number(nextCollectAtNs / 1_000_000_000n) + 1, reason: "next period not due" };
  return { kind: "send" };
}

export type TxFailureAction =
  | { readonly kind: "fallback_insufficient" }
  | { readonly kind: "retry_at_next_collect_at" }
  | { readonly kind: "await_outcome"; readonly at: number }
  | { readonly kind: "alert_gas"; readonly at: number }
  | { readonly kind: "reconcile" }
  | { readonly kind: "retry"; readonly at: number }
  | { readonly kind: "case"; readonly reason: string };

/** Delay before retry `n` (1-based) of an unexplained error: 60 s, 2 min, 4 min, 8 min. */
export const errorBackoff = (n: number): number => RULES.min_attempt_spacing_secs * 2 ** Math.max(0, n - 1);

/**
 * A `collect` transaction failed with vault error `code` (null = no vault code: RPC/transport/unknown);
 * `errorsBefore` = consecutive unexplained errors before this one. §7.1 table.
 */
export function onTxFailure(code: VaultErrorCode | null, errorsBefore: number, now: number): TxFailureAction {
  const rule = code ? (VAULT_KEEPER_ON_TX_FAILURE as Partial<Record<VaultErrorCode, string>>)[code] : undefined;
  switch (rule) {
    case "fallback_send_invoice":
      return { kind: "fallback_insufficient" };
    case "retry_at_next_collect_at":
      return { kind: "retry_at_next_collect_at" };
    case "await_forwarded_outcome":
      return { kind: "await_outcome", at: now + RULES.in_flight_recheck_secs };
    case "alert_and_fix_gas":
      return { kind: "alert_gas", at: now + GAS_RETRY_S };
    case "reconcile_no_retry":
      return { kind: "reconcile" };
  }
  const n = errorsBefore + 1;
  if (n >= RULES.other_error_retries)
    return { kind: "case", reason: `${n} consecutive keeper errors (${code ?? "rpc"})` };
  return { kind: "retry", at: now + errorBackoff(n) };
}

/**
 * After a `collect_failed` (the streak already counted in `k`): fall back after N = 5 consecutive failures
 * or 24 h since the first, else retry on a later tick (≥ 60 s, jittered by the caller).
 */
export function afterCollectFailed(
  k: KeeperState,
  now: number,
): { readonly fallback: boolean; readonly retryAt: number } {
  const since = k.collectFailuresSince ?? now;
  const fallback = k.collectFailures >= RULES.max_collect_failures || now - since >= RULES.collect_failure_window_secs;
  return { fallback, retryAt: now + RULES.min_attempt_spacing_secs };
}

/** Records that a `collect` was signed and is about to be sent (stored before sending, so a crash never loses it). */
export function markSent(m: Mandate, invoiceId: string, txHash: string, now: number): Mandate {
  return {
    ...m,
    keeper: {
      ...m.keeper,
      pendingTxHash: txHash,
      pendingSince: now,
      collectingInvoiceId: invoiceId,
      lastAttemptAt: now,
    },
    updated: now,
  };
}

/** The sent `collect` failed (no forwarded outcome will come): clear the pending mark. */
export function clearPending(m: Mandate, now: number, o: { readonly countError: boolean }): Mandate {
  return {
    ...m,
    keeper: {
      ...m.keeper,
      pendingTxHash: null,
      pendingSince: null,
      keeperErrors: o.countError ? m.keeper.keeperErrors + 1 : 0,
    },
    updated: now,
  };
}
