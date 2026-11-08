/**
 * Postgres adapter of the billing store port (migrations/0001_billing.sql). Public ids (`in_…`) are stored
 * as uuids; amounts as numeric(78,0); times as timestamptz. Every query is scoped by `account_id` AND
 * `livemode` (INV-8) except the two documented unscoped reads. Optimistic versions guard every update.
 * Outbox events are rendered by an injected renderer (the spec objects live in `src/api`).
 */
import {
  consume,
  type Database,
  emit,
  enqueueJob,
  type Kysely,
  sql,
  type Transaction,
  withTx,
} from "@nearpay-internal/db";
import { decodeSuffix, encodeUuid, uuidv7 } from "@nearpay-internal/ids";
import type {
  BillingStore,
  BillingTx,
  EventObject,
  InvoiceListQuery,
  ListQuery,
  OutgoingEvent,
  Page,
} from "../../app/ports.js";
import type { Invoice } from "../../domain/invoice/invoice.js";
import type { InvoiceLine, TaxAmount } from "../../domain/invoice/lines.js";
import type { Price } from "../../domain/price/price.js";
import type { Product } from "../../domain/product/product.js";
import type { Scope } from "../../domain/shared.js";
import type { Subscription } from "../../domain/subscription/subscription.js";
import type { TaxRate } from "../../domain/tax-rate/tax-rate.js";
import type { DB, InvoiceLinesTable, InvoicesTable, SubscriptionsTable, TaxAmountJson } from "./schema.js";

type Tx = Transaction<DB>;

// ---------------------------------------------------------------------------------------------
// Id, time and money codecs
// ---------------------------------------------------------------------------------------------

/** `in_<26>` → uuid; undefined for anything malformed (treated as "not found"). */
export function uuidOf(id: string): string | undefined {
  const i = id.lastIndexOf("_");
  if (i < 1) return undefined;
  try {
    return decodeSuffix(id.slice(i + 1));
  } catch {
    return undefined;
  }
}

const must = (id: string): string => {
  const u = uuidOf(id);
  if (!u) throw new Error(`malformed id ${id}`);
  return u;
};

export const idOf = (prefix: string, uuid: string): string => `${prefix}_${encodeUuid(uuid)}`;
const optId = (prefix: string, uuid: string | null): string | null => (uuid === null ? null : idOf(prefix, uuid));
const optUuid = (id: string | null): string | null => (id === null ? null : must(id));

const unix = (d: Date): number => Math.floor(d.getTime() / 1000);
const optUnix = (d: Date | null): number | null => (d === null ? null : unix(d));
const ts = (s: number): Date => new Date(s * 1000);
const optTs = (s: number | null): Date | null => (s === null ? null : ts(s));
const buf = (u: Uint8Array): Buffer => Buffer.from(u);

const taxOut = (t: TaxAmount): TaxAmountJson => ({
  tax_rate: must(t.taxRateId),
  display_name: t.displayName,
  jurisdiction: t.jurisdiction,
  percentage: t.percentage,
  inclusive: t.inclusive,
  amount: t.amount.toString(),
  taxable_amount: t.taxableAmount.toString(),
});
const taxIn = (t: TaxAmountJson): TaxAmount => ({
  taxRateId: idOf("txr", t.tax_rate),
  displayName: t.display_name,
  jurisdiction: t.jurisdiction,
  percentage: t.percentage,
  inclusive: t.inclusive,
  amount: BigInt(t.amount),
  taxableAmount: BigInt(t.taxable_amount),
});

// ---------------------------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------------------------

type Sel<T> = { [K in keyof T]: T[K] extends import("kysely").ColumnType<infer S, unknown, unknown> ? S : T[K] };

const productIn = (r: Sel<DB["products"]>): Product => ({
  id: idOf("prod", r.id),
  accountId: r.account_id,
  livemode: r.livemode,
  name: r.name,
  description: r.description,
  active: r.active,
  metadata: r.metadata,
  created: unix(r.created_at),
  updated: unix(r.updated_at),
  version: r.version,
});
const productOut = (p: Product) => ({
  id: must(p.id),
  account_id: p.accountId,
  livemode: p.livemode,
  name: p.name,
  description: p.description,
  active: p.active,
  metadata: JSON.stringify(p.metadata),
  created_at: ts(p.created),
  updated_at: ts(p.updated),
  version: p.version,
});

