/**
 * Ports of the billing use cases (hexagonal: `src/infra` implements them; tests use in-memory fakes).
 * Domain objects cross these ports; contract (spec) shapes appear only in the adapters and `src/api`.
 */
import type { EnvelopeCipher } from "@nearpay-internal/db";
import type { Subject } from "@nearpay-internal/spec";
import type { Reminder } from "../domain/dunning/dunning.js";
import type { Invoice } from "../domain/invoice/invoice.js";
import type { Price } from "../domain/price/price.js";
import type { Product } from "../domain/product/product.js";
import type { Pricing, Scope } from "../domain/shared.js";
import type { Subscription } from "../domain/subscription/subscription.js";
import type { TaxRate } from "../domain/tax-rate/tax-rate.js";

/** Billing subjects (spec `SUBJECTS`, producer billing). */
export type BillingSubject = Extract<Subject, `evt.billing.${string}`>;

import type { PdfRenderer } from "./pdf.js";

// ---------------------------------------------------------------------------------------------
// Store (one Postgres database, one transaction per state change)
// ---------------------------------------------------------------------------------------------

export interface CreatedFilter {
  readonly gt?: number | undefined;
  readonly gte?: number | undefined;
  readonly lt?: number | undefined;
  readonly lte?: number | undefined;
}

/** Cursor pagination, newest first (api-conventions); cursors are public ids. */
export interface ListQuery {
  readonly limit: number;
  readonly startingAfter?: string | undefined;
  readonly endingBefore?: string | undefined;
  readonly created?: CreatedFilter | undefined;
}

export interface Page<T> {
  readonly data: readonly T[];
  readonly hasMore: boolean;
}

export interface Lock {
  /** `select … for update` (the row is locked until the transaction ends). */
  readonly lock?: boolean;
}

export interface CatalogRepo<T> {
  get(scope: Scope, id: string, o?: Lock): Promise<T | undefined>;
  /** Rows of `ids` in this scope (missing ones are absent from the map). */
  getMany(scope: Scope, ids: readonly string[]): Promise<Map<string, T>>;
  insert(row: T): Promise<void>;
  /** Optimistic update: `prev.version` must still be stored; `next.version` is written. */
  update(prev: T, next: T): Promise<void>;
}

export interface ProductRepo extends CatalogRepo<Product> {
  list(scope: Scope, q: ListQuery & { readonly active?: boolean | undefined }): Promise<Page<Product>>;
}

export interface PriceRepo extends CatalogRepo<Price> {
  list(
    scope: Scope,
    q: ListQuery & {
      readonly product?: string | undefined;
      readonly active?: boolean | undefined;
      readonly type?: string | undefined;
      readonly currency?: string | undefined;
    },
  ): Promise<Page<Price>>;
}

export interface TaxRateRepo extends CatalogRepo<TaxRate> {
  list(
    scope: Scope,
    q: ListQuery & { readonly active?: boolean | undefined; readonly inclusive?: boolean | undefined },
  ): Promise<Page<TaxRate>>;
}

export interface InvoiceListQuery extends ListQuery {
  readonly status?: string | undefined;
  readonly customer?: string | undefined;
  readonly subscription?: string | undefined;
  readonly dueDate?: { readonly gte?: number | undefined; readonly lte?: number | undefined } | undefined;
}

export interface InvoiceRepo {
  get(scope: Scope, id: string, o?: Lock): Promise<Invoice | undefined>;
  /**
   * By id alone — only for the anonymous hosted-invoice routes (after the invoice-secret check) and the
   * internal notification-context route; both then act in the row's own scope (INV-8: the scope comes
   * from the row, never from the caller).
   */
  getByIdUnscoped(id: string, o?: Lock): Promise<Invoice | undefined>;
  insert(row: Invoice): Promise<void>;
  /** Optimistic update of the row and, when they changed, its lines. */
  update(prev: Invoice, next: Invoice): Promise<void>;
  /** Deletes a draft and its lines (the database refuses anything else). */
  delete(row: Invoice): Promise<void>;
  list(scope: Scope, q: InvoiceListQuery): Promise<Page<Invoice>>;
  bySubscriptionPeriod(scope: Scope, subscriptionId: string, periodStart: number): Promise<Invoice | undefined>;
  /** Open invoices of the subscription that are overdue, other than `exceptId`. */
  countOverdueOpen(scope: Scope, subscriptionId: string, exceptId: string): Promise<number>;
}

