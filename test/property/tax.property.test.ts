/**
 * Money properties of the tax rule (INV-5, lld/billing.md §11 d2): integer-only, round half-up per line
 * and rate, totals consistent, per-rate sums equal the rounded line taxes, ppm ↔ percentage exact.
 */

import { divRoundHalfUp } from "@nearpay-money/spec";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type LineDraft, priceLines } from "../../src/domain/invoice/lines.js";
import { newTaxRate, percentageToPpm, ppmToPercentage, type TaxRate } from "../../src/domain/tax-rate/tax-rate.js";
import { SCOPE, T0 } from "../support/fixtures.js";

const M = 1_000_000n;

const percentage = fc
  .tuple(fc.integer({ min: 0, max: 100 }), fc.integer({ min: 0, max: 9999 }), fc.integer({ min: 0, max: 4 }))
  .map(([i, f, digits]) => {
    if (i === 100 || digits === 0) return String(i);
    return `${i}.${String(f).padStart(4, "0").slice(0, digits)}`;
  });

const rateArb = (inclusive: boolean) =>
  percentage.map((p) => newTaxRate(SCOPE, `txr_${p}_${inclusive}`, T0, { displayName: p, percentage: p, inclusive }));

const lineArb = fc.record({
  unitAmount: fc.bigInt({ min: 0n, max: 10n ** 30n }),
  quantity: fc.integer({ min: 1, max: 1_000_000 }),
  inclusive: fc.boolean(),
  rates: fc.integer({ min: 0, max: 5 }),
});

describe("tax arithmetic properties", () => {
  it("ppm ↔ percentage round-trips exactly", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000 }), (ppm) => {
        expect(percentageToPpm(ppmToPercentage(ppm))).toBe(ppm);
      }),
    );
    fc.assert(
      fc.property(percentage, (p) => {
        expect(Number(ppmToPercentage(percentageToPpm(p)))).toBe(Number(p));
      }),
    );
  });

  it("round half-up is the nearest integer, ties up", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 40n }), fc.bigInt({ min: 1n, max: 10n ** 12n }), (n, d) => {
        const q = divRoundHalfUp(n, d);
        // |q·d − n| ≤ d/2, and at an exact tie (2n = (2q−1)d) we went up
        expect(2n * (q * d - n) <= d && 2n * (n - q * d) < d).toBe(true);
      }),
    );
  });

  it("invoice totals are consistent and every tax is the rounded exact rational", () => {
    fc.assert(
      fc.property(
        fc.array(lineArb, { minLength: 1, maxLength: 12 }),
        fc.array(rateArb(false), { minLength: 5, maxLength: 5 }),
        fc.array(rateArb(true), { minLength: 5, maxLength: 5 }),
        (lines, exclusiveRates, inclusiveRates) => {
          const uniq = (rs: TaxRate[]) => rs.map((r, i) => ({ ...r, id: `${r.id}_${i}` }));
          const ex = uniq(exclusiveRates);
          const inc = uniq(inclusiveRates);
          const all = new Map([...ex, ...inc].map((r) => [r.id, r]));
          const drafts: LineDraft[] = lines.map((l, i) => ({
            id: `il_${i}`,
            type: "invoiceitem",
            priceId: null,
            productId: null,
            subscriptionItemId: null,
            description: "x",
            quantity: l.quantity,
            unitAmount: l.unitAmount,
            taxRateIds: (l.inclusive ? inc : ex).slice(0, l.rates).map((r) => r.id),
            taxRatesExplicit: true,
            period: null,
          }));
          const { lines: priced, totals } = priceLines(drafts, [], {
            scope: SCOPE,
            taxRates: all,
            requireActive: true,
          });
          let subtotal = 0n;
          let tax = 0n;
          let exclusive = 0n;
          const perRate = new Map<string, bigint>();
          for (const l of priced) {
            expect(l.amount).toBe(l.unitAmount * BigInt(l.quantity));
            subtotal += l.amount;
            const P = l.taxAmounts.reduce((s, t) => s + BigInt(all.get(t.taxRateId)?.ratePpm ?? 0), 0n);
            for (const t of l.taxAmounts) {
              const ppm = BigInt(all.get(t.taxRateId)?.ratePpm ?? 0);
              const den = t.inclusive ? M + P : M;
              // |tax·den − amount·ppm| ≤ den/2 (nearest integer)
              const diff = t.amount * den - l.amount * ppm;
              expect(2n * (diff < 0n ? -diff : diff) <= den).toBe(true);
              expect(t.amount >= 0n).toBe(true);
              tax += t.amount;
              if (!t.inclusive) exclusive += t.amount;
              perRate.set(t.taxRateId, (perRate.get(t.taxRateId) ?? 0n) + t.amount);
            }
            const inclusiveTax = l.taxAmounts.filter((t) => t.inclusive).reduce((s, t) => s + t.amount, 0n);
            expect(inclusiveTax <= l.amount).toBe(true);
            expect(l.amountExcludingTax).toBe(l.amount - inclusiveTax);
          }
          expect(totals.subtotal).toBe(subtotal);
          expect(totals.tax).toBe(tax);
          expect(totals.total).toBe(subtotal + exclusive);
          expect(totals.totalExcludingTax).toBe(totals.total - totals.tax);
          expect(totals.total >= totals.subtotal).toBe(true);
          expect(new Map(totals.totalTaxAmounts.map((t) => [t.taxRateId, t.amount]))).toEqual(perRate);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("per-line rounding: splitting a line never changes a line's own tax, only the sum", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 12n }), fc.integer({ min: 0, max: 1_000_000 }), (amount, ppm) => {
        const r = {
          ...newTaxRate(SCOPE, "txr_a", T0, { displayName: "a", percentage: "0", inclusive: false }),
          ratePpm: ppm,
        };
        const one: LineDraft = {
          id: "il",
          type: "invoiceitem",
          priceId: null,
          productId: null,
          subscriptionItemId: null,
          description: "x",
          quantity: 1,
          unitAmount: amount,
          taxRateIds: [r.id],
          taxRatesExplicit: true,
          period: null,
        };
        const { totals } = priceLines([one, { ...one, id: "il2" }], [], {
          scope: SCOPE,
          taxRates: new Map([[r.id, r]]),
          requireActive: true,
        });
        expect(totals.tax).toBe(2n * divRoundHalfUp(amount * BigInt(ppm), M));
      }),
    );
  });
});
