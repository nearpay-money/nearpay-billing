import vectors from "@nearpay/spec/test-vectors/billing-tax.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import {
  exhaust,
  exhaustAt,
  markOverdue,
  nextReminder,
  reminderSchedule,
  reminderToSend,
} from "../../src/domain/dunning/dunning.js";
import { finalize, type Invoice, markUncollectible, newDraft } from "../../src/domain/invoice/invoice.js";
import { DAY, DomainError } from "../../src/domain/shared.js";
import {
  boundary,
  cancel,
  canTransition,
  firstOpenPeriod,
  newSubscription,
  onDunningExhausted,
  onInvoiceOverdue,
  onInvoicePaid,
  patchSubscription,
  periodLines,
  periodOf,
  renew,
  renewalUpcomingApplies,
  renewalUpcomingAt,
  resolveItems,
  type Subscription,
} from "../../src/domain/subscription/subscription.js";
import { mapOf, OTHER, price, product, SCOPE, seqId, T0, taxRate } from "../support/fixtures.js";

const code = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
  return "ok";
};

const prod = product();
const monthly = price(prod, { unitAmount: 2000n, recurring: { interval: "month" } });
const monthly2 = price(prod, { unitAmount: 500n, recurring: { interval: "month" } });
const yearly = price(prod, { recurring: { interval: "year" } });
const eurMonthly = price(prod, { currency: "eur", recurring: { interval: "month" } });
const oneTime = price(prod);
const vat = taxRate();
const catalog = {
  prices: mapOf(monthly, monthly2, yearly, eurMonthly, oneTime),
  products: mapOf(prod),
  taxRates: mapOf(vat),
};

function sub(o: { trial?: number; now?: number } = {}): Subscription {
  const r = resolveItems([{ priceId: monthly.id, quantity: 2 }], { scope: SCOPE, catalog, newId: () => seqId("si") });
  return newSubscription(SCOPE, seqId("sub"), o.now ?? T0, {
    customerId: "cus_1",
    items: r.items,
    pricing: r.pricing,
    recurring: r.recurring,
    trialPeriodDays: o.trial,
  });
}

describe("periods (spec periodBoundary vectors)", () => {
  for (const c of vectors.period_cases) {
    it(`${c.interval} × ${c.interval_count} from ${new Date(c.anchor * 1000).toISOString()}`, () => {
      const s = { anchor: c.anchor, recurring: { interval: c.interval as "month", intervalCount: c.interval_count } };
      for (const b of c.boundaries) expect(boundary(s, b.n)).toBe(b.unix);
    });
  }
  it("finds the first period that has not ended", () => {
    const s = sub();
    expect(firstOpenPeriod(s, 0, T0)).toBe(0);
    expect(firstOpenPeriod(s, 1, T0)).toBe(1);
    const p5 = periodOf(s, 5);
    expect(firstOpenPeriod(s, 1, p5.start)).toBe(5);
    expect(firstOpenPeriod(s, 1, p5.end - 1)).toBe(5);
    expect(firstOpenPeriod(s, 1, p5.end)).toBe(6);
  });
});

