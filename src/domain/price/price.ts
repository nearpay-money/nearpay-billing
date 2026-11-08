/**
 * Prices (lld/billing.md §5, §11): one-time or recurring, fiat (minor units) or asset (base units).
 * Pricing (`unit_amount`, `currency`, `asset_id`, `recurring`) is immutable (INV-6); only `active`,
 * `nickname` and `metadata` change. Pure.
 */
import type { Product } from "../product/product.js";
import {
  DomainError,
  type Metadata,
  mergeMetadata,
  missing,
  type Pricing,
  pricingLabel,
  type Scope,
  samePricing,
} from "../shared.js";

export type Interval = "day" | "week" | "month" | "year";
export const INTERVALS: readonly Interval[] = ["day", "week", "month", "year"];

export interface Recurring {
  readonly interval: Interval;
  readonly intervalCount: number;
}

export type PriceType = "one_time" | "recurring";

export interface Price extends Scope, Pricing {
  readonly id: string;
  readonly productId: string;
  readonly type: PriceType;
  readonly unitAmount: bigint;
  readonly recurring: Recurring | null;
  readonly nickname: string | null;
  readonly active: boolean;
  readonly metadata: Metadata;
  readonly created: number;
  readonly updated: number;
  readonly version: number;
}

export interface PriceCreate extends Pricing {
  readonly productId: string;
  readonly unitAmount: bigint;
  readonly recurring?: { readonly interval: Interval; readonly intervalCount?: number | undefined } | undefined;
  readonly nickname?: string | undefined;
  readonly active?: boolean | undefined;
  readonly metadata?: Metadata | undefined;
}

export interface PricePatch {
  readonly active?: boolean | undefined;
  readonly nickname?: string | null | undefined;
  readonly metadata?: Metadata | undefined;
}

export function newPrice(
  scope: Scope,
  id: string,
  now: number,
  product: Product | undefined,
  input: PriceCreate,
): Price {
  if (!product || product.accountId !== scope.accountId || product.livemode !== scope.livemode)
    throw missing("product", input.productId, "product");
  if (input.unitAmount < 0n)
    throw new DomainError("invalid_request", { detail: "unit_amount must be ≥ 0" }, "unit_amount");
  if ((input.currency === "asset") !== (input.assetId !== null))
    throw new DomainError(
      "invalid_request",
      { detail: "asset_id is required exactly when currency is asset" },
      "asset_id",
    );
  const count = input.recurring?.intervalCount ?? 1;
  if (!Number.isInteger(count) || count < 1 || count > 12)
    throw new DomainError("invalid_request", { detail: "interval_count must be 1–12" }, "recurring[interval_count]");
  return {
    ...scope,
    id,
    productId: product.id,
    type: input.recurring ? "recurring" : "one_time",
    unitAmount: input.unitAmount,
    currency: input.currency,
    assetId: input.assetId,
    recurring: input.recurring ? { interval: input.recurring.interval, intervalCount: count } : null,
    nickname: input.nickname ?? null,
    active: input.active ?? true,
    metadata: input.metadata ?? {},
    created: now,
    updated: now,
    version: 0,
  };
}

export function patchPrice(cur: Price, patch: PricePatch, now: number): Price {
  return {
    ...cur,
    ...(patch.active !== undefined ? { active: patch.active } : {}),
    ...(patch.nickname !== undefined ? { nickname: patch.nickname } : {}),
    metadata: mergeMetadata(cur.metadata, patch.metadata),
    updated: now,
  };
}

export const sameRecurring = (a: Recurring | null, b: Recurring | null): boolean =>
  a !== null && b !== null && a.interval === b.interval && a.intervalCount === b.intervalCount;

export const recurringLabel = (r: Recurring | null): string => (r ? `${r.intervalCount} ${r.interval}` : "one time");

/**
 * A price used on a new invoice line or subscription item: exists in this scope (`resource_missing`),
 * is active and its product too (`price_inactive`), has the wanted type (`price_type_invalid`) and,
 * when the target's pricing is known, the same currency/asset (`currency_mismatch`).
 */
export function usablePrice(
  o: {
    readonly id: string;
    readonly price: Price | undefined;
    readonly product: Product | undefined;
    readonly scope: Scope;
    readonly type: PriceType;
    readonly object: "invoice" | "subscription";
    readonly pricing: Pricing | null;
  },
  param: string,
): Price {
  const p = o.price;
  if (!p || p.accountId !== o.scope.accountId || p.livemode !== o.scope.livemode) throw missing("price", o.id, param);
  if (!p.active || !o.product?.active) throw new DomainError("price_inactive", { price: p.id }, param);
  if (p.type !== o.type)
    throw new DomainError(
      "price_type_invalid",
      { price: p.id, type: p.type, object: o.object, expected: o.type },
      param,
    );
  if (o.pricing && !samePricing(p, o.pricing))
    throw new DomainError(
      "currency_mismatch",
      { price: p.id, currency: pricingLabel(p), object: o.object, expected: pricingLabel(o.pricing) },
      param,
    );
  return p;
}
