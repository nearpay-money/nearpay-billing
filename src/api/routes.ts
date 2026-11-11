/**
 * Spec route bindings (lld/billing.md §5, §13, §14; spec 0.4.0). Authentication, scopes, roles and automatic
 * idempotency (merchant POSTs with `Idempotency-Key`) are enforced from the spec by the service bootstrap;
 * the hosted-invoice routes check the invoice secret in the use cases. Domain errors become the public
 * error envelope with the same code.
 */

import { isIP } from "node:net";
import { toUuid } from "@nearpay-internal/ids";
import { ApiError, implement, type RequestContext, type RouteBinding, respond } from "@nearpay-internal/service";
import {
  getInvoiceNotificationContext,
  getMandateNotificationContext,
  getSubscriptionNotificationContext,
} from "@nearpay-internal/spec";
import {
  advanceSubscriptionClock,
  cancelSubscription,
  createInvoice,
  createPrice,
  createProduct,
  createPublicInvoiceMandateFunding,
  createPublicInvoiceSession,
  createSubscription,
  createTaxRate,
  deleteInvoice,
  finalizeInvoice,
  getInvoice,
  getInvoicePdf,
  getMandate,
  getPrice,
  getProduct,
  getPublicInvoice,
  getPublicInvoiceMandate,
  getPublicInvoicePdf,
  getSubscription,
  getTaxRate,
  listInvoices,
  listMandates,
  listPrices,
  listProducts,
  listSubscriptions,
  listTaxRates,
  markInvoiceUncollectible,
  prepareMandate,
  prepareMandateCancel,
  sendInvoice,
  simulateMandateFunding,
  simulateMandatePayerAction,
  updateInvoice,
  updatePrice,
  updateProduct,
  updateSubscription,
  updateTaxRate,
  voidInvoice,
} from "@nearpay-money/spec";
import * as catalog from "../app/catalog.js";
import type { Ctx } from "../app/commit.js";
import * as hosted from "../app/hosted.js";
import * as invoices from "../app/invoices.js";
import * as mandates from "../app/mandates.js";
import {
  invoiceNotificationContext,
  mandateNotificationContext,
  subscriptionNotificationContext,
} from "../app/notification.js";
import * as pdf from "../app/pdf.js";
import type { Billing, ListQuery, Page } from "../app/ports.js";
import * as subs from "../app/subscriptions.js";
import { type ClientIpRule, clientIpRule, resolveClientIp } from "../domain/client-ip.js";
import type { Invoice } from "../domain/invoice/invoice.js";
import type { LineInput } from "../domain/invoice/lines.js";
import { DomainError } from "../domain/shared.js";
import type { Subscription } from "../domain/subscription/subscription.js";
import {
  cancelInstructionsView,
  clockAdvanceView,
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
} from "./views.js";

// ---------------------------------------------------------------------------------------------
// Context and error mapping
// ---------------------------------------------------------------------------------------------

/** The account principal of a merchant route (secret/restricted key or dashboard session). */
export function merchant(ctx: RequestContext): Ctx {
  const p = ctx.principal;
  if (!p?.acct) throw new ApiError("authentication_required");
  return { scope: { accountId: toUuid(p.acct, "acct"), livemode: ctx.livemode }, actor: `${p.ptype}:${p.sub}` };
}

export function toApiError(e: DomainError): ApiError {
  return new ApiError(e.code, {
    params: { ...e.params },
    ...(e.param ? { param: e.param } : {}),
    ...(e.upstreamMessage ? { message: e.upstreamMessage } : {}),
    ...(e.code === "rate_limited" && e.params.retry_after !== undefined
      ? { headers: { "Retry-After": String(e.params.retry_after) } }
      : {}),
    cause: e,
  });
}

/**
 * Runs a use case; domain errors become the public envelope with the same code (spec 0.3.1 lists every
 * code billing answers, so the interim mappings of LLD §12 d18 are gone).
 */
async function run<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof DomainError) throw toApiError(e);
    throw e;
  }
}

const listQuery = (q: {
  limit: number;
  starting_after?: string | undefined;
  ending_before?: string | undefined;
  "created[gte]"?: number | undefined;
  "created[lte]"?: number | undefined;
}): ListQuery => ({
  limit: q.limit,
  startingAfter: q.starting_after,
  endingBefore: q.ending_before,
  created: { gte: q["created[gte]"], lte: q["created[lte]"] },
});

