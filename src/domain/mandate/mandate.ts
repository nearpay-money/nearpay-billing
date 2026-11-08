/**
 * Mandate: billing's mirror of a subscription-vault mandate (lld/billing.md v1.7 §3, §6, §14 d1, d10;
 * contracts-vault.md v1.6 §3–§4). A mandate exists only from the vault's `mandate_created` event on (rails
 * forwards it, §6); balances, periods and status follow the vault's events, never an RPC response alone
 * (INV-2). Every number the vault accepts is bounded (contracts-vault v1.5 §3.1): ids, periods and
 * counters fit JavaScript integers; amounts are bigint (INV-5). Pure.
 *
 * Event arithmetic (each event applied exactly once — dedupe on `receipt_id:log_index`):
 * - `mandate_created`, `topped_up`, `collected` carry the absolute balance after the event; it is taken when
 *   the event's block is not older than the last one applied (a redelivered, older event never rolls the
 *   balance back).
 * - `collect_failed` leaves the balance (the vault credited the period back; the mirror never subtracted it).
 * - `canceled` subtracts `refunded` (`"0"` when the refund failed: the vault restored the balance);
 *   `withdrawn` subtracts its amount.
 * - `canceled` and `exhausted` are final.
 */
import { vaultSplit } from "../../spec-0.4.0.js";
import type { Scope } from "../shared.js";

export type MandateStatus = "active" | "insufficient" | "exhausted" | "canceled";
export type LinkStatus = "linked" | "unlinked";
export type ReceiverKind = "intents_account" | "near_account";

/** Spec `MandateUnlinkedReason` (billing §6 linkage rule, §14 d1). */
export const UNLINKED_REASONS = [
  "mode_mismatch",
  "subscription_not_auto_debit",
  "subscription_ended",
  "already_linked",
  "receiver_kind_mismatch",
  "receiver_not_destination",
  "token_mismatch",
  "amount_mismatch",
  "period_mismatch",
  "fee_mismatch",
  "start_too_late",
  "max_periods_too_low",
] as const;
export type UnlinkedReason = (typeof UNLINKED_REASONS)[number];

/** A counted vault period (`collected` event) — the evidence of an auto-debit payment (INV-2). */
export interface Collection {
  readonly period: number;
  /** `merchant_share + fee` actually paid. */
  readonly amount: bigint;
  readonly merchantShare: bigint;
  readonly fee: bigint;
  /** Merchant share below the expected `floor(amount_per_period × (10000 − fee_bps) / 10000)`. */
  readonly short: boolean;
  readonly invoiceId: string | null;
  readonly txHash: string;
  readonly receiptId: string;
  /** Block time (unix seconds). */
  readonly collectedAt: number;
}

/** The keeper's per-mandate state (§7.1). */
export interface KeeperState {
  /** Consecutive `collect_failed` outcomes. */
  readonly collectFailures: number;
  /** First failure of the current streak (unix seconds), for the 24 h rule. */
  readonly collectFailuresSince: number | null;
  /** Consecutive other errors (RPC, unknown failures): retry ×5 then case. */
  readonly keeperErrors: number;
  /** A `collect` was sent whose forwarded outcome has not been seen yet: never send another meanwhile. */
  readonly pendingTxHash: string | null;
  readonly pendingSince: number | null;
  /** The invoice the keeper is collecting (the next `collected` pays it). */
  readonly collectingInvoiceId: string | null;
  readonly lastAttemptAt: number | null;
}

export const NO_KEEPER: KeeperState = {
  collectFailures: 0,
  collectFailuresSince: null,
  keeperErrors: 0,
  pendingTxHash: null,
  pendingSince: null,
  collectingInvoiceId: null,
  lastAttemptAt: null,
};

export interface Mandate extends Scope {
  readonly id: string;
  readonly subscriptionId: string;
  readonly customerId: string;
  readonly vaultContract: string;
  readonly onchainId: number;
  readonly payer: string;
  readonly token: string;
  readonly amountPerPeriod: bigint;
  readonly periodSecs: number;
  /** Vault `start_at` in nanoseconds. */
  readonly startAtNs: bigint;
  readonly maxPeriods: number | null;
  readonly collectedPeriods: number;
  readonly balance: bigint;
  readonly withdrawn: bigint;
  readonly merchantReceiver: string;
  readonly receiverKind: ReceiverKind;
  readonly feeBps: number;
  readonly extRef: string;
  readonly settlementDestinationId: string | null;
  readonly linkStatus: LinkStatus;
  readonly unlinkedReason: UnlinkedReason | null;
  readonly status: MandateStatus;
  /** `collecting` turned false for good (subscription ended or left `auto_debit`, §14 d7). */
  readonly releasedAt: number | null;
  readonly keeper: KeeperState;
  readonly canceled: { readonly by: string; readonly refunded: bigint; readonly at: number } | null;
  readonly lastCollection: Collection | null;
  readonly lastEventHeight: number | null;
  readonly created: number;
  readonly updated: number;
  readonly version: number;
}

