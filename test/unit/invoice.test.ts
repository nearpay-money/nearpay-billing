import { describe, expect, it } from "vitest";
import {
  amountRemaining,
  assertDeletable,
  canTransition,
  checkReminderDays,
  finalize,
  formatInvoiceNumber,
  type Invoice,
  invoicePrefix,
  isPayable,
  markSent,
  markUncollectible,
  newDraft,
  patchInvoice,
  recordIntent,
  voidInvoice,
} from "../../src/domain/invoice/invoice.js";
import { type Catalog, type LineInput, priceLines, resolveLines, toDraft } from "../../src/domain/invoice/lines.js";
import { onIntentFailed, onIntentSucceeded, onSessionExpired } from "../../src/domain/invoice/payment.js";
import { newPrice, patchPrice, usablePrice } from "../../src/domain/price/price.js";
import { patchProduct } from "../../src/domain/product/product.js";
import { DomainError } from "../../src/domain/shared.js";
import { mapOf, OTHER, price, product, SCOPE, seqId, T0, taxRate } from "../support/fixtures.js";

const code = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
  return "ok";
};

const prod = product();
const archived = product({ active: false });
const usd = price(prod, { unitAmount: 1250n });
const eur = price(prod, { currency: "eur" });
const asset = price(prod, { currency: "asset", assetId: "nep141:usdc.near", unitAmount: 10n ** 20n });
const monthly = price(prod, { recurring: { interval: "month" } });
const inactive = { ...price(prod), active: false };
const ofArchived = price(archived);
const vat = taxRate();
const incl = taxRate({ inclusive: true });
const catalog: Catalog = {
  prices: mapOf(usd, eur, asset, monthly, inactive, ofArchived),
  products: mapOf(prod, archived),
  taxRates: mapOf(vat, incl),
};
const ids = () => seqId("il");

function draft(lines: LineInput[] = [{ priceId: usd.id, quantity: 2 }], defaults: string[] = []): Invoice {
  const pricing = lines.some((l) => "priceId" in l) ? null : { currency: "usd", assetId: null };
  const r = resolveLines(lines, { scope: SCOPE, pricing, catalog, newId: ids });
  const priced = priceLines(r.lines, defaults, { scope: SCOPE, taxRates: catalog.taxRates, requireActive: true });
  return newDraft(SCOPE, seqId("in"), T0, {
    currency: r.pricing?.currency ?? "usd",
    assetId: r.pricing?.assetId ?? null,
    customerId: "cus_1",
    lines: priced.lines,
    totals: priced.totals,
    defaultTaxRateIds: defaults,
  });
}

const hosted = { secretHash: new Uint8Array([1]), secretEnc: new Uint8Array([2]), billToEnc: null };
function open(inv = draft(), now = T0 + 10): Invoice {
  return finalize(inv, {
    now,
    number: "PROT-00001",
    hosted,
    merchantName: "Acme",
    priced: { lines: inv.lines, totals: inv },
  });
}

