/**
 * Subscriptions with `collection_method: send_invoice` (domain-model §4.5, lld/billing.md §4, §7, §11 d8–d9).
 *
 * Periods: boundary `n` = `periodBoundary(anchor, interval, count, n)` (spec, UTC, calendar months clamped,
 * never chained). The anchor is the creation time, or `trial_end` with a trial (the trial is the span before
 * boundary 0). `nextPeriodIndex` is the `n` whose period the next renewal invoices; each period is invoiced
 * in advance at its start, idempotently per (subscription, period start).
 *
 * Renewal after a pause (`incomplete`/`unpaid` create no invoices) resumes with the period that contains
 * "now": periods that ended while nothing was invoiced are skipped, never billed in arrears (LLD v1.3 §11 d9).
 * Pure.
 */
import { DEFAULT_REMINDER_DAYS, periodBoundary } from "@nearpay/spec";
import { checkReminderDays } from "../invoice/invoice.js";
import type { LineDraft, Period } from "../invoice/lines.js";
import {
  type Interval,
  type Price,
  type Recurring,
  recurringLabel,
  sameRecurring,
  usablePrice,
} from "../price/price.js";
import type { Product } from "../product/product.js";
import {
  DAY,
  DomainError,
  type Metadata,
  mergeMetadata,
  type Pricing,
  pricingLabel,
  type Scope,
  samePricing,
  stateConflict,
} from "../shared.js";
import { resolveTaxRates, type TaxRate } from "../tax-rate/tax-rate.js";

export type SubscriptionStatus = "incomplete" | "trialing" | "active" | "past_due" | "canceled" | "unpaid";
export type CancellationReason = "requested" | "dunning_exhausted" | "incomplete_expired";

export const SUBSCRIPTION_TRANSITIONS: Readonly<Record<SubscriptionStatus, readonly SubscriptionStatus[]>> = {
  incomplete: ["active", "canceled"],
  trialing: ["active", "canceled"],
  active: ["past_due", "canceled"],
  past_due: ["active", "canceled", "unpaid"],
  unpaid: ["active", "canceled"],
  canceled: [],
};

export const canTransition = (from: SubscriptionStatus, to: SubscriptionStatus): boolean =>
  SUBSCRIPTION_TRANSITIONS[from].includes(to);

export const DEFAULT_SUB_DAYS_UNTIL_DUE = 7;
export const RENEWAL_UPCOMING_SECONDS = 3 * DAY;
export const MAX_ITEMS = 20;

export interface SubscriptionItem {
  readonly id: string;
  readonly priceId: string;
  readonly quantity: number;
  /** null = the subscription's `defaultTaxRateIds`. */
  readonly taxRateIds: readonly string[] | null;
}

export interface Dunning {
  readonly reminderDays: readonly number[];
  readonly onExhausted: "cancel" | "unpaid";
}

/** `send_invoice` (emailed invoices) or `auto_debit` (vault mandate, lld/billing.md v1.7 §14 d6). */
export type SubscriptionCollectionMethod = "send_invoice" | "auto_debit";

export interface Subscription extends Scope, Pricing {
  readonly id: string;
  readonly customerId: string;
  readonly status: SubscriptionStatus;
  readonly collectionMethod: SubscriptionCollectionMethod;
  /** The linked mandate renewals are collected from (null when none, Stage 4). */
  readonly mandateId: string | null;
  readonly items: readonly SubscriptionItem[];
  readonly recurring: Recurring;
  readonly anchor: number;
  readonly nextPeriodIndex: number;
  readonly currentPeriodStart: number;
  readonly currentPeriodEnd: number;
  readonly daysUntilDue: number;
  readonly defaultTaxRateIds: readonly string[];
  readonly dunning: Dunning;
  readonly trialStart: number | null;
  readonly trialEnd: number | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly canceledAt: number | null;
  readonly endedAt: number | null;
  readonly cancellationReason: CancellationReason | null;
  readonly latestInvoiceId: string | null;
  readonly settlementDestinationId: string | null;
  readonly description: string | null;
  readonly metadata: Metadata;
  readonly created: number;
  readonly updated: number;
  readonly version: number;
  /**
   * Test-mode billing clock offset in seconds (clock = now + offset; 0/absent in live mode, forward-only).
   * Every date of the subscription and its invoices is on this clock (lld/billing.md §13).
   */
  readonly clockOffset?: number | undefined;
}

export const boundary = (s: Pick<Subscription, "anchor" | "recurring">, n: number): number =>
  periodBoundary(s.anchor, s.recurring.interval, s.recurring.intervalCount, n);