export const NS_PER_S = 1_000_000_000n;
export const nsToUnix = (ns: bigint): number => Number(ns / NS_PER_S);
export const unixToNs = (s: number): bigint => BigInt(s) * NS_PER_S;

/** On-chain `Active` (public `active` or `insufficient`). */
export const onchainActive = (m: Pick<Mandate, "status">): boolean =>
  m.status === "active" || m.status === "insufficient";

/** Public status of an on-chain active mandate: `insufficient` when the balance is below one period. */
export function liveStatus(balance: bigint, amountPerPeriod: bigint): "active" | "insufficient" {
  return balance >= amountPerPeriod ? "active" : "insufficient";
}

/** Billing's keeper collects renewals from it: linked, on-chain active and not released (spec `collecting`). */
export const isCollecting = (m: Pick<Mandate, "linkStatus" | "releasedAt" | "status">): boolean =>
  m.linkStatus === "linked" && m.releasedAt === null && onchainActive(m);

/** `floor(balance / amount_per_period)`. */
export const fundedPeriods = (m: Pick<Mandate, "balance" | "amountPerPeriod">): number =>
  Number(m.balance / m.amountPerPeriod);

/** The expected merchant share of one period (contracts-vault §3, `vaultSplit`). */
export const expectedShare = (m: Pick<Mandate, "amountPerPeriod" | "feeBps">): bigint =>
  vaultSplit(m.amountPerPeriod, m.feeBps).merchantShare;

/** Next due time from the mirror (unix seconds): period n+1 at `start_at + n × period`; null when none. */
export function nextCollectAt(m: Mandate): number | null {
  if (!onchainActive(m)) return null;
  if (m.maxPeriods !== null && m.collectedPeriods >= m.maxPeriods) return null;
  return nsToUnix(m.startAtNs) + m.collectedPeriods * m.periodSecs;
}

/** Who canceled, by role. */
export const canceledByRole = (m: Mandate, by: string): "payer" | "merchant_receiver" =>
  by === m.payer ? "payer" : "merchant_receiver";

// ---------------------------------------------------------------------------------------------
// Vault events → mirror (pure; the app layer dedupes and persists)
// ---------------------------------------------------------------------------------------------

/** `mandate_created` data (spec `VaultMandateCreatedData`, numbers decoded). */
export interface CreatedData {
  readonly onchainId: number;
  readonly payer: string;
  readonly merchantReceiver: string;
  readonly token: string;
  readonly amountPerPeriod: bigint;
  readonly periodSecs: number;
  readonly startAtNs: bigint;
  readonly maxPeriods: number | null;
  readonly feeBps: number;
  readonly extRef: string;
  readonly receiverKind: ReceiverKind;
  readonly balance: bigint;
}

export interface EventMeta {
  readonly vaultContract: string;
  readonly livemode: boolean;
  readonly blockHeight: number;
  /** Block time, unix seconds. */
  readonly blockTime: number;
  readonly txHash: string;
  readonly receiptId: string;
}

export type LinkDecision =
  | { readonly linked: true; readonly settlementDestinationId: string }
  | { readonly linked: false; readonly reason: UnlinkedReason };

/** A new mirror row from `mandate_created` with its linkage decision. */
export function fromCreated(
  o: {
    readonly id: string;
    readonly accountId: string;
    readonly subscriptionId: string;
    readonly customerId: string;
    readonly link: LinkDecision;
    readonly now: number;
  },
  d: CreatedData,
  meta: EventMeta,
): Mandate {
  return {
    id: o.id,
    accountId: o.accountId,
    livemode: meta.livemode,
    subscriptionId: o.subscriptionId,
    customerId: o.customerId,
    vaultContract: meta.vaultContract,
    onchainId: d.onchainId,
    payer: d.payer,
    token: d.token,
    amountPerPeriod: d.amountPerPeriod,
    periodSecs: d.periodSecs,
    startAtNs: d.startAtNs,
    maxPeriods: d.maxPeriods,
    collectedPeriods: 0,
    balance: d.balance,
    withdrawn: 0n,
    merchantReceiver: d.merchantReceiver,
    receiverKind: d.receiverKind,
    feeBps: d.feeBps,
    extRef: d.extRef,
    settlementDestinationId: o.link.linked ? o.link.settlementDestinationId : null,
    linkStatus: o.link.linked ? "linked" : "unlinked",
    unlinkedReason: o.link.linked ? null : o.link.reason,
    status: liveStatus(d.balance, d.amountPerPeriod),
    releasedAt: null,
    keeper: NO_KEEPER,
    canceled: null,
    lastCollection: null,
    lastEventHeight: meta.blockHeight,
    created: meta.blockTime,
    updated: o.now,
    version: 0,
  };
}

