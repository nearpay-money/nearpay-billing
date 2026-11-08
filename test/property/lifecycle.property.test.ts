/**
 * State machines (domain-model §4.5) under random operation sequences: invoices only move along the
 * documented edges, `paid`/`void` are final, `paid` only follows a matching succeeded intent (INV-2), late
 * money never reopens or re-pays (INV-3), amounts stay consistent; subscriptions likewise; dunning sends
 * each reminder at most once and in order whatever the job order or repetition (INV-4).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { exhaust, markOverdue, reminderToSend, scheduleOf } from "../../src/domain/dunning/dunning.js";
import {
  canTransition,
  finalize,
  INVOICE_TRANSITIONS,
  type Invoice,
  markSent,
  markUncollectible,
  newDraft,
  voidInvoice,
} from "../../src/domain/invoice/invoice.js";
import type { InvoiceLine } from "../../src/domain/invoice/lines.js";
import { onIntentFailed, onIntentSucceeded } from "../../src/domain/invoice/payment.js";
import { DAY, DomainError } from "../../src/domain/shared.js";
import {
  cancel,
  newSubscription,
  onDunningExhausted,
  onInvoiceOverdue,
  onInvoicePaid,
  patchSubscription,
  renew,
  SUBSCRIPTION_TRANSITIONS,
  type Subscription,
  canTransition as subCan,
} from "../../src/domain/subscription/subscription.js";
import { SCOPE, T0 } from "../support/fixtures.js";

const line = (amount: bigint): InvoiceLine => ({
  id: "il_1",
  type: "invoiceitem",
  priceId: null,
  productId: null,
  subscriptionItemId: null,
  description: "x",
  quantity: 1,
  unitAmount: amount,
  taxRateIds: [],
  taxRatesExplicit: false,
  period: null,
  amount,
  amountExcludingTax: amount,
  taxAmounts: [],
});

function draftOf(total: bigint, reminderDays: number[], subscriptionId: string | null = null): Invoice {
  const totals = { subtotal: total, tax: 0n, total, totalExcludingTax: total, totalTaxAmounts: [] };
  return newDraft(SCOPE, "in_p", T0, {
    currency: "usd",
    assetId: null,
    customerId: "cus_1",
    subscriptionId,
    lines: total > 0n ? [line(total)] : [],
    totals,
    daysUntilDue: 10,
    reminderDays,
  });
}

type Op =
  | { t: "finalize" }
  | { t: "send"; dt: number }
  | { t: "void"; inFlight: boolean }
  | { t: "uncollectible" }
  | { t: "succeeded"; id: number; delta: number; good: boolean }
  | { t: "failed"; id: number }
  | { t: "tick"; dt: number };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.constant<Op>({ t: "finalize" }),
  fc.integer({ min: 0, max: 2000 }).map<Op>((dt) => ({ t: "send", dt })),
  fc.boolean().map<Op>((inFlight) => ({ t: "void", inFlight })),
  fc.constant<Op>({ t: "uncollectible" }),
  fc
    .record({ id: fc.integer({ min: 1, max: 4 }), delta: fc.integer({ min: -2, max: 2 }), good: fc.boolean() })
    .map<Op>((r) => ({ t: "succeeded", ...r })),
  fc.integer({ min: 1, max: 4 }).map<Op>((id) => ({ t: "failed", id })),
  fc.integer({ min: 0, max: 20 * DAY }).map<Op>((dt) => ({ t: "tick", dt })),
);

describe("invoice state machine", () => {
  it("only documented edges; paid/void final; paid needs a matching succeeded intent", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 20n }), fc.array(opArb, { maxLength: 40 }), (total, ops) => {
        let inv = draftOf(total, [-3, 0, 3]);
        let now = T0;
        const hosted = { secretHash: new Uint8Array(), secretEnc: new Uint8Array(), billToEnc: null };
        for (const op of ops) {
          const before = inv;
          try {
            switch (op.t) {
              case "finalize":
                inv = finalize(inv, {
                  now,
                  number: "A-00001",
                  hosted,
                  merchantName: "M",
                  priced: { lines: inv.lines, totals: inv },
                });
                break;
              case "send":
                now += op.dt;
                inv = markSent(inv, now);
                break;
              case "void":
                inv = voidInvoice(inv, now, op.inFlight);
                break;
              case "uncollectible":
                inv = markUncollectible(inv, now, "merchant");
                break;
              case "succeeded": {
                const r = onIntentSucceeded(
                  inv,
                  {
                    id: `pi_${op.id}`,
                    status: op.good ? "succeeded" : "processing",
                    invoiceId: inv.id,
                    accountId: inv.accountId,
                    livemode: inv.livemode,
                    currency: "usd",
                    assetId: null,
                    amount: inv.total + BigInt(op.delta),
                  },
                  now,
                );
                if (r.kind === "paid") {
                  expect(op.good && op.delta >= 0).toBe(true);
                  expect(["open", "uncollectible"]).toContain(before.status);
                }
                if (r.kind !== "duplicate") inv = r.invoice;
                break;
              }
              case "failed": {
                const r = onIntentFailed(
                  inv,
                  {
                    id: `pi_${op.id}`,
                    status: "requires_payment",
                    invoiceId: inv.id,
                    accountId: inv.accountId,
                    livemode: inv.livemode,
                    currency: "usd",
                    assetId: null,
                    amount: inv.total,
                  },
                  now,
                );
                inv = r.invoice;
                break;
              }
              case "tick":
                now += op.dt;
                break;
            }
          } catch (e) {
            expect(e).toBeInstanceOf(DomainError);
            expect(inv).toBe(before);
          }
          if (inv.status !== before.status) expect(canTransition(before.status, inv.status)).toBe(true);
          if (before.status === "paid" || before.status === "void") expect(inv.status).toBe(before.status);
          if (before.status === "paid") expect(inv.paymentIntentId).toBe(before.paymentIntentId);
          expect(inv.amountPaid === 0n || (inv.status === "paid" && inv.amountPaid === inv.total)).toBe(true);
          if (inv.status === "paid") expect(inv.paymentIntentIds).toContain(inv.paymentIntentId);
          if (inv.status !== "draft") expect(inv.number !== null && inv.dueDate !== null && inv.total > 0n).toBe(true);
          expect(new Set(inv.paymentIntentIds).size).toBe(inv.paymentIntentIds.length);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("the transition table is closed over its statuses", () => {
    for (const table of [INVOICE_TRANSITIONS, SUBSCRIPTION_TRANSITIONS] as Record<string, readonly string[]>[])
      for (const [from, tos] of Object.entries(table))
        for (const to of tos) {
          expect(Object.keys(table)).toContain(to);
          expect(from).not.toBe(to);
        }
  });
});

describe("dunning schedule", () => {
  const daysArb = fc
    .uniqueArray(fc.integer({ min: -30, max: 60 }), { maxLength: 10 })
    .map((a) => [...a].sort((x, y) => x - y));

  it("each reminder goes out at most once, in order, never early — whatever the job order and repeats", () => {
    fc.assert(
      fc.property(
        daysArb,
        fc.integer({ min: 0, max: 40 }),
        fc.array(fc.tuple(fc.integer({ min: 1, max: 10 }), fc.integer({ min: 0, max: 5 * DAY })), { maxLength: 60 }),
        (days, dueIn, jobs) => {
          const d = { ...draftOf(100n, days, "sub_1"), daysUntilDue: dueIn };
          let inv = finalize(d, {
            now: T0,
            number: "A-1",
            hosted: { secretHash: new Uint8Array(), secretEnc: new Uint8Array(), billToEnc: null },
            merchantName: "M",
            priced: { lines: d.lines, totals: d },
          });
          const sched = scheduleOf(inv);
          for (const r of sched) expect(r.at >= T0).toBe(true);
          expect(sched.map((r) => r.at)).toEqual([...sched.map((r) => r.at)].sort((a, b) => a - b));
          let now = T0;
          const sent: number[] = [];
          for (const [n, dt] of jobs) {
            now += dt;
            const r = reminderToSend(inv, n, now);
            if (r) {
              expect(now >= r.reminder.at).toBe(true);
              sent.push(r.reminder.number);
              inv = r.invoice;
            }
            const o = markOverdue(inv, now);
            if (o) {
              expect(now >= (inv.dueDate as number)).toBe(true);
              inv = o;
            }
          }
          expect(sent).toEqual(sched.slice(0, sent.length).map((r) => r.number));
          expect(inv.remindersSent).toBe(sent.length);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("exhaustion never happens before the due date or the last reminder", () => {
    fc.assert(
      fc.property(
        daysArb,
        fc.integer({ min: 0, max: 40 }),
        fc.integer({ min: 0, max: 120 * DAY }),
        (days, dueIn, dt) => {
          const d = { ...draftOf(100n, days, "sub_1"), daysUntilDue: dueIn };
          const inv = finalize(d, {
            now: T0,
            number: "A-1",
            hosted: { secretHash: new Uint8Array(), secretEnc: new Uint8Array(), billToEnc: null },
            merchantName: "M",
            priced: { lines: d.lines, totals: d },
          });
          const out = exhaust(inv, T0 + dt, { status: "past_due", onExhausted: "cancel" });
          if (out) {
            expect(T0 + dt >= (inv.dueDate as number)).toBe(true);
            for (const r of scheduleOf(inv)) expect(T0 + dt >= r.at).toBe(true);
          }
        },
      ),
    );
  });
});

type SubOp =
  | { t: "renew"; dt: number }
  | { t: "overdue" }
  | { t: "paid"; latest: boolean; others: number }
  | { t: "exhaust"; cancel: boolean }
  | { t: "cancel"; atEnd: boolean }
  | { t: "uncancel" };

const subOpArb: fc.Arbitrary<SubOp> = fc.oneof(
  fc.integer({ min: 0, max: 70 * DAY }).map<SubOp>((dt) => ({ t: "renew", dt })),
  fc.constant<SubOp>({ t: "overdue" }),
  fc.record({ latest: fc.boolean(), others: fc.integer({ min: 0, max: 1 }) }).map<SubOp>((r) => ({ t: "paid", ...r })),
  fc.boolean().map<SubOp>((c) => ({ t: "exhaust", cancel: c })),
  fc.boolean().map<SubOp>((atEnd) => ({ t: "cancel", atEnd })),
  fc.constant<SubOp>({ t: "uncancel" }),
);

describe("subscription state machine and periods", () => {
  it("documented edges only; periods contiguous, increasing and never billed twice", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("day", "week", "month", "year"),
        fc.integer({ min: 1, max: 12 }),
        fc.option(fc.integer({ min: 1, max: 60 }), { nil: undefined }),
        fc.array(subOpArb, { maxLength: 40 }),
        (interval, count, trial, ops) => {
          let s: Subscription = newSubscription(SCOPE, "sub_p", T0, {
            customerId: "cus_1",
            items: [],
            pricing: { currency: "usd", assetId: null },
            recurring: { interval: interval as "month", intervalCount: count },
            trialPeriodDays: trial,
          });
          if (s.status === "incomplete") s = { ...s, latestInvoiceId: "in_0" };
          let now = T0;
          const invoiced: number[] = s.status === "incomplete" ? [s.currentPeriodStart] : [];
          let inv = 0;
          for (const op of ops) {
            const before = s;
            try {
              switch (op.t) {
                case "renew": {
                  now += op.dt;
                  const d = renew(s, now);
                  if (d.kind === "invoice") {
                    expect(d.period.start >= before.currentPeriodEnd || before.status === "trialing").toBe(true);
                    expect(d.period.end > now).toBe(true);
                    expect(d.period.start <= now).toBe(true);
                    expect(invoiced).not.toContain(d.period.start);
                    if (invoiced.length) expect(d.period.start > (invoiced[invoiced.length - 1] as number)).toBe(true);
                    invoiced.push(d.period.start);
                    s = { ...d.subscription, latestInvoiceId: `in_${++inv}` };
                  } else if (d.kind === "end") {
                    expect(before.cancelAtPeriodEnd).toBe(true);
                    s = d.subscription;
                  }
                  break;
                }
                case "overdue":
                  s = onInvoiceOverdue(s, now) ?? s;
                  break;
                case "paid":
                  s =
                    onInvoicePaid(
                      s,
                      { invoiceId: op.latest ? (s.latestInvoiceId ?? "x") : "in_old", otherOverdueOpen: op.others },
                      now,
                    ) ?? s;
                  break;
                case "exhaust":
                  if (s.status !== "canceled" && s.status !== "trialing") {
                    const steps = onDunningExhausted(
                      s,
                      op.cancel ? { to: "canceled", reason: "dunning_exhausted" } : { to: "unpaid" },
                      now,
                    );
                    let prev = s;
                    for (const st of steps) {
                      expect(subCan(prev.status, st.status)).toBe(true);
                      prev = st;
                    }
                    s = prev;
                  }
                  break;
                case "cancel":
                  s = cancel(s, now, op.atEnd);
                  break;
                case "uncancel":
                  s = patchSubscription(s, { cancelAtPeriodEnd: false }, now);
                  break;
              }
            } catch (e) {
              expect(e).toBeInstanceOf(DomainError);
              expect(s).toBe(before);
            }
            if (s.status !== before.status && op.t !== "exhaust") expect(subCan(before.status, s.status)).toBe(true);
            if (before.status === "canceled") expect(s.status).toBe("canceled");
            expect(s.currentPeriodEnd > s.currentPeriodStart).toBe(true);
            if (s.status === "canceled") expect(s.endedAt).not.toBeNull();
          }
        },
      ),
      { numRuns: 400 },
    );
  });
});