export const periodOf = (s: Pick<Subscription, "anchor" | "recurring">, n: number): Period => ({
  start: boundary(s, n),
  end: boundary(s, n + 1),
});

/** Smallest `n ≥ from` whose period has not ended by `now` (`end > now`). */
export function firstOpenPeriod(s: Pick<Subscription, "anchor" | "recurring">, from: number, now: number): number {
  // start from a lower bound (a period is at most 31 days per month, exact for day/week), then step
  const { interval, intervalCount } = s.recurring;
  const longest =
    interval === "day" ? DAY : interval === "week" ? 7 * DAY : interval === "month" ? 31 * DAY : 366 * DAY;
  let n = Math.max(from, Math.floor((now - s.anchor) / (longest * intervalCount)) - 1);
  while (boundary(s, n + 1) <= now) n += 1;
  return n;
}

// ---------------------------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------------------------

export interface ItemInput {
  readonly priceId: string;
  readonly quantity?: number | undefined;
  readonly taxRateIds?: readonly string[] | undefined;
}

export interface CatalogView {
  readonly prices: ReadonlyMap<string, Price>;
  readonly products: ReadonlyMap<string, Product>;
  readonly taxRates: ReadonlyMap<string, TaxRate>;
}

/**
 * Items (1–20) of active recurring prices sharing one currency (`currency_mismatch`) and one period
 * (`interval_mismatch`); `fixed` pins both (updates cannot change the period or currency).
 */
export function resolveItems(
  inputs: readonly ItemInput[],
  o: {
    readonly scope: Scope;
    readonly catalog: CatalogView;
    readonly newId: () => string;
    readonly fixed?: { readonly pricing: Pricing; readonly recurring: Recurring } | undefined;
  },
): { items: SubscriptionItem[]; pricing: Pricing; recurring: Recurring } {
  if (inputs.length < 1 || inputs.length > MAX_ITEMS)
    throw new DomainError("invalid_request", { detail: `1–${MAX_ITEMS} items` }, "items");
  let pricing: Pricing | null = o.fixed?.pricing ?? null;
  let recurring: Recurring | null = o.fixed?.recurring ?? null;
  const items = inputs.map((it, i): SubscriptionItem => {
    const param = `items[${i}][price]`;
    const raw = o.catalog.prices.get(it.priceId);
    const price = usablePrice(
      {
        id: it.priceId,
        price: raw,
        product: raw ? o.catalog.products.get(raw.productId) : undefined,
        scope: o.scope,
        type: "recurring",
        object: "subscription",
        pricing,
      },
      param,
    );
    if (recurring && !sameRecurring(price.recurring, recurring))
      throw new DomainError(
        "interval_mismatch",
        { price: price.id, interval: recurringLabel(price.recurring), expected: recurringLabel(recurring) },
        param,
      );
    pricing ??= { currency: price.currency, assetId: price.assetId };
    recurring ??= price.recurring as Recurring;
    const quantity = it.quantity ?? 1;
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 1_000_000)
      throw new DomainError("invalid_request", { detail: "quantity must be 1–1000000" }, `items[${i}][quantity]`);
    if (it.taxRateIds) resolveTaxRates(it.taxRateIds, o.catalog.taxRates, o.scope, `items[${i}][tax_rates]`);
    return { id: o.newId(), priceId: price.id, quantity, taxRateIds: it.taxRateIds ?? null };
  });
  return { items, pricing: pricing as Pricing, recurring: recurring as Recurring };
}

// ---------------------------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------------------------

export interface SubscriptionCreate {
  readonly customerId: string;
  readonly collectionMethod?: SubscriptionCollectionMethod | undefined;
  readonly items: readonly SubscriptionItem[];
  readonly pricing: Pricing;
  readonly recurring: Recurring;
  readonly daysUntilDue?: number | undefined;
  readonly trialPeriodDays?: number | undefined;
  readonly defaultTaxRateIds?: readonly string[] | undefined;
  readonly dunning?:
    | { readonly reminderDays?: readonly number[] | undefined; readonly onExhausted?: "cancel" | "unpaid" | undefined }
    | undefined;
  readonly description?: string | undefined;
  readonly settlementDestinationId?: string | undefined;
  readonly metadata?: Metadata | undefined;
}

/**
 * A new subscription. Without a trial it is `incomplete` with period 0 = [now, boundary 1) current (its
 * first invoice is created at once, `nextPeriodIndex` 1). With `trial_period_days` it is `trialing`
 * until `trial_end` (= the anchor; the first invoice follows then, `nextPeriodIndex` 0).
 */
