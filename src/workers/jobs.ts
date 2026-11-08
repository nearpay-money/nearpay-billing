/**
 * Durable jobs of the billing worker (lld/billing.md §7) → use cases. Payloads carry the account uuid and
 * mode so every handler reads in scope (INV-8). Handlers are re-entrant (locks + state checks), so the
 * kit's at-least-once job runner may repeat them safely.
 */
import { z } from "zod";
import { exhaustJob, overdueJob, remindJob } from "../app/dunning.js";
import { renderInvoicePdfJob } from "../app/pdf.js";
import type { Billing, JobKind } from "../app/ports.js";
import { renewalUpcomingJob, renewJob } from "../app/subscriptions.js";

const scoped = { account_id: z.uuid(), livemode: z.boolean(), at: z.int().optional() };
const InvoicePayload = z.object({ invoice: z.string().startsWith("in_"), ...scoped });
const ReminderPayload = InvoicePayload.extend({ number: z.int().min(1).max(10) });
const SubscriptionPayload = z.object({
  subscription: z.string().startsWith("sub_"),
  ...scoped,
  period_end: z.int().optional(),
});

const scopeOf = (p: { account_id: string; livemode: boolean }) => ({ accountId: p.account_id, livemode: p.livemode });

export type JobHandlers = Record<JobKind, (payload: unknown) => Promise<void>>;

export function jobHandlers(b: Billing): JobHandlers {
  return {
    "invoice.remind": (raw) => {
      const p = ReminderPayload.parse(raw);
      return remindJob(b, { invoice: p.invoice, scope: scopeOf(p), number: p.number, at: p.at });
    },
    "invoice.overdue": (raw) => {
      const p = InvoicePayload.parse(raw);
      return overdueJob(b, { invoice: p.invoice, scope: scopeOf(p), at: p.at });
    },
    "invoice.dunning_exhausted": (raw) => {
      const p = InvoicePayload.parse(raw);
      return exhaustJob(b, { invoice: p.invoice, scope: scopeOf(p), at: p.at });
    },
    "invoice.render_pdf": (raw) => {
      const p = InvoicePayload.parse(raw);
      return renderInvoicePdfJob(b, { invoice: p.invoice, scope: scopeOf(p) });
    },
    "subscription.renew": (raw) => {
      const p = SubscriptionPayload.parse(raw);
      return renewJob(b, { subscription: p.subscription, scope: scopeOf(p), at: p.at });
    },
    "subscription.renewal_upcoming": (raw) => {
      const p = SubscriptionPayload.parse(raw);
      return renewalUpcomingJob(b, {
        subscription: p.subscription,
        scope: scopeOf(p),
        periodEnd: p.period_end ?? 0,
      });
    },
  };
}
