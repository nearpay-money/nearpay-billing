/**
 * Test-mode billing clock (lld/billing.md §13): `advanceSubscriptionClock` from trialing, active and
 * past_due; state_conflict / livemode_forbidden; jobs follow the clock (renewal_upcoming, renewal invoice,
 * reminders, overdue, exhaustion) in order; other subscriptions untouched; one invoice per period whether the
 * helper, the scheduler or the sweep runs the renewal.
 */
import { beforeEach, describe, expect, it } from "vitest";
import * as catalog from "../../src/app/catalog.js";
import type { Ctx } from "../../src/app/commit.js";
import { sessionExpiry } from "../../src/app/hosted.js";
import * as inv from "../../src/app/invoices.js";
import { onPaymentIntentSucceeded } from "../../src/app/payment-events.js";
import * as subs from "../../src/app/subscriptions.js";
import type { Invoice } from "../../src/domain/invoice/invoice.js";
import { DAY, DomainError } from "../../src/domain/shared.js";
import { clockTargetTime, type Subscription } from "../../src/domain/subscription/subscription.js";
import { jobHandlers } from "../../src/workers/jobs.js";
import { LIVE, SCOPE, T0 } from "../support/fixtures.js";
import { runDueJobs, type TestBilling, testBilling } from "../support/memory.js";

const c: Ctx = { scope: SCOPE, actor: "user:usr_1" };

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
  return "ok";
}

let b: TestBilling;
let monthly: string;

beforeEach(async () => {
  b = testBilling(T0 * 1000);
  b.pay.addCustomer(SCOPE, { id: "cus_1" });
  const p = await catalog.createProduct(b, c, { name: "Pro" });
  monthly = (
    await catalog.createPrice(b, c, {
      productId: p.id,
      unitAmount: 2_500n,
      currency: "usd",
      assetId: null,
      recurring: { interval: "month" },
    })
  ).id;
});

const run = () => runDueJobs(b, jobHandlers(b));
const invoicesOf = async (subId: string) =>
  (await inv.listInvoices(b, c, { limit: 100, subscription: subId })).data.slice().reverse();
const subjectsFrom = (i: number) => b.mem.state.outbox.slice(i).map((e) => e.subject);
const reminders = () =>
  b.mem.state.outbox.flatMap((e) =>
    e.object.kind === "invoice_reminder" ? [`${e.object.invoice.id}:r${e.object.reminder.number}`] : [],
  );

async function pay(i: Invoice) {
  await onPaymentIntentSucceeded(b, {
    eventId: `evt-${i.id}`,
    subject: "evt.payments.payment_intent.succeeded",
    scope: SCOPE,
    object: {
      id: `pi_${i.id.slice(3)}`,
      status: "succeeded",
      invoiceId: i.id,
      ...SCOPE,
      currency: i.currency,
      assetId: i.assetId,
      amount: i.total,
      destinationFingerprint: "7KQ2-M9XA-31",
    },
  });
}

async function activeSub(): Promise<Subscription> {
  const s = await subs.createSubscription(b, c, {
    customerId: "cus_1",
    items: [{ priceId: monthly }],
    dunning: { reminderDays: [-3, 0, 1] },
  });
  const [first] = await invoicesOf(s.id);
  await pay(first as Invoice);
  await run();
  return subs.getSubscription(b, c, s.id);
}

describe("clockTargetTime (domain)", () => {
  const s = { status: "active", currentPeriodEnd: T0 + 30 * DAY } as Subscription;
  it("renewal / renewal_upcoming need a renewing status and a target ahead of the clock", () => {
    expect(clockTargetTime(s, "renewal", T0, [])).toBe(T0 + 30 * DAY);
    expect(clockTargetTime(s, "renewal_upcoming", T0, [])).toBe(T0 + 27 * DAY);
    expect(clockTargetTime(s, "renewal_upcoming", T0 + 27 * DAY, [])).toBeNull();
    expect(clockTargetTime(s, "renewal", T0 + 30 * DAY, [])).toBeNull();
    for (const status of ["incomplete", "unpaid", "canceled"] as const)
      expect(clockTargetTime({ ...s, status }, "renewal", T0, [])).toBeNull();
    expect(clockTargetTime({ ...s, status: "trialing" }, "renewal", T0, [])).toBe(T0 + 30 * DAY);
    expect(clockTargetTime({ ...s, status: "past_due" }, "renewal_upcoming", T0, [])).toBe(T0 + 27 * DAY);
  });
  it("overdue = earliest open due date strictly after the clock, whatever the status", () => {
    expect(clockTargetTime(s, "overdue", T0, [T0 + 9, T0 - 5, T0 + 3, T0])).toBe(T0 + 3);
    expect(clockTargetTime({ ...s, status: "incomplete" }, "overdue", T0, [T0 + 3])).toBe(T0 + 3);
    expect(clockTargetTime(s, "overdue", T0, [T0, T0 - 1])).toBeNull();
    expect(clockTargetTime(s, "overdue", T0, [])).toBeNull();
  });
});