export function newSubscription(scope: Scope, id: string, now: number, input: SubscriptionCreate): Subscription {
  const days = input.daysUntilDue ?? DEFAULT_SUB_DAYS_UNTIL_DUE;
  if (!Number.isInteger(days) || days < 0 || days > 90)
    throw new DomainError("invalid_request", { detail: "days_until_due must be 0–90" }, "days_until_due");
  const trial = input.trialPeriodDays;
  if (trial !== undefined && (!Number.isInteger(trial) || trial < 1 || trial > 730))
    throw new DomainError("invalid_request", { detail: "trial_period_days must be 1–730" }, "trial_period_days");
  const base = {
    ...scope,
    id,
    customerId: input.customerId,
    collectionMethod: input.collectionMethod ?? "send_invoice",
    mandateId: null,
    items: input.items,
    currency: input.pricing.currency,
    assetId: input.pricing.assetId,
    recurring: input.recurring,
    daysUntilDue: days,
    defaultTaxRateIds: input.defaultTaxRateIds ?? [],
    dunning: {
      reminderDays: checkReminderDays(input.dunning?.reminderDays ?? DEFAULT_REMINDER_DAYS, "dunning[reminder_days]"),
      onExhausted: input.dunning?.onExhausted ?? "cancel",
    },
    cancelAtPeriodEnd: false,
    canceledAt: null,
    endedAt: null,
    cancellationReason: null,
    latestInvoiceId: null,
    settlementDestinationId: input.settlementDestinationId ?? null,
    description: input.description ?? null,
    metadata: input.metadata ?? {},
    created: now,
    updated: now,
    version: 0,
    clockOffset: 0,
  } as const;
  if (trial !== undefined) {
    const trialEnd = now + trial * DAY;
    return {
      ...base,
      status: "trialing",
      anchor: trialEnd,
      nextPeriodIndex: 0,
      currentPeriodStart: now,
      currentPeriodEnd: trialEnd,
      trialStart: now,
      trialEnd,
    };
  }
  const p = periodOf({ anchor: now, recurring: input.recurring }, 0);
  return {
    ...base,
    status: "incomplete",
    anchor: now,
    nextPeriodIndex: 1,
    currentPeriodStart: p.start,
    currentPeriodEnd: p.end,
    trialStart: null,
    trialEnd: null,
  };
}

function moveTo(s: Subscription, to: SubscriptionStatus, now: number): Subscription {
  if (!canTransition(s.status, to)) throw stateConflict("subscription", s.status);
  return { ...s, status: to, updated: now };
}

/** Records the first invoice of a new subscription (created and finalized in the same transaction). */
export const withLatestInvoice = (s: Subscription, invoiceId: string, now: number): Subscription => ({
  ...s,
  latestInvoiceId: invoiceId,
  updated: now,
});

export type RenewalDecision =
  /** Not due yet (stale or early job). */
  | { readonly kind: "wait"; readonly at: number }
  /** Nothing to do (canceled; or paused: `incomplete`/`unpaid` create no invoices). */
  | { readonly kind: "none"; readonly reason: string }
  /** `cancel_at_period_end`: the subscription ends at `current_period_end` without an invoice. */
  | { readonly kind: "end"; readonly subscription: Subscription }
  /** Invoice `period` (index `n`, reason) and advance; `subscription` is the advanced state. */
  | {
      readonly kind: "invoice";
      readonly n: number;
      readonly period: Period;
      readonly billingReason: "subscription_create" | "subscription_cycle";
      readonly subscription: Subscription;
    };

/**
 * The renewal at `current_period_end` (job `subscription.renew`): the period to invoice is
 * `nextPeriodIndex`, skipped forward to the one containing `now` (no billing in arrears). The trial end
 * issues the first invoice and makes the subscription `active` (domain-model §4.5).
 */
export function renew(s: Subscription, now: number): RenewalDecision {
  if (s.status === "canceled") return { kind: "none", reason: "canceled" };
  if (now < s.currentPeriodEnd) return { kind: "wait", at: s.currentPeriodEnd };
  if (s.cancelAtPeriodEnd) {
    return {
      kind: "end",
      subscription: {
        ...moveTo(s, "canceled", now),
        endedAt: s.currentPeriodEnd,
        cancellationReason: s.cancellationReason ?? "requested",
        canceledAt: s.canceledAt ?? now,
      },
    };
  }
  if (s.status === "incomplete" || s.status === "unpaid") return { kind: "none", reason: `paused while ${s.status}` };
  const n = firstOpenPeriod(s, s.nextPeriodIndex, now);
  const period = periodOf(s, n);
  const trialEnded = s.status === "trialing";
  const next: Subscription = {
    ...(trialEnded ? moveTo(s, "active", now) : s),
    nextPeriodIndex: n + 1,
    currentPeriodStart: period.start,
    currentPeriodEnd: period.end,
    updated: now,
  };
  return {
    kind: "invoice",
    n,
    period,
    billingReason: trialEnded || s.latestInvoiceId === null ? "subscription_create" : "subscription_cycle",
    subscription: next,
  };
}

