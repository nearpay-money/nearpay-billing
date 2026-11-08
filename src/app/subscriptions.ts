/**
 * Subscription use cases and jobs (lld/billing.md §4–§7, §11 d8–d9): create (first invoice at once, or a
 * trial), update (from the next renewal, no proration), cancel (now or at period end), the renewal job
 * (`subscription.renew`, idempotent per subscription × period start) and `renewal_upcoming`.
 */
import { type Invoice, markSent, newDraft } from "../domain/invoice/invoice.js";
import type { Period } from "../domain/invoice/lines.js";
import { priceLines } from "../domain/invoice/lines.js";
import { DomainError, type Metadata, missing, type Scope } from "../domain/shared.js";
import {
  cancel,
  type ItemInput,
  newSubscription,
  patchSubscription,
  periodLines,
  periodOf,
  renew,
  renewalUpcomingApplies,
  renewalUpcomingAt,
  resolveItems,
  type Subscription,
  type SubscriptionPatch,
  withLatestInvoice,
} from "../domain/subscription/subscription.js";
import { resolveTaxRates } from "../domain/tax-rate/tax-rate.js";
import { type Ctx, type Meta, saveInvoice, saveSubscription } from "./commit.js";
import { assertCanCollect, finalizeInTx, liveCustomer, loadCatalog, nowS } from "./invoices.js";
import type { Billing, BillingTx, CustomerFacts, MerchantFacts, Page, SubscriptionRepo } from "./ports.js";

export interface SubscriptionCreateInput {
  readonly customerId: string;
  readonly items: readonly ItemInput[];
  readonly daysUntilDue?: number | undefined;
  readonly trialPeriodDays?: number | undefined;
  readonly defaultTaxRateIds?: readonly string[] | undefined;
  readonly dunning?:
    | { readonly reminderDays?: readonly number[] | undefined; readonly onExhausted?: "cancel" | "unpaid" | undefined }
    | undefined;
  readonly description?: string | undefined;
  readonly settlementDestinationId?: string | undefined;
  readonly metadata?: Metadata | undefined;
}

const itemTaxIds = (items: readonly ItemInput[]) => items.flatMap((i) => i.taxRateIds ?? []);

async function catalogFor(tx: BillingTx, scope: Scope, items: readonly ItemInput[], defaults: readonly string[]) {
  return loadCatalog(tx, scope, {
    priceIds: items.map((i) => i.priceId),
    taxRateIds: [...defaults, ...itemTaxIds(items)],
  });
}

/** Renewal / upcoming jobs for the subscription's current period end. */
async function scheduleRenewal(tx: BillingTx, s: Subscription, now: number): Promise<void> {
  const payload = { subscription: s.id, account_id: s.accountId, livemode: s.livemode, period_end: s.currentPeriodEnd };
  await tx.enqueue({
    kind: "subscription.renew",
    dedupeKey: `subscription.renew:${s.id}:${s.currentPeriodEnd}`,
    runAt: s.currentPeriodEnd,
    payload,
  });
  const upcoming = renewalUpcomingAt(s);
  if (upcoming > now)
    await tx.enqueue({
      kind: "subscription.renewal_upcoming",
      dedupeKey: `subscription.renewal_upcoming:${s.id}:${s.currentPeriodEnd}`,
      runAt: upcoming,
      payload,
    });
}

/**
 * Creates, finalizes and (when the customer has an email) sends the invoice of `period` for `sub` inside
 * `tx`; the subscription row must already exist. Idempotent per (subscription, period start).
 */
async function issuePeriodInvoice(
  b: Billing,
  tx: BillingTx,
  sub: Subscription,
  o: {
    readonly period: Period;
    readonly billingReason: "subscription_create" | "subscription_cycle";
    readonly invoiceId: string;
    readonly merchant: MerchantFacts;
    readonly customer: CustomerFacts;
    readonly meta: Meta;
    readonly requireActive: boolean;
  },
): Promise<Invoice> {
  const existing = await tx.invoices.bySubscriptionPeriod(sub, sub.id, o.period.start);
  if (existing) return existing;
  const catalog = await loadCatalog(tx, sub, {
    priceIds: sub.items.map((i) => i.priceId),
    taxRateIds: [...sub.defaultTaxRateIds, ...sub.items.flatMap((i) => i.taxRateIds ?? [])],
  });
  const drafts = periodLines(sub, o.period, catalog, () => b.newId("il"));
  const priced = priceLines(drafts, sub.defaultTaxRateIds, {
    scope: sub,
    taxRates: catalog.taxRates,
    requireActive: o.requireActive,
  });
  const draft = newDraft(sub, o.invoiceId, nowS(b), {
    currency: sub.currency,
    assetId: sub.assetId,
    customerId: sub.customerId,
    subscriptionId: sub.id,
    billingReason: o.billingReason,
    lines: priced.lines,
    totals: priced.totals,
    defaultTaxRateIds: sub.defaultTaxRateIds,
    description: sub.description,
    daysUntilDue: sub.daysUntilDue,
    period: o.period,
    reminderDays: sub.dunning.reminderDays,
    settlementDestinationId: sub.settlementDestinationId,
    metadata: sub.metadata,
  });
  const created = await saveInvoice(tx, null, draft, o.meta, ["evt.billing.invoice.created"]);
  const open = await finalizeInTx(b, tx, created, { merchant: o.merchant, customer: o.customer, meta: o.meta });
  if (!o.customer.email) {
    b.log.warn(
      { invoice: open.id, subscription: sub.id },
      "subscription invoice not mailed: the customer has no email",
    );
    return open;
  }
  return saveInvoice(tx, open, markSent(open, nowS(b)), { ...o.meta, cause: "sent with the subscription" }, [
    "evt.billing.invoice.sent",
  ]);
}