describe("catalogue", () => {
  it("creates prices with immutable pricing", () => {
    expect(monthly).toMatchObject({ type: "recurring", recurring: { interval: "month", intervalCount: 1 } });
    expect(usd).toMatchObject({ type: "one_time", recurring: null, active: true });
    const p = patchPrice(usd, { active: false, nickname: "old", metadata: { a: "1" } }, T0 + 1);
    expect(p).toMatchObject({
      active: false,
      nickname: "old",
      unitAmount: 1250n,
      currency: "usd",
      metadata: { a: "1" },
    });
    expect(patchPrice(usd, {}, T0)).toMatchObject({ nickname: null, metadata: {} });
  });
  it("refuses bad price input", () => {
    const base = { productId: prod.id, unitAmount: 1n, currency: "usd", assetId: null };
    expect(code(() => newPrice(SCOPE, "price_x", T0, undefined, base))).toBe("resource_missing");
    expect(code(() => newPrice(OTHER, "price_x", T0, prod, base))).toBe("resource_missing");
    expect(code(() => newPrice(SCOPE, "price_x", T0, prod, { ...base, unitAmount: -1n }))).toBe("invalid_request");
    expect(code(() => newPrice(SCOPE, "price_x", T0, prod, { ...base, currency: "asset" }))).toBe("invalid_request");
    expect(code(() => newPrice(SCOPE, "price_x", T0, prod, { ...base, assetId: "a" }))).toBe("invalid_request");
    expect(
      code(() => newPrice(SCOPE, "price_x", T0, prod, { ...base, recurring: { interval: "day", intervalCount: 13 } })),
    ).toBe("invalid_request");
  });
  it("patches products", () => {
    expect(patchProduct(prod, { name: "B", description: null, active: false }, T0 + 1)).toMatchObject({
      name: "B",
      description: null,
      active: false,
    });
    expect(patchProduct(prod, {}, T0)).toMatchObject({ name: prod.name });
  });
  it("checks prices used on invoices", () => {
    const use = (p: typeof usd | undefined, o: Partial<Parameters<typeof usablePrice>[0]> = {}) =>
      code(() =>
        usablePrice(
          {
            id: p?.id ?? "price_missing",
            price: p,
            product: p ? catalog.products.get(p.productId) : undefined,
            scope: SCOPE,
            type: "one_time",
            object: "invoice",
            pricing: { currency: "usd", assetId: null },
            ...o,
          },
          "p",
        ),
      );
    expect(use(usd)).toBe("ok");
    expect(use(undefined)).toBe("resource_missing");
    expect(use(usd, { scope: OTHER })).toBe("resource_missing");
    expect(use(inactive)).toBe("price_inactive");
    expect(use(ofArchived)).toBe("price_inactive");
    expect(use(monthly)).toBe("price_type_invalid");
    expect(use(eur)).toBe("currency_mismatch");
    expect(use(asset, { pricing: { currency: "asset", assetId: "nep141:other" } })).toBe("currency_mismatch");
    expect(use(asset, { pricing: { currency: "asset", assetId: "nep141:usdc.near" } })).toBe("ok");
  });
});

