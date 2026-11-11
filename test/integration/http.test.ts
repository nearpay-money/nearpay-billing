/**
 * The service over HTTP with its worker (Testcontainers Postgres + NATS, spec-mocked peers): every route,
 * the consumed payments subjects, outbox → bus, auth/roles/scope, idempotency, PDF and hosted routes.
 */

import { InvoiceEvent, InvoiceNotificationContext, SubscriptionNotificationContext } from "@nearpay-internal/spec";
import { checkoutSession, domainEvent, paymentIntent } from "@nearpay-internal/testing";
import { PublicInvoice, Subscription as SubscriptionSchema } from "@nearpay-money/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Merchant, type Stack, startStack, uuid } from "../support/stack.js";

let s: Stack;
let m: Merchant;
let tok: string;
let cus: string;

beforeAll(async () => {
  s = await startStack({ worker: true });
  m = s.merchant();
  tok = await s.token(m);
  cus = s.customer(m);
});

afterAll(async () => {
  await s?.stop();
});

async function catalogue() {
  const prod = await s.call("POST", "/v1/products", {
    token: tok,
    body: { name: "Espresso beans", description: "1 kg" },
  });
  expect(prod.status).toBe(201);
  const price = await s.call("POST", "/v1/prices", {
    token: tok,
    body: { product: prod.body.id, unit_amount: 2499, currency: "usd" },
  });
  expect(price.status).toBe(201);
  const monthly = await s.call("POST", "/v1/prices", {
    token: tok,
    body: { product: prod.body.id, unit_amount: 1500, currency: "usd", recurring: { interval: "month" } },
  });
  const tax = await s.call("POST", "/v1/tax_rates", {
    token: tok,
    body: { display_name: "Sales tax", percentage: "8.875", inclusive: false },
  });
  expect(tax.status).toBe(201);
  return { prod: prod.body, price: price.body, monthly: monthly.body, tax: tax.body };
}

describe("catalogue routes", () => {
  it("create/get/list/update, idempotent POST, scope isolation, roles", async () => {
    const key = { "idempotency-key": "prod-1" };
    const a = await s.call("POST", "/v1/products", { token: tok, body: { name: "A" }, headers: key });
    const again = await s.call("POST", "/v1/products", { token: tok, body: { name: "A" }, headers: key });
    expect(again.body.id).toBe(a.body.id);
    expect(again.headers.get("idempotent-replayed")).toBe("true");
    expect((await s.call("GET", `/v1/products/${a.body.id}`, { token: tok })).body).toMatchObject({
      name: "A",
      object: "product",
    });
    const upd = await s.call("PATCH", `/v1/products/${a.body.id}`, { token: tok, body: { active: false } });
    expect(upd.body.active).toBe(false);
    const list = await s.call("GET", "/v1/products?limit=1&active=false", { token: tok });
    expect(list.body).toMatchObject({ object: "list", url: "/v1/products" });
    expect(list.body.data[0].id).toBe(a.body.id);

    const other = s.merchant();
    expect((await s.call("GET", `/v1/products/${a.body.id}`, { token: await s.token(other) })).status).toBe(404);
    expect(
      (await s.call("GET", `/v1/products/${a.body.id}`, { token: await s.token(m, { livemode: true }) })).status,
    ).toBe(404);

    const { price, tax } = await catalogue();
    expect((await s.call("GET", `/v1/prices/${price.id}`, { token: tok })).body.unit_amount).toBe(2499);
    expect(
      (await s.call("PATCH", `/v1/prices/${price.id}`, { token: tok, body: { nickname: "retail" } })).body.nickname,
    ).toBe("retail");
    expect((await s.call("GET", "/v1/prices?type=recurring", { token: tok })).body.data).toHaveLength(1);
    expect((await s.call("GET", `/v1/tax_rates/${tax.id}`, { token: tok })).body).toMatchObject({
      percentage: "8.875",
      rate_ppm: 88750,
    });
    expect(
      (await s.call("PATCH", `/v1/tax_rates/${tax.id}`, { token: tok, body: { jurisdiction: "US-NY" } })).body
        .jurisdiction,
    ).toBe("US-NY");
    expect((await s.call("GET", "/v1/tax_rates?inclusive=false", { token: tok })).body.data.length).toBeGreaterThan(0);
    const bad = await s.call("POST", "/v1/prices", {
      token: tok,
      body: { product: a.body.id, unit_amount: 1, currency: "zzz" },
    });
    expect(bad.body.error?.code).toBe("currency_unsupported");
    const developer = await s.sessionToken(m, { role: "developer" });
    expect((await s.call("POST", "/v1/products", { token: developer, body: { name: "ok" } })).status).toBe(201);
    expect(
      (await s.call("POST", "/v1/invoices", { token: developer, body: { customer: cus, currency: "usd" } })).status,
    ).toBe(403);
  });
});