function list<T, V>(path: string, page: Page<T>, view: (t: T) => V) {
  return { object: "list" as const, data: page.data.map(view), has_more: page.hasMore, url: path };
}

const header = (ctx: RequestContext, name: string): string | undefined => {
  const v = ctx.request.headers[name];
  return (Array.isArray(v) ? v[0] : v) || undefined;
};

/**
 * The client's network (`a.b.c.0/24`, IPv6 /64) by identity's rule (L-ID-07): CF-Connecting-IP on the server stage,
 * else the rightmost untrusted X-Forwarded-For hop; forwarding headers only from a trusted proxy peer
 * (`NP_TRUSTED_PROXIES`, domain/client-ip.ts).
 */
export function clientNetwork(
  rule: ClientIpRule,
  from: { peer?: string | undefined; cfConnectingIp?: string | undefined; xForwardedFor?: string | undefined },
): string {
  const ip = resolveClientIp(rule, from) ?? "";
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1] ?? (isIP(ip) === 4 ? ip : null);
  if (v4) return `${v4.split(".").slice(0, 3).join(".")}.0/24`;
  if (isIP(ip) !== 6) return "unknown";
  const [head = "", tail = ""] = ip.toLowerCase().split("::");
  const h = head ? head.split(":") : [];
  const t = ip.includes("::") ? (tail ? tail.split(":") : []) : [];
  const groups = (xs: string[]) => xs.reduce((n, g) => n + (g.includes(".") ? 2 : 1), 0);
  const full = [...h, ...Array(Math.max(0, 8 - groups(h) - groups(t))).fill("0"), ...t];
  return `${full
    .slice(0, 4)
    .map((g) => Number.parseInt(g, 16).toString(16))
    .join(":")}::/64`;
}

/** The invoice secret header (validated against the spec's `InvoiceSecret` by the bootstrap). */
const secretOf = (ctx: RequestContext): string => {
  const v = (ctx.headers as Record<string, string | string[] | undefined>)["x-nearpay-invoice-secret"];
  return (Array.isArray(v) ? v[0] : v) ?? "";
};

type SpecLine =
  | { price: string; quantity?: number | undefined; description?: string | undefined; tax_rates?: string[] | undefined }
  | {
      unit_amount: number | string;
      description: string;
      quantity?: number | undefined;
      tax_rates?: string[] | undefined;
    };

const lineInput = (l: SpecLine): LineInput =>
  "price" in l
    ? { priceId: l.price, quantity: l.quantity, description: l.description, taxRateIds: l.tax_rates }
    : { unitAmount: BigInt(l.unit_amount), description: l.description, quantity: l.quantity, taxRateIds: l.tax_rates };

const pdfHeaders = (inv: Invoice) => ({
  "content-disposition": `attachment; filename="${inv.number ?? inv.id}.pdf"`,
  "cache-control": "private, no-store",
});

/** Raw PDF bytes (spec `binaryResponse`; kit ≥ 0.3.1 sends them with status, request id and length). */
const sendPdf = (ctx: RequestContext, r: { invoice: Invoice; pdf: Uint8Array }) =>
  ctx.binary(r.pdf, "application/pdf", pdfHeaders(r.invoice));

// ---------------------------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------------------------