export async function createSubscription(b: Billing, c: Ctx, input: SubscriptionCreateInput): Promise<Subscription> {
  const customer = await liveCustomer(b, c.scope, input.customerId);
  if (!customer.email) throw new DomainError("customer_email_missing", { customer: customer.id }, "customer");
  const defaults = input.defaultTaxRateIds ?? [];
  // read-only validation first, so the peer calls below happen outside any transaction
  const { pricing } = await b.store.transaction(async (tx) => {
    const catalog = await catalogFor(tx, c.scope, input.items, defaults);
    resolveTaxRates(defaults, catalog.taxRates, c.scope, "default_tax_rates");
    return resolveItems(input.items, { scope: c.scope, catalog, newId: () => b.newId("si") });
  });
  const merchant = await assertCanCollect(b, c.scope, {
    pricing,
    settlementDestinationId: input.settlementDestinationId ?? null,
  });
  return b.store.transaction(async (tx) => {
    const now = nowS(b);
    const catalog = await catalogFor(tx, c.scope, input.items, defaults);
    resolveTaxRates(defaults, catalog.taxRates, c.scope, "default_tax_rates");
    const r = resolveItems(input.items, { scope: c.scope, catalog, newId: () => b.newId("si") });
    let sub = newSubscription(c.scope, b.newId("sub"), now, {
      customerId: input.customerId,
      items: r.items,
      pricing: r.pricing,
      recurring: r.recurring,
      daysUntilDue: input.daysUntilDue,
      trialPeriodDays: input.trialPeriodDays,
      defaultTaxRateIds: defaults,
      dunning: input.dunning,
      description: input.description,
      settlementDestinationId: input.settlementDestinationId,
      metadata: input.metadata,
    });
    const meta = { actor: c.actor, cause: "subscription created" };
    const invoiceId = b.newId("in");
    if (sub.status === "incomplete") sub = withLatestInvoice(sub, invoiceId, now);
    const saved = await saveSubscription(tx, null, sub, meta, ["evt.billing.subscription.created"]);
    if (saved.status === "incomplete")
      await issuePeriodInvoice(b, tx, saved, {
        period: periodOf(saved, 0),
        billingReason: "subscription_create",
        invoiceId,
        merchant,
        customer,
        meta,
        requireActive: true,
      });
    await scheduleRenewal(tx, saved, now);
    return saved;
  });
}

export function getSubscription(b: Billing, c: Ctx, id: string): Promise<Subscription> {
  return b.store.transaction(
    async (tx) => (await tx.subscriptions.get(c.scope, id)) ?? Promise.reject(missing("subscription", id)),
  );
}

export function listSubscriptions(
  b: Billing,
  c: Ctx,
  q: Parameters<SubscriptionRepo["list"]>[1],
): Promise<Page<Subscription>> {
  return b.store.transaction((tx) => tx.subscriptions.list(c.scope, q));
}

export interface SubscriptionUpdateInput extends Omit<SubscriptionPatch, "items"> {
  readonly items?: readonly ItemInput[] | undefined;
}

export function updateSubscription(
  b: Billing,
  c: Ctx,
  id: string,
  input: SubscriptionUpdateInput,
): Promise<Subscription> {
  return b.store.transaction(async (tx) => {
    const cur = await tx.subscriptions.get(c.scope, id, { lock: true });
    if (!cur) throw missing("subscription", id);
    const catalog = await catalogFor(tx, c.scope, input.items ?? [], input.defaultTaxRateIds ?? []);
    if (input.defaultTaxRateIds)
      resolveTaxRates(input.defaultTaxRateIds, catalog.taxRates, c.scope, "default_tax_rates");
    const items = input.items
      ? resolveItems(input.items, {
          scope: c.scope,
          catalog,
          newId: () => b.newId("si"),
          fixed: { pricing: cur, recurring: cur.recurring },
        }).items
      : undefined;
    const next = patchSubscription(cur, { ...input, items }, nowS(b));
    return saveSubscription(tx, cur, next, { actor: c.actor, cause: "updated" }, ["evt.billing.subscription.updated"]);
  });
}