describe("invoices end to end", () => {
  it("draft → finalize → send (bus) → hosted session → paid by payments' event (bus); PDFs", async () => {
    const { price, tax } = await catalogue();
    const probe = await s.probe();
    const created = await s.call("POST", "/v1/invoices", {
      token: tok,
      body: {
        customer: cus,
        lines: [
          { price: price.id, quantity: 2 },
          { unit_amount: 100, description: "Shipping" },
        ],
        default_tax_rates: [tax.id],
      },
      headers: { "idempotency-key": "inv-1" },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      status: "draft",
      subtotal: 5098,
      tax: 453,
      total: 5551,
      hosted_invoice_url: null,
    });
    const id = created.body.id as string;
    const patched = await s.call("PATCH", `/v1/invoices/${id}`, { token: tok, body: { description: "Order 42" } });
    expect(patched.body.description).toBe("Order 42");
    expect((await s.call("GET", `/v1/invoices/${id}/pdf`, { token: tok })).status).toBe(409);

    const fin = await s.call("POST", `/v1/invoices/${id}/finalize`, { token: tok });
    expect(fin.status).toBe(200);
    expect(fin.body).toMatchObject({ status: "open", number: "ACMECOT-00001" });
    const hosted = fin.body.hosted_invoice_url as string;
    const secret = hosted.split("#")[1] as string;
    expect(hosted).toMatch(new RegExp(`^https://pay\\.nearpay\\.localhost/i/${id}#`));

    const sent = await s.call("POST", `/v1/invoices/${id}/send`, { token: tok });
    expect(sent.body.status_transitions.sent_at).toEqual(expect.any(Number));
    expect((await s.call("POST", `/v1/invoices/${id}/send`, { token: tok })).body.error.code).toBe("rate_limited");
    const sentEvt = await probe.next("evt.billing.invoice.sent", (e) => e.aggregate.id === id);
    const evObj = InvoiceEvent.parse(sentEvt.data.object);
    expect(evObj.hosted_invoice_url).toBeNull();
    expect(sentEvt.account_id).toBe(uuid(m.account, "acct"));

    const pdf = await s.call("GET", `/v1/invoices/${id}/pdf`, { token: tok });
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get("content-type")).toBe("application/pdf");
    expect(pdf.headers.get("content-disposition")).toBe('attachment; filename="ACMECOT-00001.pdf"');
    expect(pdf.bytes.subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");

    // hosted page
    const h = { "x-nearpay-invoice-secret": secret };
    const wrong = await s.call("GET", `/v1/invoices/${id}/public`, {
      headers: { "x-nearpay-invoice-secret": `${id}_secret_${"A".repeat(32)}` },
    });
    expect(wrong.status).toBe(401);
    expect(wrong.body.error.code).toBe("invoice_secret_invalid");
    const pub = await s.call("GET", `/v1/invoices/${id}/public`, { headers: h });
    expect(PublicInvoice.parse(pub.body)).toMatchObject({ payable: true, bill_to: { email: "payer@example.com" } });
    expect((await s.call("GET", `/v1/invoices/${id}/public/pdf`, { headers: h })).headers.get("content-type")).toBe(
      "application/pdf",
    );
    const sess = await s.call("POST", `/v1/invoices/${id}/public/sessions`, {
      headers: { ...h, "x-forwarded-for": "198.51.100.7" },
      body: {},
    });
    expect(sess.status).toBe(201);
    expect(sess.body).toMatchObject({ object: "invoice_payment_session", reused: false });
    const reused = await s.call("POST", `/v1/invoices/${id}/public/sessions`, { headers: h, body: {} });
    expect(reused.body).toMatchObject({
      checkout_session: sess.body.checkout_session,
      client_secret: sess.body.client_secret,
      reused: true,
    });
    const createCall = s.payments.calls.find((c) => c.routeId === "createInvoiceCheckoutSession");
    expect(createCall?.headers["idempotency-key"]).toBe(`in:${id}:s1`);
    expect(createCall?.body).toMatchObject({
      invoice: id,
      amount: 5551,
      currency: "usd",
      success_url: `https://pay.nearpay.localhost/i/${id}`,
    });

    // notify reads the context with its service token
    const notifyTok = await s.serviceToken("notify");
    const ctx = await s.call("GET", `/internal/invoices/${id}/notification-context?reminder=1`, { token: notifyTok });
    expect(InvoiceNotificationContext.parse(ctx.body)).toMatchObject({
      customer_email: "payer@example.com",
      reminder: { number: 1 },
    });
    expect((await s.call("GET", `/internal/invoices/${id}/notification-context`, { token: tok })).status).toBe(403);

    // payments settles (evidence verified there) → billing marks paid from the event
    const pi = paymentIntent({
      status: "succeeded",
      amount: 5551,
      currency: "usd",
      source: "invoice",
      invoice: id as `in_${string}`,
      checkout_session: sess.body.checkout_session,
    } as never);
    await s.publishEvent(
      domainEvent("evt.payments.payment_intent.succeeded", pi, {
        accountUuid: uuid(m.account, "acct"),
        livemode: false,
      }),
    );
    const paidEvt = await probe.next("evt.billing.invoice.paid", (e) => e.aggregate.id === id, 15_000);
    expect(paidEvt.data.object).toMatchObject({ status: "paid", payment_intent: pi.id });
    const after = await s.call("GET", `/v1/invoices/${id}`, { token: tok });
    expect(after.body).toMatchObject({
      status: "paid",
      amount_paid: 5551,
      amount_remaining: 0,
      checkout_session: null,
    });
    expect((await s.call("POST", `/v1/invoices/${id}/public/sessions`, { headers: h, body: {} })).body.error.code).toBe(
      "invoice_not_payable",
    );
    await probe.close();
  });

  it("void refuses while money may move, then voids; mark uncollectible; delete drafts; list filters", async () => {
    const { price } = await catalogue();
    const mk = async () => {
      const d = await s.call("POST", "/v1/invoices", {
        token: tok,
        body: { customer: cus, lines: [{ price: price.id }] },
      });
      return (await s.call("POST", `/v1/invoices/${d.body.id}/finalize`, { token: tok })).body;
    };
    const a = await mk();
    const secret = (a.hosted_invoice_url as string).split("#")[1] as string;
    await s.call("POST", `/v1/invoices/${a.id}/public/sessions`, {
      headers: { "x-nearpay-invoice-secret": secret },
      body: {},
    });
    s.expireMode = "in_flight";
    expect((await s.call("POST", `/v1/invoices/${a.id}/void`, { token: tok })).body.error.code).toBe(
      "attempt_in_flight",
    );
    s.expireMode = "expire";
    expect((await s.call("POST", `/v1/invoices/${a.id}/void`, { token: tok })).body.status).toBe("void");
    const b = await mk();
    expect((await s.call("POST", `/v1/invoices/${b.id}/mark_uncollectible`, { token: tok })).body).toMatchObject({
      status: "uncollectible",
      uncollectible_reason: "merchant",
    });
    const d = await s.call("POST", "/v1/invoices", { token: tok, body: { customer: cus, currency: "usd" } });
    expect((await s.call("POST", `/v1/invoices/${d.body.id}/finalize`, { token: tok })).body.error.code).toBe(
      "invoice_empty",
    );
    expect((await s.call("DELETE", `/v1/invoices/${d.body.id}`, { token: tok })).body).toEqual({
      id: d.body.id,
      object: "invoice",
      livemode: false,
      deleted: true,
    });
    expect((await s.call("DELETE", `/v1/invoices/${a.id}`, { token: tok })).body.error.code).toBe("state_conflict");
    const voided = await s.call("GET", "/v1/invoices?status=void", { token: tok });
    expect(voided.body.data.map((i: { id: string }) => i.id)).toContain(a.id);
    expect(
      (await s.call("GET", `/v1/invoices?customer=${cus}&limit=100`, { token: tok })).body.data.length,
    ).toBeGreaterThan(1);
  });

  it("live mode without KYB refuses finalize; a session expiry event forgets the session", async () => {
    const live = s.merchant({ liveEnabled: false });
    const ltok = await s.token(live, { livemode: true });
    const lcus = s.customer(live, { livemode: true });
    const d = await s.call("POST", "/v1/invoices", {
      token: ltok,
      body: { customer: lcus, currency: "usd", lines: [{ unit_amount: 500, description: "x" }] },
    });
    expect(d.status).toBe(201);
    expect((await s.call("POST", `/v1/invoices/${d.body.id}/finalize`, { token: ltok })).body.error.code).toBe(
      "account_not_live",
    );

    const { price } = await catalogue();
    const inv = (
      await s.call(
        "POST",
        `/v1/invoices/${(await s.call("POST", "/v1/invoices", { token: tok, body: { customer: cus, lines: [{ price: price.id }] } })).body.id}/finalize`,
        { token: tok },
      )
    ).body;
    const secret = (inv.hosted_invoice_url as string).split("#")[1] as string;
    const sess = await s.call("POST", `/v1/invoices/${inv.id}/public/sessions`, {
      headers: { "x-nearpay-invoice-secret": secret },
      body: {},
    });
    const stored = s.sessions.get(sess.body.checkout_session);
    if (stored) stored.status = "expired";
    const cs = checkoutSession({ id: sess.body.checkout_session, status: "expired", invoice: inv.id } as never);
    await s.publishEvent(
      domainEvent("evt.payments.checkout_session.expired", cs, {
        accountUuid: uuid(m.account, "acct"),
        livemode: false,
      }),
    );
    await expect
      .poll(async () => (await s.call("GET", `/v1/invoices/${inv.id}`, { token: tok })).body.checkout_session, {
        timeout: 15_000,
      })
      .toBeNull();

    // a failed payment is reported and the invoice stays open; an expired intent forgets its session too
    const probe = await s.probe();
    const acct = { accountUuid: uuid(m.account, "acct"), livemode: false };
    const failed = paymentIntent({
      status: "requires_payment",
      amount: inv.total,
      source: "invoice",
      invoice: inv.id,
    } as never);
    await s.publishEvent(domainEvent("evt.payments.payment_intent.payment_failed", failed, acct));
    const fe = await probe.next("evt.billing.invoice.payment_failed", (e) => e.aggregate.id === inv.id, 15_000);
    expect(fe.data.object).toMatchObject({ status: "open", payment_intents: [failed.id] });
    const sess2 = await s.call("POST", `/v1/invoices/${inv.id}/public/sessions`, {
      headers: { "x-nearpay-invoice-secret": secret },
      body: {},
    });
    expect(sess2.body.reused).toBe(false);
    const st2 = s.sessions.get(sess2.body.checkout_session);
    if (st2) st2.status = "expired";
    const expiredPi = paymentIntent({
      status: "expired",
      amount: inv.total,
      source: "invoice",
      invoice: inv.id,
      checkout_session: sess2.body.checkout_session,
    } as never);
    await s.publishEvent(domainEvent("evt.payments.payment_intent.expired", expiredPi, acct));
    await expect
      .poll(async () => (await s.call("GET", `/v1/invoices/${inv.id}`, { token: tok })).body.checkout_session, {
        timeout: 15_000,
      })
      .toBeNull();
    await probe.close();
  });
});

