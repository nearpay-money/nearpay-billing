import { beforeEach, describe, expect, it } from "vitest";
import * as catalog from "../../src/app/catalog.js";
import type { Ctx } from "../../src/app/commit.js";
import { createPublicInvoiceSession, getPublicInvoice } from "../../src/app/hosted.js";
import * as inv from "../../src/app/invoices.js";
import { invoiceNotificationContext } from "../../src/app/notification.js";
import {
  onCheckoutSessionExpired,
  onPaymentIntentFailed,
  onPaymentIntentSucceeded,
} from "../../src/app/payment-events.js";
import { getInvoicePdf, getPublicInvoicePdf } from "../../src/app/pdf.js";
import type { Invoice } from "../../src/domain/invoice/invoice.js";
import { DomainError } from "../../src/domain/shared.js";
import { jobHandlers } from "../../src/workers/jobs.js";
import { LIVE, OTHER, SCOPE, T0 } from "../support/fixtures.js";
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
let priceId: string;
let vatId: string;

beforeEach(async () => {
  b = testBilling(T0 * 1000);
  b.pay.addCustomer(SCOPE, { id: "cus_1" });
  b.pay.addCustomer(SCOPE, { id: "cus_noemail", email: null, name: null });
  b.pay.addCustomer(SCOPE, { id: "cus_gone", deleted: true });
  const p = await catalog.createProduct(b, c, { name: "Consulting" });
  priceId = (await catalog.createPrice(b, c, { productId: p.id, unitAmount: 10_000n, currency: "usd", assetId: null }))
    .id;
  vatId = (await catalog.createTaxRate(b, c, { displayName: "VAT", percentage: "19", inclusive: false })).id;
});

const subjects = () => b.mem.state.outbox.map((e) => e.subject);
const secretOf = (i: Invoice) => inv.invoiceSecretOf(b, i) as string;

async function openInvoice(): Promise<Invoice> {
  const d = await inv.createInvoice(b, c, {
    customerId: "cus_1",
    lines: [{ priceId, quantity: 2 }],
    defaultTaxRateIds: [vatId],
  });
  return inv.finalizeInvoice(b, c, d.id);
}

describe("catalogue use cases", () => {
  it("create/get/list/update in scope only", async () => {
    const p = await catalog.createProduct(b, c, { name: "A" });
    expect((await catalog.getProduct(b, c, p.id)).name).toBe("A");
    expect(await code(catalog.getProduct(b, { ...c, scope: OTHER }, p.id))).toBe("resource_missing");
    expect((await catalog.updateProduct(b, c, p.id, { active: false })).version).toBe(1);
    const page = await catalog.listProducts(b, c, { limit: 1, active: true });
    expect(page.data).toHaveLength(1);
    expect(page.hasMore).toBe(false);
    expect(await code(catalog.updateProduct(b, c, "prod_x", {}))).toBe("resource_missing");
    expect(
      await code(catalog.createPrice(b, c, { productId: p.id, unitAmount: 1n, currency: "jpy", assetId: null })),
    ).toBe("currency_unsupported");
    expect(
      await code(
        catalog.createPrice(b, c, { productId: p.id, unitAmount: 1n, currency: "asset", assetId: "nep141:nope" }),
      ),
    ).toBe("currency_unsupported");
    const ap = await catalog.createPrice(b, c, {
      productId: p.id,
      unitAmount: 10n ** 24n,
      currency: "asset",
      assetId: "nep141:usdc.near",
    });
    expect((await catalog.updatePrice(b, c, ap.id, { nickname: "n" })).unitAmount).toBe(10n ** 24n);
    expect((await catalog.getPrice(b, c, ap.id)).nickname).toBe("n");
    expect((await catalog.listPrices(b, c, { limit: 10, currency: "asset" })).data.map((x) => x.id)).toEqual([ap.id]);
    expect(await code(catalog.getPrice(b, c, "price_x"))).toBe("resource_missing");
    expect(await code(catalog.updatePrice(b, c, "price_x", {}))).toBe("resource_missing");
    const r = await catalog.updateTaxRate(b, c, vatId, { active: false });
    expect(r).toMatchObject({ active: false, ratePpm: 190_000 });
    expect((await catalog.getTaxRate(b, c, vatId)).active).toBe(false);
    expect((await catalog.listTaxRates(b, c, { limit: 10, inclusive: false })).data).toHaveLength(1);
    expect(await code(catalog.getTaxRate(b, c, "txr_x"))).toBe("resource_missing");
    expect(await code(catalog.updateTaxRate(b, c, "txr_x", {}))).toBe("resource_missing");
  });
});

