/** Domain builders for unit and property tests. */
import { newPrice, type Price, type PriceCreate } from "../../src/domain/price/price.js";
import { newProduct, type Product } from "../../src/domain/product/product.js";
import type { Scope } from "../../src/domain/shared.js";
import { newTaxRate, type TaxRate, type TaxRateCreate } from "../../src/domain/tax-rate/tax-rate.js";

export const SCOPE: Scope = { accountId: "0190f0c4-0000-7000-8000-000000000001", livemode: false };
export const OTHER: Scope = { accountId: "0190f0c4-0000-7000-8000-000000000002", livemode: false };
export const LIVE: Scope = { ...SCOPE, livemode: true };

/** 2026-11-08T12:00:00Z */
export const T0 = 1_794_139_200;

let n = 0;
export const seqId = (prefix: string): string => `${prefix}_${String(++n).padStart(26, "0")}`;

export function product(o: Partial<Product> = {}, scope: Scope = SCOPE): Product {
  return { ...newProduct(scope, seqId("prod"), T0, { name: "Pro plan" }), ...o };
}

export function price(p: Product, o: Partial<PriceCreate> = {}, scope: Scope = SCOPE): Price {
  return newPrice(scope, seqId("price"), T0, p, {
    productId: p.id,
    unitAmount: 1000n,
    currency: "usd",
    assetId: null,
    ...o,
  });
}

export function taxRate(o: Partial<TaxRateCreate> = {}, scope: Scope = SCOPE): TaxRate {
  return newTaxRate(scope, seqId("txr"), T0, { displayName: "VAT", percentage: "19", inclusive: false, ...o });
}

export const mapOf = <T extends { id: string }>(...xs: T[]): Map<string, T> => new Map(xs.map((x) => [x.id, x]));