export interface SubscriptionRepo {
  get(scope: Scope, id: string, o?: Lock): Promise<Subscription | undefined>;
  /** By id alone — only for the internal notification-context route (acts in the row's scope). */
  getByIdUnscoped(id: string): Promise<Subscription | undefined>;
  insert(row: Subscription): Promise<void>;
  update(prev: Subscription, next: Subscription): Promise<void>;
  list(
    scope: Scope,
    q: ListQuery & {
      readonly status?: string | undefined;
      readonly customer?: string | undefined;
      readonly price?: string | undefined;
    },
  ): Promise<Page<Subscription>>;
}

export interface SequenceRepo {
  /** Allocates the next invoice number; the prefix is fixed by the first allocation of the scope. */
  next(scope: Scope, prefixIfNew: string): Promise<{ prefix: string; number: number }>;
}

export interface Transition {
  readonly aggregate: "invoice" | "subscription";
  readonly id: string;
  readonly from: string | null;
  readonly to: string;
  readonly cause: string;
  readonly actor: string;
  readonly evidence?: unknown;
}

/** What an event carries; the outbox adapter renders the spec object (`InvoiceEvent`, `Subscription`, …). */
export type EventObject =
  | { readonly kind: "invoice"; readonly invoice: Invoice }
  | { readonly kind: "subscription"; readonly subscription: Subscription }
  | { readonly kind: "invoice_reminder"; readonly invoice: Invoice; readonly reminder: Reminder };

export interface OutgoingEvent {
  readonly subject: BillingSubject;
  readonly aggregate: { readonly type: "invoice" | "subscription"; readonly id: string; readonly version: number };
  readonly scope: Scope;
  readonly object: EventObject;
  readonly previous?: Record<string, unknown> | undefined;
}

export type JobKind =
  | "invoice.remind"
  | "invoice.overdue"
  | "invoice.dunning_exhausted"
  | "invoice.render_pdf"
  | "subscription.renew"
  | "subscription.renewal_upcoming";

/**
 * A durable job. Adapters store `runAt` in the payload as `at`: handlers decide at `max(now, at)`, so a job
 * the database runs a moment before the service clock reaches `runAt` (clock skew) still acts instead of
 * being skipped for ever.
 */
export interface JobRequest {
  readonly kind: JobKind;
  /** Must start with `<kind>:`; an existing job with the key wins. */
  readonly dedupeKey: string;
  readonly runAt: number;
  readonly payload: Readonly<Record<string, string | number | boolean>>;
}

export interface BillingTx {
  readonly products: ProductRepo;
  readonly prices: PriceRepo;
  readonly taxRates: TaxRateRepo;
  readonly invoices: InvoiceRepo;
  readonly subscriptions: SubscriptionRepo;
  readonly sequences: SequenceRepo;
  recordTransition(t: Transition): Promise<void>;
  /** Outbox row in this transaction (kit `emit`). */
  emit(e: OutgoingEvent): Promise<void>;
  enqueue(j: JobRequest): Promise<void>;
  /** Inbox dedupe: true when the event is new. */
  consume(eventId: string, subject: string): Promise<boolean>;
  /** Fixed-window counter: the count in the current window after this hit. */
  hit(key: string, windowSeconds: number, now: number): Promise<number>;
}

export interface BillingStore {
  transaction<T>(fn: (tx: BillingTx) => Promise<T>): Promise<T>;
}

// ---------------------------------------------------------------------------------------------
// Peers (published internal APIs only)
// ---------------------------------------------------------------------------------------------

export interface CustomerFacts {
  readonly id: string;
  readonly email: string | null;
  readonly name: string | null;
  readonly deleted: boolean;
}

