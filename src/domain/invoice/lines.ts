/**
 * Invoice lines and totals (lld/billing.md §11 d2, d7). Line `amount = unit_amount × quantity` in integer
 * units of the invoice currency; tax per line and rate with the spec's normative `computeInvoiceTotals`
 * (round half-up per line); the tax snapshot (name, percentage) is taken from the rates at computation
 * time and frozen at finalize. Pure.
 */
import { computeInvoiceTotals } from "@nearpay-money/spec";
import { type Price, usablePrice } from "../price/price.js";
import type { Product } from "../product/product.js";
import { DomainError, type Pricing, type Scope } from "../shared.js";
import { ppmToPercentage, resolveTaxRates, type TaxRate, taxInput } from "../tax-rate/tax-rate.js";

export const MAX_LINES = 100;
export const MAX_QUANTITY = 1_000_000;

export type LineType = "invoiceitem" | "subscription";

export interface Period {
  readonly start: number;
  readonly end: number;
}

/** A line as entered (before tax). */
export interface LineDraft {
  readonly id: string;
  readonly type: LineType;
  readonly priceId: string | null;
  readonly productId: string | null;
  readonly subscriptionItemId: string | null;
  readonly description: string;
  readonly quantity: number;
  readonly unitAmount: bigint;
  /** The line's own tax rates; ignored when `taxRatesExplicit` is false (the invoice defaults apply). */
  readonly taxRateIds: readonly string[];
  readonly taxRatesExplicit: boolean;
  readonly period: Period | null;
}

export interface TaxAmount {
  readonly taxRateId: string;
  readonly displayName: string;
  readonly jurisdiction: string | null;
  readonly percentage: string;
  readonly inclusive: boolean;
  readonly amount: bigint;
  readonly taxableAmount: bigint;
}

export interface InvoiceLine extends LineDraft {
  readonly amount: bigint;
  readonly amountExcludingTax: bigint;
  readonly taxAmounts: readonly TaxAmount[];
}

export interface Totals {
  readonly subtotal: bigint;
  readonly tax: bigint;
  readonly total: bigint;
  readonly totalExcludingTax: bigint;
  readonly totalTaxAmounts: readonly TaxAmount[];
}

/** Exactly the totals fields (never spread a wider object into an invoice). */
export const totalsOf = (t: Totals): Totals => ({
  subtotal: t.subtotal,
  tax: t.tax,
  total: t.total,
  totalExcludingTax: t.totalExcludingTax,
  totalTaxAmounts: t.totalTaxAmounts,
});

export const ZERO_TOTALS: Totals = { subtotal: 0n, tax: 0n, total: 0n, totalExcludingTax: 0n, totalTaxAmounts: [] };

export type LineInput =
  | {
      readonly priceId: string;
      readonly quantity?: number | undefined;
      readonly description?: string | undefined;
      readonly taxRateIds?: readonly string[] | undefined;
    }
  | {
      readonly unitAmount: bigint;
      readonly description: string;
      readonly quantity?: number | undefined;
      readonly taxRateIds?: readonly string[] | undefined;
    };

export interface Catalog {
  readonly prices: ReadonlyMap<string, Price>;
  readonly products: ReadonlyMap<string, Product>;
  readonly taxRates: ReadonlyMap<string, TaxRate>;
}

function checkQuantity(q: number, param: string): number {
  if (!Number.isInteger(q) || q < 1 || q > MAX_QUANTITY)
    throw new DomainError("invalid_request", { detail: `quantity must be 1–${MAX_QUANTITY}` }, param);
  return q;
}

/**
 * Resolves the lines of a manual invoice (`createInvoice` / `updateInvoice`): price lines need active
 * `one_time` prices; the invoice currency defaults to the first price line's (§11 d7) and must be given
 * when every line has a custom amount. Tax-rate references are checked later by `priceLines`.
 */
