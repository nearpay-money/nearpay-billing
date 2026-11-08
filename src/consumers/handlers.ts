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
 * | evt.payments.payment_intent.expired | the same, for the intent's checkout session |
 */

import { CheckoutSession, PaymentIntent } from "@nearpay/spec";
import type { EventHandler } from "@nearpay-internal/bus";
import type { Envelope } from "@nearpay-internal/db";
import { deadLetterSink, type Kysely } from "@nearpay-internal/db";
import type { Subject } from "@nearpay-internal/spec";
import { onCheckoutSessionExpired, onPaymentIntentFailed, onPaymentIntentSucceeded } from "../app/payment-events.js";
import type { Billing } from "../app/ports.js";
import { onVaultEvent, type VaultEventRecord } from "../app/vault-events.js";
import type { IntentFacts } from "../domain/invoice/payment.js";
import type { Scope } from "../domain/shared.js";
import type { DB } from "../infra/db/schema.js";
import { VaultEventRecord as VaultEventRecordSchema } from "../spec-0.4.0.js";

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
    destinationFingerprint: pi.destination?.fingerprint ?? null,
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
    "evt.payments.payment_intent.expired": async (e) => {
      const pi = PaymentIntent.parse(e.data.object);
      if (!pi.invoice || !pi.checkout_session) return;
      await onCheckoutSessionExpired(b, {
        eventId: e.id,
        subject: e.subject,
        scope: scopeOf(e),
        object: { id: pi.checkout_session, invoiceId: pi.invoice },
      });
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

/**
 * `evt.rails.vault.event` (spec 0.4.0, lld/billing.md §6): the envelope has no account (`account_id` null)
 * and `livemode` = the vault's mode; the scope comes from the mandate / the subscription its `ext_ref`
 * names. A payload that does not parse is parked, never thrown (the stream must not block on one event).
 * Registered in `billingHandlers` with the 0.4.0 bump (Phase B: the subject is not in the 0.3.1 catalogue).
 */
export function vaultEventHandler(b: Billing): EventHandler {
  return async (e) => {
    if (e.livemode === null) {
      b.log.error({ event: e.id }, "ALERT vault event without livemode: ignored");
      return;
    }
    const parsed = VaultEventRecordSchema.safeParse(e.data.object);
    if (!parsed.success) {
      b.log.error({ event: e.id, error: parsed.error.message.slice(0, 500) }, "ALERT unparsable vault event parked");
      await b.store.transaction((tx) =>
        tx.vaultEvents.park({
          dedupeKey: `envelope:${e.id}`,
          vaultContract: null,
          livemode: e.livemode,
          onchainId: null,
          event: null,
          reason: "bad_schema",
          error: parsed.error.message.slice(0, 1000),
          payload: e.data.object,
          retryAt: null,
        }),
      );
      return;
    }
    await onVaultEvent(b, { livemode: e.livemode, record: parsed.data as unknown as VaultEventRecord });
  };
}

export const deadLetters = (db: Kysely<DB>) => deadLetterSink(db, "consumer:billing");
