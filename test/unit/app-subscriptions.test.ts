import { beforeEach, describe, expect, it } from "vitest";
import * as catalog from "../../src/app/catalog.js";
import type { Ctx } from "../../src/app/commit.js";
import * as inv from "../../src/app/invoices.js";
import { subscriptionNotificationContext } from "../../src/app/notification.js";
import { onPaymentIntentSucceeded } from "../../src/app/payment-events.js";
import * as subs from "../../src/app/subscriptions.js";
import type { Invoice } from "../../src/domain/invoice/invoice.js";
import { DAY, DomainError } from "../../src/domain/shared.js";
import { jobHandlers } from "../../src/workers/jobs.js";
import { SCOPE, T0 } from "../support/fixtures.js";
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
let yearly: string;
let vatId: string;

beforeEach(async () => {
  b = testBilling(T0 * 1000);
  b.pay.addCustomer(SCOPE, { id: "cus_1" });
  b.pay.addCustomer(SCOPE, { id: "cus_noemail", email: null });
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
  yearly = (
    await catalog.createPrice(b, c, {
      productId: p.id,
      unitAmount: 25_000n,
      currency: "usd",
      assetId: null,
      recurring: { interval: "year" },
    })
  ).id;
  vatId = (await catalog.createTaxRate(b, c, { displayName: "VAT", percentage: "20", inclusive: false })).id;
});

const invoicesOf = async (subId: string) =>
  (await inv.listInvoices(b, c, { limit: 100, subscription: subId })).data.slice().reverse();

async function pay(i: Invoice, id = `pi_${i.id}`) {
  await onPaymentIntentSucceeded(b, {
    eventId: `evt-${id}`,
    subject: "evt.payments.payment_intent.succeeded",
    scope: SCOPE,
    object: {
      id,
      status: "succeeded",
      invoiceId: i.id,
      ...SCOPE,
      currency: i.currency,
      assetId: i.assetId,
      amount: i.total,
    },
  });
}

async function advanceTo(unix: number) {
  b.clock.ms = unix * 1000;
  return runDueJobs(b, jobHandlers(b));
}