export function resolveLines(
  inputs: readonly LineInput[],
  o: {
    readonly scope: Scope;
    readonly pricing: Pricing | null;
    readonly catalog: Catalog;
    readonly newId: () => string;
  },
): { pricing: Pricing | null; lines: LineDraft[] } {
  if (inputs.length > MAX_LINES)
    throw new DomainError("invalid_request", { detail: `at most ${MAX_LINES} lines` }, "lines");
  let pricing = o.pricing;
  if (!pricing) {
    const first = inputs.find((l) => "priceId" in l);
    if (first && "priceId" in first) {
      const p = o.catalog.prices.get(first.priceId);
      if (p && p.accountId === o.scope.accountId && p.livemode === o.scope.livemode)
        pricing = { currency: p.currency, assetId: p.assetId };
    }
  }
  if (!pricing && inputs.length > 0)
    throw new DomainError("invalid_request", { detail: "currency is required when no line has a price" }, "currency");
  const lines = inputs.map((l, i): LineDraft => {
    const param = `lines[${i}]`;
    const quantity = checkQuantity(l.quantity ?? 1, `${param}[quantity]`);
    const own = l.taxRateIds !== undefined;
    if ("priceId" in l) {
      const price = usablePrice(
        {
          id: l.priceId,
          price: o.catalog.prices.get(l.priceId),
          product: productOf(o.catalog, l.priceId),
          scope: o.scope,
          type: "one_time",
          object: "invoice",
          pricing,
        },
        `${param}[price]`,
      );
      return {
        id: o.newId(),
        type: "invoiceitem",
        priceId: price.id,
        productId: price.productId,
        subscriptionItemId: null,
        description: l.description ?? (o.catalog.products.get(price.productId)?.name as string),
        quantity,
        unitAmount: price.unitAmount,
        taxRateIds: l.taxRateIds ?? [],
        taxRatesExplicit: own,
        period: null,
      };
    }
    if (l.unitAmount < 0n)
      throw new DomainError("invalid_request", { detail: "unit_amount must be ≥ 0" }, `${param}[unit_amount]`);
    return {
      id: o.newId(),
      type: "invoiceitem",
      priceId: null,
      productId: null,
      subscriptionItemId: null,
      description: l.description,
      quantity,
      unitAmount: l.unitAmount,
      taxRateIds: l.taxRateIds ?? [],
      taxRatesExplicit: own,
      period: null,
    };
  });
  return { pricing, lines };
}

const productOf = (c: Catalog, priceId: string): Product | undefined => {
  const p = c.prices.get(priceId);
  return p ? c.products.get(p.productId) : undefined;
};

/**
 * Prices every line: effective tax rates (own, or the invoice `defaultTaxRateIds`), validated per line
 * (`tax_rates_mixed`, inactive rates when `requireActive`), then the normative totals.
 */
export function priceLines(
  drafts: readonly LineDraft[],
  defaultTaxRateIds: readonly string[],
  o: { readonly scope: Scope; readonly taxRates: ReadonlyMap<string, TaxRate>; readonly requireActive: boolean },
): { lines: InvoiceLine[]; totals: Totals } {
  const defaults = resolveTaxRates(defaultTaxRateIds, o.taxRates, o.scope, "default_tax_rates", o.requireActive);
  const perLine = drafts.map((d, i) =>
    d.taxRatesExplicit
      ? resolveTaxRates(d.taxRateIds, o.taxRates, o.scope, `lines[${i}][tax_rates]`, o.requireActive)
      : defaults,
  );
  const computed = computeInvoiceTotals(
    drafts.map((d, i) => ({ amount: d.unitAmount * BigInt(d.quantity), tax_rates: (perLine[i] ?? []).map(taxInput) })),
  );
  const snapshot = (rateId: string, inclusive: boolean, amount: bigint, taxable: bigint): TaxAmount => {
    const r = o.taxRates.get(rateId) as TaxRate;
    return {
      taxRateId: rateId,
      displayName: r.displayName,
      jurisdiction: r.jurisdiction,
      percentage: ppmToPercentage(r.ratePpm),
      inclusive,
      amount,
      taxableAmount: taxable,
    };
  };
  const lines = drafts.map((d, i): InvoiceLine => {
    const c = computed.lines[i] as (typeof computed.lines)[number];
    const inclusiveTax = c.taxes.filter((t) => t.inclusive).reduce((s, t) => s + t.amount, 0n);
    return {
      ...d,
      taxRateIds: (perLine[i] ?? []).map((r) => r.id),
      amount: c.amount,
      amountExcludingTax: c.amount - inclusiveTax,
      taxAmounts: c.taxes.map((t) => snapshot(t.tax_rate, t.inclusive, t.amount, t.taxable_amount)),
    };
  });
  return {
    lines,
    totals: {
      subtotal: computed.subtotal,
      tax: computed.tax,
      total: computed.total,
      totalExcludingTax: computed.total_excluding_tax,
      totalTaxAmounts: computed.total_tax_amounts.map((t) =>
        snapshot(t.tax_rate, t.inclusive, t.amount, t.taxable_amount),
      ),
    },
  };
}

/** The draft view of priced lines (drops computed fields). */
export const toDraft = (l: InvoiceLine): LineDraft => ({
  id: l.id,
  type: l.type,
  priceId: l.priceId,
  productId: l.productId,
  subscriptionItemId: l.subscriptionItemId,
  description: l.description,
  quantity: l.quantity,
  unitAmount: l.unitAmount,
  taxRateIds: l.taxRatesExplicit ? l.taxRateIds : [],
  taxRatesExplicit: l.taxRatesExplicit,
  period: l.period,
});
