/**
 * Prepared mandate terms and the linkage rule (lld/billing.md v1.7 §6, §14 d2–d4; AI vault audits
 * A1-L-2 / A2-M-6). `prepareMandate` computes the terms the payer signs; when the vault's `mandate_created`
 * arrives, the same computation at that moment decides whether the mandate is linked to the subscription
 * its `ext_ref` names — every term must match, otherwise it is recorded `unlinked` with the first failing
 * reason (the contract cannot refuse payer-signed terms; a payer-edited `fee_bps` must never bypass the
 * fee). Pure.
 */
import { VAULT_LIMITS, vaultPeriodSecs, vaultSplit } from "@nearpay/spec";
import type { Interval } from "../price/price.js";
import { DomainError, type Pricing } from "../shared.js";
import type { Subscription } from "../subscription/subscription.js";
import { type CreatedData, type LinkDecision, NS_PER_S, type UnlinkedReason, unixToNs } from "./mandate.js";

/** The NEAR Intents asset id of a NEP-141 token. */
export const tokenAssetId = (token: string): string => `nep141:${token}`;

/** The token of a `nep141:<token>` asset id; null for other asset ids. */
export function tokenOfAsset(assetId: string | null): string | null {
  return assetId?.startsWith("nep141:") ? assetId.slice("nep141:".length) : null;
}

/** Fiat minor-unit exponent of USD (cents). */
const USD_EXPONENT = 2;

/**
 * Pricing units → token base units (§14 d2): USD at par in a USD stablecoin (`cents × 10^(decimals − 2)`),
 * asset pricing 1:1. Null when the pricing cannot be paid with this token.
 */
export function toTokenUnits(amount: bigint, pricing: Pricing, token: string, decimals: number): bigint | null {
  if (pricing.currency === "usd") {
    if (!Number.isInteger(decimals) || decimals < USD_EXPONENT) return null;
    return amount * 10n ** BigInt(decimals - USD_EXPONENT);
  }
  if (pricing.currency === "asset") return tokenOfAsset(pricing.assetId) === token ? amount : null;
  return null;
}

/** Token base units → pricing units, rounded up (a shortfall is never under-billed). */
export function fromTokenUnitsCeil(units: bigint, pricing: Pricing, decimals: number): bigint {
  if (pricing.currency === "asset") return units;
  const d = 10n ** BigInt(decimals - USD_EXPONENT);
  return (units + d - 1n) / d;
}

/** Vault-compatible pricing, without RPC: USD (configured USD stablecoins) or an asset that is an allowed token. */
export function vaultPricingProblem(pricing: Pricing, usdTokens: readonly string[], vaultTokens: readonly string[]) {
  if (pricing.currency === "usd") return usdTokens.length ? null : "usd has no vault token configured";
  if (pricing.currency === "asset") {
    const t = tokenOfAsset(pricing.assetId);
    return t && vaultTokens.includes(t) ? null : `${pricing.assetId} is not an allowed vault token`;
  }
  return `${pricing.currency} pricing has no vault token (use usd or an allowed token)`;
}

export interface DestinationFacts {
  readonly id: string;
  readonly assetId: string;
  readonly type: string;
  /** Receiving address; for `intents_account` the merchant's NEAR Intents account id. */
  readonly address: string;
}

export interface TermsInput {
  readonly subscription: Subscription;
  /** The next renewal invoice's total with current items and tax rates (pricing units, §14 d2). */
  readonly perPeriodTotal: bigint;
  /** Requested token, if any (prepare `token`; the event's token for linkage). */
  readonly token: string | undefined;
  readonly tokenDecimals: (token: string) => number | undefined;
  /** USD stablecoins accepted at par, in preference order (default first). */
  readonly usdTokens: readonly string[];
  /** The vault's `allowed_tokens` (`get_config`; the configured list for linkage). */
  readonly allowedTokens: readonly string[];
  readonly maxFeeBps: number;
  /** The account's agreed NearPay fee for vault collections (ADR-0006). */
  readonly feeBps: number;
  readonly destinations: readonly DestinationFacts[];
  readonly defaults: Readonly<Record<string, string>>;
  /** The subscription's latest invoice is open (payable): the first collection pays it (`start_at` = now). */
  readonly latestInvoicePayable: boolean;
  /** Real time, unix seconds. */
  readonly now: number;
}

