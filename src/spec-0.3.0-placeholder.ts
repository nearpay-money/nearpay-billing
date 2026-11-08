/**
 * PHASE A PLACEHOLDER — delete in Phase B (step 3.2).
 *
 * `@nearpay/spec` 0.3.0 (Stage 3 billing contracts, `nearpay-spec` branch `stage-3/3.1-contracts`) is not
 * published yet; this repo builds against 0.2.1. Everything billing needs from 0.3.0 that 0.2.1 lacks is
 * isolated here, copied verbatim (normative arithmetic) or reduced to names (codes, subjects, prefixes).
 * Phase B: bump to 0.3.0, replace every import of this module with `@nearpay/spec` /
 * `@nearpay-internal/spec`, delete this file and `test/support/spec-0.3.0-vectors.json`.
 */

// =============================================================================================
// Normative tax arithmetic — verbatim from spec 0.3.0 `src/public/billing-catalog.ts`
// =============================================================================================

/** Exact decimal percentage, 0–100 with at most 4 decimals (spec `TaxPercentage`). */
export const TAX_PERCENTAGE_RE = /^(100(\.0{1,4})?|[1-9]?[0-9](\.[0-9]{1,4})?)$/;

/** Denominator of `rate_ppm`. */
export const TAX_PPM_DENOMINATOR = 1_000_000n;

/** `"8.875"` → 88 750 ppm (exact). Throws on anything `TaxPercentage` rejects. */
export function taxPercentageToPpm(percentage: string): number {
  if (!TAX_PERCENTAGE_RE.test(percentage)) throw new Error(`invalid tax percentage ${percentage}`);
  const [int, frac = ""] = percentage.split(".");
  return Number(int) * 10_000 + Number(frac.padEnd(4, "0"));
}

/** Round-half-up integer division for non-negative `n` and positive `d`: ⌊n/d + 1/2⌋. */
export function divRoundHalfUp(n: bigint, d: bigint): bigint {
  if (n < 0n || d <= 0n) throw new Error("divRoundHalfUp: n must be ≥ 0 and d > 0");
  return (2n * n + d) / (2n * d);
}

/** A tax rate as the arithmetic needs it. */
export interface TaxRateInput {
  readonly id: string;
  readonly rate_ppm: number;
  readonly inclusive: boolean;
}

export interface LineTax {
  readonly tax_rate: string;
  readonly inclusive: boolean;
  readonly amount: bigint;
  /** Amount the rate applies to: the line amount (exclusive) or the line amount less its inclusive taxes. */
  readonly taxable_amount: bigint;
}

export function computeLineTax(amount: bigint, rates: readonly TaxRateInput[]): LineTax[] {
  if (amount < 0n) throw new Error("line amount must be ≥ 0");
  if (rates.length === 0) return [];
  const inclusive = rates[0]?.inclusive === true;
  if (rates.some((r) => r.inclusive !== inclusive)) throw new Error("tax_rates_mixed");
  if (!inclusive) {
    return rates.map((r) => ({
      tax_rate: r.id,
      inclusive: false,
      amount: divRoundHalfUp(amount * BigInt(r.rate_ppm), TAX_PPM_DENOMINATOR),
      taxable_amount: amount,
    }));
  }
  const p = rates.reduce((s, r) => s + BigInt(r.rate_ppm), 0n);
  const taxes = rates.map((r) => divRoundHalfUp(amount * BigInt(r.rate_ppm), TAX_PPM_DENOMINATOR + p));
  const net = amount - taxes.reduce((s, t) => s + t, 0n);
  return rates.map((r, i) => ({ tax_rate: r.id, inclusive: true, amount: taxes[i] as bigint, taxable_amount: net }));
}

export interface InvoiceTotals {
  readonly subtotal: bigint;
  readonly tax: bigint;
  readonly total: bigint;
  readonly total_excluding_tax: bigint;
  readonly total_tax_amounts: readonly LineTax[];
  readonly lines: readonly { readonly amount: bigint; readonly taxes: readonly LineTax[] }[];
}