describe("subscription lifecycle", () => {
  it("starts incomplete with period 0 current, or trialing until trial end", () => {
    const s = sub();
    expect(s).toMatchObject({
      status: "incomplete",
      anchor: T0,
      nextPeriodIndex: 1,
      currentPeriodStart: T0,
      daysUntilDue: 7,
    });
    expect(s.currentPeriodEnd).toBe(boundary(s, 1));
    expect(s.dunning).toEqual({ reminderDays: [-3, 0, 1, 3, 7], onExhausted: "cancel" });
    const t = sub({ trial: 14 });
    expect(t).toMatchObject({
      status: "trialing",
      anchor: T0 + 14 * DAY,
      nextPeriodIndex: 0,
      currentPeriodEnd: T0 + 14 * DAY,
      trialStart: T0,
      trialEnd: T0 + 14 * DAY,
    });
  });
  it("validates create input and items", () => {
    const base = {
      customerId: "c",
      items: [],
      pricing: { currency: "usd", assetId: null },
      recurring: { interval: "month" as const, intervalCount: 1 },
    };
    expect(code(() => newSubscription(SCOPE, "sub_x", T0, { ...base, daysUntilDue: 91 }))).toBe("invalid_request");
    expect(code(() => newSubscription(SCOPE, "sub_x", T0, { ...base, trialPeriodDays: 0 }))).toBe("invalid_request");
    expect(code(() => newSubscription(SCOPE, "sub_x", T0, { ...base, dunning: { reminderDays: [3, 1] } }))).toBe(
      "invalid_request",
    );
    const items = (
      ids: { priceId: string; quantity?: number; taxRateIds?: string[] }[],
      fixed?: Parameters<typeof resolveItems>[1]["fixed"],
    ) => code(() => resolveItems(ids, { scope: SCOPE, catalog, newId: () => seqId("si"), fixed }));
    expect(items([{ priceId: monthly.id }, { priceId: monthly2.id, taxRateIds: [vat.id] }])).toBe("ok");
    expect(items([])).toBe("invalid_request");
    expect(items([{ priceId: monthly.id }, { priceId: yearly.id }])).toBe("interval_mismatch");
    expect(items([{ priceId: monthly.id }, { priceId: eurMonthly.id }])).toBe("currency_mismatch");
    expect(items([{ priceId: oneTime.id }])).toBe("price_type_invalid");
    expect(items([{ priceId: monthly.id, quantity: 0 }])).toBe("invalid_request");
    expect(items([{ priceId: monthly.id, taxRateIds: ["txr_nope"] }])).toBe("resource_missing");
    expect(
      items([{ priceId: yearly.id }], {
        pricing: { currency: "usd", assetId: null },
        recurring: { interval: "month", intervalCount: 1 },
      }),
    ).toBe("interval_mismatch");
    expect(code(() => resolveItems([{ priceId: monthly.id }], { scope: OTHER, catalog, newId: () => "si" }))).toBe(
      "resource_missing",
    );
  });
  it("renews at period end, advancing exactly one period", () => {
    const s = { ...sub(), status: "active" as const, latestInvoiceId: "in_1" };
    expect(renew(s, s.currentPeriodEnd - 1)).toEqual({ kind: "wait", at: s.currentPeriodEnd });
    const d = renew(s, s.currentPeriodEnd);
    expect(d.kind).toBe("invoice");
    if (d.kind !== "invoice") return;
    expect(d.n).toBe(1);
    expect(d.billingReason).toBe("subscription_cycle");
    expect(d.period).toEqual(periodOf(s, 1));
    expect(d.subscription).toMatchObject({
      nextPeriodIndex: 2,
      currentPeriodStart: periodOf(s, 1).start,
      currentPeriodEnd: periodOf(s, 1).end,
    });
  });
  it("skips periods that ended while nothing was invoiced (no billing in arrears)", () => {
    const s = { ...sub(), status: "active" as const, latestInvoiceId: "in_1" };
    const late = periodOf(s, 4).start + 10;
    const d = renew(s, late);
    expect(d.kind === "invoice" && d.n).toBe(4);
  });
  it("issues the first invoice and activates at trial end", () => {
    const t = sub({ trial: 7 });
    const d = renew(t, t.trialEnd as number);
    expect(d.kind).toBe("invoice");
    if (d.kind !== "invoice") return;
    expect(d).toMatchObject({
      n: 0,
      billingReason: "subscription_create",
      subscription: { status: "active", nextPeriodIndex: 1 },
    });
    expect(d.period.start).toBe(t.trialEnd);
  });
  it("pauses incomplete/unpaid, ends at period end when asked, ignores canceled", () => {
    const s = sub();
    expect(renew(s, s.currentPeriodEnd).kind).toBe("none");
    expect(renew({ ...s, status: "unpaid" }, s.currentPeriodEnd).kind).toBe("none");
    const c = cancel({ ...s, status: "active" }, T0 + 5, true);
    expect(c).toMatchObject({ cancelAtPeriodEnd: true, canceledAt: T0 + 5, status: "active" });
    const e = renew(c, c.currentPeriodEnd + 3);
    expect(e.kind === "end" && e.subscription).toMatchObject({
      status: "canceled",
      endedAt: c.currentPeriodEnd,
      cancellationReason: "requested",
    });
    const now = cancel({ ...s, status: "active" }, T0 + 6, false);
    expect(now).toMatchObject({ status: "canceled", endedAt: T0 + 6, cancellationReason: "requested" });
    expect(renew(now, now.currentPeriodEnd).kind).toBe("none");
    expect(code(() => cancel(now, T0, false))).toBe("state_conflict");
  });
  it("follows invoices: overdue, paid, dunning exhausted", () => {
    const a = { ...sub(), status: "active" as const, latestInvoiceId: "in_2" };
    const pd = onInvoiceOverdue(a, T0) as Subscription;
    expect(pd.status).toBe("past_due");
    expect(onInvoiceOverdue(pd, T0)).toBeNull();
    expect(onInvoicePaid(pd, { invoiceId: "in_1", otherOverdueOpen: 1 }, T0)).toBeNull();
    expect(onInvoicePaid(pd, { invoiceId: "in_1", otherOverdueOpen: 0 }, T0)?.status).toBe("active");
    const inc = { ...sub(), latestInvoiceId: "in_9" };
    expect(onInvoicePaid(inc, { invoiceId: "in_9", otherOverdueOpen: 0 }, T0)?.status).toBe("active");
    expect(onInvoicePaid(inc, { invoiceId: "in_8", otherOverdueOpen: 0 }, T0)).toBeNull();
    const unpaid = { ...a, status: "unpaid" as const };
    expect(onInvoicePaid(unpaid, { invoiceId: "in_2", otherOverdueOpen: 0 }, T0)?.status).toBe("active");
    expect(onInvoicePaid(unpaid, { invoiceId: "in_1", otherOverdueOpen: 0 }, T0)).toBeNull();
    expect(onInvoicePaid(a, { invoiceId: "in_2", otherOverdueOpen: 0 }, T0)).toBeNull();

    expect(onDunningExhausted(a, { to: "unpaid" }, T0).map((s) => s.status)).toEqual(["past_due", "unpaid"]);
    expect(
      onDunningExhausted(pd, { to: "canceled", reason: "dunning_exhausted" }, T0).map((s) => [
        s.status,
        s.cancellationReason,
      ]),
    ).toEqual([["canceled", "dunning_exhausted"]]);
    expect(onDunningExhausted(unpaid, { to: "unpaid" }, T0)).toEqual([]);
    expect(onDunningExhausted(inc, { to: "canceled", reason: "incomplete_expired" }, T0)[0]?.cancellationReason).toBe(
      "incomplete_expired",
    );
  });
  it("updates from the next renewal; canceled refuses", () => {
    const s = { ...sub(), status: "active" as const };
    const u = patchSubscription(
      s,
      {
        daysUntilDue: 3,
        description: "d",
        metadata: { a: "b" },
        dunning: { onExhausted: "unpaid" },
        settlementDestinationId: "sd_1",
        defaultTaxRateIds: [vat.id],
      },
      T0 + 1,
    );
    expect(u).toMatchObject({
      daysUntilDue: 3,
      description: "d",
      dunning: { reminderDays: [-3, 0, 1, 3, 7], onExhausted: "unpaid" },
      currentPeriodEnd: s.currentPeriodEnd,
    });
    expect(patchSubscription(s, { dunning: { reminderDays: [1] } }, T0).dunning).toEqual({
      reminderDays: [1],
      onExhausted: "cancel",
    });
    const sched = patchSubscription(s, { cancelAtPeriodEnd: true }, T0 + 2);
    expect(sched).toMatchObject({ cancelAtPeriodEnd: true, canceledAt: T0 + 2, cancellationReason: "requested" });
    expect(patchSubscription(sched, { cancelAtPeriodEnd: false }, T0 + 3)).toMatchObject({
      cancelAtPeriodEnd: false,
      canceledAt: null,
      cancellationReason: null,
    });
    expect(code(() => patchSubscription(s, { daysUntilDue: 100 }, T0))).toBe("invalid_request");
    expect(code(() => patchSubscription({ ...s, status: "canceled" }, {}, T0))).toBe("state_conflict");
    expect(patchSubscription(s, { items: [] }, T0).items).toEqual([]);
  });
  it("announces renewals 3 days ahead for renewing subscriptions only", () => {
    const s = { ...sub(), status: "active" as const };
    expect(renewalUpcomingAt(s)).toBe(s.currentPeriodEnd - 3 * DAY);
    expect(renewalUpcomingApplies(s, s.currentPeriodEnd)).toBe(true);
    expect(renewalUpcomingApplies(s, s.currentPeriodEnd - 1)).toBe(false);
    expect(renewalUpcomingApplies({ ...s, cancelAtPeriodEnd: true }, s.currentPeriodEnd)).toBe(false);
    expect(renewalUpcomingApplies({ ...s, status: "unpaid" }, s.currentPeriodEnd)).toBe(false);
  });
  it("builds period lines from the current items", () => {
    const s = sub();
    const lines = periodLines(s, periodOf(s, 0), catalog, () => "il_1");
    expect(lines[0]).toMatchObject({
      type: "subscription",
      priceId: monthly.id,
      quantity: 2,
      unitAmount: 2000n,
      description: "Pro plan",
      taxRatesExplicit: false,
    });
    expect(code(() => periodLines({ ...s, currency: "eur" }, periodOf(s, 0), catalog, () => "x"))).toBe(
      "currency_mismatch",
    );
  });
  it("has the domain-model edges", () => {
    expect(canTransition("trialing", "active")).toBe(true);
    expect(canTransition("past_due", "unpaid")).toBe(true);
    expect(canTransition("canceled", "active")).toBe(false);
    expect(canTransition("active", "unpaid")).toBe(false);
  });
});

