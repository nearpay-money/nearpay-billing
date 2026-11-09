/**
 * Contract (foundations §16): every Stage 3–4 billing route is bound (and nothing else); every subject the
 * catalogue routes to billing is handled; every subject billing produces is emitted; the objects billing
 * serves and emits parse with the spec 0.4.0 schemas (auto-debit: mandates, vault events, hosted setup).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  Invoice,
  InvoicePaymentSession,
  Mandate,
  MandateCancelInstructions,
  MandateFundingInstructions,
  MandateSimulation,
  Price,
  Product,
  PUBLIC_ROUTES,
  PublicInvoice,
  PublicMandate,
  Subscription,
  SubscriptionClockAdvance,
  TaxRate,
} from "@nearpay/spec";
import { unhandledSubjects } from "@nearpay-internal/bus";
import { unimplementedRoutes } from "@nearpay-internal/service";
import {
  INTERNAL_ROUTES,
  InvoiceNotificationContext,
  MandateNotificationContext,
  SUBJECTS,
  type Subject,
  SubscriptionNotificationContext,
} from "@nearpay-internal/spec";
import { describe, expect, it } from "vitest";
import { billingRoutes } from "../../src/api/routes.js";
import {
  cancelInstructionsView,
  clockAdvanceView,
  eventRenderer,
  fundingView,
  invoiceNotificationView,
  invoicePaymentSessionView,
  invoiceView,
  mandateNotificationView,
  mandateView,
  priceView,
  productView,
  publicInvoiceView,
  publicMandateView,
  simulationView,
  subscriptionNotificationView,
  subscriptionView,
  taxRateView,
} from "../../src/api/views.js";
import * as catalog from "../../src/app/catalog.js";
import type { Ctx } from "../../src/app/commit.js";
import { createPublicInvoiceSession, getPublicInvoice } from "../../src/app/hosted.js";
import * as inv from "../../src/app/invoices.js";
import * as md from "../../src/app/mandates.js";
import {
  invoiceNotificationContext,
  mandateNotificationContext,
  subscriptionNotificationContext,
} from "../../src/app/notification.js";
import * as subs from "../../src/app/subscriptions.js";
import { onVaultEvent, type VaultEventRecord } from "../../src/app/vault-events.js";
import { billingHandlers } from "../../src/consumers/handlers.js";
import { newBillingId } from "../../src/infra/ids.js";
import { jobHandlers } from "../../src/workers/jobs.js";
import { SCOPE, T0 } from "../support/fixtures.js";
import { runDueJobs, testBilling } from "../support/memory.js";

const ALL = [...PUBLIC_ROUTES, ...INTERNAL_ROUTES];
const c: Ctx = { scope: SCOPE, actor: "secret_key:key_1" };

describe("routes and events", () => {
  it("binds every Stage 3–4 billing route, and nothing else", () => {
    const bindings = billingRoutes({} as never, "test");
    expect(unimplementedRoutes("billing", ALL, bindings, 4).map((r) => r.id)).toEqual([]);
    expect(bindings.map((b) => b.route.id).sort()).toEqual(
      [...new Map(ALL.map((r) => [r.id, r])).values()]
        .filter((r) => r.service === "billing" && r.stage <= 4)
        .map((r) => r.id)
        .sort(),
    );
    // 33 Stage-3 routes + 8 public mandate routes + the internal mandate notification context
    expect(bindings).toHaveLength(42);
  });

  it("handles every subject the catalogue routes to billing", () => {
    const handlers = billingHandlers({} as never);
    expect(unhandledSubjects("billing", handlers)).toEqual([]);
    for (const s of Object.keys(handlers) as Subject[]) expect(SUBJECTS[s].consumers).toContain("billing");
  });

  it("emits every subject billing produces (Stage 3–4)", () => {
    const produced = (Object.keys(SUBJECTS) as Subject[]).filter(
      (k) => SUBJECTS[k].producer === "billing" && SUBJECTS[k].stage <= 4,
    );
    expect(produced.length).toBe(21);
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
      const r = SUBJECTS[e.subject as keyof typeof SUBJECTS].object.safeParse(object);
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
      expect(SUBJECTS[e.subject as keyof typeof SUBJECTS].object.safeParse(render(e.object)).success).toBe(true);
  });
});

describe("Stage 4 objects parse with the spec 0.4.0 schemas", () => {
  const NS = 1_000_000_000n;
  const VAULT = "vault.sandbox.near";

  it("mandates (API, events, hosted, notification, simulations), auto-debit invoices and subscriptions", async () => {
    const b = testBilling(T0 * 1000);
    (b as { newId: typeof b.newId }).newId = newBillingId;
    b.fakeVault.blockNs = BigInt(T0) * NS;
    const sd = newBillingId("in").replace(/^in_/, "sd_");
    const dest = { ...(b.merchantFacts.destinations[0] as (typeof b.merchantFacts.destinations)[number]), id: sd };
    b.merchantFacts = { ...b.merchantFacts, destinations: [dest], defaults: { "*": sd } };
    const cus = newBillingId("in").replace(/^in_/, "cus_");
    b.pay.addCustomer(SCOPE, { id: cus });
    const p = await catalog.createProduct(b, c, { name: "Pro" });
    const monthly = await catalog.createPrice(b, c, {
      productId: p.id,
      unitAmount: 2_500n,
      currency: "usd",
      assetId: null,
      recurring: { interval: "month" },
    });
    const s = await subs.createSubscription(b, c, {
      customerId: cus,
      items: [{ priceId: monthly.id }],
      collectionMethod: "auto_debit",
    });
    const first = b.mem.state.invoices.get(s.latestInvoiceId as string) as NonNullable<
      ReturnType<typeof b.mem.state.invoices.get>
    >;
    const secret = inv.invoiceSecretOf(b, first) as string;

    // prepare (merchant) and hosted setup (invoice secret): the same instructions
    const prepared = MandateFundingInstructions.parse(
      fundingView(await md.prepareMandate(b, c, { subscriptionId: s.id, payer: "alice.near" })),
    );
    expect(prepared).toMatchObject({ subscription: s.id, amount_per_period: "25000000", periods: 3 });
    // token_asset (spec 0.4.1): the same rails facts as MandateNotificationContext.token_asset
    const usdc = { asset_id: "nep141:usdc.near", symbol: "USDC", decimals: 6 };
    expect(prepared.token_asset).toEqual(usdc);
    expect(
      fundingView({ ...(await md.prepareMandate(b, c, { subscriptionId: s.id })), tokenAsset: null }),
    ).not.toHaveProperty("token_asset");
    MandateFundingInstructions.parse(fundingView(await md.createPublicInvoiceMandateFunding(b, first.id, secret, {})));
    expect(
      PublicInvoice.parse(publicInvoiceView(await md.getHostedInvoice(b, first.id, secret))).auto_debit,
    ).toMatchObject({ available: true, mandate: null });

    // vault events: one linked mandate (#7), one unlinked (#8, payer-edited fee)
    let n = 0;
    const record = (event: string, data: Record<string, unknown>): VaultEventRecord => {
      n += 1;
      return {
        vault_contract: VAULT,
        tx_hash: `TxHash${String(n).padStart(38, "1")}`,
        receipt_id: `Receipt${String(n).padStart(37, "1")}`,
        log_index: 0,
        block_height: 100 + n,
        block_hash: `bh_${n}`,
        block_timestamp: (BigInt(Math.floor(b.clock.ms / 1000)) * NS).toString(),
        event: { standard: "nearpay_vault", version: "1.0.0", event, data: [data] },
      } as unknown as VaultEventRecord;
    };
    const created = (id: number, o: Record<string, unknown> = {}) =>
      record("mandate_created", {
        mandate_id: id,
        payer: "alice.near",
        merchant_receiver: "acme.near",
        token: "usdc.near",
        amount_per_period: "25000000",
        period_secs: 2_629_746,
        start_at: (BigInt(T0) * NS).toString(),
        max_periods: null,
        fee_bps: 100,
        ext_ref: s.id,
        receiver_kind: "intents_account",
        balance: "75000000",
        ...o,
      });
    const deliver = (r: VaultEventRecord) => onVaultEvent(b, { livemode: false, record: r });
    expect(await deliver(created(7))).toBe("applied");
    expect(await deliver(created(8, { fee_bps: 0 }))).toBe("applied");
    const linked = [...b.mem.state.mandates.values()].find((m) => m.onchainId === 7);
    expect(linked?.linkStatus).toBe("linked");
    const m7 = linked as NonNullable<typeof linked>;
    const m8 = [...b.mem.state.mandates.values()].find((m) => m.onchainId === 8) as typeof m7;

    // notify's contract: payer transactions target the context's vault, signed by the payer (or null), exact methods
    const context = async (id: string) =>
      MandateNotificationContext.parse(mandateNotificationView(await mandateNotificationContext(b, id)));
    const payerTx = (ctx: Awaited<ReturnType<typeof context>>, method: "cancel" | "withdraw") => {
      const tx = method === "cancel" ? ctx.cancel_transaction : ctx.withdraw_transaction;
      expect(tx, `${ctx.mandate} ${method}`).not.toBeNull();
      expect(tx?.receiver_id).toBe(ctx.vault_contract);
      expect([null, ctx.payer]).toContain(tx?.signer_id);
      expect(tx?.actions.map((a) => a.method_name)).toEqual([method]);
    };
    const activatedCtx = await context(m7.id); // mandate.activated
    expect(activatedCtx).toMatchObject({ vault_contract: VAULT, payer: "alice.near", refunded: null });
    payerTx(activatedCtx, "cancel");
    const unlinkedCtx = await context(m8.id); // mandate.unlinked
    expect(unlinkedCtx).toMatchObject({ link_status: "unlinked", unlinked_reason: "already_linked" });
    payerTx(unlinkedCtx, "cancel");

    // the keeper collects the first invoice; the forwarded `collected` pays it (evidence on the invoice)
    await runDueJobs(b, jobHandlers(b));
    expect(b.fakeVault.sent).toHaveLength(1);
    await deliver(
      record("collected", {
        mandate_id: 7,
        period: 1,
        amount: "25000000",
        merchant_share: "24750000",
        fee: "250000",
        balance: "50000000",
      }),
    );
    await deliver(record("topped_up", { mandate_id: 7, amount: "25000000", balance: "75000000" }));
    const paid = b.mem.state.invoices.get(first.id) as typeof first;
    const pv = Invoice.parse(invoiceView(paid, { hostedInvoiceUrl: null, apiOrigin: "https://api.nearpay.test" }));
    expect(pv).toMatchObject({ status: "paid", collection_method: "auto_debit", mandate: m7.id });
    expect(pv.mandate_collection).toMatchObject({ mandate: m7.id, period: 1, merchant_share: "24750000" });
    const sub = b.mem.state.subscriptions.get(s.id) as typeof s;
    const prices = await b.store.transaction((tx) => tx.prices.getMany(sub, [monthly.id]));
    expect(Subscription.parse(subscriptionView(sub, prices))).toMatchObject({
      collection_method: "auto_debit",
      mandate: m7.id,
    });

    // reads, merchant cancel, payer view, notification context, simulations
    const cur = await md.getMandate(b, c, m7.id);
    expect(Mandate.parse(mandateView(cur))).toMatchObject({ id: m7.id, status: "active", link_status: "linked" });
    expect(Mandate.parse(mandateView(m8))).toMatchObject({
      link_status: "unlinked",
      unlinked_reason: "already_linked",
    });
    for (const x of (await md.listMandates(b, c, { limit: 10, created: {} })).data) Mandate.parse(mandateView(x));
    const cancel = await md.prepareMandateCancel(b, c, m7.id);
    MandateCancelInstructions.parse(cancelInstructionsView(cancel.mandate, cancel.transaction));
    const pub = PublicMandate.parse(publicMandateView(await md.getPublicInvoiceMandate(b, first.id, secret)));
    const notif = MandateNotificationContext.parse(mandateNotificationView(await mandateNotificationContext(b, m7.id)));
    expect(pub.token_asset).toEqual(notif.token_asset);
    expect(pub.token_asset).toEqual(usdc);
    b.fakeSandbox.outcomes.push({
      txHash: "SimTx1111111111111111111111111111111111111111",
      failure: null,
      vaultLogs: [],
    });
    MandateSimulation.parse(simulationView(await md.simulateMandatePayerAction(b, c, m7.id, { action: "withdraw" })));

    // insufficient funds on the next renewal, then release (subscription canceled), cancel and exhaustion
    const adv = await subs.advanceSubscriptionClock(b, c, s.id, "renewal");
    b.clock.ms += 3_600_000;
    b.fakeVault.blockNs = BigInt(Math.floor(b.clock.ms / 1000)) * NS;
    b.fakeVault.results.push((h) => ({
      kind: "failure",
      txHash: h,
      code: "ERR_INSUFFICIENT_BALANCE",
      message: "Smart contract panicked: ERR_INSUFFICIENT_BALANCE",
    }));
    await runDueJobs(b, jobHandlers(b));
    expect(adv.advancedBy).toBeGreaterThan(0);
    await subs.cancelSubscription(b, c, s.id, false);
    payerTx(await context(m7.id), "cancel"); // mandate.released: still active on chain, the payer cancels
    await deliver(record("canceled", { mandate_id: 7, by: "alice.near", refunded: "75000000" }));
    const canceledCtx = await context(m7.id); // mandate.canceled
    expect(canceledCtx).toMatchObject({ status: "canceled", refunded: "75000000", cancel_transaction: null });
    await deliver(record("exhausted", { mandate_id: 8 }));
    payerTx(await context(m8.id), "withdraw"); // exhausted with a balance left: the payer withdraws

    const render = eventRenderer("https://api.nearpay.test");
    const subjects = new Set(b.mem.state.outbox.map((e) => e.subject));
    for (const want of [
      "evt.billing.mandate.activated",
      "evt.billing.mandate.unlinked",
      "evt.billing.mandate.collected",
      "evt.billing.mandate.updated",
      "evt.billing.mandate.insufficient_funds",
      "evt.billing.mandate.released",
      "evt.billing.mandate.canceled",
      "evt.billing.mandate.exhausted",
    ] as const)
      expect(subjects.has(want), want).toBe(true);
    for (const e of b.mem.state.outbox) {
      const object = render(e.object);
      const r = SUBJECTS[e.subject as keyof typeof SUBJECTS].object.safeParse(object);
      expect(r.success, `${e.subject}: ${r.success ? "" : JSON.stringify(r.error.issues[0])}`).toBe(true);
      // mandate events: envelope account = the mandate's merchant account; payload livemode = envelope mode
      if (e.object.kind === "mandate") {
        expect(e.scope).toEqual({ accountId: SCOPE.accountId, livemode: false });
        expect(e.scope.accountId).toBe(e.object.mandate.accountId);
        expect((object as { livemode: boolean }).livemode).toBe(e.scope.livemode);
      }
    }
  });
});