const priceIn = (r: Sel<DB["prices"]>): Price => ({
  id: idOf("price", r.id),
  accountId: r.account_id,
  livemode: r.livemode,
  productId: idOf("prod", r.product_id),
  type: r.type as Price["type"],
  unitAmount: BigInt(r.unit_amount),
  currency: r.currency,
  assetId: r.asset_id,
  recurring:
    r.interval === null ? null : { interval: r.interval as "month", intervalCount: r.interval_count as number },
  nickname: r.nickname,
  active: r.active,
  metadata: r.metadata,
  created: unix(r.created_at),
  updated: unix(r.updated_at),
  version: r.version,
});
const priceOut = (p: Price) => ({
  id: must(p.id),
  account_id: p.accountId,
  livemode: p.livemode,
  product_id: must(p.productId),
  type: p.type,
  unit_amount: p.unitAmount.toString(),
  currency: p.currency,
  asset_id: p.assetId,
  interval: p.recurring?.interval ?? null,
  interval_count: p.recurring?.intervalCount ?? null,
  nickname: p.nickname,
  active: p.active,
  metadata: JSON.stringify(p.metadata),
  created_at: ts(p.created),
  updated_at: ts(p.updated),
  version: p.version,
});

const taxRateIn = (r: Sel<DB["tax_rates"]>): TaxRate => ({
  id: idOf("txr", r.id),
  accountId: r.account_id,
  livemode: r.livemode,
  displayName: r.display_name,
  description: r.description,
  jurisdiction: r.jurisdiction,
  country: r.country,
  ratePpm: r.rate_ppm,
  inclusive: r.inclusive,
  active: r.active,
  metadata: r.metadata,
  created: unix(r.created_at),
  updated: unix(r.updated_at),
  version: r.version,
});
const taxRateOut = (t: TaxRate) => ({
  id: must(t.id),
  account_id: t.accountId,
  livemode: t.livemode,
  display_name: t.displayName,
  rate_ppm: t.ratePpm,
  inclusive: t.inclusive,
  jurisdiction: t.jurisdiction,
  country: t.country,
  description: t.description,
  active: t.active,
  metadata: JSON.stringify(t.metadata),
  created_at: ts(t.created),
  updated_at: ts(t.updated),
  version: t.version,
});

const lineIn = (r: Sel<InvoiceLinesTable>): InvoiceLine => ({
  id: idOf("il", r.id),
  type: r.type as InvoiceLine["type"],
  priceId: optId("price", r.price_id),
  productId: optId("prod", r.product_id),
  subscriptionItemId: optId("si", r.subscription_item_id),
  description: r.description,
  quantity: r.quantity,
  unitAmount: BigInt(r.unit_amount),
  amount: BigInt(r.amount),
  amountExcludingTax: BigInt(r.amount_excluding_tax),
  taxRateIds: r.tax_rate_ids.map((u) => idOf("txr", u)),
  taxRatesExplicit: r.tax_rates_explicit,
  taxAmounts: r.tax_amounts.map(taxIn),
  period: r.period_start && r.period_end ? { start: unix(r.period_start), end: unix(r.period_end) } : null,
});
const lineOut = (invoiceId: string, l: InvoiceLine, position: number) => ({
  id: must(l.id),
  invoice_id: invoiceId,
  position,
  type: l.type,
  price_id: optUuid(l.priceId),
  product_id: optUuid(l.productId),
  subscription_item_id: optUuid(l.subscriptionItemId),
  description: l.description,
  quantity: l.quantity,
  unit_amount: l.unitAmount.toString(),
  amount: l.amount.toString(),
  amount_excluding_tax: l.amountExcludingTax.toString(),
  tax_rate_ids: l.taxRateIds.map(must),
  tax_rates_explicit: l.taxRatesExplicit,
  tax_amounts: JSON.stringify(l.taxAmounts.map(taxOut)),
  period_start: optTs(l.period?.start ?? null),
  period_end: optTs(l.period?.end ?? null),
});

