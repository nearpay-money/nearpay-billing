/**
 * How payments' events move an invoice (lld/billing.md §6, §11 d4, d10). Billing never sees funds: it
 * learns "paid" only from `evt.payments.payment_intent.succeeded` for an intent whose `invoice` is this
 * invoice — payments sets `succeeded` only on verified settlement evidence (INV-2). Billing still checks
 * the intent itself (status, link, mode, pricing, amount ≥ amount remaining) and fails closed: a mismatch
 * is recorded and alerted, never turned into `paid`. Settlements for an already `paid`/`void` invoice are
 * listed (INV-3) and left to the merchant to refund. Pure.
 */
import { type Pricing, type Scope, samePricing } from "../shared.js";
import { amountRemaining, type Invoice, isPayable, markPaid, recordIntent } from "./invoice.js";

/** The facts billing reads from a payment intent event object. */
export interface IntentFacts extends Scope, Pricing {
  readonly id: string;
  readonly status: string;
  readonly invoiceId: string | null;
  /** Amount the intent was priced at (invoice currency units). */
  readonly amount: bigint;
}

export type SucceededOutcome =
  | { readonly kind: "paid"; readonly invoice: Invoice }
  /** Money arrived for a `paid`/`void` invoice (or a second intent): listed, status unchanged. */
  | { readonly kind: "late"; readonly invoice: Invoice }
  /** The intent does not prove payment of this invoice; nothing changes but the record (alert). */
  | { readonly kind: "mismatch"; readonly invoice: Invoice; readonly reason: string }
  | { readonly kind: "duplicate" };

function linked(inv: Invoice, pi: IntentFacts): string | null {
  if (pi.invoiceId !== inv.id) return "intent is not linked to this invoice";
  if (pi.accountId !== inv.accountId || pi.livemode !== inv.livemode) return "account or mode differs";
  return null;
}

export function onIntentSucceeded(inv: Invoice, pi: IntentFacts, now: number): SucceededOutcome {
  const why = linked(inv, pi);
  if (why) return { kind: "mismatch", invoice: inv, reason: why };
  if (inv.paymentIntentId === pi.id) return { kind: "duplicate" };
  const recorded = recordIntent(inv, pi.id);
  if (pi.status !== "succeeded") return { kind: "mismatch", invoice: recorded, reason: `intent status ${pi.status}` };
  if (inv.status === "draft") return { kind: "mismatch", invoice: recorded, reason: "invoice is a draft" };
  if (!isPayable(inv)) return { kind: "late", invoice: { ...recorded, updated: now } };
  if (!samePricing(pi, inv)) return { kind: "mismatch", invoice: recorded, reason: "pricing differs" };
  if (pi.amount < amountRemaining(inv))
    return { kind: "mismatch", invoice: recorded, reason: `intent amount ${pi.amount} below ${amountRemaining(inv)}` };
  return { kind: "paid", invoice: markPaid(recorded, now, pi.id) };
}

export type FailedOutcome =
  | { readonly kind: "failed"; readonly invoice: Invoice }
  | { readonly kind: "ignored"; readonly invoice: Invoice; readonly reason: string };

/** `payment_intent.payment_failed`: the invoice stays as it is (`invoice.payment_failed` while payable). */
export function onIntentFailed(inv: Invoice, pi: IntentFacts, now: number): FailedOutcome {
  const why = linked(inv, pi);
  if (why) return { kind: "ignored", invoice: inv, reason: why };
  const recorded = { ...recordIntent(inv, pi.id), updated: now };
  if (!isPayable(inv)) return { kind: "ignored", invoice: recorded, reason: `invoice is ${inv.status}` };
  return { kind: "failed", invoice: recorded };
}

/** `checkout_session.expired`: forget the session if it is the current one (a new one opens lazily). */
export function onSessionExpired(inv: Invoice, sessionId: string, now: number): Invoice | null {
  if (inv.session?.id !== sessionId) return null;
  return { ...inv, session: null, updated: now };
}
