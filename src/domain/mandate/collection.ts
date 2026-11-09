/**
 * What a vault `collected` event does to the invoice it pays (lld/billing.md v1.7 §7.1, §14 d6; INV-2,
 * INV-3). The evidence is the forwarded event, never the keeper's RPC response:
 * - full merchant share and the period covers the invoice → `paid` (with `mandate_collection`);
 *   `fee = "0"` while `fee_bps > 0` → still paid, ops alert (treasury not registered / blocklisted);
 * - short merchant share (partial delivery) or a period worth less than the invoice → not paid: the
 *   invoice is voided with the collection recorded, a `send_invoice` balance invoice bills the shortfall and
 *   a case is opened;
 * - the invoice is already `paid`/`void` → `late` (listed; the merchant refunds, like an overpayment);
 * - an invoice whose pricing the token cannot pay (cannot happen for a linked mandate) → `mismatch`:
 *   recorded, case opened, the invoice untouched;
 * - no invoice to apply it to (someone else's permissionless `collect` ran early) → `unapplied`: the next
 *   auto-debit invoice of the mandate is paid by it instead of a new collect.
 * Pure.
 */
import { reminderSchedule } from "../dunning/dunning.js";
import { type Invoice, isPayable, type MandateCollectionEvidence } from "../invoice/invoice.js";
import { stateConflict } from "../shared.js";
import type { Collection, Mandate } from "./mandate.js";
import { expectedShare } from "./mandate.js";
import { fromTokenUnitsCeil, tokenAssetId, toTokenUnits } from "./terms.js";

export type CollectionOutcome =
  | { readonly kind: "paid"; readonly feeLegFailed: boolean }
  | { readonly kind: "short"; readonly shortfallToken: bigint; readonly shortfall: bigint }
  | { readonly kind: "late" }
  | { readonly kind: "unapplied" }
  /** The invoice's pricing cannot be valued in the mandate's token (never linked like this): ops case. */
  | { readonly kind: "mismatch" };

/** Whether the collection is short of the expected merchant share (partial delivery, contracts-vault §3.2). */
export const isShort = (m: Pick<Mandate, "amountPerPeriod" | "feeBps">, merchantShare: bigint): boolean =>
  merchantShare < expectedShare(m);

/**
 * Classifies a collection for `invoice` (null = none to apply it to). `decimals` = the token's decimals
 * (the invoice is priced in USD cents or the token itself, §14 d2).
 */
export function classifyCollection(
  m: Pick<Mandate, "amountPerPeriod" | "feeBps" | "token">,
  c: Pick<Collection, "merchantShare" | "fee">,
  invoice: Invoice | null,
  decimals: number,
): CollectionOutcome {
  if (!invoice) return { kind: "unapplied" };
  if (!isPayable(invoice)) return { kind: "late" };
  const short = isShort(m, c.merchantShare);
  // what the payer actually paid for this invoice: the whole period, or only the delivered share (no fee
  // is taken after a partial delivery; the rest stayed in the mandate's balance)
  const covered = short ? c.merchantShare : m.amountPerPeriod;
  const owed = toTokenUnits(invoice.total - invoice.amountPaid, invoice, m.token, decimals);
  if (owed === null) return { kind: "mismatch" };
  if (!short && covered >= owed) return { kind: "paid", feeLegFailed: c.fee === 0n && m.feeBps > 0 };
  const shortfallToken = owed > covered ? owed - covered : 0n;
  return { kind: "short", shortfallToken, shortfall: fromTokenUnitsCeil(shortfallToken, invoice, decimals) };
}

/** The evidence written on an invoice paid (or applied to) by a collection (spec `Invoice.mandate_collection`). */
export function evidenceOf(m: Pick<Mandate, "id" | "token">, c: Collection): MandateCollectionEvidence {
  return {
    mandateId: m.id,
    period: c.period,
    assetId: tokenAssetId(m.token),
    merchantShare: c.merchantShare,
    fee: c.fee,
    txHash: c.txHash,
    receiptId: c.receiptId,
  };
}

/**
 * The keeper gives up on an `auto_debit` invoice (insufficient balance, repeated failures, mandate
 * released/canceled/exhausted): it becomes a `send_invoice` invoice the customer pays on the hosted page.
 * Reminders whose time has already passed while it was collected are skipped (like offsets already past
 * at finalize), so the remaining ones go out in order.
 */
export function fallbackToSendInvoice(inv: Invoice, now: number): Invoice {
  if (inv.collectionMethod !== "auto_debit" || !isPayable(inv)) throw stateConflict("invoice", inv.status);
  const past =
    inv.dueDate === null || inv.finalizedAt === null
      ? 0
      : reminderSchedule(inv.dueDate, inv.reminderDays, inv.finalizedAt).filter((r) => r.at < now).length;
  return {
    ...inv,
    collectionMethod: "send_invoice",
    remindersSent: Math.max(inv.remindersSent, past),
    updated: now,
  };
}

/** A payable invoice of the subscription is collected from this mandate from now on (first invoice, §14 d4). */
export function switchToAutoDebit(inv: Invoice, mandateId: string, now: number): Invoice {
  if (!isPayable(inv) || inv.subscriptionId === null) throw stateConflict("invoice", inv.status);
  return { ...inv, collectionMethod: "auto_debit", mandateId, updated: now };
}
