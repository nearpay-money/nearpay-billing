/**
 * Manual tax rates (lld/billing.md §11 d1–d2). The rate is an exact decimal percentage (≤ 4 decimals)
 * held as `rate_ppm` (percentage × 10 000); `percentage` and `inclusive` are immutable. Line taxes use the
 * spec's normative `computeLineTax` (round half-up per line and rate). Pure.
 */
import { TaxPercentage, type TaxRateInput, taxPercentageToPpm } from "@nearpay/spec";
import { DomainError, distinct, type Metadata, mergeMetadata, missing, type Scope } from "../shared.js";

export const MAX_TAX_RATES_PER_LINE = 5;

export interface TaxRate extends Scope {
  readonly id: string;
  readonly displayName: string;
  readonly description: string | null;
  readonly jurisdiction: string | null;
  readonly country: string | null;
  readonly ratePpm: number;
  readonly inclusive: boolean;
  readonly active: boolean;
  readonly metadata: Metadata;
  readonly created: number;
  readonly updated: number;
  readonly version: number;
}

export interface TaxRateCreate {
  readonly displayName: string;
  readonly percentage: string;
  readonly inclusive: boolean;
  readonly description?: string | undefined;
  readonly jurisdiction?: string | undefined;
  readonly country?: string | undefined;
  readonly active?: boolean | undefined;
  readonly metadata?: Metadata | undefined;
}

/** `percentage` and `inclusive` cannot be patched (immutable, INV-6). */
export interface TaxRatePatch {
  readonly displayName?: string | undefined;
  readonly description?: string | null | undefined;
  readonly jurisdiction?: string | null | undefined;
  readonly country?: string | null | undefined;
  readonly active?: boolean | undefined;
  readonly metadata?: Metadata | undefined;
}

/** Exact `percentage` → ppm; `invalid_request` for anything the spec's `TaxPercentage` rejects. */
export function percentageToPpm(percentage: string, param = "percentage"): number {
  if (!TaxPercentage.safeParse(percentage).success)
    throw new DomainError("invalid_request", { detail: "invalid percentage" }, param);
  return taxPercentageToPpm(percentage);
}

/** ppm → canonical decimal string (`88750` → `"8.875"`, `190000` → `"19"`). Exact inverse of `percentageToPpm`. */
export function ppmToPercentage(ppm: number): string {
  if (!Number.isInteger(ppm) || ppm < 0 || ppm > 1_000_000) throw new RangeError(`invalid rate_ppm ${ppm}`);
  const int = Math.floor(ppm / 10_000);
  const frac = String(ppm % 10_000)
    .padStart(4, "0")
    .replace(/0+$/, "");
  return frac ? `${int}.${frac}` : String(int);
}

export function newTaxRate(scope: Scope, id: string, now: number, input: TaxRateCreate): TaxRate {
  return {
    ...scope,
    id,
    displayName: input.displayName,
    description: input.description ?? null,
    jurisdiction: input.jurisdiction ?? null,
    country: input.country ?? null,
    ratePpm: percentageToPpm(input.percentage),
    inclusive: input.inclusive,
    active: input.active ?? true,
    metadata: input.metadata ?? {},
    created: now,
    updated: now,
    version: 0,
  };
}

export function patchTaxRate(cur: TaxRate, patch: TaxRatePatch, now: number): TaxRate {
  return {
    ...cur,
    ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.jurisdiction !== undefined ? { jurisdiction: patch.jurisdiction } : {}),
    ...(patch.country !== undefined ? { country: patch.country } : {}),
    ...(patch.active !== undefined ? { active: patch.active } : {}),
    metadata: mergeMetadata(cur.metadata, patch.metadata),
    updated: now,
  };
}

/**
 * Checks the tax rates of one line (or item, or a default list) and returns them in order:
 * ≤ 5 distinct rates, each of this scope (`resource_missing`), active when `requireActive`
 * (`tax_rate_inactive`), and all inclusive or all exclusive (`tax_rates_mixed`).
 */
export function resolveTaxRates(
  ids: readonly string[],
  rates: ReadonlyMap<string, TaxRate>,
  scope: Scope,
  param: string,
  requireActive = true,
): TaxRate[] {
  const unique = distinct(ids);
  if (unique.length !== ids.length) throw new DomainError("invalid_request", { detail: "duplicate tax rate" }, param);
  if (unique.length > MAX_TAX_RATES_PER_LINE)
    throw new DomainError("invalid_request", { detail: `at most ${MAX_TAX_RATES_PER_LINE} tax rates` }, param);
  const out = unique.map((id, i) => {
    const r = rates.get(id);
    if (!r || r.accountId !== scope.accountId || r.livemode !== scope.livemode)
      throw missing("tax_rate", id, `${param}[${i}]`);
    if (requireActive && !r.active) throw new DomainError("tax_rate_inactive", { tax_rate: id }, `${param}[${i}]`);
    return r;
  });
  if (out.length > 1 && out.some((r) => r.inclusive !== out[0]?.inclusive))
    throw new DomainError("tax_rates_mixed", { param }, param);
  return out;
}

export const taxInput = (r: TaxRate): TaxRateInput => ({ id: r.id, rate_ppm: r.ratePpm, inclusive: r.inclusive });