/** The subscription's linked mandate changed (linked on `mandate_created`, cleared on release). */
export const withMandate = (s: Subscription, mandateId: string | null, now: number): Subscription => ({
  ...s,
  mandateId,
  updated: now,
});

/** The subscription ended for good: a linked mandate is released (§14 d7). */
export const hasEnded = (s: Pick<Subscription, "status">): boolean => s.status === "canceled";

/** `renewal_upcoming` fires 3 days before the period end for subscriptions that will renew. */
export function renewalUpcomingAt(s: Subscription): number {
  return s.currentPeriodEnd - RENEWAL_UPCOMING_SECONDS;
}

export function renewalUpcomingApplies(s: Subscription, periodEnd: number): boolean {
  return (
    s.currentPeriodEnd === periodEnd &&
    !s.cancelAtPeriodEnd &&
    (s.status === "active" || s.status === "past_due" || s.status === "trialing")
  );
}

/** Targets of the test-mode billing clock helper (spec `SubscriptionClockTarget`, lld/billing.md §13). */
export type ClockTarget = "renewal_upcoming" | "renewal" | "overdue";

/** The subscription's billing clock: real time + its (test-mode only) offset. */
export const clockOf = (s: { readonly clockOffset?: number | undefined }, now: number): number =>
  now + (s.clockOffset ?? 0);

/**
 * Clock time of `target` (§13 d3): `renewal_upcoming` = `current_period_end − 3 d`, `renewal` =
 * `current_period_end` (= `trial_end` while trialing) — both only for `trialing`/`active`/`past_due`;
 * `overdue` = the earliest of `openDueDates` (due dates of the subscription's open invoices) after
 * `clock`. Null when there is none strictly ahead of `clock` (the caller answers `state_conflict`).
 */
export function clockTargetTime(
  s: Subscription,
  target: ClockTarget,
  clock: number,
  openDueDates: readonly number[],
): number | null {
  let at: number | null;
  if (target === "overdue") {
    const ahead = openDueDates.filter((d) => d > clock);
    at = ahead.length ? Math.min(...ahead) : null;
  } else if (s.status === "trialing" || s.status === "active" || s.status === "past_due") {
    at = target === "renewal" ? s.currentPeriodEnd : renewalUpcomingAt(s);
  } else at = null;
  return at !== null && at > clock ? at : null;
}

/** A subscription invoice became overdue: `active → past_due` (others unchanged). */
export function onInvoiceOverdue(s: Subscription, now: number): Subscription | null {
  return s.status === "active" ? moveTo(s, "past_due", now) : null;
}

/**
 * A subscription invoice was paid: `incomplete → active` (first invoice), `past_due → active` when no other
 * overdue invoice remains, `unpaid → active` when it was the latest invoice. Returns null when unchanged.
 */
export function onInvoicePaid(
  s: Subscription,
  o: { readonly invoiceId: string; readonly otherOverdueOpen: number },
  now: number,
): Subscription | null {
  if (s.status === "incomplete" && s.latestInvoiceId === o.invoiceId) return moveTo(s, "active", now);
  if (s.status === "past_due" && o.otherOverdueOpen === 0) return moveTo(s, "active", now);
  if (s.status === "unpaid" && s.latestInvoiceId === o.invoiceId) return moveTo(s, "active", now);
  return null;
}

/** Dunning exhausted (from `../dunning/dunning.ts` `exhaust`). `active` passes through `past_due`. */
export function onDunningExhausted(
  s: Subscription,
  effect: { readonly to: "canceled"; readonly reason: CancellationReason } | { readonly to: "unpaid" },
  now: number,
): Subscription[] {
  const steps: Subscription[] = [];
  let cur = s;
  if (cur.status === "active") {
    cur = moveTo(cur, "past_due", now);
    steps.push(cur);
  }
  if (effect.to === "unpaid") {
    if (cur.status === "unpaid") return steps;
    steps.push(moveTo(cur, "unpaid", now));
    return steps;
  }
  steps.push({ ...moveTo(cur, "canceled", now), canceledAt: now, endedAt: now, cancellationReason: effect.reason });
  return steps;
}