const invoiceIn = (r: Sel<InvoicesTable>, lines: InvoiceLine[]): Invoice => ({
  id: idOf("in", r.id),
  accountId: r.account_id,
  livemode: r.livemode,
  customerId: idOf("cus", r.customer_id),
  subscriptionId: optId("sub", r.subscription_id),
  billingReason: r.billing_reason as Invoice["billingReason"],
  number: r.number,
  status: r.status as Invoice["status"],
  currency: r.currency,
  assetId: r.asset_id,
  description: r.description,
  footer: r.footer,
  defaultTaxRateIds: r.default_tax_rate_ids.map((u) => idOf("txr", u)),
  lines,
  subtotal: BigInt(r.subtotal),
  tax: BigInt(r.tax),
  total: BigInt(r.total),
  totalExcludingTax: BigInt(r.total_excluding_tax),
  totalTaxAmounts: r.total_tax_amounts.map(taxIn),
  amountPaid: BigInt(r.amount_paid),
  daysUntilDue: r.days_until_due,
  dueDate: optUnix(r.due_date),
  period: r.period_start && r.period_end ? { start: unix(r.period_start), end: unix(r.period_end) } : null,
  settlementDestinationId: optId("sd", r.settlement_destination_id),
  reminderDays: r.reminder_days,
  remindersSent: r.reminders_sent,
  overdueAt: optUnix(r.overdue_at),
  merchantName: r.merchant_name,
  hosted:
    r.invoice_secret_hash && r.invoice_secret_enc
      ? { secretHash: r.invoice_secret_hash, secretEnc: r.invoice_secret_enc, billToEnc: r.bill_to_enc }
      : null,
  session:
    r.checkout_session_id && r.checkout_session_expires_at && r.checkout_client_secret_enc
      ? {
          id: idOf("cs", r.checkout_session_id),
          expiresAt: unix(r.checkout_session_expires_at),
          clientSecretEnc: r.checkout_client_secret_enc,
        }
      : null,
  sessionsCreated: r.checkout_sessions_created,
  paymentIntentId: optId("pi", r.payment_intent_id),
  paymentIntentIds: r.payment_intent_ids.map((u) => idOf("pi", u)),
  pdfObjectKey: r.pdf_object_key,
  uncollectibleReason: r.uncollectible_reason as Invoice["uncollectibleReason"],
  finalizedAt: optUnix(r.finalized_at),
  sentAt: optUnix(r.sent_at),
  paidAt: optUnix(r.paid_at),
  voidedAt: optUnix(r.voided_at),
  markedUncollectibleAt: optUnix(r.marked_uncollectible_at),
  metadata: r.metadata,
  created: unix(r.created_at),
  updated: unix(r.updated_at),
  version: r.version,
});
const invoiceOut = (i: Invoice) => ({
  id: must(i.id),
  account_id: i.accountId,
  livemode: i.livemode,
  customer_id: must(i.customerId),
  subscription_id: optUuid(i.subscriptionId),
  billing_reason: i.billingReason,
  number: i.number,
  status: i.status,
  currency: i.currency,
  asset_id: i.assetId,
  description: i.description,
  footer: i.footer,
  default_tax_rate_ids: i.defaultTaxRateIds.map(must),
  subtotal: i.subtotal.toString(),
  tax: i.tax.toString(),
  total: i.total.toString(),
  total_excluding_tax: i.totalExcludingTax.toString(),
  total_tax_amounts: JSON.stringify(i.totalTaxAmounts.map(taxOut)),
  amount_paid: i.amountPaid.toString(),
  days_until_due: i.daysUntilDue,
  due_date: optTs(i.dueDate),
  period_start: optTs(i.period?.start ?? null),
  period_end: optTs(i.period?.end ?? null),
  settlement_destination_id: optUuid(i.settlementDestinationId),
  reminder_days: [...i.reminderDays],
  reminders_sent: i.remindersSent,
  overdue_at: optTs(i.overdueAt),
  invoice_secret_hash: i.hosted ? buf(i.hosted.secretHash) : null,
  invoice_secret_enc: i.hosted ? buf(i.hosted.secretEnc) : null,
  bill_to_enc: i.hosted?.billToEnc ? buf(i.hosted.billToEnc) : null,
  merchant_name: i.merchantName,
  checkout_session_id: i.session ? must(i.session.id) : null,
  checkout_session_expires_at: i.session ? ts(i.session.expiresAt) : null,
  checkout_client_secret_enc: i.session ? buf(i.session.clientSecretEnc) : null,
  checkout_sessions_created: i.sessionsCreated,
  payment_intent_id: optUuid(i.paymentIntentId),
  payment_intent_ids: i.paymentIntentIds.map(must),
  pdf_object_key: i.pdfObjectKey,
  uncollectible_reason: i.uncollectibleReason,
  finalized_at: optTs(i.finalizedAt),
  sent_at: optTs(i.sentAt),
  paid_at: optTs(i.paidAt),
  voided_at: optTs(i.voidedAt),
  marked_uncollectible_at: optTs(i.markedUncollectibleAt),
  metadata: JSON.stringify(i.metadata),
  created_at: ts(i.created),
  updated_at: ts(i.updated),
  version: i.version,
});