export interface Terms {
  readonly token: string;
  readonly assetId: string;
  readonly amountPerPeriod: bigint;
  readonly periodSecs: number;
  readonly feeBps: number;
  readonly merchantReceiver: string;
  readonly receiverKind: "intents_account";
  readonly settlementDestinationId: string;
  readonly extRef: string;
  /** ns; null = the block time. */
  readonly startAtNs: bigint | null;
  readonly maxPeriods: null;
}

/** Which term could not be prepared (the linkage rule maps it to an unlinked reason). */
export type TermsProblem = "state" | "token" | "amount" | "fee" | "period" | "destination" | "start";

export type TermsResult =
  | { readonly ok: true; readonly terms: Terms }
  | { readonly ok: false; readonly problem: TermsProblem; readonly error: DomainError };

/** The active `intents_account` destination for `assetId` the mandate pays into (§14 d4). */
export function receiverDestination(
  s: Pick<Subscription, "settlementDestinationId">,
  assetId: string,
  destinations: readonly DestinationFacts[],
  defaults: Readonly<Record<string, string>>,
): DestinationFacts | null {
  const ok = (id: string | null | undefined) => {
    const d = id ? destinations.find((x) => x.id === id) : undefined;
    return d && d.type === "intents_account" && d.assetId === assetId ? d : null;
  };
  return ok(s.settlementDestinationId) ?? ok(defaults[assetId]) ?? ok(defaults["*"]);
}

/**
 * The terms `prepareMandate` writes (§14 d4), or the first term that cannot be prepared:
 * `auto_debit_unavailable` (pricing, token, fee, period, start), `destination_not_intents_account`, or
 * `state_conflict` (not `auto_debit`, or canceled). RPC-dependent caps are checked by the caller.
 */
export function prepareTerms(i: TermsInput): TermsResult {
  const s = i.subscription;
  const fail = (problem: TermsProblem, error: DomainError): TermsResult => ({ ok: false, problem, error });
  const unavailable = (problem: TermsProblem, reason: string, param?: string) =>
    fail(problem, new DomainError("auto_debit_unavailable", { subscription: s.id, reason }, param));
  if (s.collectionMethod !== "auto_debit")
    return fail("state", new DomainError("state_conflict", { object: "subscription", state: "not auto_debit" }));
  if (s.status === "canceled")
    return fail("state", new DomainError("state_conflict", { object: "subscription", state: s.status }));
  let token: string;
  if (s.currency === "usd") {
    token = i.token ?? i.usdTokens[0] ?? "";
    if (!token || !i.usdTokens.includes(token))
      return unavailable("token", `usd is paid at par in ${i.usdTokens.join(" or ") || "no token"}`, "token");
  } else if (s.currency === "asset") {
    const t = tokenOfAsset(s.assetId);
    if (!t) return unavailable("token", `${s.assetId} is not a NEAR token`);
    if (i.token !== undefined && i.token !== t)
      return unavailable("token", `asset subscriptions are paid in ${t}`, "token");
    token = t;
  } else return unavailable("token", `${s.currency} pricing has no vault token (use usd or an allowed token)`);
  if (!i.allowedTokens.includes(token)) return unavailable("token", `${token} is not an allowed vault token`, "token");
  const decimals = i.tokenDecimals(token);
  if (decimals === undefined) return unavailable("token", `${token} is unknown to the asset registry`, "token");
  const amountPerPeriod = toTokenUnits(i.perPeriodTotal, s, token, decimals);
  if (amountPerPeriod === null || amountPerPeriod <= 0n) return unavailable("amount", "the per-period total is zero");
  if (!Number.isInteger(i.feeBps) || i.feeBps < 0 || i.feeBps > i.maxFeeBps)
    return unavailable("fee", `the fee of ${i.feeBps} bps exceeds the vault's maximum`);
  if (vaultSplit(amountPerPeriod, i.feeBps).merchantShare <= 0n)
    return unavailable("amount", "the merchant share of a period is zero");
  let periodSecs: number;
  try {
    periodSecs = vaultPeriodSecs(s.recurring.interval as Interval, s.recurring.intervalCount);
  } catch {
    return unavailable("period", "the billing period is too long for the vault");
  }
  const assetId = tokenAssetId(token);
  const dest = receiverDestination(s, assetId, i.destinations, i.defaults);
  if (!dest)
    return fail(
      "destination",
      new DomainError(
        "destination_not_intents_account",
        { destination: s.settlementDestinationId ?? "default" },
        "settlement_destination",
      ),
    );
  // `start_at`: the block time while the latest invoice is open (the first collection pays it), else the
  // period end (= trial end while trialing), translated from the subscription's billing clock to real time
  let startAtNs: bigint | null = null;
  if (!i.latestInvoicePayable) {
    const start = s.currentPeriodEnd - (s.clockOffset ?? 0);
    if (start > i.now) {
      if (unixToNs(start) - unixToNs(i.now) > BigInt(VAULT_LIMITS.max_start_delay_ns))
        return unavailable("start", "the next period starts more than 366 days ahead");
      startAtNs = unixToNs(start);
    }
  }
  return {
    ok: true,
    terms: {
      token,
      assetId,
      amountPerPeriod,
      periodSecs,
      feeBps: i.feeBps,
      merchantReceiver: dest.address,
      receiverKind: "intents_account",
      settlementDestinationId: dest.id,
      extRef: s.id,
      startAtNs,
      maxPeriods: null,
    },
  };
}