/** `cancel`: now (`canceled`, `subscription.deleted`) or at period end (`subscription.updated`). */
export function cancel(s: Subscription, now: number, atPeriodEnd: boolean): Subscription {
  if (s.status === "canceled") throw stateConflict("subscription", s.status);
  if (atPeriodEnd)
    return { ...s, cancelAtPeriodEnd: true, canceledAt: now, cancellationReason: "requested", updated: now };
  return { ...moveTo(s, "canceled", now), canceledAt: now, endedAt: now, cancellationReason: "requested" };
}

export interface SubscriptionPatch {
  readonly items?: readonly SubscriptionItem[] | undefined;
  readonly collectionMethod?: SubscriptionCollectionMethod | undefined;
  readonly daysUntilDue?: number | undefined;
  readonly defaultTaxRateIds?: readonly string[] | undefined;
  readonly dunning?:
    | { readonly reminderDays?: readonly number[] | undefined; readonly onExhausted?: "cancel" | "unpaid" | undefined }
    | undefined;
  readonly cancelAtPeriodEnd?: boolean | undefined;
  readonly description?: string | null | undefined;
  readonly settlementDestinationId?: string | null | undefined;
  readonly metadata?: Metadata | undefined;
}

/** `updateSubscription`: applies from the next renewal; never prorates; `canceled` is `state_conflict`. */
export function patchSubscription(s: Subscription, patch: SubscriptionPatch, now: number): Subscription {
  if (s.status === "canceled") throw stateConflict("subscription", s.status);
  if (
    patch.daysUntilDue !== undefined &&
    (!Number.isInteger(patch.daysUntilDue) || patch.daysUntilDue < 0 || patch.daysUntilDue > 90)
  )
    throw new DomainError("invalid_request", { detail: "days_until_due must be 0–90" }, "days_until_due");
  const cancelFields =
    patch.cancelAtPeriodEnd === undefined
      ? {}
      : patch.cancelAtPeriodEnd
        ? { cancelAtPeriodEnd: true, canceledAt: s.canceledAt ?? now, cancellationReason: "requested" as const }
        : { cancelAtPeriodEnd: false, canceledAt: null, cancellationReason: null };
  return {
    ...s,
    ...(patch.items !== undefined ? { items: patch.items } : {}),
    ...(patch.collectionMethod !== undefined
      ? {
          collectionMethod: patch.collectionMethod,
          // leaving auto_debit unlinks the mandate (the app releases it, §14 d6–d7)
          ...(patch.collectionMethod === "send_invoice" ? { mandateId: null } : {}),
        }
      : {}),
    ...(patch.daysUntilDue !== undefined ? { daysUntilDue: patch.daysUntilDue } : {}),
    ...(patch.defaultTaxRateIds !== undefined ? { defaultTaxRateIds: patch.defaultTaxRateIds } : {}),
    ...(patch.dunning !== undefined
      ? {
          dunning: {
            reminderDays:
              patch.dunning.reminderDays !== undefined
                ? checkReminderDays(patch.dunning.reminderDays, "dunning[reminder_days]")
                : s.dunning.reminderDays,
            onExhausted: patch.dunning.onExhausted ?? s.dunning.onExhausted,
          },
        }
      : {}),
    ...cancelFields,
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.settlementDestinationId !== undefined ? { settlementDestinationId: patch.settlementDestinationId } : {}),
    metadata: mergeMetadata(s.metadata, patch.metadata),
    updated: now,
  };
}

/**
 * The lines of the invoice for `period` from the current items: product name, current unit amount, the
 * item's tax rates (or the subscription defaults, applied as the invoice's `default_tax_rates`). Prices
 * deactivated after the subscription was created keep billing (only new subscriptions need active prices).
 */
export function periodLines(s: Subscription, period: Period, catalog: CatalogView, newId: () => string): LineDraft[] {
  return s.items.map((it, i) => {
    const price = catalog.prices.get(it.priceId);
    if (!price || !samePricing(price, s))
      throw new DomainError(
        "currency_mismatch",
        {
          price: it.priceId,
          currency: price ? pricingLabel(price) : "unknown",
          object: "subscription",
          expected: pricingLabel(s),
        },
        `items[${i}][price]`,
      );
    return {
      id: newId(),
      type: "subscription",
      priceId: price.id,
      productId: price.productId,
      subscriptionItemId: it.id,
      description: catalog.products.get(price.productId)?.name ?? price.id,
      quantity: it.quantity,
      unitAmount: price.unitAmount,
      taxRateIds: it.taxRateIds ?? [],
      taxRatesExplicit: it.taxRateIds !== null,
      period,
    };
  });
}

export type { Interval };
