/**
 * Consumed subjects (lld/billing.md §6, spec 0.3.0 catalogue) → use cases. Each use case runs one
 * transaction with the inbox dedupe (INV-4). Objects are parsed with the spec schemas; an unparsable event
 * throws (the bus redelivers, then dead-letters). The scope comes from the envelope (`account_id`,
 * `livemode`), never from the object alone (INV-8).
 *
 * | Subject | Effect |
 * |---|---|
 * | evt.payments.payment_intent.succeeded | `invoice` set → invoice paid (or late money listed) |
 * | evt.payments.payment_intent.payment_failed | `invoice.payment_failed`; the invoice stays open |
 * | evt.payments.checkout_session.expired | forget the invoice's session (a new one opens lazily) |
 */

import { CheckoutSession, PaymentIntent } from "@nearpay/spec";
import type { EventHandler } from "@nearpay-internal/bus";
import type { Envelope } from "@nearpay-internal/db";
import { deadLetterSink, type Kysely } from "@nearpay-internal/db";
import type { Subject } from "@nearpay-internal/spec";
import { onCheckoutSessionExpired, onPaymentIntentFailed, onPaymentIntentSucceeded } from "../app/payment-events.js";
import type { Billing } from "../app/ports.js";
import type { IntentFacts } from "../domain/invoice/payment.js";
import type { Scope } from "../domain/shared.js";
import type { DB } from "../infra/db/schema.js";

function scopeOf(e: Envelope): Scope {
  if (!e.account_id || e.livemode === null) throw new Error(`${e.subject} ${e.id} has no account scope`);
  return { accountId: e.account_id, livemode: e.livemode };
}

export function intentFacts(e: Envelope): IntentFacts {
  const pi = PaymentIntent.parse(e.data.object);
  const scope = scopeOf(e);
  return {
    id: pi.id,
    status: pi.status,
    invoiceId: pi.invoice ?? null,
    accountId: scope.accountId,
    // the object's own mode must agree with the envelope's (INV-8); a disagreement can never pay
    livemode: pi.livemode === scope.livemode ? scope.livemode : !scope.livemode,
    currency: pi.currency,
    assetId: pi.asset_id,
    amount: BigInt(pi.amount),
  };
}

export function billingHandlers(b: Billing): Partial<Record<Subject, EventHandler>> {
  return {
    "evt.payments.payment_intent.succeeded": async (e) => {
      const object = intentFacts(e);
      if (!object.invoiceId) return;
      await onPaymentIntentSucceeded(b, { eventId: e.id, subject: e.subject, scope: scopeOf(e), object });
    },
    "evt.payments.payment_intent.payment_failed": async (e) => {
      const object = intentFacts(e);
      if (!object.invoiceId) return;
      await onPaymentIntentFailed(b, { eventId: e.id, subject: e.subject, scope: scopeOf(e), object });
    },
    "evt.payments.checkout_session.expired": async (e) => {
      const cs = CheckoutSession.parse(e.data.object);
      if (!cs.invoice) return;
      await onCheckoutSessionExpired(b, {
        eventId: e.id,
        subject: e.subject,
        scope: scopeOf(e),
        object: { id: cs.id, invoiceId: cs.invoice },
      });
    },
  };
}

export const deadLetters = (db: Kysely<DB>) => deadLetterSink(db, "consumer:billing");
