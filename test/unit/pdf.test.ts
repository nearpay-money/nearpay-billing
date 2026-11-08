import { describe, expect, it } from "vitest";
import type { InvoiceDocument } from "../../src/app/pdf.js";
import { finalize, type Invoice, newDraft } from "../../src/domain/invoice/invoice.js";
import { type LineDraft, priceLines } from "../../src/domain/invoice/lines.js";
import { fitText, invoicePdfRenderer, money, textWidth, winAnsi } from "../../src/infra/pdf/invoice-pdf.js";
import { mapOf, SCOPE, T0, taxRate } from "../support/fixtures.js";

const vat = taxRate({ jurisdiction: "DE" });
const incl = taxRate({ inclusive: true, percentage: "7.7", displayName: "MWST" });

function invoice(n: number, o: { currency?: string; assetId?: string | null; period?: boolean } = {}): Invoice {
  const drafts: LineDraft[] = Array.from({ length: n }, (_, i) => ({
    id: `il_${i}`,
    type: o.period ? "subscription" : "invoiceitem",
    priceId: null,
    productId: null,
    subscriptionItemId: null,
    description:
      i === 0
        ? "Consulting (Grüße) — a very long description that will certainly not fit into its column at all"
        : `Line ${i}`,
    quantity: i + 1,
    unitAmount: 1999n,
    taxRateIds: i % 2 ? [incl.id] : [vat.id],
    taxRatesExplicit: true,
    period: o.period ? { start: T0, end: T0 + 30 * 86_400 } : null,
  }));
  const priced = priceLines(drafts, [], { scope: SCOPE, taxRates: mapOf(vat, incl), requireActive: true });
  const d = newDraft(SCOPE, "in_0000000000000000000000000a", T0, {
    currency: o.currency ?? "eur",
    assetId: o.assetId ?? null,
    customerId: "cus_1",
    lines: priced.lines,
    totals: priced.totals,
    description: "Thanks for your business",
    footer: "Acme GmbH · Berlin",
    period: o.period ? { start: T0, end: T0 + 30 * 86_400 } : null,
  });
  return finalize(d, {
    now: T0,
    number: "ACMEGMT-00042",
    hosted: { secretHash: new Uint8Array(), secretEnc: new Uint8Array(), billToEnc: null },
    merchantName: "Acme GmbH",
    priced,
  });
}

const doc = (inv: Invoice, stamp: InvoiceDocument["stamp"] = null): InvoiceDocument => ({
  invoice: inv,
  merchantName: "Acme GmbH",
  billTo: { name: "Pat Payer", email: "pat@example.com" },
  pricingAsset: inv.currency === "asset" ? { assetId: "nep141:usdc.near", symbol: "USDC", decimals: 6 } : null,
  stamp,
});

/** Checks the xref table: every offset points at its `N 0 obj`. */
function checkStructure(bytes: Uint8Array): { pages: number; text: string } {
  const text = Buffer.from(bytes).toString("latin1");
  expect(text.startsWith("%PDF-1.4\n")).toBe(true);
  expect(text.trimEnd().endsWith("%%EOF")).toBe(true);
  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)?.[1]);
  expect(text.slice(startxref, startxref + 4)).toBe("xref");
  const rows = text.slice(startxref).split("\n").slice(3);
  const size = Number(/\/Size (\d+)/.exec(text)?.[1]);
  for (let i = 1; i < size; i++) {
    const off = Number(rows[i - 1]?.slice(0, 10));
    expect(text.slice(off, off + `${i} 0 obj`.length)).toBe(`${i} 0 obj`);
  }
  for (const m of text.matchAll(/<< \/Length (\d+) >>\nstream\n/g)) {
    const start = (m.index ?? 0) + m[0].length;
    expect(text.slice(start + Number(m[1]), start + Number(m[1]) + 10)).toBe("\nendstream");
  }
  return { pages: Number(/\/Count (\d+)/.exec(text)?.[1]), text };
}

describe("invoice PDF", () => {
  const render = invoicePdfRenderer();

  it("is a well-formed, deterministic PDF with the invoice content", () => {
    const inv = invoice(3);
    const a = render.render(doc(inv));
    const b = render.render(doc(inv));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const { pages, text } = checkStructure(a);
    expect(pages).toBe(1);
    expect(text).toContain("(ACMEGMT-00042)");
    expect(text).toContain("(Pat Payer)");
    expect(text).toContain("(TEST MODE - not a real invoice)");
    expect(text).toContain(`(${money(inv.total, doc(inv))})`);
    expect(text).toContain("(VAT \\(DE\\) 19%)");
    expect(text).toContain("(MWST 7.7% incl.)");
    expect(text).toContain("Gr\xfc\xdfe"); // WinAnsi
    expect(text).not.toContain("secret");
  });

  it("paginates long invoices and stamps status changes", () => {
    const { pages, text } = checkStructure(render.render(doc(invoice(70, { period: true }), "PAID")));
    expect(pages).toBe(3);
    expect(text).toContain("(PAID)");
    expect(text).toContain("(Page 3/3)");
    expect(text).toContain("(continued\\))");
  });

  it("formats fiat and asset amounts exactly (no floats)", () => {
    const eur = doc(invoice(1));
    expect(money(123456n, eur)).toBe("EUR 1234.56");
    const jpy = doc(invoice(1, { currency: "jpy" }));
    expect(money(5000n, jpy)).toBe("JPY 5000");
    const asset = doc(invoice(1, { currency: "asset", assetId: "nep141:usdc.near" }));
    expect(money(12_345_678_901_234_567_890n, asset)).toBe("12345678901234.56789 USDC");
    expect(money(1_000_000n, asset)).toBe("1.00 USDC");
    expect(money(5n, { ...asset, pricingAsset: null })).toBe("5 (nep141:usdc.near)");
    checkStructure(render.render(asset));
  });

  it("measures and fits text", () => {
    expect(textWidth("ii", "F1", 10)).toBeCloseTo(4.44);
    expect(textWidth("ii", "F2", 10)).toBeCloseTo(5.56);
    expect(fitText("short", "F1", 10, 100)).toBe("short");
    expect(textWidth(fitText("x".repeat(200), "F1", 10, 100), "F1", 10)).toBeLessThanOrEqual(100);
    expect(winAnsi("日本 ok")).toBe("?? ok");
  });
});