describe("lines and drafts", () => {
  it("infers the currency from the first price line and prices custom lines", () => {
    const r = resolveLines(
      [
        { unitAmount: 500n, description: "Setup", quantity: 3 },
        { priceId: usd.id, description: "Override" },
      ],
      { scope: SCOPE, pricing: null, catalog, newId: ids },
    );
    expect(r.pricing).toEqual({ currency: "usd", assetId: null });
    expect(r.lines.map((l) => [l.description, l.quantity, l.unitAmount])).toEqual([
      ["Setup", 3, 500n],
      ["Override", 1, 1250n],
    ]);
    expect(
      resolveLines([{ priceId: usd.id }], { scope: SCOPE, pricing: null, catalog, newId: ids }).lines[0]?.description,
    ).toBe("Pro plan");
  });
  it("refuses lines that do not fit", () => {
    const res = (lines: LineInput[], pricing = null as null | { currency: string; assetId: string | null }) =>
      code(() => resolveLines(lines, { scope: SCOPE, pricing, catalog, newId: ids }));
    expect(res([{ unitAmount: 1n, description: "x" }])).toBe("invalid_request"); // no currency
    expect(res([{ unitAmount: 1n, description: "x" }], { currency: "usd", assetId: null })).toBe("ok");
    expect(res([{ unitAmount: -1n, description: "x" }], { currency: "usd", assetId: null })).toBe("invalid_request");
    expect(res([{ priceId: usd.id }, { priceId: eur.id }])).toBe("currency_mismatch");
    expect(res([{ priceId: usd.id, quantity: 0 }])).toBe("invalid_request");
    expect(res([{ priceId: usd.id, quantity: 1.5 }])).toBe("invalid_request");
    expect(res([{ priceId: monthly.id }])).toBe("price_type_invalid");
    expect(res([{ priceId: "price_nope" }], { currency: "usd", assetId: null })).toBe("resource_missing");
    expect(res(Array.from({ length: 101 }, () => ({ priceId: usd.id })))).toBe("invalid_request");
    expect(res([])).toBe("ok");
  });
  it("applies invoice default tax rates to lines without their own", () => {
    const inv = draft(
      [{ priceId: usd.id }, { priceId: usd.id, taxRateIds: [] }, { priceId: usd.id, taxRateIds: [incl.id] }],
      [vat.id],
    );
    expect(inv.lines.map((l) => l.taxRateIds)).toEqual([[vat.id], [], [incl.id]]);
    expect(inv.lines.map(toDraft).map((l) => [l.taxRatesExplicit, l.taxRateIds])).toEqual([
      [false, []],
      [true, []],
      [true, [incl.id]],
    ]);
    // 1250 × 19 % = 237.5 → 238 (exclusive, line 1); inclusive 1250 × 19/119 = 199.58 → 200
    expect(inv.tax).toBe(238n + 200n);
    expect(inv.total).toBe(3750n + 238n);
    expect(inv.totalExcludingTax).toBe(inv.total - inv.tax);
    expect(inv.daysUntilDue).toBe(30);
  });
  it("validates reminder days", () => {
    expect(checkReminderDays([-30, 0, 60])).toEqual([-30, 0, 60]);
    expect(checkReminderDays([])).toEqual([]);
    for (const bad of [[1, 1], [2, 1], [-31], [61], [0.5], Array.from({ length: 11 }, (_, i) => i)])
      expect(code(() => checkReminderDays(bad))).toBe("invalid_request");
  });
  it("patches drafts and only metadata of issued invoices", () => {
    const d = draft();
    expect(patchInvoice(d, { description: "Memo", footer: "F", customerId: "cus_2" }, T0 + 1)).toMatchObject({
      description: "Memo",
      footer: "F",
      customerId: "cus_2",
    });
    expect(patchInvoice(d, { dueDate: T0 + 99 }, T0)).toMatchObject({ dueDate: T0 + 99, daysUntilDue: null });
    const fixed = patchInvoice(d, { dueDate: T0 + 99 }, T0);
    expect(patchInvoice(fixed, { dueDate: null }, T0)).toMatchObject({ dueDate: null, daysUntilDue: 30 });
    expect(patchInvoice(fixed, { daysUntilDue: 5 }, T0)).toMatchObject({ dueDate: null, daysUntilDue: 5 });
    expect(code(() => patchInvoice(d, { daysUntilDue: 5, dueDate: T0 + 5 }, T0))).toBe("invalid_request");
    expect(
      code(() =>
        newDraft(SCOPE, "in_x", T0, {
          currency: "usd",
          assetId: null,
          customerId: "c",
          lines: [],
          totals: d,
          daysUntilDue: 1,
          dueDate: T0,
        }),
      ),
    ).toBe("invalid_request");
    const o = open(d);
    expect(patchInvoice(o, { metadata: { a: "b" } }, T0).metadata).toEqual({ a: "b" });
    expect(code(() => patchInvoice(o, { description: "x" }, T0))).toBe("state_conflict");
    expect(
      patchInvoice(d, { reminderDays: [1, 2], settlementDestinationId: "sd_1", defaultTaxRateIds: [vat.id] }, T0),
    ).toMatchObject({
      reminderDays: [1, 2],
      settlementDestinationId: "sd_1",
    });
    expect(
      patchInvoice(
        d,
        { pricing: { currency: "eur", assetId: null }, priced: { lines: [], totals: { ...d, total: 0n } } },
        T0,
      ),
    ).toMatchObject({
      total: 0n,
      currency: "eur",
      lines: [],
    });
    expect(code(() => assertDeletable(o))).toBe("state_conflict");
    expect(code(() => assertDeletable(d))).toBe("ok");
  });
});