describe("subscriptions", () => {
  it("create (first invoice sent), get/list/update/cancel, notification context", async () => {
    const { monthly, tax } = await catalogue();
    const created = await s.call("POST", "/v1/subscriptions", {
      token: tok,
      body: {
        customer: cus,
        items: [{ price: monthly.id, quantity: 2 }],
        default_tax_rates: [tax.id],
        dunning: { reminder_days: [0, 3], on_exhausted: "unpaid" },
      },
      headers: { "idempotency-key": "sub-1" },
    });
    expect(created.status).toBe(201);
    const sub = SubscriptionSchema.parse(created.body);
    expect(sub).toMatchObject({ status: "incomplete", items: [{ quantity: 2, price: { id: monthly.id } }] });
    const invs = await s.call("GET", `/v1/invoices?subscription=${sub.id}`, { token: tok });
    expect(invs.body.data[0]).toMatchObject({
      billing_reason: "subscription_create",
      status: "open",
      total: 3266,
      reminder_days: [0, 3],
    });
    expect(invs.body.data[0].status_transitions.sent_at).toEqual(expect.any(Number));

    const upd = await s.call("PATCH", `/v1/subscriptions/${sub.id}`, {
      token: tok,
      body: { items: [{ price: monthly.id, quantity: 3 }], proration_behavior: "none" },
    });
    expect(upd.body.items[0].quantity).toBe(3);
    expect(
      (await s.call("GET", `/v1/subscriptions?price=${monthly.id}`, { token: tok })).body.data.map(
        (x: { id: string }) => x.id,
      ),
    ).toContain(sub.id);
    const ctx = await s.call("GET", `/internal/subscriptions/${sub.id}/notification-context`, {
      token: await s.serviceToken("notify"),
    });
    expect(SubscriptionNotificationContext.parse(ctx.body)).toMatchObject({
      next_amount: 4899,
      items: [{ quantity: 3 }],
    });
    const atEnd = await s.call("POST", `/v1/subscriptions/${sub.id}/cancel`, {
      token: tok,
      body: { at_period_end: true },
    });
    expect(atEnd.body).toMatchObject({ cancel_at_period_end: true, status: "incomplete" });
    const now = await s.call("POST", `/v1/subscriptions/${sub.id}/cancel`, { token: tok, body: {} });
    expect(now.body).toMatchObject({ status: "canceled", cancellation_reason: "requested" });
    expect((await s.call("GET", `/v1/subscriptions/${sub.id}`, { token: tok })).body.status).toBe("canceled");
    expect((await s.call("POST", `/v1/subscriptions/${sub.id}/cancel`, { token: tok, body: {} })).body.error.code).toBe(
      "state_conflict",
    );

    const noMail = s.customer(m, { email: null });
    const refused = await s.call("POST", "/v1/subscriptions", {
      token: tok,
      body: { customer: noMail, items: [{ price: monthly.id }] },
    });
    expect(refused.body.error.code).toBe("customer_email_missing");
    const mixed = await s.call("POST", "/v1/subscriptions", {
      token: tok,
      body: { customer: cus, items: [{ price: monthly.id }, { price: (await catalogue()).price.id }] },
    });
    expect(mixed.body.error.code).toBe("price_type_invalid");
  });
});