describe("advanceSubscriptionClock", () => {
  it("active: renewal_upcoming → renewal → overdue → renewal, events in order, reminders across advances", async () => {
    const s = await activeSub();
    const end = s.currentPeriodEnd;
    let mark = b.mem.state.outbox.length;

    const up = await subs.advanceSubscriptionClock(b, c, s.id, "renewal_upcoming");
    expect(up).toMatchObject({ target: "renewal_upcoming", clockTime: end - 3 * DAY, advancedBy: end - 3 * DAY - T0 });
    expect(up.subscription.clockOffset).toBe(end - 3 * DAY - T0);
    await run();
    expect(subjectsFrom(mark)).toEqual(["evt.billing.subscription.renewal_upcoming"]);
    expect(await code(subs.advanceSubscriptionClock(b, c, s.id, "renewal_upcoming"))).toBe("state_conflict");

    mark = b.mem.state.outbox.length;
    const r = await subs.advanceSubscriptionClock(b, c, s.id, "renewal");
    expect(r).toMatchObject({ clockTime: end, advancedBy: 3 * DAY });
    await run();
    expect(subjectsFrom(mark)).toEqual([
      "evt.billing.subscription.updated",
      "evt.billing.invoice.created",
      "evt.billing.invoice.finalized",
      "evt.billing.invoice.sent",
    ]);
    const renewed = await subs.getSubscription(b, c, s.id);
    expect(renewed).toMatchObject({ status: "active", currentPeriodStart: end, clockOffset: end - T0 });
    const second = (await invoicesOf(s.id))[1] as Invoice;
    expect(second).toMatchObject({
      billingReason: "subscription_cycle",
      status: "open",
      period: { start: end, end: renewed.currentPeriodEnd },
      finalizedAt: end,
      dueDate: end + 7 * DAY,
      clockOffset: end - T0,
    });
    // real time did not move: the hosted session still expires in real time (last reminder translated back)
    const exp = sessionExpiry(second, T0);
    expect(exp).toBe(end + 8 * DAY - (end - T0));

    mark = b.mem.state.outbox.length;
    const o = await subs.advanceSubscriptionClock(b, c, s.id, "overdue");
    expect(o).toMatchObject({ clockTime: end + 7 * DAY, advancedBy: 7 * DAY });
    await run();
    expect(subjectsFrom(mark)).toEqual([
      "evt.billing.invoice.reminder",
      "evt.billing.invoice.reminder",
      "evt.billing.invoice.overdue",
      "evt.billing.subscription.updated",
    ]);
    expect(reminders()).toEqual([`${second.id}:r1`, `${second.id}:r2`]);
    expect((await subs.getSubscription(b, c, s.id)).status).toBe("past_due");
    expect(await code(subs.advanceSubscriptionClock(b, c, s.id, "overdue"))).toBe("state_conflict");

    // from past_due: the next renewal passes the last reminder (+1 d) and exhaustion first
    mark = b.mem.state.outbox.length;
    await subs.advanceSubscriptionClock(b, c, s.id, "renewal");
    await run();
    expect(reminders()).toEqual([`${second.id}:r1`, `${second.id}:r2`, `${second.id}:r3`]);
    expect(subjectsFrom(mark)).toEqual([
      "evt.billing.invoice.reminder",
      "evt.billing.invoice.marked_uncollectible",
      "evt.billing.subscription.deleted",
    ]);
    expect(await subs.getSubscription(b, c, s.id)).toMatchObject({ status: "canceled" });
    expect(await code(subs.advanceSubscriptionClock(b, c, s.id, "renewal"))).toBe("state_conflict");
    expect(b.logs.filter((l) => l.msg === "billing.test_clock.advanced")).toHaveLength(4);
  });

  it("trialing: renewal_upcoming then renewal issues the first invoice and activates", async () => {
    const s = await subs.createSubscription(b, c, {
      customerId: "cus_1",
      items: [{ priceId: monthly }],
      trialPeriodDays: 14,
    });
    expect(s.status).toBe("trialing");
    let mark = b.mem.state.outbox.length;
    await subs.advanceSubscriptionClock(b, c, s.id, "renewal_upcoming");
    await run();
    expect(subjectsFrom(mark)).toEqual(["evt.billing.subscription.renewal_upcoming"]);
    mark = b.mem.state.outbox.length;
    const r = await subs.advanceSubscriptionClock(b, c, s.id, "renewal");
    expect(r.clockTime).toBe(T0 + 14 * DAY);
    await run();
    expect(subjectsFrom(mark)).toContain("evt.billing.invoice.sent");
    const [first] = await invoicesOf(s.id);
    expect(first).toMatchObject({ billingReason: "subscription_create", period: { start: T0 + 14 * DAY } });
    expect((await subs.getSubscription(b, c, s.id)).status).toBe("active");
  });

  it("incomplete: renewal targets conflict, overdue works; cancel_at_period_end ends at renewal", async () => {
    const s = await subs.createSubscription(b, c, { customerId: "cus_1", items: [{ priceId: monthly }] });
    expect(await code(subs.advanceSubscriptionClock(b, c, s.id, "renewal"))).toBe("state_conflict");
    expect(await code(subs.advanceSubscriptionClock(b, c, s.id, "renewal_upcoming"))).toBe("state_conflict");
    const mark = b.mem.state.outbox.length;
    expect((await subs.advanceSubscriptionClock(b, c, s.id, "overdue")).clockTime).toBe(T0 + 7 * DAY);
    await run();
    expect(subjectsFrom(mark)).toContain("evt.billing.invoice.overdue");

    const a = await activeSub();
    await subs.updateSubscription(b, c, a.id, { cancelAtPeriodEnd: true });
    await subs.advanceSubscriptionClock(b, c, a.id, "renewal");
    await run();
    expect(await subs.getSubscription(b, c, a.id)).toMatchObject({ status: "canceled", endedAt: a.currentPeriodEnd });
  });

  it("errors: live mode, unknown subscription", async () => {
    expect(await code(subs.advanceSubscriptionClock(b, { ...c, scope: LIVE }, "sub_x", "renewal"))).toBe(
      "livemode_forbidden",
    );
    expect(await code(subs.advanceSubscriptionClock(b, c, "sub_00000000000000000000000000", "renewal"))).toBe(
      "resource_missing",
    );
  });

  it("moves only the subscription's own jobs; a repeated renewal (scheduler / sweep) never double-invoices", async () => {
    const a = await activeSub();
    const other = await activeSub();
    const otherJobs = () =>
      [...b.mem.state.jobs.entries()].filter(([k]) => k.includes(other.id)).map(([k, j]) => [k, j.runAt]);
    const before = otherJobs();
    await subs.advanceSubscriptionClock(b, c, a.id, "renewal");
    expect(otherJobs()).toEqual(before);
    await run();
    // the sweep / a stale scheduler job for the same period end
    for (const key of ["sweep", "late"])
      await b.mem.transaction((tx) =>
        tx.enqueue({
          kind: "subscription.renew",
          dedupeKey: `subscription.renew:${a.id}:${a.currentPeriodEnd}:${key}`,
          runAt: a.currentPeriodEnd,
          payload: { subscription: a.id, account_id: SCOPE.accountId, livemode: false },
        }),
      );
    await run();
    const list = await invoicesOf(a.id);
    expect(list.map((i) => i.period?.start)).toEqual([T0, a.currentPeriodEnd]);
    expect((await invoicesOf(other.id)).length).toBe(1);
  });

  it("a reminder whose earlier due reminder has not run waits (retry) instead of being skipped", async () => {
    const s = await activeSub();
    await subs.advanceSubscriptionClock(b, c, s.id, "renewal");
    await run();
    const second = (await invoicesOf(s.id))[1] as Invoice;
    await subs.advanceSubscriptionClock(b, c, s.id, "overdue");
    const h = jobHandlers(b);
    const payload = { invoice: second.id, account_id: SCOPE.accountId, livemode: false };
    await expect(h["invoice.remind"]({ ...payload, number: 2, at: second.dueDate as number })).rejects.toThrow(
      /waits for reminder 1/,
    );
    await run();
    expect(reminders()).toEqual([`${second.id}:r1`, `${second.id}:r2`]);
  });

  it("exhaustion due with the overdue job (no reminders) marks the invoice overdue first, whatever runs first", async () => {
    const s0 = await subs.createSubscription(b, c, {
      customerId: "cus_1",
      items: [{ priceId: monthly }],
      dunning: { reminderDays: [] },
    });
    const first = (await invoicesOf(s0.id))[0] as Invoice;
    await pay(first);
    await subs.advanceSubscriptionClock(b, c, s0.id, "renewal");
    await run();
    const second = (await invoicesOf(s0.id))[1] as Invoice;
    await subs.advanceSubscriptionClock(b, c, s0.id, "overdue");
    const mark = b.mem.state.outbox.length;
    const payload = { invoice: second.id, account_id: SCOPE.accountId, livemode: false, at: second.dueDate as number };
    await jobHandlers(b)["invoice.dunning_exhausted"](payload);
    await run();
    expect(subjectsFrom(mark)).toEqual([
      "evt.billing.invoice.overdue",
      "evt.billing.subscription.updated",
      "evt.billing.invoice.marked_uncollectible",
      "evt.billing.subscription.deleted",
    ]);
    expect(await subs.getSubscription(b, c, s0.id)).toMatchObject({
      status: "canceled",
      cancellationReason: "dunning_exhausted",
    });
  });

  it("records the destination fingerprint of the paying intent", async () => {
    const s = await activeSub();
    const [first] = await invoicesOf(s.id);
    expect(first?.destinationFingerprint).toBe("7KQ2-M9XA-31");
  });
});