describe("invoice lifecycle", () => {
  it("finalizes with number, due date and secrets", () => {
    const o = open();
    expect(o).toMatchObject({
      status: "open",
      number: "PROT-00001",
      finalizedAt: T0 + 10,
      dueDate: T0 + 10 + 30 * 86_400,
      merchantName: "Acme",
    });
    const fixed = open(patchInvoice(draft(), { dueDate: T0 + 1000 }, T0));
    expect(fixed.dueDate).toBe(T0 + 1000);
  });
  it("refuses to finalize empty, zero or past-due drafts and non-drafts", () => {
    const empty = newDraft(SCOPE, "in_e", T0, {
      currency: "usd",
      assetId: null,
      customerId: "c",
      lines: [],
      totals: { subtotal: 0n, tax: 0n, total: 0n, totalExcludingTax: 0n, totalTaxAmounts: [] },
    });
    expect(code(() => open(empty))).toBe("invoice_empty");
    const zero = draft(
      [{ unitAmount: 0n, description: "free" } as LineInput].map((l) => l),
      [],
    );
    expect(code(() => open(zero))).toBe("invoice_empty");
    expect(code(() => open(patchInvoice(draft(), { dueDate: T0 + 5 }, T0), T0 + 5))).toBe("invalid_request");
    expect(code(() => open(open()))).toBe("state_conflict");
  });
  it("sends at most once per 10 minutes, only open/uncollectible", () => {
    const o = open();
    const s = markSent(o, T0 + 100);
    expect(s.sentAt).toBe(T0 + 100);
    const e = (() => {
      try {
        markSent(s, T0 + 699);
      } catch (x) {
        return x as DomainError;
      }
    })();
    expect(e?.code).toBe("rate_limited");
    expect(e?.params.retry_after).toBe(1);
    expect(markSent(s, T0 + 700).sentAt).toBe(T0 + 700);
    expect(code(() => markSent(draft(), T0))).toBe("state_conflict");
    expect(markSent(markUncollectible(o, T0, "merchant"), T0).sentAt).toBe(T0);
  });
  it("voids only open invoices whose session cannot settle", () => {
    const o = { ...open(), session: { id: "cs_1", expiresAt: T0 + 9, clientSecretEnc: new Uint8Array() } };
    expect(code(() => voidInvoice(o, T0, true))).toBe("attempt_in_flight");
    const v = voidInvoice(o, T0 + 5, false);
    expect(v).toMatchObject({ status: "void", voidedAt: T0 + 5, session: null });
    expect(code(() => voidInvoice(v, T0, false))).toBe("state_conflict");
    expect(code(() => voidInvoice(draft(), T0, false))).toBe("state_conflict");
  });
  it("marks uncollectible; it stays payable", () => {
    const u = markUncollectible(open(), T0 + 1, "merchant");
    expect(u).toMatchObject({
      status: "uncollectible",
      uncollectibleReason: "merchant",
      markedUncollectibleAt: T0 + 1,
    });
    expect(isPayable(u)).toBe(true);
    expect(code(() => markUncollectible(u, T0, "merchant"))).toBe("state_conflict");
  });
  it("has the domain-model edges", () => {
    expect(canTransition("draft", "open")).toBe(true);
    expect(canTransition("uncollectible", "paid")).toBe(true);
    expect(canTransition("paid", "void")).toBe(false);
    expect(canTransition("void", "paid")).toBe(false);
    expect(canTransition("draft", "paid")).toBe(false);
  });
  it("numbers invoices per account and mode", () => {
    expect(invoicePrefix("Acme Corp GmbH", false)).toBe("ACMECOT");
    expect(invoicePrefix("Café №1", true)).toBe(`${"CAFENO1L".slice(0, 6)}L`);
    expect(invoicePrefix("☃", false)).toBe("INVT");
    expect(formatInvoiceNumber("ACMECOT", 42)).toBe("ACMECOT-00042");
    expect(formatInvoiceNumber("A", 123456)).toBe("A-123456");
    expect(() => formatInvoiceNumber("A", 0)).toThrow(RangeError);
  });
});