describe("test-mode billing clock (spec 0.3.1, lld/billing.md §13)", () => {
  it("advance_clock: renewal_upcoming → notice, renewal → invoice, overdue → invoice.overdue; idempotent; live refused", async () => {
    const { monthly } = await catalogue();
    const created = await s.call("POST", "/v1/subscriptions", {
      token: tok,
      body: { customer: cus, items: [{ price: monthly.id }], dunning: { reminder_days: [0, 3] } },
    });
    const sub = SubscriptionSchema.parse(created.body);
    const first = (await s.call("GET", `/v1/invoices?subscription=${sub.id}`, { token: tok })).body.data[0];
    const pi = paymentIntent({
      status: "succeeded",
      amount: first.total,
      currency: "usd",
      source: "invoice",
      invoice: first.id,
    } as never);
    await s.publishEvent(
      domainEvent("evt.payments.payment_intent.succeeded", pi, {
        accountUuid: uuid(m.account, "acct"),
        livemode: false,
      }),
    );
    await expect
      .poll(async () => (await s.call("GET", `/v1/subscriptions/${sub.id}`, { token: tok })).body.status, {
        timeout: 15_000,
      })
      .toBe("active");
    // the paid mail's verification line: the fingerprint of the destination the intent settled to
    const nctx = await s.call("GET", `/internal/invoices/${first.id}/notification-context`, {
      token: await s.serviceToken("notify"),
    });
    expect(InvoiceNotificationContext.parse(nctx.body)).toMatchObject({
      subtotal: first.subtotal,
      tax: first.tax,
      line_count: 1,
      destination_fingerprint: pi.destination.fingerprint ?? null,
    });

    const path = `/v1/test_helpers/subscriptions/${sub.id}/advance_clock`;
    const live = await s.call("POST", path, {
      token: await s.token(m, { livemode: true }),
      body: { target: "renewal" },
    });
    expect(live.body.error.code).toBe("livemode_forbidden");

    const probe = await s.probe();
    const end = sub.current_period_end;
    const up = await s.call("POST", path, {
      token: tok,
      body: { target: "renewal_upcoming" },
      headers: { "idempotency-key": "clk-1" },
    });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({
      object: "subscription_clock_advance",
      subscription: sub.id,
      target: "renewal_upcoming",
      clock_time: end - 3 * 86_400,
    });
    // advanced from real time (offset 0 before): clock_time − advanced_by ≈ now
    expect(Math.abs(up.body.clock_time - up.body.advanced_by - Math.floor(Date.now() / 1000))).toBeLessThan(30);
    const replay = await s.call("POST", path, {
      token: tok,
      body: { target: "renewal_upcoming" },
      headers: { "idempotency-key": "clk-1" },
    });
    expect(replay.body).toEqual(up.body);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    await probe.next("evt.billing.subscription.renewal_upcoming", (e) => e.aggregate.id === sub.id, 15_000);
    expect((await s.call("POST", path, { token: tok, body: { target: "renewal_upcoming" } })).body.error.code).toBe(
      "state_conflict",
    );

    const r = await s.call("POST", path, { token: tok, body: { target: "renewal" } });
    expect(r.body).toMatchObject({ target: "renewal", clock_time: end });
    // 3 days minus the real seconds that passed since the first advance
    expect(3 * 86_400 - r.body.advanced_by).toBeGreaterThanOrEqual(0);
    expect(3 * 86_400 - r.body.advanced_by).toBeLessThan(30);
    const sent = await probe.next(
      "evt.billing.invoice.sent",
      (e) => (e.data.object as { subscription?: string }).subscription === sub.id,
      15_000,
    );
    const renewal = InvoiceEvent.parse(sent.data.object);
    expect(renewal).toMatchObject({ billing_reason: "subscription_cycle", period_start: end });

    const o = await s.call("POST", path, { token: tok, body: { target: "overdue" } });
    expect(o.body).toMatchObject({ target: "overdue", clock_time: renewal.due_date });
    await probe.next("evt.billing.invoice.overdue", (e) => e.aggregate.id === renewal.id, 15_000);
    await probe.next("evt.billing.invoice.reminder", (e) => e.aggregate.id === renewal.id, 15_000);
    await expect
      .poll(async () => (await s.call("GET", `/v1/subscriptions/${sub.id}`, { token: tok })).body.status, {
        timeout: 15_000,
      })
      .toBe("past_due");
    expect((await s.call("POST", path, { token: tok, body: { target: "overdue" } })).body.error.code).toBe(
      "state_conflict",
    );
    await probe.close();
  });
});
