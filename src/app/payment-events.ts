/**
 * Consumers of payments' events (lld/billing.md §6). Each runs in one transaction with the inbox dedupe
 * (INV-4). Ordering is handled by the rules themselves rather than by intent versions: `paid` is final,
 * a `payment_failed` never changes an invoice's status, and an expired session is forgotten only when it is
 * still the invoice's current one.
 */

import type { Invoice } from "../domain/invoice/invoice.js";
import { type IntentFacts, onIntentFailed, onIntentSucceeded, onSessionExpired } from "../domain/invoice/payment.js";
import type { Scope } from "../domain/shared.js";
import { onInvoicePaid } from "../domain/subscription/subscription.js";
import { saveInvoice, saveSubscription } from "./commit.js";
import { clockS, renderPdfLater } from "./invoices.js";
import type { Billing, BillingTx } from "./ports.js";

export interface Incoming<T> {
  readonly eventId: string;
  readonly subject: string;
  readonly scope: Scope;
  readonly object: T;
}

const SYSTEM = "service:payments";

async function lockInvoice(b: Billing, tx: BillingTx, scope: Scope, invoiceId: string | null, eventId: string) {
  if (!invoiceId) return undefined;
  const inv = await tx.invoices.get(scope, invoiceId, { lock: true });
  if (!inv) b.log.error({ invoice: invoiceId, event: eventId }, "ALERT payments event for an unknown invoice");
  return inv;
}

/** After an invoice was paid: its subscription may become `active` again (and resume renewals). */
async function subscriptionAfterPaid(b: Billing, tx: BillingTx, inv: Invoice): Promise<void> {
  if (!inv.subscriptionId) return;
  const sub = await tx.subscriptions.get(inv, inv.subscriptionId, { lock: true });
  if (!sub) return;
  const otherOverdueOpen = await tx.invoices.countOverdueOpen(inv, sub.id, inv.id);
  const now = clockS(b, sub);
  const next = onInvoicePaid(sub, { invoiceId: inv.id, otherOverdueOpen }, now);
  if (!next) return;
  const saved = await saveSubscription(tx, sub, next, { actor: SYSTEM, cause: `invoice ${inv.id} paid` }, [
    "evt.billing.subscription.updated",
  ]);
  // paused subscriptions resume: the next renewal runs at current_period_end (immediately if past, §11 d8)
  if (sub.status === "incomplete" || sub.status === "unpaid")
    await tx.enqueue({
      kind: "subscription.renew",
      dedupeKey: `subscription.renew:${saved.id}:${saved.currentPeriodEnd}:resume${saved.version}`,
      runAt: Math.max(now, saved.currentPeriodEnd),
      clockOffset: saved.clockOffset ?? 0,
      payload: { subscription: saved.id, account_id: saved.accountId, livemode: saved.livemode },
    });
}

/** `evt.payments.payment_intent.succeeded` with `invoice` set → invoice paid (or a late settlement listed). */
export function onPaymentIntentSucceeded(b: Billing, e: Incoming<IntentFacts>): Promise<void> {
  return b.store.transaction(async (tx) => {
    if (!(await tx.consume(e.eventId, e.subject))) return;
    const inv = await lockInvoice(b, tx, e.scope, e.object.invoiceId, e.eventId);
    if (!inv) return;
    const out = onIntentSucceeded(inv, e.object, clockS(b, inv));
    const meta = {
      actor: SYSTEM,
      cause: `payment_intent ${e.object.id} succeeded`,
      evidence: { payment_intent: e.object.id, event: e.eventId },
    };
    switch (out.kind) {
      case "duplicate":
        return;
      case "paid": {
        const saved = await saveInvoice(tx, inv, out.invoice, meta, ["evt.billing.invoice.paid"]);
        await renderPdfLater(tx, saved);
        await subscriptionAfterPaid(b, tx, saved);
        return;
      }
      case "late":
        b.log.warn(
          { invoice: inv.id, payment_intent: e.object.id, status: inv.status },
          "late settlement for a closed invoice (merchant refunds it)",
        );
        if (out.invoice.paymentIntentIds !== inv.paymentIntentIds) await saveInvoice(tx, inv, out.invoice, meta);
        return;
      case "mismatch":
        b.log.error(
          { invoice: inv.id, payment_intent: e.object.id, reason: out.reason },
          "ALERT intent does not prove payment of the invoice",
        );
        if (out.invoice.paymentIntentIds !== inv.paymentIntentIds) await saveInvoice(tx, inv, out.invoice, meta);
        return;
    }
  });
}

/** `evt.payments.payment_intent.payment_failed` → `invoice.payment_failed`; the invoice stays open. */
export function onPaymentIntentFailed(b: Billing, e: Incoming<IntentFacts>): Promise<void> {
  return b.store.transaction(async (tx) => {
    if (!(await tx.consume(e.eventId, e.subject))) return;
    const inv = await lockInvoice(b, tx, e.scope, e.object.invoiceId, e.eventId);
    if (!inv) return;
    const out = onIntentFailed(inv, e.object, clockS(b, inv));
    const meta = { actor: SYSTEM, cause: `payment_intent ${e.object.id} failed` };
    if (out.kind === "failed") await saveInvoice(tx, inv, out.invoice, meta, ["evt.billing.invoice.payment_failed"]);
    else if (out.invoice !== inv) await saveInvoice(tx, inv, out.invoice, meta);
  });
}

/** `evt.payments.checkout_session.expired` → forget the session; the next hosted-page visit opens a new one. */
export function onCheckoutSessionExpired(
  b: Billing,
  e: Incoming<{ readonly id: string; readonly invoiceId: string | null }>,
): Promise<void> {
  return b.store.transaction(async (tx) => {
    if (!(await tx.consume(e.eventId, e.subject))) return;
    if (!e.object.invoiceId) return;
    const inv = await tx.invoices.get(e.scope, e.object.invoiceId, { lock: true });
    if (!inv) return;
    const next = onSessionExpired(inv, e.object.id, clockS(b, inv));
    if (next) await saveInvoice(tx, inv, next, { actor: SYSTEM, cause: `checkout_session ${e.object.id} expired` });
  });
}
