/**
 * Spec route bindings (lld/billing.md §5; spec 0.3.0). Authentication, scopes, roles and automatic
 * idempotency (merchant POSTs with `Idempotency-Key`) are enforced from the spec by the service bootstrap;
 * the hosted-invoice routes check the invoice secret in the use cases. Domain errors become the public
 * error envelope with the same code.
 */
import { isIP } from "node:net";
import {
  cancelSubscription,
  createInvoice,
  createPrice,
  createProduct,
  createPublicInvoiceSession,
  createSubscription,
  createTaxRate,
  deleteInvoice,
  finalizeInvoice,
  getInvoice,
  getInvoicePdf,
  getPrice,
  getProduct,
  getPublicInvoice,
  getPublicInvoicePdf,
  getSubscription,
  getTaxRate,
  listInvoices,
  listPrices,
  listProducts,
  listSubscriptions,
  listTaxRates,
  markInvoiceUncollectible,
  sendInvoice,
  updateInvoice,
  updatePrice,
  updateProduct,
  updateSubscription,
  updateTaxRate,
  voidInvoice,
} from "@nearpay/spec";
import { toUuid } from "@nearpay-internal/ids";
import { ApiError, implement, type RequestContext, type RouteBinding, respond } from "@nearpay-internal/service";
import { getInvoiceNotificationContext, getSubscriptionNotificationContext } from "@nearpay-internal/spec";
import * as catalog from "../app/catalog.js";
import type { Ctx } from "../app/commit.js";
import * as hosted from "../app/hosted.js";
import * as invoices from "../app/invoices.js";
import { invoiceNotificationContext, subscriptionNotificationContext } from "../app/notification.js";
import * as pdf from "../app/pdf.js";
import type { Billing, ListQuery, Page } from "../app/ports.js";
import * as subs from "../app/subscriptions.js";
import type { Invoice } from "../domain/invoice/invoice.js";
import type { LineInput } from "../domain/invoice/lines.js";
import { DomainError } from "../domain/shared.js";
import type { Subscription } from "../domain/subscription/subscription.js";
import {
  invoiceNotificationView,
  invoicePaymentSessionView,
  invoiceView,
  priceView,
  productView,
  publicInvoiceView,
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

async function run<T>(f: () => Promise<T>, map: (e: DomainError) => DomainError = (e) => e): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof DomainError) throw toApiError(map(e));
    throw e;
  }
}

/**
 * `createSubscription` cannot answer `invoice_empty` until spec 0.3.1 (lead decision 2026-11-08): a
 * zero-total first invoice is refused as `invalid_request` on `items`.
 */
const subscriptionCreateErrors = (e: DomainError): DomainError =>
  e.code === "invoice_empty"
    ? new DomainError(
        "invalid_request",
        { detail: "the first invoice of a subscription must have a total above zero" },
        "items",
      )
    : e;

/**
 * Pass-through refusals of payments' `createInvoiceCheckoutSession` that `createPublicInvoiceSession` does
 * not list until spec 0.3.1 (lead decision 2026-11-08): amount and customer refusals → `invoice_not_payable`
 * (with the reason as status), a concurrent open race → `rate_limited` (retry in 1 s).
 */
export function publicSessionErrors(invoiceId: string) {
  return (e: DomainError): DomainError => {
    const reasons: Partial<Record<string, string>> = {
      amount_below_destination_minimum: "below the destination minimum",
      amount_above_unverified_cap: "above the unverified destination cap",
      customer_deleted: "billed to a deleted customer",
    };
    const reason = reasons[e.code];
    if (reason) return new DomainError("invoice_not_payable", { invoice: invoiceId, status: reason });
    if (e.code === "state_conflict") return new DomainError("rate_limited", { retry_after: 1 });
    return e;
  };
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

/** The client's network (`a.b.c.0/24`, IPv6 /64) by identity's rule: CF-Connecting-IP on the server, else XFF. */
export function clientNetwork(env: string, cf: string | undefined, xff: string | undefined): string {
  const ip = (env === "server" ? cf : xff?.split(",")[0])?.trim() ?? "";
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

/** Sends raw PDF bytes (spec `binaryResponse`; kit 0.2.1 serialises JSON only, so the reply is written here). */
function sendPdf(ctx: RequestContext, r: { invoice: Invoice; pdf: Uint8Array }): undefined {
  void ctx.reply
    .code(200)
    .headers({ ...pdfHeaders(r.invoice), "x-request-id": ctx.requestId })
    .type("application/pdf")
    .send(Buffer.from(r.pdf));
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Bindings
// ---------------------------------------------------------------------------------------------

export function billingRoutes(b: Billing, env: string): RouteBinding[] {
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
      publicInvoiceView(await run(() => hosted.getPublicInvoice(b, ctx.params.id, secretOf(ctx)))),
    ),
    implement(createPublicInvoiceSession, async (ctx) => {
      const s = await run(
        () =>
          hosted.createPublicInvoiceSession(b, ctx.params.id, secretOf(ctx), {
            locale: ctx.body.locale,
            clientNetwork: clientNetwork(env, header(ctx, "cf-connecting-ip"), header(ctx, "x-forwarded-for")),
          }),
        publicSessionErrors(ctx.params.id),
      );
      return invoicePaymentSessionView(s);
    }),
    implement(getPublicInvoicePdf, async (ctx) =>
      sendPdf(ctx, await run(() => pdf.getPublicInvoicePdf(b, ctx.params.id, secretOf(ctx)))),
    ),

    // ---- subscriptions
    implement(createSubscription, async (ctx) => {
      const body = ctx.body;
      const s = await run(
        () =>
          subs.createSubscription(b, merchant(ctx), {
            customerId: body.customer,
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
        subscriptionCreateErrors,
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

    // ---- internal (notify)
    implement(getInvoiceNotificationContext, async (ctx) =>
      invoiceNotificationView(await run(() => invoiceNotificationContext(b, ctx.params.id, ctx.query.reminder))),
    ),
    implement(getSubscriptionNotificationContext, async (ctx) =>
      subscriptionNotificationView(await run(() => subscriptionNotificationContext(b, ctx.params.id))),
    ),
  ];
}