/** `prepareTerms`, throwing its error. */
export function computeTerms(i: TermsInput): Terms {
  const r = prepareTerms(i);
  if (!r.ok) throw r.error;
  return r.terms;
}

export interface LinkInput extends Omit<TermsInput, "token" | "now"> {
  /** Mode of the vault that emitted the event (INV-8). */
  readonly vaultLivemode: boolean;
  /** Another linked, collecting mandate exists for the subscription. */
  readonly alreadyLinked: boolean;
  readonly now: number;
}

/**
 * The linkage rule at `mandate_created` (§6). Checks in order; the first failure is the reason. `start_at`
 * must not be after the current period end (real time) and `max_periods` must cover the remaining periods
 * (null — subscriptions have no end — unless the subscription ends at its period end).
 */
export function decideLink(d: CreatedData, i: LinkInput): LinkDecision {
  const s = i.subscription;
  const no = (reason: UnlinkedReason): LinkDecision => ({ linked: false, reason });
  if (s.livemode !== i.vaultLivemode) return no("mode_mismatch");
  if (s.collectionMethod !== "auto_debit") return no("subscription_not_auto_debit");
  if (s.status === "canceled") return no("subscription_ended");
  if (i.alreadyLinked) return no("already_linked");
  if (d.receiverKind !== "intents_account") return no("receiver_kind_mismatch");
  const r = prepareTerms({ ...i, token: d.token, latestInvoicePayable: true });
  if (!r.ok) return no(PROBLEM_REASON[r.problem]);
  const t = r.terms;
  if (d.merchantReceiver !== t.merchantReceiver) return no("receiver_not_destination");
  if (d.token !== t.token) return no("token_mismatch");
  if (d.amountPerPeriod !== t.amountPerPeriod) return no("amount_mismatch");
  if (d.periodSecs !== t.periodSecs) return no("period_mismatch");
  if (d.feeBps !== t.feeBps) return no("fee_mismatch");
  const periodEnd = s.currentPeriodEnd - (s.clockOffset ?? 0);
  if (d.startAtNs > BigInt(periodEnd) * NS_PER_S) return no("start_too_late");
  const remaining = s.cancelAtPeriodEnd ? (i.latestInvoicePayable ? 1 : 0) : null;
  if (d.maxPeriods !== null && (remaining === null || d.maxPeriods < remaining)) return no("max_periods_too_low");
  return { linked: true, settlementDestinationId: t.settlementDestinationId };
}

const PROBLEM_REASON: Readonly<Record<TermsProblem, UnlinkedReason>> = {
  state: "subscription_not_auto_debit",
  token: "token_mismatch",
  amount: "amount_mismatch",
  fee: "fee_mismatch",
  period: "period_mismatch",
  destination: "receiver_not_destination",
  start: "start_too_late",
};
