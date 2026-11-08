/**
 * Contract (foundations §16): every Stage-3 billing route is bound (and nothing else); every subject the
 * catalogue routes to billing is handled; every subject billing produces is emitted; the objects billing
 * serves and emits parse with the spec 0.3.0 schemas.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  Invoice,
  InvoicePaymentSession,
  Price,
  Product,
  PUBLIC_ROUTES,
  PublicInvoice,
  Subscription,
  SubscriptionClockAdvance,
  TaxRate,
} from "@nearpay/spec";
import { unhandledSubjects } from "@nearpay-internal/bus";
import { unimplementedRoutes } from "@nearpay-internal/service";
import {
  INTERNAL_ROUTES,
  InvoiceNotificationContext,
  SUBJECTS,
  type Subject,
  SubscriptionNotificationContext,
} from "@nearpay-internal/spec";
import { describe, expect, it } from "vitest";
import { billingRoutes } from "../../src/api/routes.js";
import {
  clockAdvanceView,
  eventRenderer,
  invoiceNotificationView,
  invoicePaymentSessionView,
  invoiceView,
  priceView,
  productView,
  publicInvoiceView,
  subscriptionNotificationView,
  subscriptionView,
  taxRateView,
} from "../../src/api/views.js";
import * as catalog from "../../src/app/catalog.js";
import type { Ctx } from "../../src/app/commit.js";
import { createPublicInvoiceSession, getPublicInvoice } from "../../src/app/hosted.js";
import * as inv from "../../src/app/invoices.js";
import { invoiceNotificationContext, subscriptionNotificationContext } from "../../src/app/notification.js";
import * as subs from "../../src/app/subscriptions.js";
import { billingHandlers } from "../../src/consumers/handlers.js";
import { newBillingId } from "../../src/infra/ids.js";
import { jobHandlers } from "../../src/workers/jobs.js";
import { SCOPE, T0 } from "../support/fixtures.js";
import { runDueJobs, testBilling } from "../support/memory.js";

const ALL = [...PUBLIC_ROUTES, ...INTERNAL_ROUTES];
const c: Ctx = { scope: SCOPE, actor: "secret_key:key_1" };

describe("routes and events", () => {
  it("binds every Stage-3 billing route, and nothing else", () => {
    const bindings = billingRoutes({} as never, "test");
    expect(unimplementedRoutes("billing", ALL, bindings, 3).map((r) => r.id)).toEqual([]);
    expect(bindings.map((b) => b.route.id).sort()).toEqual(
      [...new Map(ALL.map((r) => [r.id, r])).values()]
        .filter((r) => r.service === "billing" && r.stage <= 3)
        .map((r) => r.id)
        .sort(),
    );
    expect(bindings).toHaveLength(33);
  });

  it("handles every subject the catalogue routes to billing", () => {
    const handlers = billingHandlers({} as never);
    expect(unhandledSubjects("billing", handlers)).toEqual([]);
    for (const s of Object.keys(handlers) as Subject[]) expect(SUBJECTS[s].consumers).toContain("billing");
  });

  it("emits every subject billing produces (Stage 3)", () => {
    const produced = (Object.keys(SUBJECTS) as Subject[]).filter(
      (k) => SUBJECTS[k].producer === "billing" && SUBJECTS[k].stage <= 3,
    );
    expect(produced.length).toBe(13);
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));
    const src = files(new URL("../../src", import.meta.url).pathname)
      .map((f) => readFileSync(f, "utf8"))
      .join("\n");
    for (const s of produced) expect(src).toContain(s);
  });
});

describe("objects parse with the spec schemas", () => {
  it("catalogue, invoices (API, events, hosted, notification), subscriptions, sessions; fiat and asset", async () => {
    const b = testBilling(T0 * 1000);
    (b as { newId: typeof b.newId }).newId = newBillingId;
    const cus = newBillingId("in").replace(/^in_/, "cus_");
    b.pay.addCustomer(SCOPE, { id: cus });
    const p = await catalog.createProduct(b, c, { name: "Pro", description: "d", metadata: { a: "b" } });
    const fiat = await catalog.createPrice(b, c, {
      productId: p.id,
      unitAmount: 1999n,
      currency: "usd",
      assetId: null,
    });
    const monthly = await catalog.createPrice(b, c, {
      productId: p.id,
      unitAmount: 900n,
      currency: "usd",
      assetId: null,
      recurring: { interval: "month", intervalCount: 3 },
    });
    const asset = await catalog.createPrice(b, c, {
      productId: p.id,
      unitAmount: 10n ** 22n,
      currency: "asset",
      assetId: "nep141:usdc.near",
    });
    const vat = await catalog.createTaxRate(b, c, {
      displayName: "VAT",
      percentage: "8.875",
      inclusive: false,
      jurisdiction: "US-NY",
      country: "US",
    });
    Product.parse(productView(p));
    for (const x of [fiat, monthly, asset]) Price.parse(priceView(x));
    expect(TaxRate.parse(taxRateView(vat))).toMatchObject({ percentage: "8.875", rate_ppm: 88_750 });

    const draft = await inv.createInvoice(b, c, {
      customerId: cus,
      lines: [
        { priceId: fiat.id, quantity: 2 },
        { unitAmount: 5n, description: "fee" },
      ],
      defaultTaxRateIds: [vat.id],
    });
    const opts = { apiOrigin: "https://api.nearpay.test" };
    expect(Invoice.parse(invoiceView(draft, { ...opts, hostedInvoiceUrl: null }))).toMatchObject({
      status: "draft",
      invoice_pdf: null,
    });
    const open = await inv.finalizeInvoice(b, c, draft.id);
    const v = Invoice.parse(invoiceView(open, { ...opts, hostedInvoiceUrl: inv.hostedInvoiceUrl(b, open) }));
    expect(v).toMatchObject({
      status: "open",
      subtotal: 4003,
      total: (v.subtotal as number) + (v.tax as number),
      next_reminder_at: expect.any(Number),
    });
    expect(v.hosted_invoice_url).toContain(`/i/${open.id}#${open.id}_secret_`);

    const assetInv = await inv.finalizeInvoice(
      b,
      c,
      (await inv.createInvoice(b, c, { customerId: cus, lines: [{ priceId: asset.id }] })).id,
    );
    expect(Invoice.parse(invoiceView(assetInv, { ...opts, hostedInvoiceUrl: null })).total).toBe(
      (10n ** 22n).toString(),
    );

    const render = eventRenderer(opts.apiOrigin);
    for (const e of b.mem.state.outbox) {
      const object = render(e.object);
      const r = SUBJECTS[e.subject].object.safeParse(object);
      expect(r.success, `${e.subject}: ${r.success ? "" : JSON.stringify(r.error.issues[0])}`).toBe(true);
      if (e.object.kind === "invoice")
        expect((object as { hosted_invoice_url: unknown }).hosted_invoice_url).toBeNull();
    }

    const secret = inv.invoiceSecretOf(b, open) as string;
    PublicInvoice.parse(publicInvoiceView(await getPublicInvoice(b, open.id, secret)));
    PublicInvoice.parse(
      publicInvoiceView(await getPublicInvoice(b, assetInv.id, inv.invoiceSecretOf(b, assetInv) as string)),
    );
    const session = await createPublicInvoiceSession(b, open.id, secret, { clientNetwork: "n" });
    InvoicePaymentSession.parse(
      invoicePaymentSessionView({
        ...session,
        checkoutSession: newBillingId("in").replace(/^in_/, "cs_"),
        clientSecret: `cs_${"0".repeat(26)}_secret_${"a".repeat(32)}`,
      }),
    );
    const nctx = InvoiceNotificationContext.parse(
      invoiceNotificationView(await invoiceNotificationContext(b, open.id, 2)),
    );
    // spec 0.3.1 optional fields are always filled (fingerprint null until a paying intent names one)
    expect(nctx).toMatchObject({ subtotal: 4003, tax: v.tax, line_count: 2, destination_fingerprint: null });

    const s = await subs.createSubscription(b, c, {
      customerId: cus,
      items: [{ priceId: monthly.id, quantity: 2, taxRateIds: [vat.id] }],
    });
    const prices = await b.store.transaction((tx) => tx.prices.getMany(s, [monthly.id]));
    expect(Subscription.parse(subscriptionView(s, prices)).items[0]?.price.id).toBe(monthly.id);
    SubscriptionNotificationContext.parse(subscriptionNotificationView(await subscriptionNotificationContext(b, s.id)));

    // test-mode clock helper response (spec 0.3.1)
    const adv = await subs.advanceSubscriptionClock(b, c, s.id, "overdue");
    expect(SubscriptionClockAdvance.parse(clockAdvanceView(adv))).toMatchObject({
      object: "subscription_clock_advance",
      subscription: s.id,
      target: "overdue",
      advanced_by: 7 * 86_400,
    });

    // reminders and renewal events through the jobs
    b.clock.ms = (s.currentPeriodEnd + 30 * 86_400) * 1000;
    await runDueJobs(b, jobHandlers(b));
    const subjects = new Set(b.mem.state.outbox.map((e) => e.subject));
    for (const want of [
      "evt.billing.invoice.reminder",
      "evt.billing.invoice.overdue",
      "evt.billing.invoice.marked_uncollectible",
      "evt.billing.subscription.deleted",
    ] as const)
      expect(subjects.has(want), want).toBe(true);
    for (const e of b.mem.state.outbox)
      expect(SUBJECTS[e.subject].object.safeParse(render(e.object)).success).toBe(true);
  });
});