export type SessionStatus = "open" | "expiring" | "complete" | "expired";

export interface SessionFacts {
  readonly id: string;
  readonly status: SessionStatus | string;
  readonly expiresAt: number;
  readonly invoiceId: string | null;
}

export interface InvoiceSessionRequest extends Pricing {
  readonly scope: Scope;
  readonly invoiceId: string;
  readonly amount: bigint;
  readonly customerId: string;
  readonly description: string;
  readonly settlementDestinationId: string | null;
  readonly successUrl: string;
  readonly expiresAt: number;
  readonly locale?: string | undefined;
  readonly metadata: Readonly<Record<string, string>>;
}

/** payments' internal invoice-session API (lld/payments.md §6.3; lld/billing.md §11 d4). */
export interface PaymentsPort {
  /** The customer of this scope; undefined when missing or of another account/mode. */
  getCustomer(scope: Scope, customerId: string): Promise<CustomerFacts | undefined>;
  /**
   * `createInvoiceCheckoutSession`. `conflict` = another session of the invoice is open (409). Other
   * refusals throw `DomainError` with payments' code (e.g. `amount_below_destination_minimum`).
   */
  createInvoiceSession(
    req: InvoiceSessionRequest,
    idempotencyKey: string,
  ): Promise<
    | { readonly kind: "created"; readonly session: SessionFacts; readonly clientSecret: string }
    | { readonly kind: "conflict" }
  >;
  getSession(sessionId: string): Promise<SessionFacts>;
  /** `expireInvoiceCheckoutSession`; throws `DomainError("attempt_in_flight")` while money may move. */
  expireSession(sessionId: string, reason: "invoice_voided" | "invoice_paid" | "superseded"): Promise<SessionFacts>;
}

export interface MerchantFacts {
  readonly displayName: string;
  /** Live mode enabled (KYB approved, active destination); test mode is always enabled. */
  readonly liveEnabled: boolean;
  readonly liveMissing: string | null;
  readonly destinations: readonly {
    readonly id: string;
    readonly assetId: string;
    readonly chain: string;
    readonly type: string;
  }[];
  /** Default destination per asset id; `*` = account default. */
  readonly defaults: Readonly<Record<string, string>>;
}

/** identity's settlement context (`getSettlementContext`, scope `identity.context.read`). */
export interface MerchantPort {
  context(scope: Scope): Promise<MerchantFacts>;
}

export interface AssetFacts {
  readonly assetId: string;
  readonly symbol: string;
  readonly decimals: number;
}

/** rails' asset registry (scope `rails.read`). */
export interface AssetsPort {
  asset(assetId: string): Promise<AssetFacts | undefined>;
}

export interface ObjectStore {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
}

export interface Logger {
  info(o: object, msg: string): void;
  warn(o: object, msg: string): void;
  error(o: object, msg: string): void;
}

export interface BillingSettings {
  /** Hosted pages: `<payOrigin>/i/<in_…>#<invoice secret>`. */
  readonly payOrigin: string;
  /** Fiat pricing currencies payments accepts. */
  readonly pricingCurrencies: ReadonlySet<string>;
  /** Anonymous session creations per minute per client network and per invoice. */
  readonly publicSessionsPerClient: number;
  readonly publicSessionsPerInvoice: number;
}

/** Everything a use case may touch. */
export interface Billing {
  readonly store: BillingStore;
  readonly payments: PaymentsPort;
  readonly merchant: MerchantPort;
  readonly assets: AssetsPort;
  readonly cipher: EnvelopeCipher;
  readonly objects: ObjectStore;
  readonly pdf: PdfRenderer;
  readonly log: Logger;
  readonly settings: BillingSettings;
  /** Prefixed public ids (`newId("in")`, …). */
  readonly newId: (prefix: IdKind) => string;
  readonly randomBytes: (n: number) => Uint8Array;
  /** Milliseconds. */
  readonly now: () => number;
}

export type IdKind = "prod" | "price" | "txr" | "in" | "il" | "sub" | "si";