export function cancelSubscription(b: Billing, c: Ctx, id: string, atPeriodEnd: boolean): Promise<Subscription> {
  return b.store.transaction(async (tx) => {
    const cur = await tx.subscriptions.get(c.scope, id, { lock: true });
    if (!cur) throw missing("subscription", id);
    const next = cancel(cur, nowS(b), atPeriodEnd);
    return saveSubscription(
      tx,
      cur,
      next,
      { actor: c.actor, cause: atPeriodEnd ? "cancel at period end" : "canceled" },
      [atPeriodEnd ? "evt.billing.subscription.updated" : "evt.billing.subscription.deleted"],
    );
  });
}

// ---------------------------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------------------------

export interface SubscriptionJob {
  readonly subscription: string;
  readonly scope: Scope;
  /** When the job was scheduled for (decisions use `max(now, at)`, see `JobRequest`). */
  readonly at?: number | undefined;
}

const jobNow = (b: Billing, j: { readonly at?: number | undefined }): number => Math.max(nowS(b), j.at ?? 0);

const SYSTEM = "system:renewal";

/** `subscription.renew` at `current_period_end` (re-entrant: the period's invoice is unique). */
export async function renewJob(b: Billing, j: SubscriptionJob): Promise<void> {
  const before = await b.store.transaction((tx) => tx.subscriptions.get(j.scope, j.subscription));
  if (!before) return;
  const first = renew(before, jobNow(b, j));
  if (first.kind === "none") return;
  if (first.kind === "wait") {
    // not due: the job for `current_period_end` exists (or is this one, running early) — retry later
    if (j.at !== undefined && j.at < first.at) await b.store.transaction((tx) => scheduleRenewal(tx, before, nowS(b)));
    else throw new Error(`renewal of ${j.subscription} is not due before ${first.at}`);
    return;
  }
  // peer reads before the transaction (merchant name for the number prefix, customer for bill-to/mail)
  const peers =
    first.kind === "invoice"
      ? { merchant: await b.merchant.context(j.scope), customer: await liveCustomer(b, j.scope, before.customerId) }
      : null;
  await b.store.transaction(async (tx) => {
    const cur = await tx.subscriptions.get(j.scope, j.subscription, { lock: true });
    if (!cur) return;
    const now = jobNow(b, j);
    const d = renew(cur, now);
    const meta = { actor: SYSTEM, cause: `renewal at ${cur.currentPeriodEnd}` };
    if (d.kind === "end") {
      await saveSubscription(tx, cur, d.subscription, meta, ["evt.billing.subscription.deleted"]);
      return;
    }
    if (d.kind === "wait") {
      await scheduleRenewal(tx, cur, nowS(b));
      return;
    }
    if (d.kind !== "invoice" || !peers) return;
    const invoiceId = b.newId("in");
    const advanced = await saveSubscription(tx, cur, withLatestInvoice(d.subscription, invoiceId, now), meta, [
      "evt.billing.subscription.updated",
    ]);
    const inv = await issuePeriodInvoice(b, tx, advanced, {
      period: d.period,
      billingReason: d.billingReason,
      invoiceId,
      merchant: peers.merchant,
      customer: peers.customer,
      meta,
      requireActive: false,
    });
    if (inv.id !== invoiceId) {
      // the period was already invoiced (a replayed job): keep the real latest invoice
      await saveSubscription(tx, advanced, { ...advanced, latestInvoiceId: inv.id }, meta);
    }
    await scheduleRenewal(tx, advanced, now);
  });
}

/** `subscription.renewal_upcoming`, 3 days before the period end of a subscription that will renew. */
export function renewalUpcomingJob(b: Billing, j: SubscriptionJob & { readonly periodEnd: number }): Promise<void> {
  return b.store.transaction(async (tx) => {
    const cur = await tx.subscriptions.get(j.scope, j.subscription, { lock: true });
    if (!cur || !renewalUpcomingApplies(cur, j.periodEnd)) return;
    await saveSubscription(tx, cur, { ...cur, updated: nowS(b) }, { actor: SYSTEM, cause: "renewal upcoming" }, [
      "evt.billing.subscription.renewal_upcoming",
    ]);
  });
}