const subscriptionIn = (r: Sel<SubscriptionsTable>, items: Subscription["items"]): Subscription => ({
  id: idOf("sub", r.id),
  accountId: r.account_id,
  livemode: r.livemode,
  customerId: idOf("cus", r.customer_id),
  status: r.status as Subscription["status"],
  items,
  currency: r.currency,
  assetId: r.asset_id,
  recurring: { interval: r.interval as "month", intervalCount: r.interval_count },
  anchor: unix(r.billing_cycle_anchor),
  nextPeriodIndex: r.next_period_index,
  currentPeriodStart: unix(r.current_period_start),
  currentPeriodEnd: unix(r.current_period_end),
  daysUntilDue: r.days_until_due,
  defaultTaxRateIds: r.default_tax_rate_ids.map((u) => idOf("txr", u)),
  dunning: { reminderDays: r.reminder_days, onExhausted: r.on_exhausted as "cancel" | "unpaid" },
  trialStart: optUnix(r.trial_start),
  trialEnd: optUnix(r.trial_end),
  cancelAtPeriodEnd: r.cancel_at_period_end,
  canceledAt: optUnix(r.canceled_at),
  endedAt: optUnix(r.ended_at),
  cancellationReason: r.cancellation_reason as Subscription["cancellationReason"],
  latestInvoiceId: optId("in", r.latest_invoice_id),
  settlementDestinationId: optId("sd", r.settlement_destination_id),
  description: r.description,
  metadata: r.metadata,
  created: unix(r.created_at),
  updated: unix(r.updated_at),
  version: r.version,
});
const subscriptionOut = (s: Subscription) => ({
  id: must(s.id),
  account_id: s.accountId,
  livemode: s.livemode,
  customer_id: must(s.customerId),
  status: s.status,
  currency: s.currency,
  asset_id: s.assetId,
  interval: s.recurring.interval,
  interval_count: s.recurring.intervalCount,
  billing_cycle_anchor: ts(s.anchor),
  next_period_index: s.nextPeriodIndex,
  current_period_start: ts(s.currentPeriodStart),
  current_period_end: ts(s.currentPeriodEnd),
  days_until_due: s.daysUntilDue,
  default_tax_rate_ids: s.defaultTaxRateIds.map(must),
  reminder_days: [...s.dunning.reminderDays],
  on_exhausted: s.dunning.onExhausted,
  trial_start: optTs(s.trialStart),
  trial_end: optTs(s.trialEnd),
  cancel_at_period_end: s.cancelAtPeriodEnd,
  canceled_at: optTs(s.canceledAt),
  ended_at: optTs(s.endedAt),
  cancellation_reason: s.cancellationReason,
  latest_invoice_id: optUuid(s.latestInvoiceId),
  settlement_destination_id: optUuid(s.settlementDestinationId),
  description: s.description,
  metadata: JSON.stringify(s.metadata),
  created_at: ts(s.created),
  updated_at: ts(s.updated),
  version: s.version,
});

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

type ListTable = "products" | "prices" | "tax_rates" | "invoices" | "subscriptions";

/**
 * Keyset page, newest first, `(created_at, id)` order. Cursors must belong to the same scope (a foreign or
 * unknown cursor yields an empty page rather than a leak).
 */