export function billingRoutes(b: Billing, env: string, ipRule: ClientIpRule = clientIpRule(env)): RouteBinding[] {
  const inv = (i: Invoice) =>
    invoiceView(i, { hostedInvoiceUrl: invoices.hostedInvoiceUrl(b, i), apiOrigin: b.settings.apiOrigin });
  const subView = async (s: Subscription) => {
    const prices = await b.store.transaction((tx) =>
      tx.prices.getMany(
        s,
        s.items.map((i) => i.priceId),
      ),
    );
    return subscriptionView(s, prices);
  };
  const subList = async (page: Page<Subscription>) => {
    const ids = [...new Set(page.data.flatMap((s) => s.items.map((i) => i.priceId)))];
    const first = page.data[0];
    const prices = first ? await b.store.transaction((tx) => tx.prices.getMany(first, ids)) : new Map();
    return {
      object: "list" as const,
      data: page.data.map((s) => subscriptionView(s, prices)),
      has_more: page.hasMore,
      url: "/v1/subscriptions",
    };
  };

  return [
    // ---- catalogue
    implement(createProduct, async (ctx) =>
      respond(201, productView(await run(() => catalog.createProduct(b, merchant(ctx), ctx.body)))),
    ),
    implement(getProduct, async (ctx) =>
      productView(await run(() => catalog.getProduct(b, merchant(ctx), ctx.params.id))),
    ),
    implement(listProducts, async (ctx) =>
      list(
        "/v1/products",
        await run(() => catalog.listProducts(b, merchant(ctx), { ...listQuery(ctx.query), active: ctx.query.active })),
        productView,
      ),
    ),
    implement(updateProduct, async (ctx) =>
      productView(await run(() => catalog.updateProduct(b, merchant(ctx), ctx.params.id, ctx.body))),
    ),
    implement(createPrice, async (ctx) => {
      const body = ctx.body;
      const p = await run(() =>
        catalog.createPrice(b, merchant(ctx), {
          productId: body.product,
          unitAmount: BigInt(body.unit_amount),
          currency: body.currency,
          assetId: body.asset_id ?? null,
          recurring: body.recurring
            ? { interval: body.recurring.interval as "month", intervalCount: body.recurring.interval_count }
            : undefined,
          nickname: body.nickname,
          active: body.active,
          metadata: body.metadata,
        }),
      );
      return respond(201, priceView(p));
    }),
    implement(getPrice, async (ctx) => priceView(await run(() => catalog.getPrice(b, merchant(ctx), ctx.params.id)))),
    implement(listPrices, async (ctx) =>
      list(
        "/v1/prices",
        await run(() =>
          catalog.listPrices(b, merchant(ctx), {
            ...listQuery(ctx.query),
            product: ctx.query.product,
            active: ctx.query.active,
            type: ctx.query.type,
            currency: ctx.query.currency,
          }),
        ),
        priceView,
      ),
    ),
    implement(updatePrice, async (ctx) =>
      priceView(await run(() => catalog.updatePrice(b, merchant(ctx), ctx.params.id, ctx.body))),
    ),
    implement(createTaxRate, async (ctx) => {
      const body = ctx.body;
      const t = await run(() =>
        catalog.createTaxRate(b, merchant(ctx), {
          displayName: body.display_name,
          percentage: body.percentage,
          inclusive: body.inclusive,
          description: body.description,
          jurisdiction: body.jurisdiction,
          country: body.country,
          active: body.active,
          metadata: body.metadata,
        }),
      );
      return respond(201, taxRateView(t));
    }),
    implement(getTaxRate, async (ctx) =>
      taxRateView(await run(() => catalog.getTaxRate(b, merchant(ctx), ctx.params.id))),
    ),
    implement(listTaxRates, async (ctx) =>
      list(
        "/v1/tax_rates",
        await run(() =>
          catalog.listTaxRates(b, merchant(ctx), {
            ...listQuery(ctx.query),
            active: ctx.query.active,
            inclusive: ctx.query.inclusive,
          }),
        ),
        taxRateView,
      ),
    ),
    implement(updateTaxRate, async (ctx) => {
      const body = ctx.body;
      const t = await run(() =>
        catalog.updateTaxRate(b, merchant(ctx), ctx.params.id, {
          displayName: body.display_name,
          description: body.description,
          jurisdiction: body.jurisdiction,
          country: body.country,
          active: body.active,
          metadata: body.metadata,
        }),
      );
      return taxRateView(t);
    }),

    // ---- invoices
    implement(createInvoice, async (ctx) => {
      const body = ctx.body;
      const i = await run(() =>
        invoices.createInvoice(b, merchant(ctx), {
          customerId: body.customer,
          currency: body.currency,
          assetId: body.asset_id,
          lines: body.lines?.map((l) => lineInput(l as SpecLine)),
          defaultTaxRateIds: body.default_tax_rates,
          description: body.description,
          footer: body.footer,
          daysUntilDue: body.days_until_due,
          dueDate: body.due_date,
          reminderDays: body.reminder_days,
          settlementDestinationId: body.settlement_destination,
          metadata: body.metadata,
        }),
      );
      return respond(201, inv(i));
    }),
    implement(getInvoice, async (ctx) => inv(await run(() => invoices.getInvoice(b, merchant(ctx), ctx.params.id)))),
    implement(listInvoices, async (ctx) => {
      const q = ctx.query;
      const page = await run(() =>
        invoices.listInvoices(b, merchant(ctx), {
          ...listQuery(q),
          status: q.status,
          customer: q.customer,
          subscription: q.subscription,
          dueDate: { gte: q["due_date[gte]"], lte: q["due_date[lte]"] },
          collectionMethod: q.collection_method,
        }),
      );
      return list("/v1/invoices", page, inv);
    }),
    implement(updateInvoice, async (ctx) => {
      const body = ctx.body;
      const i = await run(() =>
        invoices.updateInvoice(b, merchant(ctx), ctx.params.id, {
          customerId: body.customer,
          currency: body.currency,
          assetId: body.asset_id,
          lines: body.lines?.map((l) => lineInput(l as SpecLine)),
          defaultTaxRateIds: body.default_tax_rates,
          description: body.description,
          footer: body.footer,
          daysUntilDue: body.days_until_due,
          dueDate: body.due_date,
          reminderDays: body.reminder_days,
          settlementDestinationId: body.settlement_destination,
          metadata: body.metadata,
        }),
      );
      return inv(i);
    }),
    implement(deleteInvoice, async (ctx) => {
      const r = await run(() => invoices.deleteInvoice(b, merchant(ctx), ctx.params.id));
      return { id: r.id as `in_${string}`, object: "invoice" as const, livemode: r.livemode, deleted: true as const };
    }),
    implement(finalizeInvoice, async (ctx) =>
      inv(await run(() => invoices.finalizeInvoice(b, merchant(ctx), ctx.params.id))),
    ),
    implement(sendInvoice, async (ctx) => inv(await run(() => invoices.sendInvoice(b, merchant(ctx), ctx.params.id)))),
    implement(voidInvoice, async (ctx) =>
      inv(await run(() => invoices.voidInvoiceUseCase(b, merchant(ctx), ctx.params.id))),
    ),
    implement(markInvoiceUncollectible, async (ctx) =>
      inv(await run(() => invoices.markInvoiceUncollectible(b, merchant(ctx), ctx.params.id))),
    ),
    implement(getInvoicePdf, async (ctx) =>
      sendPdf(ctx, await run(() => pdf.getInvoicePdf(b, merchant(ctx), ctx.params.id))),
    ),

    // ---- hosted invoice (anonymous; invoice secret header)
    implement(getPublicInvoice, async (ctx) =>
      publicInvoiceView(await run(() => mandates.getHostedInvoice(b, ctx.params.id, secretOf(ctx)))),
    ),
    implement(createPublicInvoiceSession, async (ctx) => {
      const s = await run(() =>
        hosted.createPublicInvoiceSession(b, ctx.params.id, secretOf(ctx), {
          locale: ctx.body.locale,
          clientNetwork: clientNetwork(ipRule, {
            peer: ctx.request.socket?.remoteAddress,
            cfConnectingIp: header(ctx, "cf-connecting-ip"),
            xForwardedFor: header(ctx, "x-forwarded-for"),
          }),
        }),
      );
      return invoicePaymentSessionView(s);
    }),
    implement(getPublicInvoicePdf, async (ctx) =>
      sendPdf(ctx, await run(() => pdf.getPublicInvoicePdf(b, ctx.params.id, secretOf(ctx)))),
    ),

    // ---- subscriptions
    implement(createSubscription, async (ctx) => {
      const body = ctx.body;
      const s = await run(() =>
        subs.createSubscription(b, merchant(ctx), {
          customerId: body.customer,
          collectionMethod: body.collection_method,
          items: body.items.map((i) => ({ priceId: i.price, quantity: i.quantity, taxRateIds: i.tax_rates })),
          daysUntilDue: body.days_until_due,
          trialPeriodDays: body.trial_period_days,
          defaultTaxRateIds: body.default_tax_rates,
          dunning: body.dunning
            ? { reminderDays: body.dunning.reminder_days, onExhausted: body.dunning.on_exhausted }
            : undefined,
          description: body.description,
          settlementDestinationId: body.settlement_destination,
          metadata: body.metadata,
        }),
      );
      return respond(201, await subView(s));
    }),
    implement(getSubscription, async (ctx) =>
      subView(await run(() => subs.getSubscription(b, merchant(ctx), ctx.params.id))),
    ),
    implement(listSubscriptions, async (ctx) =>
      subList(
        await run(() =>
          subs.listSubscriptions(b, merchant(ctx), {
            ...listQuery(ctx.query),
            status: ctx.query.status,
            customer: ctx.query.customer,
            price: ctx.query.price,
          }),
        ),
      ),
    ),
    implement(updateSubscription, async (ctx) => {
      const body = ctx.body;
      const s = await run(() =>
        subs.updateSubscription(b, merchant(ctx), ctx.params.id, {
          items: body.items?.map((i) => ({ priceId: i.price, quantity: i.quantity, taxRateIds: i.tax_rates })),
          daysUntilDue: body.days_until_due,
          defaultTaxRateIds: body.default_tax_rates,
          dunning: body.dunning
            ? { reminderDays: body.dunning.reminder_days, onExhausted: body.dunning.on_exhausted }
            : undefined,
          cancelAtPeriodEnd: body.cancel_at_period_end,
          collectionMethod: body.collection_method,
          description: body.description,
          settlementDestinationId: body.settlement_destination,
          metadata: body.metadata,
        }),
      );
      return subView(s);
    }),
    implement(cancelSubscription, async (ctx) =>
      subView(
        await run(() => subs.cancelSubscription(b, merchant(ctx), ctx.params.id, ctx.body.at_period_end ?? false)),
      ),
    ),

    // ---- mandates (Stage 4, lld/billing.md §5, §14): rows come from vault events only; prepare is side-effect free
    implement(prepareMandate, async (ctx) => {
      const body = ctx.body;
      return fundingView(
        await run(() =>
          mandates.prepareMandate(b, merchant(ctx), {
            subscriptionId: body.subscription,
            payer: body.payer,
            token: body.token,
            periods: body.periods,
          }),
        ),
      );
    }),
    implement(getMandate, async (ctx) =>
      mandateView(await run(() => mandates.getMandate(b, merchant(ctx), ctx.params.id))),
    ),
    implement(listMandates, async (ctx) => {
      const q = ctx.query;
      const page = await run(() =>
        mandates.listMandates(b, merchant(ctx), {
          ...listQuery(q),
          subscription: q.subscription,
          customer: q.customer,
          status: q.status,
          linkStatus: q.link_status,
          payer: q.payer,
        }),
      );
      return list("/v1/mandates", page, mandateView);
    }),
    implement(prepareMandateCancel, async (ctx) => {
      const r = await run(() => mandates.prepareMandateCancel(b, merchant(ctx), ctx.params.id));
      return cancelInstructionsView(r.mandate, r.transaction);
    }),
    implement(createPublicInvoiceMandateFunding, async (ctx) =>
      fundingView(
        await run(() =>
          mandates.createPublicInvoiceMandateFunding(b, ctx.params.id, secretOf(ctx), {
            payer: ctx.body.payer,
            token: ctx.body.token,
            periods: ctx.body.periods,
          }),
        ),
      ),
    ),
    implement(getPublicInvoiceMandate, async (ctx) =>
      publicMandateView(await run(() => mandates.getPublicInvoiceMandate(b, ctx.params.id, secretOf(ctx)))),
    ),
    implement(simulateMandateFunding, async (ctx) => {
      const body = ctx.body;
      return simulationView(
        await run(() =>
          mandates.simulateMandateFunding(b, merchant(ctx), {
            subscriptionId: body.subscription,
            payer: body.payer,
            token: body.token,
            periods: body.periods,
          }),
        ),
      );
    }),
    implement(simulateMandatePayerAction, async (ctx) =>
      simulationView(
        await run(() =>
          mandates.simulateMandatePayerAction(b, merchant(ctx), ctx.params.id, {
            action: ctx.body.action,
            periods: ctx.body.periods,
          }),
        ),
      ),
    ),

    // ---- test helper (test mode only; lld/billing.md §13)
    implement(advanceSubscriptionClock, async (ctx) =>
      clockAdvanceView(
        await run(() => subs.advanceSubscriptionClock(b, merchant(ctx), ctx.params.id, ctx.body.target)),
      ),
    ),

    // ---- internal (notify)
    implement(getInvoiceNotificationContext, async (ctx) =>
      invoiceNotificationView(await run(() => invoiceNotificationContext(b, ctx.params.id, ctx.query.reminder))),
    ),
    implement(getSubscriptionNotificationContext, async (ctx) =>
      subscriptionNotificationView(await run(() => subscriptionNotificationContext(b, ctx.params.id))),
    ),
    implement(getMandateNotificationContext, async (ctx) =>
      mandateNotificationView(await run(() => mandateNotificationContext(b, ctx.params.id))),
    ),
  ];
}