const fresh = (m: Mandate, height: number): boolean => m.lastEventHeight === null || height >= m.lastEventHeight;
const height = (m: Mandate, h: number): number => Math.max(m.lastEventHeight ?? 0, h);

function withBalance(m: Mandate, balance: bigint): Mandate {
  return { ...m, balance, status: onchainActive(m) ? liveStatus(balance, m.amountPerPeriod) : m.status };
}

/** `topped_up {amount, balance}`. */
export function applyToppedUp(m: Mandate, balanceAfter: bigint, meta: EventMeta, now: number): Mandate {
  const next = fresh(m, meta.blockHeight) ? withBalance(m, balanceAfter) : m;
  return { ...next, lastEventHeight: height(m, meta.blockHeight), updated: now };
}

/** `collected {period, amount, merchant_share, fee, balance}`: counts the period, resets the failure streak. */
export function applyCollected(m: Mandate, c: Collection, balanceAfter: bigint, meta: EventMeta, now: number): Mandate {
  const base = fresh(m, meta.blockHeight) ? withBalance(m, balanceAfter) : m;
  const last = m.lastCollection;
  const newer = last === null || c.period > last.period || (c.period === last.period && fresh(m, meta.blockHeight));
  return {
    ...base,
    collectedPeriods: Math.max(m.collectedPeriods, c.period),
    lastCollection: newer ? c : m.lastCollection,
    keeper: {
      ...m.keeper,
      collectFailures: 0,
      collectFailuresSince: null,
      keeperErrors: 0,
      pendingTxHash: null,
      pendingSince: null,
      collectingInvoiceId: null,
    },
    lastEventHeight: height(m, meta.blockHeight),
    updated: now,
  };
}

/** `collect_failed`: the merchant leg delivered nothing; the period was credited back (§7.1). */
export function applyCollectFailed(m: Mandate, meta: EventMeta, now: number): Mandate {
  return {
    ...m,
    keeper: {
      ...m.keeper,
      collectFailures: m.keeper.collectFailures + 1,
      collectFailuresSince: m.keeper.collectFailuresSince ?? now,
      pendingTxHash: null,
      pendingSince: null,
    },
    lastEventHeight: height(m, meta.blockHeight),
    updated: now,
  };
}

/** `canceled {by, refunded}` (final; `refunded = "0"` when the refund failed and the balance stayed). */
export function applyCanceled(m: Mandate, by: string, refunded: bigint, meta: EventMeta, now: number): Mandate {
  const balance = m.balance > refunded ? m.balance - refunded : 0n;
  return {
    ...m,
    status: m.status === "exhausted" ? m.status : "canceled",
    balance,
    canceled: { by, refunded, at: meta.blockTime },
    lastEventHeight: height(m, meta.blockHeight),
    updated: now,
  };
}

/** `withdrawn {amount}` after cancel/exhaustion. */
export function applyWithdrawn(m: Mandate, amount: bigint, meta: EventMeta, now: number): Mandate {
  return {
    ...m,
    balance: m.balance > amount ? m.balance - amount : 0n,
    withdrawn: m.withdrawn + amount,
    lastEventHeight: height(m, meta.blockHeight),
    updated: now,
  };
}

/** `exhausted`: `max_periods` collected (final). */
export function applyExhausted(m: Mandate, meta: EventMeta, now: number): Mandate {
  return {
    ...m,
    status: m.status === "canceled" ? m.status : "exhausted",
    lastEventHeight: height(m, meta.blockHeight),
    updated: now,
  };
}

/** Collection stops for good (subscription ended or left `auto_debit`); null when it already did. */
export function release(m: Mandate, now: number): Mandate | null {
  if (m.linkStatus !== "linked" || m.releasedAt !== null) return null;
  return { ...m, releasedAt: now, keeper: { ...m.keeper, collectingInvoiceId: null }, updated: now };
}