async function listPage<T extends ListTable>(
  tx: Tx,
  table: T,
  scope: Scope,
  q: ListQuery,
  // biome-ignore lint/suspicious/noExplicitAny: kysely's builder types are table-generic here
  filter: (qb: any) => any = (qb) => qb,
): Promise<Sel<DB[T]>[] & { hasMore?: boolean }> {
  // biome-ignore lint/suspicious/noExplicitAny: see above
  let qb: any = tx
    .selectFrom(table as ListTable)
    .selectAll()
    .where("account_id", "=", scope.accountId)
    .where("livemode", "=", scope.livemode);
  const c = q.created;
  if (c?.gt !== undefined) qb = qb.where("created_at", ">", ts(c.gt));
  if (c?.gte !== undefined) qb = qb.where("created_at", ">=", ts(c.gte));
  if (c?.lt !== undefined) qb = qb.where("created_at", "<", ts(c.lt));
  if (c?.lte !== undefined) qb = qb.where("created_at", "<=", ts(c.lte));
  qb = filter(qb);
  const cursorId = q.startingAfter ?? q.endingBefore;
  if (cursorId) {
    const u = uuidOf(cursorId);
    const cur = u
      ? await tx
          .selectFrom(table as ListTable)
          .select(["created_at", "id"])
          .where("id", "=", u)
          .where("account_id", "=", scope.accountId)
          .where("livemode", "=", scope.livemode)
          .executeTakeFirst()
      : undefined;
    if (!cur) return [];
    const op = q.startingAfter ? "<" : ">";
    qb = qb.where(sql`(created_at, id)`, op, sql`(${cur.created_at}, ${cur.id}::uuid)`);
  }
  const asc = !q.startingAfter && Boolean(q.endingBefore);
  qb = qb
    .orderBy("created_at", asc ? "asc" : "desc")
    .orderBy("id", asc ? "asc" : "desc")
    .limit(q.limit + 1);
  const rows = (await qb.execute()) as Sel<DB[T]>[];
  const ordered = asc ? rows.slice(0, q.limit).reverse() : rows.slice(0, q.limit);
  return Object.assign(ordered, { hasMore: rows.length > q.limit });
}

async function linesOf(tx: Tx, invoiceUuids: string[]): Promise<Map<string, InvoiceLine[]>> {
  const out = new Map<string, InvoiceLine[]>(invoiceUuids.map((u) => [u, []]));
  if (invoiceUuids.length === 0) return out;
  const rows = await tx
    .selectFrom("invoice_lines")
    .selectAll()
    .where("invoice_id", "in", invoiceUuids)
    .orderBy("position")
    .execute();
  for (const r of rows) out.get(r.invoice_id)?.push(lineIn(r));
  return out;
}

async function itemsOf(tx: Tx, subUuids: string[]): Promise<Map<string, Subscription["items"][number][]>> {
  const out = new Map<string, Subscription["items"][number][]>(subUuids.map((u) => [u, []]));
  if (subUuids.length === 0) return out;
  const rows = await tx
    .selectFrom("subscription_items")
    .selectAll()
    .where("subscription_id", "in", subUuids)
    .orderBy("position")
    .execute();
  for (const r of rows)
    out.get(r.subscription_id)?.push({
      id: idOf("si", r.id),
      priceId: idOf("price", r.price_id),
      quantity: r.quantity,
      taxRateIds: r.tax_rate_ids === null ? null : r.tax_rate_ids.map((u) => idOf("txr", u)),
    });
  return out;
}

const invoicesWithLines = async (tx: Tx, rows: Sel<InvoicesTable>[]): Promise<Invoice[]> => {
  const lines = await linesOf(
    tx,
    rows.map((r) => r.id),
  );
  return rows.map((r) => invoiceIn(r, lines.get(r.id) ?? []));
};

const subsWithItems = async (tx: Tx, rows: Sel<SubscriptionsTable>[]): Promise<Subscription[]> => {
  const items = await itemsOf(
    tx,
    rows.map((r) => r.id),
  );
  return rows.map((r) => subscriptionIn(r, items.get(r.id) ?? []));
};

const sameJson = (a: unknown, b: unknown): boolean =>
  JSON.stringify(a, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v,
  ) ===
  JSON.stringify(b, (_k, v) =>
    typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v,
  );

function concurrent(what: string, id: string): Error {
  return new Error(`${what} ${id} changed concurrently`);
}

/** Renders an outbox event's object as the spec object (`src/api` views). */
export type EventRenderer = (o: EventObject) => unknown;

