import { describe, expect, it } from "vitest";
import { priceLines } from "../../src/domain/invoice/lines.js";
import { DomainError } from "../../src/domain/shared.js";
import {
  newTaxRate,
  patchTaxRate,
  percentageToPpm,
  ppmToPercentage,
  resolveTaxRates,
  type TaxRate,
} from "../../src/domain/tax-rate/tax-rate.js";
import { OTHER, SCOPE, T0, taxRate } from "../support/fixtures.js";
import vectors from "../support/spec-0.3.0-vectors.json" with { type: "json" };

interface VectorTax {
  tax_rate: string;
  inclusive: boolean;
  amount: string;
  taxable_amount: string;
}

describe("spec 0.3.0 tax vectors (normative per-line half-up rounding)", () => {
  for (const c of vectors.tax_cases) {
    it(c.name, () => {
      const rates = new Map<string, TaxRate>(
        c.tax_rates.map((r) => [
          r.id,
          { ...newTaxRate(SCOPE, r.id, T0, { displayName: r.id, percentage: r.percentage, inclusive: r.inclusive }) },
        ]),
      );
      for (const r of c.tax_rates) expect(rates.get(r.id)?.ratePpm).toBe(r.rate_ppm);
      const drafts = c.lines.map((l, i) => ({
        id: `il_${i}`,
        type: "invoiceitem" as const,
        priceId: null,
        productId: null,
        subscriptionItemId: null,
        description: "x",
        quantity: l.quantity,
        unitAmount: BigInt(l.unit_amount),
        taxRateIds: l.rates,
        taxRatesExplicit: true,
        period: null,
      }));
      const { lines, totals } = priceLines(drafts, [], { scope: SCOPE, taxRates: rates, requireActive: true });
      const e = c.expected;
      expect(totals.subtotal).toBe(BigInt(e.subtotal));
      expect(totals.tax).toBe(BigInt(e.tax));
      expect(totals.total).toBe(BigInt(e.total));
      expect(totals.totalExcludingTax).toBe(BigInt(e.total_excluding_tax));
      const norm = (t: { taxRateId: string; inclusive: boolean; amount: bigint; taxableAmount: bigint }) => ({
        tax_rate: t.taxRateId,
        inclusive: t.inclusive,
        amount: t.amount.toString(),
        taxable_amount: t.taxableAmount.toString(),
      });
      expect(totals.totalTaxAmounts.map(norm)).toEqual(e.total_tax_amounts as VectorTax[]);
      lines.forEach((l, i) => {
        const want = e.lines[i] as { amount: string; taxes: VectorTax[] };
        expect(l.amount.toString()).toBe(want.amount);
        expect(l.taxAmounts.map(norm)).toEqual(want.taxes);
        const inclusive = l.taxAmounts.filter((t) => t.inclusive).reduce((s, t) => s + t.amount, 0n);
        expect(l.amountExcludingTax).toBe(l.amount - inclusive);
      });
    });
  }
});

describe("tax rate percentages", () => {
  it("parses exact decimals to ppm and renders them back canonically", () => {
    expect(percentageToPpm("8.875")).toBe(88_750);
    expect(percentageToPpm("19")).toBe(190_000);
    expect(percentageToPpm("0.0001")).toBe(1);
    expect(percentageToPpm("100")).toBe(1_000_000);
    expect(percentageToPpm("7.6000")).toBe(76_000);
    expect(ppmToPercentage(88_750)).toBe("8.875");
    expect(ppmToPercentage(190_000)).toBe("19");
    expect(ppmToPercentage(1)).toBe("0.0001");
    expect(ppmToPercentage(0)).toBe("0");
    expect(ppmToPercentage(1_000_000)).toBe("100");
  });

  it("rejects floats-in-disguise and out-of-range values", () => {
    for (const bad of ["8.87501", "101", "-1", "1e2", "08.5", ".5", "abc", ""])
      expect(() => percentageToPpm(bad)).toThrow(DomainError);
    expect(() => ppmToPercentage(1_000_001)).toThrow(RangeError);
    expect(() => ppmToPercentage(0.5)).toThrow(RangeError);
  });

  it("keeps percentage and inclusive immutable on update", () => {
    const r = taxRate({ percentage: "8.875", jurisdiction: "US-NY" });
    const u = patchTaxRate(
      r,
      { displayName: "Sales tax", jurisdiction: null, country: "US", active: false, metadata: { a: "b" } },
      T0 + 5,
    );
    expect(u).toMatchObject({
      ratePpm: 88_750,
      inclusive: false,
      displayName: "Sales tax",
      jurisdiction: null,
      country: "US",
      active: false,
      metadata: { a: "b" },
      updated: T0 + 5,
    });
    expect(patchTaxRate(r, {}, T0)).toMatchObject({ displayName: r.displayName, metadata: r.metadata });
    expect(
      newTaxRate(SCOPE, "txr_x", T0, {
        displayName: "A",
        percentage: "5",
        inclusive: true,
        description: "d",
        country: "DE",
        jurisdiction: "DE",
        active: false,
        metadata: { k: "v" },
      }),
    ).toMatchObject({ description: "d", active: false });
  });
});

describe("resolveTaxRates", () => {
  const ex = taxRate();
  const ex2 = taxRate({ percentage: "1.5" });
  const inc = taxRate({ inclusive: true });
  const off = { ...taxRate(), active: false };
  const foreign = taxRate({}, OTHER);
  const all = new Map([ex, ex2, inc, off, foreign].map((r) => [r.id, r]));
  const code = (f: () => unknown) => {
    try {
      f();
    } catch (e) {
      return (e as DomainError).code;
    }
    return "ok";
  };

  it("returns the rates in order", () => {
    expect(resolveTaxRates([ex2.id, ex.id], all, SCOPE, "p").map((r) => r.id)).toEqual([ex2.id, ex.id]);
    expect(resolveTaxRates([], all, SCOPE, "p")).toEqual([]);
  });
  it("refuses mixed, inactive, foreign, unknown, duplicate and more than five rates", () => {
    expect(code(() => resolveTaxRates([ex.id, inc.id], all, SCOPE, "p"))).toBe("tax_rates_mixed");
    expect(code(() => resolveTaxRates([off.id], all, SCOPE, "p"))).toBe("tax_rate_inactive");
    expect(code(() => resolveTaxRates([off.id], all, SCOPE, "p", false))).toBe("ok");
    expect(code(() => resolveTaxRates([foreign.id], all, SCOPE, "p"))).toBe("resource_missing");
    expect(code(() => resolveTaxRates(["txr_nope"], all, SCOPE, "p"))).toBe("resource_missing");
    expect(code(() => resolveTaxRates([ex.id, ex.id], all, SCOPE, "p"))).toBe("invalid_request");
    const six = Array.from({ length: 6 }, () => taxRate());
    const m = new Map(six.map((r) => [r.id, r]));
    expect(
      code(() =>
        resolveTaxRates(
          six.map((r) => r.id),
          m,
          SCOPE,
          "p",
        ),
      ),
    ).toBe("invalid_request");
  });
});