export function computeInvoiceTotals(
  lines: readonly { readonly amount: bigint; readonly tax_rates: readonly TaxRateInput[] }[],
): InvoiceTotals {
  let subtotal = 0n;
  let tax = 0n;
  let exclusive = 0n;
  const per = new Map<string, { inclusive: boolean; amount: bigint; taxable_amount: bigint }>();
  const out: { amount: bigint; taxes: LineTax[] }[] = [];
  for (const l of lines) {
    const taxes = computeLineTax(l.amount, l.tax_rates);
    subtotal += l.amount;
    for (const t of taxes) {
      tax += t.amount;
      if (!t.inclusive) exclusive += t.amount;
      const acc = per.get(t.tax_rate) ?? { inclusive: t.inclusive, amount: 0n, taxable_amount: 0n };
      acc.amount += t.amount;
      acc.taxable_amount += t.taxable_amount;
      per.set(t.tax_rate, acc);
    }
    out.push({ amount: l.amount, taxes });
  }
  const total = subtotal + exclusive;
  return {
    subtotal,
    tax,
    total,
    total_excluding_tax: total - tax,
    total_tax_amounts: [...per.entries()].map(([tax_rate, v]) => ({ tax_rate, ...v })),
    lines: out,
  };
}

// =============================================================================================
// Normative billing periods — verbatim from spec 0.3.0 `periodBoundary`
// =============================================================================================

export function periodBoundary(
  anchor: number,
  interval: "day" | "week" | "month" | "year",
  count: number,
  n: number,
): number {
  if (!Number.isInteger(anchor) || !Number.isInteger(count) || !Number.isInteger(n) || count < 1 || n < 0) {
    throw new Error("periodBoundary: integer anchor, count ≥ 1, n ≥ 0");
  }
  if (interval === "day") return anchor + n * count * 86_400;
  if (interval === "week") return anchor + n * count * 604_800;
  const months = n * count * (interval === "year" ? 12 : 1);
  const a = new Date(anchor * 1000);
  const y = a.getUTCFullYear();
  const m = a.getUTCMonth() + months;
  const ty = y + Math.floor(m / 12);
  const tm = ((m % 12) + 12) % 12;
  const last = new Date(Date.UTC(ty, tm + 1, 0)).getUTCDate();
  const day = Math.min(a.getUTCDate(), last);
  return Date.UTC(ty, tm, day, a.getUTCHours(), a.getUTCMinutes(), a.getUTCSeconds(), a.getUTCMilliseconds()) / 1000;
}

// =============================================================================================
// Constants and names (spec 0.3.0 `invoices.ts`, `errors/catalogue.ts`, `events/catalogue.ts`, `ids.ts`)
// =============================================================================================

/** `DEFAULT_REMINDER_DAYS` (spec `invoices.ts`). */
export const DEFAULT_REMINDER_DAYS = [-3, 0, 1, 3, 7] as const;

/** Error codes added in 0.3.0 (`e3(...)` entries of the error catalogue). */
export const BILLING_ERROR_CODES_030 = [
  "currency_mismatch",
  "interval_mismatch",
  "price_inactive",
  "price_type_invalid",
  "tax_rate_inactive",
  "tax_rates_mixed",
  "invoice_empty",
  "customer_email_missing",
  "invoice_secret_invalid",
  "invoice_not_payable",
] as const;
export type BillingErrorCode030 = (typeof BILLING_ERROR_CODES_030)[number];

/** Billing subjects added in 0.3.0 (`SUBJECTS`, producer billing). */
export type BillingSubject030 =
  | "evt.billing.invoice.created"
  | "evt.billing.invoice.finalized"
  | "evt.billing.invoice.sent"
  | "evt.billing.invoice.paid"
  | "evt.billing.invoice.payment_failed"
  | "evt.billing.invoice.overdue"
  | "evt.billing.invoice.voided"
  | "evt.billing.invoice.marked_uncollectible"
  | "evt.billing.invoice.reminder"
  | "evt.billing.subscription.created"
  | "evt.billing.subscription.updated"
  | "evt.billing.subscription.deleted"
  | "evt.billing.subscription.renewal_upcoming";

/** ID prefixes added in 0.3.0 (`ID_PREFIXES`). */
export type BillingIdPrefix030 = "txr" | "il" | "si";