describe("invoice use cases", () => {
  it("drafts → finalize → number, due date, hosted URL, reminders and events", async () => {
    const d = await inv.createInvoice(b, c, {
      customerId: "cus_1",
      lines: [{ priceId, quantity: 2 }],
      defaultTaxRateIds: [vatId],
    });
    expect(d).toMatchObject({
      status: "draft",
      currency: "usd",
      subtotal: 20_000n,
      tax: 3_800n,
      total: 23_800n,
      number: null,
    });
    const o = await inv.finalizeInvoice(b, c, d.id);
    expect(o).toMatchObject({
      status: "open",
      number: "ACMECOT-00001",
      dueDate: T0 + 30 * 86_400,
      merchantName: "Acme Corp",
    });
    const url = inv.hostedInvoiceUrl(b, o) as string;
    expect(url).toMatch(new RegExp(`^https://pay\\.nearpay\\.test/i/${o.id}#${o.id}_secret_[0-9A-Za-z]{32}$`));
    expect(inv.billToOf(b, o)).toEqual({ name: "Pat Payer", email: "payer@example.com" });
    expect(subjects()).toEqual(["evt.billing.invoice.created", "evt.billing.invoice.finalized"]);
    expect(b.mem.state.outbox.map((e) => e.aggregate.version)).toEqual([0, 1]);
    expect(b.mem.state.transitions.map((t) => `${t.from}->${t.to}`)).toEqual(["null->draft", "draft->open"]);
    expect([...b.mem.state.jobs.keys()].sort()).toEqual(
      [
        ...[1, 2, 3, 4, 5].map((n) => `invoice.remind:${o.id}:r${n}`),
        `invoice.overdue:${o.id}`,
        `invoice.render_pdf:${o.id}:open`,
      ].sort(),
    );
    const second = await openInvoice();
    expect(second.number).toBe("ACMECOT-00002");
    expect(await code(inv.finalizeInvoice(b, c, o.id))).toBe("state_conflict");
  });

  it("finalize guards: customer, live mode, destination, currency, prices, empty", async () => {
    const d = await inv.createInvoice(b, c, { customerId: "cus_1", lines: [{ priceId }] });
    b.merchantFacts = { ...b.merchantFacts, defaults: {} };
    expect(await code(inv.finalizeInvoice(b, c, d.id))).toBe("destination_not_active");
    b.merchantFacts = { ...b.merchantFacts, defaults: { "*": "sd_default" } };
    const withDest = await inv.updateInvoice(b, c, d.id, { settlementDestinationId: "sd_other" });
    expect(await code(inv.finalizeInvoice(b, c, withDest.id))).toBe("destination_not_active");
    await inv.updateInvoice(b, c, d.id, { settlementDestinationId: null });
    await catalog.updatePrice(b, c, priceId, { active: false });
    expect(await code(inv.finalizeInvoice(b, c, d.id))).toBe("price_inactive");
    await catalog.updatePrice(b, c, priceId, { active: true });
    b.pay.customers.set("cus_1", {
      ...(b.pay.customers.get("cus_1") as NonNullable<ReturnType<typeof b.pay.customers.get>>),
      deleted: true,
    });
    expect(await code(inv.finalizeInvoice(b, c, d.id))).toBe("customer_deleted");
    const empty = await inv.createInvoice(b, c, { customerId: "cus_noemail", currency: "usd" });
    expect(await code(inv.finalizeInvoice(b, c, empty.id))).toBe("invoice_empty");
    expect(await code(inv.finalizeInvoice(b, c, "in_missing"))).toBe("resource_missing");

    const live: Ctx = { scope: LIVE, actor: "user:usr_1" };
    b.pay.addCustomer(LIVE, { id: "cus_live" });
    const ld = await inv.createInvoice(b, live, {
      customerId: "cus_live",
      currency: "usd",
      lines: [{ unitAmount: 5n, description: "x" }],
    });
    b.merchantFacts = { ...b.merchantFacts, liveEnabled: false, liveMissing: "kyb" };
    expect(await code(inv.finalizeInvoice(b, live, ld.id))).toBe("account_not_live");
  });

  it("create/update input errors", async () => {
    expect(await code(inv.createInvoice(b, c, { customerId: "cus_x" }))).toBe("resource_missing");
    expect(await code(inv.createInvoice(b, c, { customerId: "cus_gone", currency: "usd" }))).toBe("customer_deleted");
    expect(await code(inv.createInvoice(b, c, { customerId: "cus_1" }))).toBe("invalid_request");
    expect(await code(inv.createInvoice(b, c, { customerId: "cus_1", currency: "jpy" }))).toBe("currency_unsupported");
    expect(await code(inv.createInvoice(b, c, { customerId: "cus_1", currency: "eur", lines: [{ priceId }] }))).toBe(
      "currency_mismatch",
    );
    const inc = await catalog.createTaxRate(b, c, { displayName: "GST", percentage: "10", inclusive: true });
    expect(
      await code(inv.createInvoice(b, c, { customerId: "cus_1", lines: [{ priceId, taxRateIds: [vatId, inc.id] }] })),
    ).toBe("tax_rates_mixed");
    const d = await inv.createInvoice(b, c, { customerId: "cus_1", lines: [{ priceId }] });
    expect(await code(inv.updateInvoice(b, c, d.id, { currency: "eur" }))).toBe("invalid_request");
    const u = await inv.updateInvoice(b, c, d.id, {
      lines: [{ unitAmount: 700n, description: "x", quantity: 3 }],
      currency: "eur",
    });
    expect(u).toMatchObject({ currency: "eur", total: 2100n });
    const taxed = await inv.updateInvoice(b, c, d.id, { defaultTaxRateIds: [vatId] });
    expect(taxed.tax).toBe(399n);
    expect(await code(inv.updateInvoice(b, c, d.id, { customerId: "cus_gone" }))).toBe("customer_deleted");
    expect(await code(inv.updateInvoice(b, c, "in_x", {}))).toBe("resource_missing");
    const o = await inv.finalizeInvoice(b, c, d.id);
    expect(await code(inv.updateInvoice(b, c, o.id, { description: "late" }))).toBe("state_conflict");
    expect((await inv.updateInvoice(b, c, o.id, { metadata: { k: "v" } })).metadata).toEqual({ k: "v" });
    expect(await code(inv.deleteInvoice(b, c, o.id))).toBe("state_conflict");
    const gone = await inv.createInvoice(b, c, { customerId: "cus_1", currency: "usd" });
    expect(await inv.deleteInvoice(b, c, gone.id)).toEqual({ id: gone.id, livemode: false });
    expect(await code(inv.getInvoice(b, c, gone.id))).toBe("resource_missing");
    expect(await code(inv.deleteInvoice(b, c, gone.id))).toBe("resource_missing");
    expect((await inv.listInvoices(b, c, { limit: 10, status: "open" })).data.map((i) => i.id)).toEqual([o.id]);
  });

  it("send: email required, rate-limited, emits invoice.sent", async () => {
    const o = await openInvoice();
    const s = await inv.sendInvoice(b, c, o.id);
    expect(s.sentAt).toBe(T0);
    expect(subjects().at(-1)).toBe("evt.billing.invoice.sent");
    expect(await code(inv.sendInvoice(b, c, o.id))).toBe("rate_limited");
    b.clock.ms += 600_000;
    expect(await code(inv.sendInvoice(b, c, o.id))).toBe("ok");
    const d = await inv.createInvoice(b, c, { customerId: "cus_noemail", lines: [{ priceId }] });
    expect(await code(inv.sendInvoice(b, c, d.id))).toBe("state_conflict");
    const n = await inv.finalizeInvoice(b, c, d.id);
    expect(await code(inv.sendInvoice(b, c, n.id))).toBe("customer_email_missing");
    expect(await code(inv.sendInvoice(b, c, "in_x"))).toBe("resource_missing");
  });

  it("hosted page: secret check, read-only GET, session create/reuse, rate limit", async () => {
    const o = await openInvoice();
    const secret = secretOf(o);
    expect(await code(getPublicInvoice(b, o.id, `${o.id}_secret_${"A".repeat(32)}`))).toBe("invoice_secret_invalid");
    expect(await code(getPublicInvoice(b, "in_missing", secret))).toBe("resource_missing");
    const pub = await getPublicInvoice(b, o.id, secret);
    expect(pub).toMatchObject({
      payable: true,
      merchantName: "Acme Corp",
      billTo: { email: "payer@example.com" },
      settlement: { assetId: "nep141:usdc.near", chain: "near:mainnet" },
    });
    expect(b.pay.created).toHaveLength(0); // GET has no side effects

    const s1 = await createPublicInvoiceSession(b, o.id, secret, { clientNetwork: "198.51.100.0/24" });
    expect(s1).toMatchObject({ reused: false });
    expect(b.pay.created[0]).toMatchObject({
      key: `in:${o.id}:s1`,
      amount: 23_800n,
      metadata: { invoice_number: "ACMECOT-00001" },
    });
    const s2 = await createPublicInvoiceSession(b, o.id, secret, { clientNetwork: "198.51.100.0/24" });
    expect(s2).toEqual({ ...s1, reused: true });

    // expired session → forgotten by the consumer → a new one with the next idempotency key
    const sess = b.pay.sessions.get(s1.checkoutSession);
    if (sess) sess.status = "expired";
    await onCheckoutSessionExpired(b, {
      eventId: "e-exp",
      subject: "evt.payments.checkout_session.expired",
      scope: SCOPE,
      object: { id: s1.checkoutSession, invoiceId: o.id },
    });
    const s3 = await createPublicInvoiceSession(b, o.id, secret, { clientNetwork: "198.51.100.0/24" });
    expect(s3.reused).toBe(false);
    expect(b.pay.created.at(-1)?.key).toBe(`in:${o.id}:s2`);

    for (let i = 0; i < 7; i++) await createPublicInvoiceSession(b, o.id, secret, { clientNetwork: "198.51.100.0/24" });
    expect(await code(createPublicInvoiceSession(b, o.id, secret, { clientNetwork: "198.51.100.0/24" }))).toBe(
      "rate_limited",
    );
    b.clock.ms += 60_000;
    expect(await code(createPublicInvoiceSession(b, o.id, secret, { clientNetwork: "198.51.100.0/24" }))).toBe("ok");

    const d = await inv.createInvoice(b, c, { customerId: "cus_1", lines: [{ priceId }] });
    expect(await code(getPublicInvoice(b, d.id, secret))).toBe("resource_missing"); // drafts look missing
  });

  it("a stale stored session is replaced when payments says it is no longer open", async () => {
    const o = await openInvoice();
    const secret = secretOf(o);
    const s1 = await createPublicInvoiceSession(b, o.id, secret, { clientNetwork: "n" });
    const s = b.pay.sessions.get(s1.checkoutSession);
    if (s) s.status = "complete";
    const s2 = await createPublicInvoiceSession(b, o.id, secret, { clientNetwork: "n" });
    expect(s2.checkoutSession).not.toBe(s1.checkoutSession);
  });

  it("payment succeeded → paid (once), events, PDF re-render; failures and late money", async () => {
    const o = await openInvoice();
    const s = await createPublicInvoiceSession(b, o.id, secretOf(o), { clientNetwork: "n" });
    const pi = {
      id: "pi_1",
      status: "succeeded",
      invoiceId: o.id,
      ...SCOPE,
      currency: "usd",
      assetId: null,
      amount: o.total,
    };
    await onPaymentIntentFailed(b, {
      eventId: "e0",
      subject: "evt.payments.payment_intent.payment_failed",
      scope: SCOPE,
      object: { ...pi, id: "pi_0", status: "requires_payment" },
    });
    expect(subjects().at(-1)).toBe("evt.billing.invoice.payment_failed");
    await onPaymentIntentSucceeded(b, {
      eventId: "e1",
      subject: "evt.payments.payment_intent.succeeded",
      scope: SCOPE,
      object: pi,
    });
    await onPaymentIntentSucceeded(b, {
      eventId: "e1",
      subject: "evt.payments.payment_intent.succeeded",
      scope: SCOPE,
      object: pi,
    });
    const paid = await inv.getInvoice(b, c, o.id);
    expect(paid).toMatchObject({
      status: "paid",
      paymentIntentId: "pi_1",
      amountPaid: o.total,
      paymentIntentIds: ["pi_1", "pi_0"],
      session: null,
    });
    expect(subjects().filter((x) => x === "evt.billing.invoice.paid")).toHaveLength(1);
    expect(b.mem.state.jobs.has(`invoice.render_pdf:${o.id}:paid`)).toBe(true);
    expect(s.checkoutSession).toMatch(/^cs_/);

    // late settlement on a paid invoice: listed, nothing else
    await onPaymentIntentSucceeded(b, {
      eventId: "e2",
      subject: "evt.payments.payment_intent.succeeded",
      scope: SCOPE,
      object: { ...pi, id: "pi_2" },
    });
    expect((await inv.getInvoice(b, c, o.id)).paymentIntentIds).toEqual(["pi_2", "pi_1", "pi_0"]);
    expect(b.logs.some((l) => l.msg.includes("late settlement"))).toBe(true);

    // hosted page after payment
    expect(await code(createPublicInvoiceSession(b, o.id, secretOf(o), { clientNetwork: "n" }))).toBe(
      "invoice_not_payable",
    );
    expect((await getPublicInvoice(b, o.id, secretOf(o))).payable).toBe(false);
  });

  it("fails closed on an intent that does not cover the invoice", async () => {
    const o = await openInvoice();
    await onPaymentIntentSucceeded(b, {
      eventId: "e1",
      subject: "evt.payments.payment_intent.succeeded",
      scope: SCOPE,
      object: {
        id: "pi_x",
        status: "succeeded",
        invoiceId: o.id,
        ...SCOPE,
        currency: "usd",
        assetId: null,
        amount: o.total - 1n,
      },
    });
    expect((await inv.getInvoice(b, c, o.id)).status).toBe("open");
    expect(b.logs.some((l) => l.level === "error" && l.msg.startsWith("ALERT"))).toBe(true);
    await onPaymentIntentSucceeded(b, {
      eventId: "e2",
      subject: "evt.payments.payment_intent.succeeded",
      scope: SCOPE,
      object: {
        id: "pi_y",
        status: "succeeded",
        invoiceId: "in_unknown",
        ...SCOPE,
        currency: "usd",
        assetId: null,
        amount: 1n,
      },
    });
    await onPaymentIntentSucceeded(b, {
      eventId: "e3",
      subject: "evt.payments.payment_intent.succeeded",
      scope: SCOPE,
      object: {
        id: "pi_z",
        status: "succeeded",
        invoiceId: null,
        ...SCOPE,
        currency: "usd",
        assetId: null,
        amount: 1n,
      },
    });
    expect((await inv.getInvoice(b, c, o.id)).status).toBe("open");
  });

  it("void: expires the session first; refuses while money may move", async () => {
    const o = await openInvoice();
    await createPublicInvoiceSession(b, o.id, secretOf(o), { clientNetwork: "n" });
    b.pay.expireResult = "in_flight";
    expect(await code(inv.voidInvoiceUseCase(b, c, o.id))).toBe("attempt_in_flight");
    b.pay.expireResult = "expiring";
    expect(await code(inv.voidInvoiceUseCase(b, c, o.id))).toBe("attempt_in_flight");
    b.pay.expireResult = "expired";
    const v = await inv.voidInvoiceUseCase(b, c, o.id);
    expect(v).toMatchObject({ status: "void", session: null });
    expect(subjects().at(-1)).toBe("evt.billing.invoice.voided");
    expect(await code(inv.voidInvoiceUseCase(b, c, o.id))).toBe("state_conflict");
    expect(await code(createPublicInvoiceSession(b, o.id, secretOf(o), { clientNetwork: "n" }))).toBe(
      "invoice_not_payable",
    );
    const ctx = await invoiceNotificationContext(b, o.id);
    expect(ctx.hostedInvoiceUrl).toBeNull();
  });

  it("mark uncollectible keeps the invoice payable; a late payment pays it (INV-3)", async () => {
    const o = await openInvoice();
    const u = await inv.markInvoiceUncollectible(b, c, o.id);
    expect(u).toMatchObject({ status: "uncollectible", uncollectibleReason: "merchant" });
    expect(await code(inv.markInvoiceUncollectible(b, c, o.id))).toBe("state_conflict");
    expect(await code(inv.markInvoiceUncollectible(b, c, "in_x"))).toBe("resource_missing");
    await createPublicInvoiceSession(b, o.id, secretOf(o), { clientNetwork: "n" });
    await onPaymentIntentSucceeded(b, {
      eventId: "e1",
      subject: "evt.payments.payment_intent.succeeded",
      scope: SCOPE,
      object: {
        id: "pi_1",
        status: "succeeded",
        invoiceId: o.id,
        ...SCOPE,
        currency: "usd",
        assetId: null,
        amount: o.total,
      },
    });
    expect((await inv.getInvoice(b, c, o.id)).status).toBe("paid");
  });

  it("dunning jobs: reminders in order, overdue once; manual invoices stay open", async () => {
    const o = await openInvoice();
    const handlers = jobHandlers(b);
    b.clock.ms = ((o.dueDate as number) + 8 * 86_400) * 1000;
    await runDueJobs(b, handlers);
    const after = await inv.getInvoice(b, c, o.id);
    expect(after).toMatchObject({
      status: "open",
      remindersSent: 5,
      overdueAt: o.dueDate === null ? null : expect.any(Number),
    });
    const reminders = b.mem.state.outbox.filter((e) => e.subject === "evt.billing.invoice.reminder");
    expect(reminders.map((e) => (e.object.kind === "invoice_reminder" ? e.object.reminder.number : 0))).toEqual([
      1, 2, 3, 4, 5,
    ]);
    expect(subjects().filter((s) => s === "evt.billing.invoice.overdue")).toHaveLength(1);
    const ctx = await invoiceNotificationContext(b, o.id, 5);
    expect(ctx.reminder).toEqual({ number: 5, offsetDays: 7, last: true });
    expect(ctx).toMatchObject({
      customerEmail: "payer@example.com",
      merchantDisplayName: "Acme Corp",
      amountRemaining: o.total,
    });
    expect(ctx.hostedInvoiceUrl).toContain(`/i/${o.id}#`);
    expect((await invoiceNotificationContext(b, o.id, 9)).reminder).toBeNull();
    expect(await code(invoiceNotificationContext(b, "in_x"))).toBe("resource_missing");
  });

  it("time-based jobs act at their scheduled time even if the service clock lags (skew)", async () => {
    const o = await openInvoice();
    const first = o.dueDate as number;
    // the database runs the reminder job a second before the service clock reaches it
    b.clock.ms = (first - 3 * 86_400 - 1) * 1000;
    await jobHandlers(b)["invoice.remind"]({
      invoice: o.id,
      account_id: SCOPE.accountId,
      livemode: false,
      number: 1,
      at: first - 3 * 86_400,
    });
    expect((await inv.getInvoice(b, c, o.id)).remindersSent).toBe(1);
    await jobHandlers(b)["invoice.overdue"]({ invoice: o.id, account_id: SCOPE.accountId, livemode: false, at: first });
    expect((await inv.getInvoice(b, c, o.id)).overdueAt).toBe(first);
  });

  it("PDFs: drafts refused, rendered with a status stamp, served to the secret holder", async () => {
    const d = await inv.createInvoice(b, c, { customerId: "cus_1", lines: [{ priceId }] });
    expect(await code(getInvoicePdf(b, c, d.id))).toBe("state_conflict");
    expect(await code(getInvoicePdf(b, c, "in_x"))).toBe("resource_missing");
    const o = await inv.finalizeInvoice(b, c, d.id);
    await runDueJobs(b, jobHandlers(b));
    const stored = await inv.getInvoice(b, c, o.id);
    expect(stored.pdfObjectKey).toMatch(/\/open\.pdf$/);
    expect(new TextDecoder().decode((await getInvoicePdf(b, c, o.id)).pdf)).toBe("%PDF ACMECOT-00001 ");
    await inv.voidInvoiceUseCase(b, c, o.id);
    expect(new TextDecoder().decode((await getPublicInvoicePdf(b, o.id, secretOf(o))).pdf)).toBe(
      "%PDF ACMECOT-00001 VOID",
    );
    expect(await code(getPublicInvoicePdf(b, o.id, "nope"))).toBe("invoice_secret_invalid");
  });
});
