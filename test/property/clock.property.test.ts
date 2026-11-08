/**
 * Test-mode billing clock (lld/billing.md §13) under random sequences of advances, payments and real time:
 * the clock only moves forward (by exactly the reported amount, to the reported time), each period is
 * invoiced at most once, and every invoice's reminders go out at most once and in order (INV-4).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as catalog from "../../src/app/catalog.js";
import type { Ctx } from "../../src/app/commit.js";
import * as inv from "../../src/app/invoices.js";
import { onPaymentIntentSucceeded } from "../../src/app/payment-events.js";
import * as subs from "../../src/app/subscriptions.js";
import { DAY, DomainError } from "../../src/domain/shared.js";
import { clockOf } from "../../src/domain/subscription/subscription.js";
import { jobHandlers } from "../../src/workers/jobs.js";
import { SCOPE, T0 } from "../support/fixtures.js";
import { runDueJobs, testBilling } from "../support/memory.js";

const c: Ctx = { scope: SCOPE, actor: "user:usr_1" };

const Action = fc.oneof(
  fc.record({
    kind: fc.constant("advance" as const),
    target: fc.constantFrom("renewal_upcoming", "renewal", "overdue"),
  }),
  fc.record({ kind: fc.constant("pay" as const) }),
  fc.record({ kind: fc.constant("wait" as const), seconds: fc.integer({ min: 60, max: 12 * DAY }) }),
);

describe("billing clock properties", () => {
  it("forward-only, one invoice per period, reminders once and in order", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<"day" | "week" | "month">("day", "week", "month"),
        fc.boolean(),
        fc.array(Action, { minLength: 1, maxLength: 12 }),
        async (interval, trial, actions) => {
          const b = testBilling(T0 * 1000);
          b.pay.addCustomer(SCOPE, { id: "cus_1" });
          const p = await catalog.createProduct(b, c, { name: "Pro" });
          const price = await catalog.createPrice(b, c, {
            productId: p.id,
            unitAmount: 1_000n,
            currency: "usd",
            assetId: null,
            recurring: { interval },
          });
          const s = await subs.createSubscription(b, c, {
            customerId: "cus_1",
            items: [{ priceId: price.id }],
            daysUntilDue: 2,
            dunning: { reminderDays: [-1, 0, 1, 3], onExhausted: "unpaid" },
            ...(trial ? { trialPeriodDays: 5 } : {}),
          });
          const run = () => runDueJobs(b, jobHandlers(b));
          let offset = 0;
          for (const a of actions) {
            if (a.kind === "advance") {
              const before = clockOf({ clockOffset: offset }, Math.floor(b.clock.ms / 1000));
              try {
                const r = await subs.advanceSubscriptionClock(b, c, s.id, a.target);
                expect(r.advancedBy).toBeGreaterThan(0);
                expect(r.clockTime).toBe(before + r.advancedBy);
                expect(r.subscription.clockOffset).toBe(offset + r.advancedBy);
              } catch (e) {
                if (!(e instanceof DomainError) || e.code !== "state_conflict") throw e;
              }
            } else if (a.kind === "pay") {
              const open = (await inv.listInvoices(b, c, { limit: 100, subscription: s.id, status: "open" })).data[0];
              if (open)
                await onPaymentIntentSucceeded(b, {
                  eventId: `evt-${open.id}`,
                  subject: "evt.payments.payment_intent.succeeded",
                  scope: SCOPE,
                  object: {
                    id: `pi_${open.id.slice(3)}`,
                    status: "succeeded",
                    invoiceId: open.id,
                    ...SCOPE,
                    currency: open.currency,
                    assetId: open.assetId,
                    amount: open.total,
                  },
                });
            } else b.clock.ms += a.seconds * 1000;
            await run();
            const cur = await subs.getSubscription(b, c, s.id);
            const next = cur.clockOffset ?? 0;
            expect(next).toBeGreaterThanOrEqual(offset);
            offset = next;
          }
          const all = (await inv.listInvoices(b, c, { limit: 100, subscription: s.id })).data;
          const starts = all.map((i) => i.period?.start);
          expect(new Set(starts).size).toBe(starts.length);
          const sent = new Map<string, number[]>();
          for (const e of b.mem.state.outbox)
            if (e.object.kind === "invoice_reminder")
              sent.set(e.object.invoice.id, [...(sent.get(e.object.invoice.id) ?? []), e.object.reminder.number]);
          for (const ns of sent.values())
            for (let i = 1; i < ns.length; i++) expect(ns[i]).toBeGreaterThan(ns[i - 1] as number);
        },
      ),
      { numRuns: 40 },
    );
  });
});