describe("subscriptions", () => {
  it("create: first invoice finalized and sent at once; incomplete until paid", async () => {
    const s = await subs.createSubscription(b, c, {
      customerId: "cus_1",
      items: [{ priceId: monthly, quantity: 2 }],
      defaultTaxRates: undefined,
      defaultTaxRateIds: [vatId],
    } as never);
    expect(s).toMatchObject({ status: "incomplete", currentPeriodStart: T0, nextPeriodIndex: 1 });
    const [first] = await invoicesOf(s.id);
    expect(first).toMatchObject({
      status: "open",
      billingReason: "subscription_create",
      subscriptionId: s.id,
      total: 6_000n,
      dueDate: T0 + 7 * DAY,
      sentAt: T0,
      period: { start: s.currentPeriodStart, end: s.currentPeriodEnd },
    });
    expect(s.latestInvoiceId).toBe(first?.id);
    expect(b.mem.state.outbox.map((e) => e.subject)).toEqual([
      "evt.billing.subscription.created",
      "evt.billing.invoice.created",
      "evt.billing.invoice.finalized",
      "evt.billing.invoice.sent",
    ]);
    await pay(first as Invoice);
    expect((await subs.getSubscription(b, c, s.id)).status).toBe("active");
  });

  it("create errors", async () => {
    expect(
      await code(subs.createSubscription(b, c, { customerId: "cus_noemail", items: [{ priceId: monthly }] })),
    ).toBe("customer_email_missing");
    expect(await code(subs.createSubscription(b, c, { customerId: "cus_x", items: [{ priceId: monthly }] }))).toBe(
      "resource_missing",
    );
    expect(
      await code(
        subs.createSubscription(b, c, { customerId: "cus_1", items: [{ priceId: monthly }, { priceId: yearly }] }),
      ),
    ).toBe("interval_mismatch");
    expect(
      await code(
        subs.createSubscription(b, c, {
          customerId: "cus_1",
          items: [{ priceId: monthly }],
          defaultTaxRateIds: ["txr_x"],
        }),
      ),
    ).toBe("resource_missing");
    b.merchantFacts = { ...b.merchantFacts, defaults: {} };
    expect(await code(subs.createSubscription(b, c, { customerId: "cus_1", items: [{ priceId: monthly }] }))).toBe(
      "destination_not_active",
    );
    expect(b.mem.state.subscriptions.size).toBe(0);
  });

  it("renews each period once (jobs replayed), with renewal_upcoming 3 days ahead", async () => {
    const s = await subs.createSubscription(b, c, { customerId: "cus_1", items: [{ priceId: monthly }] });
    const [first] = await invoicesOf(s.id);
    await pay(first as Invoice);
    const p1End = s.currentPeriodEnd;
    await advanceTo(p1End - 3 * DAY);
    expect(b.mem.state.outbox.filter((e) => e.subject === "evt.billing.subscription.renewal_upcoming")).toHaveLength(1);
    await advanceTo(p1End);
    let all = await invoicesOf(s.id);
    expect(all).toHaveLength(2);
    expect(all[1]).toMatchObject({ billingReason: "subscription_cycle", period: { start: p1End }, status: "open" });
    // replay the renewal job: nothing new
    await subs.renewJob(b, { subscription: s.id, scope: SCOPE });
    expect(await invoicesOf(s.id)).toHaveLength(2);
    const cur = await subs.getSubscription(b, c, s.id);
    expect(cur).toMatchObject({
      status: "active",
      currentPeriodStart: p1End,
      nextPeriodIndex: 2,
      latestInvoiceId: all[1]?.id,
    });
    await pay(all[1] as Invoice);
    await advanceTo(cur.currentPeriodEnd);
    all = await invoicesOf(s.id);
    expect(all.map((i) => i.number)).toEqual(["ACMECOT-00001", "ACMECOT-00002", "ACMECOT-00003"]);
    const ctx = await subscriptionNotificationContext(b, s.id);
    expect(ctx).toMatchObject({
      customerEmail: "payer@example.com",
      nextAmount: 2_500n,
      items: [{ description: "Pro", quantity: 1 }],
    });
  });

  it("unpaid renewal → past_due at due date → canceled when dunning is exhausted", async () => {
    const s = await subs.createSubscription(b, c, {
      customerId: "cus_1",
      items: [{ priceId: monthly }],
      dunning: { reminderDays: [0, 2] },
    });
    const [first] = await invoicesOf(s.id);
    await pay(first as Invoice);
    await advanceTo(s.currentPeriodEnd);
    const renewal = (await invoicesOf(s.id))[1] as Invoice;
    await advanceTo(renewal.dueDate as number);
    expect((await subs.getSubscription(b, c, s.id)).status).toBe("past_due");
    await advanceTo((renewal.dueDate as number) + 2 * DAY);
    expect(await inv.getInvoice(b, c, renewal.id)).toMatchObject({
      status: "uncollectible",
      uncollectibleReason: "dunning_exhausted",
      remindersSent: 2,
    });
    const ended = await subs.getSubscription(b, c, s.id);
    expect(ended).toMatchObject({ status: "canceled", cancellationReason: "dunning_exhausted" });
    expect(b.mem.state.outbox.filter((e) => e.subject === "evt.billing.subscription.deleted")).toHaveLength(1);
    // late payment still pays the invoice (INV-3); the subscription stays canceled
    await pay(renewal);
    expect((await inv.getInvoice(b, c, renewal.id)).status).toBe("paid");
    expect((await subs.getSubscription(b, c, s.id)).status).toBe("canceled");
  });

  it("on_exhausted=unpaid pauses renewals; paying resumes with the period containing now", async () => {
    const s = await subs.createSubscription(b, c, {
      customerId: "cus_1",
      items: [{ priceId: monthly }],
      dunning: { reminderDays: [], onExhausted: "unpaid" },
    });
    await pay((await invoicesOf(s.id))[0] as Invoice);
    await advanceTo(s.currentPeriodEnd);
    const renewal = (await invoicesOf(s.id))[1] as Invoice;
    await advanceTo(renewal.dueDate as number);
    expect((await subs.getSubscription(b, c, s.id)).status).toBe("unpaid");
    // months pass: no invoices while unpaid
    const later = s.currentPeriodEnd + 80 * DAY;
    await advanceTo(later);
    expect(await invoicesOf(s.id)).toHaveLength(2);
    await pay(renewal);
    await advanceTo(later);
    const all = await invoicesOf(s.id);
    expect(all).toHaveLength(3);
    const last = all[2] as Invoice;
    expect((last.period?.start as number) <= later && later < (last.period?.end as number)).toBe(true);
    expect((await subs.getSubscription(b, c, s.id)).status).toBe("active");
  });

  it("first invoice never paid → incomplete_expired", async () => {
    const s = await subs.createSubscription(b, c, {
      customerId: "cus_1",
      items: [{ priceId: monthly }],
      dunning: { reminderDays: [1] },
    });
    const first = (await invoicesOf(s.id))[0] as Invoice;
    await advanceTo((first.dueDate as number) + DAY);
    expect(await subs.getSubscription(b, c, s.id)).toMatchObject({
      status: "canceled",
      cancellationReason: "incomplete_expired",
    });
  });

  it("trial: trialing, then the first invoice at trial end and active", async () => {
    const s = await subs.createSubscription(b, c, {
      customerId: "cus_1",
      items: [{ priceId: monthly }],
      trialPeriodDays: 14,
    });
    expect(s.status).toBe("trialing");
    expect(await invoicesOf(s.id)).toHaveLength(0);
    await advanceTo(T0 + 14 * DAY);
    const [first] = await invoicesOf(s.id);
    expect(first).toMatchObject({ billingReason: "subscription_create", period: { start: T0 + 14 * DAY } });
    expect((await subs.getSubscription(b, c, s.id)).status).toBe("active");
  });

  it("update applies from the next renewal; cancel now or at period end", async () => {
    const s = await subs.createSubscription(b, c, { customerId: "cus_1", items: [{ priceId: monthly }] });
    await pay((await invoicesOf(s.id))[0] as Invoice);
    const u = await subs.updateSubscription(b, c, s.id, { items: [{ priceId: monthly, quantity: 3 }] });
    expect(u.items[0]?.quantity).toBe(3);
    expect((await invoicesOf(s.id))[0]?.total).toBe(2_500n); // existing invoice untouched
    expect(await code(subs.updateSubscription(b, c, s.id, { items: [{ priceId: yearly }] }))).toBe("interval_mismatch");
    expect(await code(subs.updateSubscription(b, c, s.id, { defaultTaxRateIds: ["txr_x"] }))).toBe("resource_missing");
    await advanceTo(s.currentPeriodEnd);
    const second = (await invoicesOf(s.id))[1] as Invoice;
    expect(second.total).toBe(7_500n);
    await pay(second);

    const sched = await subs.cancelSubscription(b, c, s.id, true);
    expect(sched).toMatchObject({ cancelAtPeriodEnd: true, status: "active" });
    const end = sched.currentPeriodEnd;
    await advanceTo(end - 3 * DAY);
    expect(b.mem.state.outbox.filter((e) => e.subject === "evt.billing.subscription.renewal_upcoming")).toHaveLength(1);
    await advanceTo(end);
    expect(await subs.getSubscription(b, c, s.id)).toMatchObject({ status: "canceled", endedAt: end });
    expect(await invoicesOf(s.id)).toHaveLength(2);
    expect(await code(subs.cancelSubscription(b, c, s.id, false))).toBe("state_conflict");
    expect(await code(subs.updateSubscription(b, c, s.id, {}))).toBe("state_conflict");
    expect(await code(subs.cancelSubscription(b, c, "sub_x", false))).toBe("resource_missing");
    expect(await code(subs.getSubscription(b, c, "sub_x"))).toBe("resource_missing");
    expect((await subs.listSubscriptions(b, c, { limit: 5, status: "canceled" })).data).toHaveLength(1);
  });

  it("renewal for a customer without email is finalized but not sent", async () => {
    b.pay.addCustomer(SCOPE, { id: "cus_later_noemail" });
    const s = await subs.createSubscription(b, c, { customerId: "cus_later_noemail", items: [{ priceId: monthly }] });
    await pay((await invoicesOf(s.id))[0] as Invoice);
    b.pay.customers.set("cus_later_noemail", {
      ...(b.pay.customers.get("cus_later_noemail") as NonNullable<ReturnType<typeof b.pay.customers.get>>),
      email: null,
    });
    await advanceTo(s.currentPeriodEnd);
    const renewal = (await invoicesOf(s.id))[1] as Invoice;
    expect(renewal).toMatchObject({ status: "open", sentAt: null });
  });
});
