/**
 * Catalogue use cases (lld/billing.md §5): products, prices, tax rates — create/get/list/update, no
 * deletes. No events (no product/price webhooks, §11 d13).
 */
import { newPrice, type Price, type PriceCreate, type PricePatch, patchPrice } from "../domain/price/price.js";
import {
  newProduct,
  type Product,
  type ProductCreate,
  type ProductPatch,
  patchProduct,
} from "../domain/product/product.js";
import { DomainError, missing, type Pricing } from "../domain/shared.js";
import {
  newTaxRate,
  patchTaxRate,
  type TaxRate,
  type TaxRateCreate,
  type TaxRatePatch,
} from "../domain/tax-rate/tax-rate.js";
import type { Ctx } from "./commit.js";
import type { Billing, Page, PriceRepo, ProductRepo, TaxRateRepo } from "./ports.js";

const nowS = (b: Billing) => Math.floor(b.now() / 1000);

/** A pricing currency payments accepts (`currency_unsupported`): a configured fiat code or a known asset. */
export async function assertPricingSupported(b: Billing, p: Pricing, param = "currency"): Promise<void> {
  if (p.currency === "asset") {
    const a = p.assetId ? await b.assets.asset(p.assetId) : undefined;
    if (!a) throw new DomainError("currency_unsupported", { currency: `asset ${p.assetId ?? ""}`.trim() }, "asset_id");
    return;
  }
  if (!b.settings.pricingCurrencies.has(p.currency))
    throw new DomainError("currency_unsupported", { currency: p.currency }, param);
}

// --------------------------------------------------------------------------------------------- products

export function createProduct(b: Billing, c: Ctx, input: ProductCreate): Promise<Product> {
  const p = newProduct(c.scope, b.newId("prod"), nowS(b), input);
  return b.store.transaction(async (tx) => {
    await tx.products.insert(p);
    return p;
  });
}

export function getProduct(b: Billing, c: Ctx, id: string): Promise<Product> {
  return b.store.transaction(
    async (tx) => (await tx.products.get(c.scope, id)) ?? Promise.reject(missing("product", id)),
  );
}

export function listProducts(b: Billing, c: Ctx, q: Parameters<ProductRepo["list"]>[1]): Promise<Page<Product>> {
  return b.store.transaction((tx) => tx.products.list(c.scope, q));
}

export function updateProduct(b: Billing, c: Ctx, id: string, patch: ProductPatch): Promise<Product> {
  return b.store.transaction(async (tx) => {
    const cur = await tx.products.get(c.scope, id, { lock: true });
    if (!cur) throw missing("product", id);
    const next = { ...patchProduct(cur, patch, nowS(b)), version: cur.version + 1 };
    await tx.products.update(cur, next);
    return next;
  });
}

// --------------------------------------------------------------------------------------------- prices

export async function createPrice(b: Billing, c: Ctx, input: PriceCreate): Promise<Price> {
  await assertPricingSupported(b, input);
  return b.store.transaction(async (tx) => {
    const product = await tx.products.get(c.scope, input.productId);
    const p = newPrice(c.scope, b.newId("price"), nowS(b), product, input);
    await tx.prices.insert(p);
    return p;
  });
}

export function getPrice(b: Billing, c: Ctx, id: string): Promise<Price> {
  return b.store.transaction(async (tx) => (await tx.prices.get(c.scope, id)) ?? Promise.reject(missing("price", id)));
}

export function listPrices(b: Billing, c: Ctx, q: Parameters<PriceRepo["list"]>[1]): Promise<Page<Price>> {
  return b.store.transaction((tx) => tx.prices.list(c.scope, q));
}

export function updatePrice(b: Billing, c: Ctx, id: string, patch: PricePatch): Promise<Price> {
  return b.store.transaction(async (tx) => {
    const cur = await tx.prices.get(c.scope, id, { lock: true });
    if (!cur) throw missing("price", id);
    const next = { ...patchPrice(cur, patch, nowS(b)), version: cur.version + 1 };
    await tx.prices.update(cur, next);
    return next;
  });
}

// --------------------------------------------------------------------------------------------- tax rates

export function createTaxRate(b: Billing, c: Ctx, input: TaxRateCreate): Promise<TaxRate> {
  const r = newTaxRate(c.scope, b.newId("txr"), nowS(b), input);
  return b.store.transaction(async (tx) => {
    await tx.taxRates.insert(r);
    return r;
  });
}

export function getTaxRate(b: Billing, c: Ctx, id: string): Promise<TaxRate> {
  return b.store.transaction(
    async (tx) => (await tx.taxRates.get(c.scope, id)) ?? Promise.reject(missing("tax_rate", id)),
  );
}

export function listTaxRates(b: Billing, c: Ctx, q: Parameters<TaxRateRepo["list"]>[1]): Promise<Page<TaxRate>> {
  return b.store.transaction((tx) => tx.taxRates.list(c.scope, q));
}

export function updateTaxRate(b: Billing, c: Ctx, id: string, patch: TaxRatePatch): Promise<TaxRate> {
  return b.store.transaction(async (tx) => {
    const cur = await tx.taxRates.get(c.scope, id, { lock: true });
    if (!cur) throw missing("tax_rate", id);
    const next = { ...patchTaxRate(cur, patch, nowS(b)), version: cur.version + 1 };
    await tx.taxRates.update(cur, next);
    return next;
  });
}