function catalogRepo<T extends Product | Price | TaxRate>(
  tx: Tx,
  table: "products" | "prices" | "tax_rates",
  fromRow: (r: never) => T,
  toRow: (t: T) => Record<string, unknown>,
) {
  return {
    async get(scope: Scope, id: string, o?: { lock?: boolean }) {
      const u = uuidOf(id);
      if (!u) return undefined;
      const q = tx
        .selectFrom(table)
        .selectAll()
        .where("id", "=", u)
        .where("account_id", "=", scope.accountId)
        .where("livemode", "=", scope.livemode);
      const r = await (o?.lock ? q.forUpdate() : q).executeTakeFirst();
      return r ? fromRow(r as never) : undefined;
    },
    async getMany(scope: Scope, ids: readonly string[]) {
      const us = ids.map(uuidOf).filter((u): u is string => u !== undefined);
      const out = new Map<string, T>();
      if (us.length === 0) return out;
      const rows = await tx
        .selectFrom(table)
        .selectAll()
        .where("id", "in", us)
        .where("account_id", "=", scope.accountId)
        .where("livemode", "=", scope.livemode)
        .execute();
      for (const r of rows) {
        const t = fromRow(r as never);
        out.set(t.id, t);
      }
      return out;
    },
    async insert(t: T) {
      await tx
        .insertInto(table)
        .values(toRow(t) as never)
        .execute();
    },
    async update(prev: T, next: T) {
      const { id, account_id, livemode, created_at, ...rest } = toRow(next);
      void account_id;
      void livemode;
      void created_at;
      const r = await tx
        .updateTable(table)
        .set(rest as never)
        .where("id", "=", id as string)
        .where("version", "=", prev.version)
        .executeTakeFirst();
      if (Number(r.numUpdatedRows) !== 1) throw concurrent(table, prev.id);
    },
  };
}