describe("payments' events (INV-2, INV-3)", () => {
  const facts = (inv: Invoice, o: Partial<Parameters<typeof onIntentSucceeded>[1]> = {}) => ({
    id: "pi_1",
    status: "succeeded",
    invoiceId: inv.id,
    accountId: inv.accountId,
    livemode: inv.livemode,
    currency: inv.currency,
    assetId: inv.assetId,
    amount: inv.total,
    ...o,
  });

  it("pays an open or uncollectible invoice from a matching succeeded intent", () => {
    const o = open();
    const r = onIntentSucceeded(o, facts(o), T0 + 50);
    expect(r.kind).toBe("paid");
    if (r.kind !== "paid") return;
    expect(r.invoice).toMatchObject({
      status: "paid",
      paymentIntentId: "pi_1",
      paidAt: T0 + 50,
      amountPaid: o.total,
      paymentIntentIds: ["pi_1"],
    });
    expect(amountRemaining(r.invoice)).toBe(0n);
    expect(onIntentSucceeded(r.invoice, facts(o), T0 + 60).kind).toBe("duplicate");
    const u = markUncollectible(o, T0, "dunning_exhausted");
    expect(onIntentSucceeded(u, facts(u), T0).kind).toBe("paid");
  });
  it("never pays from a mismatching intent (fail closed)", () => {
    const o = open();
    const reason = (f: ReturnType<typeof facts>) => {
      const r = onIntentSucceeded(o, f, T0);
      return r.kind === "mismatch" ? r.reason : r.kind;
    };
    expect(reason(facts(o, { amount: o.total - 1n }))).toMatch(/below/);
    expect(reason(facts(o, { currency: "eur" }))).toMatch(/pricing/);
    expect(reason(facts(o, { status: "processing" }))).toMatch(/status/);
    expect(reason(facts(o, { invoiceId: "in_other" }))).toMatch(/not linked/);
    expect(reason(facts(o, { livemode: true }))).toMatch(/mode/);
    expect(reason(facts(o, { accountId: OTHER.accountId }))).toMatch(/account/);
    const d = draft();
    expect(onIntentSucceeded(d, facts(d), T0).kind).toBe("mismatch");
    expect(onIntentSucceeded(o, facts(o, { amount: o.total + 5n }), T0).kind).toBe("paid");
  });
  it("lists late money for paid and void invoices without changing them", () => {
    const o = open();
    const paid = onIntentSucceeded(o, facts(o), T0);
    if (paid.kind !== "paid") throw new Error("expected paid");
    const late = onIntentSucceeded(paid.invoice, facts(o, { id: "pi_2" }), T0 + 1);
    expect(late.kind).toBe("late");
    if (late.kind === "late")
      expect(late.invoice).toMatchObject({
        status: "paid",
        paymentIntentId: "pi_1",
        paymentIntentIds: ["pi_2", "pi_1"],
      });
    const v = voidInvoice(o, T0, false);
    const lv = onIntentSucceeded(v, facts(v), T0);
    expect(lv.kind).toBe("late");
    if (lv.kind === "late") expect(lv.invoice.status).toBe("void");
  });
  it("reports failed payments while payable and forgets expired sessions", () => {
    const o = open();
    expect(onIntentFailed(o, facts(o, { status: "requires_payment" }), T0).kind).toBe("failed");
    expect(onIntentFailed(voidInvoice(o, T0, false), facts(o), T0).kind).toBe("ignored");
    expect(onIntentFailed(o, facts(o, { invoiceId: null }), T0).kind).toBe("ignored");
    const withS = { ...o, session: { id: "cs_1", expiresAt: 1, clientSecretEnc: new Uint8Array() } };
    expect(onSessionExpired(withS, "cs_1", T0)?.session).toBeNull();
    expect(onSessionExpired(withS, "cs_0", T0)).toBeNull();
    expect(recordIntent(recordIntent(o, "pi_a"), "pi_a").paymentIntentIds).toEqual(["pi_a"]);
  });
});