describe("dunning", () => {
  const due = T0 + 30 * DAY;
  it("skips reminders already past at finalize; numbers stay positional", () => {
    expect(reminderSchedule(due, [-3, 0, 1, 3, 7], T0).map((r) => [r.number, r.offsetDays, r.last])).toEqual([
      [1, -3, false],
      [2, 0, false],
      [3, 1, false],
      [4, 3, false],
      [5, 7, true],
    ]);
    expect(reminderSchedule(T0 + DAY, [-3, 0, 1], T0).map((r) => r.number)).toEqual([2, 3]);
    expect(reminderSchedule(T0, [], T0)).toEqual([]);
  });

  function subInvoice(reminderDays = [-3, 0, 7]): Invoice {
    const d = newDraft(SCOPE, seqId("in"), T0, {
      currency: "usd",
      assetId: null,
      customerId: "cus_1",
      subscriptionId: "sub_1",
      billingReason: "subscription_cycle",
      lines: [],
      totals: { subtotal: 100n, tax: 0n, total: 100n, totalExcludingTax: 100n, totalTaxAmounts: [] },
      daysUntilDue: 7,
      reminderDays,
    });
    return finalize(
      {
        ...d,
        lines: [
          {
            id: "il",
            type: "subscription",
            priceId: null,
            productId: null,
            subscriptionItemId: null,
            description: "x",
            quantity: 1,
            unitAmount: 100n,
            taxRateIds: [],
            taxRatesExplicit: false,
            period: null,
            amount: 100n,
            amountExcludingTax: 100n,
            taxAmounts: [],
          },
        ],
      },
      {
        now: T0,
        number: "X-00001",
        hosted: { secretHash: new Uint8Array(), secretEnc: new Uint8Array(), billToEnc: null },
        merchantName: "M",
        priced: {
          lines: [
            {
              id: "il",
              type: "subscription",
              priceId: null,
              productId: null,
              subscriptionItemId: null,
              description: "x",
              quantity: 1,
              unitAmount: 100n,
              taxRateIds: [],
              taxRatesExplicit: false,
              period: null,
              amount: 100n,
              amountExcludingTax: 100n,
              taxAmounts: [],
            },
          ],
          totals: d,
        },
      },
    );
  }

  it("sends reminders in order, once each", () => {
    const inv = subInvoice();
    const dueAt = inv.dueDate as number;
    expect(nextReminder(inv)?.number).toBe(1);
    expect(reminderToSend(inv, 1, dueAt - 3 * DAY - 1)).toBeNull();
    expect(reminderToSend(inv, 2, dueAt)).toBeNull(); // out of order
    const r1 = reminderToSend(inv, 1, dueAt - 3 * DAY);
    expect(r1?.invoice.remindersSent).toBe(1);
    const after = r1?.invoice as Invoice;
    expect(reminderToSend(after, 1, dueAt)).toBeNull(); // repeat
    expect(nextReminder(after)?.number).toBe(2);
    expect(reminderToSend(markUncollectible(after, dueAt, "merchant"), 2, dueAt)).toBeNull();
    expect(reminderToSend(markUncollectible(after, dueAt, "dunning_exhausted"), 2, dueAt)).not.toBeNull();
    expect(nextReminder(markUncollectible(after, dueAt, "merchant"))).toBeNull();
  });
  it("marks overdue once at the due date", () => {
    const inv = subInvoice();
    expect(markOverdue(inv, (inv.dueDate as number) - 1)).toBeNull();
    const o = markOverdue(inv, inv.dueDate as number) as Invoice;
    expect(o.overdueAt).toBe(inv.dueDate);
    expect(markOverdue(o, (inv.dueDate as number) + 5)).toBeNull();
  });
  it("exhausts subscription invoices at max(due, last reminder)", () => {
    const inv = subInvoice();
    expect(exhaustAt(inv)).toBe((inv.dueDate as number) + 7 * DAY);
    expect(exhaustAt(subInvoice([-3]))).toBe(inv.dueDate);
    expect(exhaustAt(subInvoice([]))).toBe(inv.dueDate);
    const at = exhaustAt(inv) as number;
    const sub = { status: "past_due", onExhausted: "cancel" as const };
    expect(exhaust(inv, at - 1, sub)).toBeNull();
    const out = exhaust(inv, at, sub);
    expect(out?.invoice).toMatchObject({ status: "uncollectible", uncollectibleReason: "dunning_exhausted" });
    expect(out?.subscription).toEqual({ to: "canceled", reason: "dunning_exhausted" });
    expect(exhaust(inv, at, { status: "active", onExhausted: "unpaid" })?.subscription).toEqual({ to: "unpaid" });
    expect(exhaust(inv, at, { status: "incomplete", onExhausted: "unpaid" })?.subscription).toEqual({
      to: "canceled",
      reason: "incomplete_expired",
    });
    expect(exhaust(inv, at, { status: "canceled", onExhausted: "cancel" })?.subscription).toBeNull();
    expect(exhaust(inv, at, { status: "unpaid", onExhausted: "cancel" })?.subscription).toBeNull();
    expect(exhaust(inv, at, null)).toBeNull();
    expect(exhaust({ ...inv, subscriptionId: null }, at, sub)).toBeNull();
    expect(exhaust(out?.invoice as Invoice, at, sub)).toBeNull();
  });
});
