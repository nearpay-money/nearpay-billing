/**
 * Notification contexts for notify (lld/billing.md §5, §11 d5): personal data and the hosted link (which
 * embeds the invoice secret) are served here only — never put on the bus. Internal routes, service scope
 * `billing.read`; they act in the row's own scope.
 */
import { amountRemaining, type Invoice, isPayable } from "../domain/invoice/invoice.js";
import { priceLines } from "../domain/invoice/lines.js";
import type { NearTx } from "../domain/mandate/funding.js";
import type { Mandate } from "../domain/mandate/mandate.js";
import { tokenAssetId } from "../domain/mandate/terms.js";
import { missing } from "../domain/shared.js";
import { periodLines, periodOf, type Subscription } from "../domain/subscription/subscription.js";
import { hostedInvoiceUrl, loadCatalog } from "./invoices.js";
import { payerTransactions } from "./mandates.js";
import type { AssetFacts, Billing } from "./ports.js";

interface Party {
  readonly merchantDisplayName: string;
  readonly customerEmail: string | null;
  readonly customerName: string | null;
  readonly pricingAsset: AssetFacts | null;
}

async function party(b: Billing, row: Invoice | Subscription): Promise<Party> {
  const [m, c, asset] = await Promise.all([
    b.merchant.context(row),
    b.payments.getCustomer(row, row.customerId),
    row.assetId ? b.assets.asset(row.assetId) : Promise.resolve(undefined),
  ]);
  const usable = c && !c.deleted;
  return {
    merchantDisplayName: m.displayName,
    customerEmail: usable ? c.email : null,
    customerName: usable ? c.name : null,
    pricingAsset: asset ?? null,
  };
}

export interface InvoiceNotificationData extends Party {
  readonly invoice: Invoice;
  readonly amountRemaining: bigint;
  readonly hostedInvoiceUrl: string | null;
  readonly reminder: { readonly number: number; readonly offsetDays: number; readonly last: boolean } | null;
}

export async function invoiceNotificationContext(
  b: Billing,
  id: string,
  reminder?: number,
): Promise<InvoiceNotificationData> {
  const inv = await b.store.transaction((tx) => tx.invoices.getByIdUnscoped(id));
  if (!inv || inv.status === "draft") throw missing("invoice", id);
  const r = reminder === undefined ? undefined : inv.reminderDays[reminder - 1];
  return {
    ...(await party(b, inv)),
    invoice: inv,
    amountRemaining: amountRemaining(inv),
    hostedInvoiceUrl: inv.status === "void" ? null : hostedInvoiceUrl(b, inv),
    reminder:
      reminder === undefined || r === undefined
        ? null
        : { number: reminder, offsetDays: r, last: reminder === inv.reminderDays.length },
  };
}

export interface SubscriptionNotificationData extends Party {
  readonly subscription: Subscription;
  readonly renewsAt: number;
  readonly nextAmount: bigint;
  readonly items: readonly { readonly description: string; readonly quantity: number }[];
}

export async function subscriptionNotificationContext(b: Billing, id: string): Promise<SubscriptionNotificationData> {
  const sub = await b.store.transaction((tx) => tx.subscriptions.getByIdUnscoped(id));
  if (!sub) throw missing("subscription", id);
  const next = await b.store.transaction(async (tx) => {
    const catalog = await loadCatalog(tx, sub, {
      priceIds: sub.items.map((i) => i.priceId),
      taxRateIds: [...sub.defaultTaxRateIds, ...sub.items.flatMap((i) => i.taxRateIds ?? [])],
    });
    const drafts = periodLines(sub, periodOf(sub, sub.nextPeriodIndex), catalog, () => "il_preview");
    return priceLines(drafts, sub.defaultTaxRateIds, { scope: sub, taxRates: catalog.taxRates, requireActive: false });
  });
  return {
    ...(await party(b, sub)),
    subscription: sub,
    renewsAt: sub.currentPeriodEnd,
    nextAmount: next.totals.total,
    items: next.lines.map((l) => ({ description: l.description, quantity: l.quantity })),
  };
}

// ---------------------------------------------------------------------------------------------
// Mandate mails (lld/billing.md v1.7 §14 d11)
// ---------------------------------------------------------------------------------------------

export interface MandateNotificationData {
  readonly mandate: Mandate;
  readonly subscription: Subscription | null;
  readonly merchantDisplayName: string;
  readonly customerEmail: string | null;
  readonly customerName: string | null;
  readonly tokenAsset: AssetFacts | null;
  readonly cancelTx: NearTx | null;
  readonly withdrawTx: NearTx | null;
  /** The invoice that fell back to `send_invoice` (`mandate.insufficient_funds`); null otherwise. */
  readonly invoiceId: string | null;
  /** Hosted page of the subscription's latest invoice (with its secret) — PII-grade, never in events. */
  readonly manageUrl: string | null;
}

/** `getMandateNotificationContext` (acts in the mandate's own scope). */
export async function mandateNotificationContext(b: Billing, id: string): Promise<MandateNotificationData> {
  const r = await b.store.transaction(async (tx) => {
    const m = await tx.mandates.getByIdUnscoped(id);
    if (!m) throw missing("mandate", id);
    // a mode-mismatched mandate names a subscription of the other mode: read it in its own row's scope
    const sub = (await tx.subscriptions.getByIdUnscoped(m.subscriptionId)) ?? null;
    const latest = sub?.latestInvoiceId ? await tx.invoices.get(sub, sub.latestInvoiceId) : undefined;
    return { m, sub, latest };
  });
  const { m, sub, latest } = r;
  const [merchant, customer, asset] = await Promise.all([
    b.merchant.context(m),
    sub ? b.payments.getCustomer(sub, sub.customerId) : Promise.resolve(undefined),
    b.assets.asset(tokenAssetId(m.token)),
  ]);
  const usable = customer && !customer.deleted;
  const tx = payerTransactions(m);
  const fellBack =
    latest && latest.mandateId === m.id && latest.collectionMethod === "send_invoice" && isPayable(latest);
  return {
    mandate: m,
    subscription: sub,
    merchantDisplayName: merchant.displayName,
    customerEmail: usable ? customer.email : null,
    customerName: usable ? customer.name : null,
    tokenAsset: asset ?? null,
    cancelTx: tx.cancel,
    withdrawTx: tx.withdraw,
    invoiceId: fellBack ? latest.id : null,
    manageUrl: latest && latest.status !== "void" ? hostedInvoiceUrl(b, latest) : null,
  };
}
