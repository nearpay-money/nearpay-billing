/**
 * Invoice PDFs (lld/billing.md §11 d11): rendered at finalize and re-rendered on each later status change
 * with a status stamp; served to the merchant (`GET /v1/invoices/{id}/pdf`) and to the holder of the invoice
 * secret (`GET …/public/pdf`). The document is a pure function of the frozen invoice, so a missing object
 * is simply rendered again (same bytes for the same status).
 */
import type { Invoice } from "../domain/invoice/invoice.js";
import { missing, stateConflict } from "../domain/shared.js";
import type { Ctx } from "./commit.js";
import { saveInvoice } from "./commit.js";
import { checkSecret } from "./hosted.js";
import { billToOf } from "./invoices.js";
import type { AssetFacts, Billing } from "./ports.js";

export interface InvoiceDocument {
  readonly invoice: Invoice;
  readonly merchantName: string;
  readonly billTo: { readonly name: string | null; readonly email: string | null };
  /** Display data of the pricing asset (asset invoices); null for fiat. */
  readonly pricingAsset: AssetFacts | null;
  readonly stamp: "PAID" | "VOID" | "UNCOLLECTIBLE" | null;
}

/** Pure renderer (templates/invoice-pdf). */
export interface PdfRenderer {
  render(doc: InvoiceDocument): Uint8Array;
}

export const pdfKey = (inv: Invoice): string =>
  `invoices/${inv.accountId}/${inv.livemode ? "live" : "test"}/${inv.id}/${inv.status}.pdf`;

const STAMPS = { paid: "PAID", void: "VOID", uncollectible: "UNCOLLECTIBLE" } as const;

async function render(b: Billing, inv: Invoice): Promise<Uint8Array> {
  const asset = inv.assetId ? ((await b.assets.asset(inv.assetId)) ?? null) : null;
  const bytes = b.pdf.render({
    invoice: inv,
    merchantName: inv.merchantName ?? "",
    billTo: billToOf(b, inv),
    pricingAsset: asset,
    stamp: inv.status in STAMPS ? STAMPS[inv.status as keyof typeof STAMPS] : null,
  });
  await b.objects.put(pdfKey(inv), bytes, "application/pdf");
  return bytes;
}

/** The current PDF of a finalized invoice (stored copy, or rendered and stored now). */
export async function invoicePdf(b: Billing, inv: Invoice): Promise<Uint8Array> {
  if (inv.status === "draft") throw stateConflict("invoice", inv.status);
  const stored = inv.pdfObjectKey === pdfKey(inv) ? await b.objects.get(inv.pdfObjectKey) : undefined;
  return stored ?? render(b, inv);
}

export async function getInvoicePdf(b: Billing, c: Ctx, id: string): Promise<{ invoice: Invoice; pdf: Uint8Array }> {
  const inv = await b.store.transaction((tx) => tx.invoices.get(c.scope, id));
  if (!inv) throw missing("invoice", id);
  return { invoice: inv, pdf: await invoicePdf(b, inv) };
}

export async function getPublicInvoicePdf(
  b: Billing,
  id: string,
  secret: string,
): Promise<{ invoice: Invoice; pdf: Uint8Array }> {
  const inv = checkSecret(await b.store.transaction((tx) => tx.invoices.getByIdUnscoped(id)), id, secret);
  return { invoice: inv, pdf: await invoicePdf(b, inv) };
}

/** Job `invoice.render_pdf`: render the current status and remember the object key. */
export async function renderInvoicePdfJob(
  b: Billing,
  j: { readonly invoice: string; readonly scope: { readonly accountId: string; readonly livemode: boolean } },
): Promise<void> {
  const inv = await b.store.transaction((tx) => tx.invoices.get(j.scope, j.invoice));
  if (!inv || inv.status === "draft") return;
  await render(b, inv);
  await b.store.transaction(async (tx) => {
    const cur = await tx.invoices.get(j.scope, j.invoice, { lock: true });
    if (!cur || cur.status !== inv.status || cur.pdfObjectKey === pdfKey(cur)) return;
    await saveInvoice(tx, cur, { ...cur, pdfObjectKey: pdfKey(cur) }, { actor: "system:pdf", cause: "pdf rendered" });
  });
}