function txAdapter(tx: Tx, render: EventRenderer): BillingTx {
  return {
    products: {
      ...catalogRepo(tx, "products", productIn as never, productOut as never),
      async list(scope, q) {
        const rows = await listPage(tx, "products", scope, q, (qb) =>
          q.active === undefined ? qb : qb.where("active", "=", q.active),
        );
        return { data: rows.map(productIn), hasMore: rows.hasMore ?? false };
      },
    },
    prices: {
      ...catalogRepo(tx, "prices", priceIn as never, priceOut as never),
      async list(scope, q) {
        const product = q.product === undefined ? undefined : uuidOf(q.product);
        if (q.product !== undefined && !product) return { data: [], hasMore: false };
        const rows = await listPage(tx, "prices", scope, q, (qb) => {
          let b = qb;
          if (q.active !== undefined) b = b.where("active", "=", q.active);
          if (product) b = b.where("product_id", "=", product);
          if (q.type !== undefined) b = b.where("type", "=", q.type);
          if (q.currency !== undefined) b = b.where("currency", "=", q.currency);
          return b;
        });
        return { data: rows.map(priceIn), hasMore: rows.hasMore ?? false };
      },
    },
    taxRates: {
      ...catalogRepo(tx, "tax_rates", taxRateIn as never, taxRateOut as never),
      async list(scope, q) {
        const rows = await listPage(tx, "tax_rates", scope, q, (qb) => {
          let b = qb;
          if (q.active !== undefined) b = b.where("active", "=", q.active);
          if (q.inclusive !== undefined) b = b.where("inclusive", "=", q.inclusive);
          return b;
        });
        return { data: rows.map(taxRateIn), hasMore: rows.hasMore ?? false };
      },
    },
    invoices: {
      async get(scope, id, o) {
        const u = uuidOf(id);
        if (!u) return undefined;
        const q = tx
          .selectFrom("invoices")
          .selectAll()
          .where("id", "=", u)
          .where("account_id", "=", scope.accountId)
          .where("livemode", "=", scope.livemode);
        const r = await (o?.lock ? q.forUpdate() : q).executeTakeFirst();
        return r ? (await invoicesWithLines(tx, [r]))[0] : undefined;
      },
      async getByIdUnscoped(id, o) {
        const u = uuidOf(id);
        if (!u) return undefined;
        const q = tx.selectFrom("invoices").selectAll().where("id", "=", u);
        const r = await (o?.lock ? q.forUpdate() : q).executeTakeFirst();
        return r ? (await invoicesWithLines(tx, [r]))[0] : undefined;
      },
      async insert(row) {
        const v = invoiceOut(row);
        await tx.insertInto("invoices").values(v).execute();
        if (row.lines.length)
          await tx
            .insertInto("invoice_lines")
            .values(row.lines.map((l, i) => lineOut(v.id, l, i)))
            .execute();
      },
      async update(prev, next) {
        const { id, account_id, livemode, created_at, ...rest } = invoiceOut(next);
        void account_id;
        void livemode;
        void created_at;
        const r = await tx
          .updateTable("invoices")
          .set(rest)
          .where("id", "=", id)
          .where("version", "=", prev.version)
          .executeTakeFirst();
        if (Number(r.numUpdatedRows) !== 1) throw concurrent("invoice", prev.id);
        if (!sameJson(prev.lines, next.lines)) {
          await tx.deleteFrom("invoice_lines").where("invoice_id", "=", id).execute();
          if (next.lines.length)
            await tx
              .insertInto("invoice_lines")
              .values(next.lines.map((l, i) => lineOut(id, l, i)))
              .execute();
        }
      },
      async delete(row) {
        const u = must(row.id);
        await tx.deleteFrom("invoice_lines").where("invoice_id", "=", u).execute();
        const r = await tx
          .deleteFrom("invoices")
          .where("id", "=", u)
          .where("status", "=", "draft")
          .where("version", "=", row.version)
          .executeTakeFirst();
        if (Number(r.numDeletedRows) !== 1) throw concurrent("invoice", row.id);
      },
      async list(scope, q: InvoiceListQuery) {
        const customer = q.customer === undefined ? undefined : uuidOf(q.customer);
        const subscription = q.subscription === undefined ? undefined : uuidOf(q.subscription);
        if ((q.customer !== undefined && !customer) || (q.subscription !== undefined && !subscription))
          return { data: [], hasMore: false };
        const rows = await listPage(tx, "invoices", scope, q, (qb) => {
          let b = qb;
          if (q.status !== undefined) b = b.where("status", "=", q.status);
          if (customer) b = b.where("customer_id", "=", customer);
          if (subscription) b = b.where("subscription_id", "=", subscription);
          if (q.dueDate?.gte !== undefined) b = b.where("due_date", ">=", ts(q.dueDate.gte));
          if (q.dueDate?.lte !== undefined) b = b.where("due_date", "<=", ts(q.dueDate.lte));
          return b;
        });
        return { data: await invoicesWithLines(tx, rows), hasMore: rows.hasMore ?? false };
      },
      async bySubscriptionPeriod(scope, subscriptionId, periodStart) {
        const r = await tx
          .selectFrom("invoices")
          .selectAll()
          .where("account_id", "=", scope.accountId)
          .where("livemode", "=", scope.livemode)
          .where("subscription_id", "=", must(subscriptionId))
          .where("period_start", "=", ts(periodStart))
          .executeTakeFirst();
        return r ? (await invoicesWithLines(tx, [r]))[0] : undefined;
      },
      async countOverdueOpen(scope, subscriptionId, exceptId) {
        const r = await tx
          .selectFrom("invoices")
          .select(sql<string>`count(*)`.as("n"))
          .where("account_id", "=", scope.accountId)
          .where("livemode", "=", scope.livemode)
          .where("subscription_id", "=", must(subscriptionId))
          .where("id", "<>", must(exceptId))
          .where("status", "=", "open")
          .where("overdue_at", "is not", null)
          .executeTakeFirstOrThrow();
        return Number(r.n);
      },
    },
    subscriptions: {
      async get(scope, id, o) {
        const u = uuidOf(id);
        if (!u) return undefined;
        const q = tx
          .selectFrom("subscriptions")
          .selectAll()
          .where("id", "=", u)
          .where("account_id", "=", scope.accountId)
          .where("livemode", "=", scope.livemode);
        const r = await (o?.lock ? q.forUpdate() : q).executeTakeFirst();
        return r ? (await subsWithItems(tx, [r]))[0] : undefined;
      },
      async getByIdUnscoped(id) {
        const u = uuidOf(id);
        if (!u) return undefined;
        const r = await tx.selectFrom("subscriptions").selectAll().where("id", "=", u).executeTakeFirst();
        return r ? (await subsWithItems(tx, [r]))[0] : undefined;
      },
      async insert(row) {
        const v = subscriptionOut(row);
        await tx.insertInto("subscriptions").values(v).execute();
        await writeItems(tx, v.id, row.items);
      },
      async update(prev, next) {
        const { id, account_id, livemode, created_at, ...rest } = subscriptionOut(next);
        void account_id;
        void livemode;
        void created_at;
        const r = await tx
          .updateTable("subscriptions")
          .set(rest)
          .where("id", "=", id)
          .where("version", "=", prev.version)
          .executeTakeFirst();
        if (Number(r.numUpdatedRows) !== 1) throw concurrent("subscription", prev.id);
        if (!sameJson(prev.items, next.items)) {
          await tx.deleteFrom("subscription_items").where("subscription_id", "=", id).execute();
          await writeItems(tx, id, next.items);
        }
      },
      async list(scope, q) {
        const customer = q.customer === undefined ? undefined : uuidOf(q.customer);
        const price = q.price === undefined ? undefined : uuidOf(q.price);
        if ((q.customer !== undefined && !customer) || (q.price !== undefined && !price))
          return { data: [], hasMore: false };
        const rows = await listPage(tx, "subscriptions", scope, q, (qb) => {
          let b = qb;
          if (q.status !== undefined) b = b.where("status", "=", q.status);
          if (customer) b = b.where("customer_id", "=", customer);
          if (price)
            b = b.where(
              "id",
              "in",
              tx.selectFrom("subscription_items").select("subscription_id").where("price_id", "=", price),
            );
          return b;
        });
        return { data: await subsWithItems(tx, rows), hasMore: rows.hasMore ?? false };
      },
    },
    sequences: {
      async next(scope, prefixIfNew) {
        const r = await tx
          .insertInto("invoice_sequences")
          .values({ account_id: scope.accountId, livemode: scope.livemode, prefix: prefixIfNew, next_number: 2 })
          .onConflict((oc) =>
            oc.columns(["account_id", "livemode"]).doUpdateSet({ next_number: sql`invoice_sequences.next_number + 1` }),
          )
          .returning(["prefix", "next_number"])
          .executeTakeFirstOrThrow();
        return { prefix: r.prefix, number: r.next_number - 1 };
      },
    },
    async recordTransition(t) {
      const row = {
        id: uuidv7(),
        from_state: t.from,
        to_state: t.to,
        cause: t.cause.slice(0, 500),
        actor: t.actor,
        evidence: t.evidence === undefined ? null : JSON.stringify(t.evidence),
      };
      if (t.aggregate === "invoice")
        await tx
          .insertInto("invoice_transitions")
          .values({ ...row, invoice_id: must(t.id) })
          .execute();
      else
        await tx
          .insertInto("subscription_transitions")
          .values({ ...row, subscription_id: must(t.id) })
          .execute();
    },
    async emit(e: OutgoingEvent) {
      await emit(tx, {
        subject: e.subject,
        aggregate: e.aggregate,
        accountId: e.scope.accountId,
        livemode: e.scope.livemode,
        data: { object: render(e.object), ...(e.previous ? { previous: e.previous } : {}) },
      });
    },
    async enqueue(j) {
      await enqueueJob(tx, {
        kind: j.kind,
        payload: { ...j.payload, at: j.runAt },
        runAt: ts(j.runAt),
        dedupeKey: j.dedupeKey,
      });
    },
    consume: (eventId, subject) => consume(tx, eventId, subject),
    async hit(key, windowSeconds, now) {
      const window = ts(Math.floor(now / windowSeconds) * windowSeconds);
      const r = await tx
        .insertInto("rate_counters")
        .values({ key, window_start: window, count: 1 })
        .onConflict((oc) =>
          oc.column("key").doUpdateSet({
            count: sql`case when rate_counters.window_start = excluded.window_start then rate_counters.count + 1 else 1 end`,
            window_start: sql`excluded.window_start`,
          }),
        )
        .returning("count")
        .executeTakeFirstOrThrow();
      return r.count;
    },
  };
}

async function writeItems(tx: Tx, subUuid: string, items: Subscription["items"]): Promise<void> {
  if (items.length === 0) return;
  await tx
    .insertInto("subscription_items")
    .values(
      items.map((it, i) => ({
        id: must(it.id),
        subscription_id: subUuid,
        position: i,
        price_id: must(it.priceId),
        quantity: it.quantity,
        tax_rate_ids: it.taxRateIds === null ? null : it.taxRateIds.map(must),
      })),
    )
    .execute();
}

export function postgresStore(db: Kysely<DB> | Database<DB>["db"], render: EventRenderer): BillingStore {
  return {
    transaction: (fn) => withTx(db, (tx) => fn(txAdapter(tx, render))),
  };
}

export type { Page };
