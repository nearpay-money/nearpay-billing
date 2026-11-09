/**
 * Ports of the billing use cases (hexagonal: `src/infra` implements them; tests use in-memory fakes).
 * Domain objects cross these ports; contract (spec) shapes appear only in the adapters and `src/api`.
 */

import type { VaultErrorCode } from "@nearpay/spec";
import type { EnvelopeCipher } from "@nearpay-internal/db";
import type { Subject } from "@nearpay-internal/spec";
import type { Reminder } from "../domain/dunning/dunning.js";
import type { Invoice } from "../domain/invoice/invoice.js";
import type { Collection, Mandate } from "../domain/mandate/mandate.js";
import type { Price } from "../domain/price/price.js";
import type { Product } from "../domain/product/product.js";
import type { Pricing, Scope } from "../domain/shared.js";
import type { Subscription } from "../domain/subscription/subscription.js";
import type { TaxRate } from "../domain/tax-rate/tax-rate.js";

/** Mandate subjects (spec 0.4.0 `SUBJECTS`, §14 d10; placeholder union until the bump). */
export const MANDATE_SUBJECTS = [
  "evt.billing.mandate.activated",
  "evt.billing.mandate.collected",
  "evt.billing.mandate.insufficient_funds",
  "evt.billing.mandate.canceled",
  "evt.billing.mandate.exhausted",
  "evt.billing.mandate.updated",
  "evt.billing.mandate.unlinked",
  "evt.billing.mandate.released",
] as const;
export type MandateSubject = (typeof MANDATE_SUBJECTS)[number];

/** Billing subjects (spec `SUBJECTS`, producer billing). */
export type BillingSubject = Extract<Subject, `evt.billing.${string}`> | MandateSubject;

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
  readonly collectionMethod?: string | undefined;
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
  /** Due dates (subscription clock) of the subscription's open invoices that have one (§13 `overdue`). */
  openDueDates(scope: Scope, subscriptionId: string): Promise<number[]>;
}

export interface SubscriptionRepo {
  get(scope: Scope, id: string, o?: Lock): Promise<Subscription | undefined>;
  /** By id alone — only for the internal notification-context route (acts in the row's scope). */
  getByIdUnscoped(id: string): Promise<Subscription | undefined>;
  insert(row: Subscription): Promise<void>;
  update(prev: Subscription, next: Subscription): Promise<void>;
  /**
   * Test-mode clock advance (§13): `clock_offset_s += delta` (delta > 0) on the locked row, guarded by the
   * offset `prev` was read with. The offset is never written by `update` (forward-only, test mode only by
   * check constraint). Returns the subscription with the new offset.
   */
  advanceClock(prev: Subscription, delta: number): Promise<Subscription>;
  list(
    scope: Scope,
    q: ListQuery & {
      readonly status?: string | undefined;
      readonly customer?: string | undefined;
      readonly price?: string | undefined;
    },
  ): Promise<Page<Subscription>>;
}

export interface MandateListQuery extends ListQuery {
  readonly subscription?: string | undefined;
  readonly customer?: string | undefined;
  readonly status?: string | undefined;
  readonly linkStatus?: string | undefined;
  readonly payer?: string | undefined;
}

/** How a recorded collection was used (`mandate_collections.applied`). */
export type CollectionUse = "paid" | "short" | "late" | "unapplied";

export interface MandateRepo {
  get(scope: Scope, id: string, o?: Lock): Promise<Mandate | undefined>;
  /** By id alone — only for the internal notification-context route (acts in the row's own scope). */
  getByIdUnscoped(id: string): Promise<Mandate | undefined>;
  /**
   * By the vault's id — only for forwarded vault events, which carry no account (the envelope's `account_id`
   * is null); the row's own scope is used from then on, and the vault/mode must match the event's.
   */
  byOnchain(vaultContract: string, onchainId: number, o?: Lock): Promise<Mandate | undefined>;
  insert(row: Mandate): Promise<void>;
  update(prev: Mandate, next: Mandate): Promise<void>;
  list(scope: Scope, q: MandateListQuery): Promise<Page<Mandate>>;
  /** The linked, collecting mandate of the subscription (at most one, unique index). */
  collectingFor(scope: Scope, subscriptionId: string, o?: Lock): Promise<Mandate | undefined>;
  /** Newest mandate (linked or unlinked) of the subscription in this scope. */
  newestFor(scope: Scope, subscriptionId: string): Promise<Mandate | undefined>;
  /** Records a `collected` event; false when its receipt (or the period) was recorded already. */
  recordCollection(m: Mandate, c: Collection, use: CollectionUse): Promise<boolean>;
  /** The oldest unapplied full collection of the mandate, if any. */
  unappliedCollection(m: Mandate): Promise<Collection | undefined>;
  /** Marks a recorded collection as applied to `invoiceId`. */
  applyCollection(receiptId: string, invoiceId: string, use: CollectionUse): Promise<void>;
}

export interface InvoiceByMandateRepo {
  /** Payable `auto_debit` invoices collected from the mandate, oldest period first. */
  payableAutoDebit(m: Mandate): Promise<Invoice[]>;
  /** Payable `auto_debit` invoices of the subscription (any mandate), oldest first. */
  payableAutoDebitOfSubscription(scope: Scope, subscriptionId: string): Promise<Invoice[]>;
}

export interface ParkedVaultEvent {
  readonly dedupeKey: string;
  readonly payload: unknown;
  readonly attempts: number;
}

/** Applied/parked forwarded vault events (§6: dedupe `receipt_id:log_index`, never block the stream). */
export interface VaultEventLog {
  /** Records the event as applied; false when it was applied already. */
  markApplied(e: {
    readonly dedupeKey: string;
    readonly vaultContract: string;
    readonly livemode: boolean;
    readonly onchainId: number;
    readonly event: string;
    readonly blockHeight: number;
    readonly outcome: string;
  }): Promise<boolean>;
  /** Parks an event (insert or bump attempts); `retryAt` null = not retried. */
  park(e: {
    readonly dedupeKey: string;
    readonly vaultContract: string | null;
    readonly livemode: boolean | null;
    readonly onchainId: number | null;
    readonly event: string | null;
    readonly reason: string;
    readonly error: string | null;
    readonly payload: unknown;
    readonly retryAt: number | null;
  }): Promise<void>;
  /** Parked retriable events due for a retry. */
  dueParked(now: number, limit: number): Promise<ParkedVaultEvent[]>;
  resolveParked(dedupeKey: string): Promise<void>;
  /** Parked retriable events of one mandate (re-applied once its `mandate_created` arrived). */
  parkedFor(vaultContract: string, onchainId: number): Promise<ParkedVaultEvent[]>;
}

export type CaseKind = "collect_failures" | "short_share" | "keeper_errors" | "late_collection" | "fee_leg_failed";

export interface SequenceRepo {
  /** Allocates the next invoice number; the prefix is fixed by the first allocation of the scope. */
  next(scope: Scope, prefixIfNew: string): Promise<{ prefix: string; number: number }>;
}

export interface Transition {
  readonly aggregate: "invoice" | "subscription" | "mandate";
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
  | {
      readonly kind: "subscription";
      readonly subscription: Subscription;
      /** Prices of its items (the event embeds each item's price object). */
      readonly prices: ReadonlyMap<string, Price>;
    }
  | { readonly kind: "invoice_reminder"; readonly invoice: Invoice; readonly reminder: Reminder }
  | { readonly kind: "mandate"; readonly mandate: Mandate };

export interface OutgoingEvent {
  readonly subject: BillingSubject;
  readonly aggregate: {
    readonly type: "invoice" | "subscription" | "mandate";
    readonly id: string;
    readonly version: number;
  };
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
  | "subscription.renewal_upcoming"
  | "mandate.collect";

/**
 * A durable job. Adapters store `runAt` in the payload as `at`: handlers decide at `max(now, at)`, so a job
 * the database runs a moment before the service clock reaches `runAt` (clock skew) still acts instead of
 * being skipped for ever.
 */
export interface JobRequest {
  readonly kind: JobKind;
  /** Must start with `<kind>:`; an existing job with the key wins. */
  readonly dedupeKey: string;
  /** On the clock of the job's subscription (real time when `clockOffset` is 0/absent). */
  readonly runAt: number;
  /**
   * The subscription's billing clock offset (§13): the job is stored to run at real time
   * `runAt − clockOffset`, with `at = runAt` (clock time) in the payload.
   */
  readonly clockOffset?: number | undefined;
  readonly payload: Readonly<Record<string, string | number | boolean>>;
}

/** Which pending jobs follow a subscription's billing clock (§13 d2). */
export const CLOCK_JOB_KINDS = [
  "subscription.renew",
  "subscription.renewal_upcoming",
  "invoice.remind",
  "invoice.overdue",
  "invoice.dunning_exhausted",
] as const satisfies readonly JobKind[];

export interface BillingTx {
  readonly products: ProductRepo;
  readonly prices: PriceRepo;
  readonly taxRates: TaxRateRepo;
  readonly invoices: InvoiceRepo;
  readonly subscriptions: SubscriptionRepo;
  readonly sequences: SequenceRepo;
  readonly mandates: MandateRepo;
  readonly mandateInvoices: InvoiceByMandateRepo;
  readonly vaultEvents: VaultEventLog;
  /** An ops case (§7.1); also logged as `ALERT`. */
  openCase(c: {
    readonly scope: Scope;
    readonly mandateId: string;
    readonly invoiceId: string | null;
    readonly kind: CaseKind;
    readonly detail: Readonly<Record<string, unknown>>;
  }): Promise<void>;
  recordTransition(t: Transition): Promise<void>;
  /** Outbox row in this transaction (kit `emit`). */
  emit(e: OutgoingEvent): Promise<void>;
  enqueue(j: JobRequest): Promise<void>;
  /**
   * §13 d4: every pending clock job (`CLOCK_JOB_KINDS`) of the subscription and of its open/uncollectible
   * invoices with `run_at > now` (unix seconds, real time) moves to `run_at − delta`: jobs due at the new
   * clock time become due at once and keep their relative order (`greatest(now, …)` would tie them).
   * Returns how many moved.
   */
  shiftClockJobs(scope: Scope, subscriptionId: string, delta: number, now: number): Promise<number>;
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
    /** Receiving address (the Intents account id for `intents_account`; Stage 4 mandates). */
    readonly address: string;
  }[];
  /** The agreed NearPay fee for vault collections (`intents_transfer` route class, ADR-0006, LLD §15 d2). */
  readonly vaultFeeBps: number;
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

// ---------------------------------------------------------------------------------------------
// The vault (NEAR JSON-RPC: mainnet RPC in live mode, the sandbox stand-in in test mode)
// ---------------------------------------------------------------------------------------------

export interface VaultConfigFacts {
  readonly allowedTokens: readonly string[];
  readonly maxFeeBps: number;
  readonly caps: ReadonlyMap<string, { readonly cap: bigint; readonly mandateCap: bigint }>;
}

/** A signed `collect` (hash known before broadcasting, so it is stored first). */
export interface SignedCollect {
  readonly txHash: string;
  readonly bytes: Uint8Array;
}

export type CollectTxResult =
  /** Final and successful: the outcome (collected / collect_failed) arrives as a forwarded event. */
  | { readonly kind: "success"; readonly txHash: string }
  /** Final and failed with a vault error (or another failure; `code` null). */
  | {
      readonly kind: "failure";
      readonly txHash: string;
      readonly code: VaultErrorCode | null;
      readonly message: string;
    }
  /** Not known to have executed (transport error, timeout, or `tx` does not know the hash yet). */
  | { readonly kind: "unknown"; readonly txHash: string; readonly error: string };

/** One vault per mode: `livemode` selects the mainnet vault or the sandbox stand-in (INV-8). */
export interface VaultPort {
  contract(livemode: boolean): string;
  /** Whether the keeper can sign for this mode (key configured). */
  keeperEnabled(livemode: boolean): boolean;
  config(livemode: boolean): Promise<VaultConfigFacts>;
  tokenTvl(livemode: boolean, token: string): Promise<{ readonly tvl: bigint; readonly cap: bigint } | null>;
  storageBalanceOf(
    livemode: boolean,
    account: string,
  ): Promise<{ readonly total: bigint; readonly available: bigint } | null>;
  /** `next_collect_at` view (ns; null unless active below `max_periods`). */
  nextCollectAt(livemode: boolean, onchainId: number): Promise<bigint | null>;
  /** `get_mandate` view (reconciliation only; the mirror follows events). */
  mandateView(livemode: boolean, onchainId: number): Promise<{ readonly status: string } | null>;
  /** Latest final block time (ns). */
  blockTimeNs(livemode: boolean): Promise<bigint>;
  /** Signs `collect({mandate_id})` with the keeper key (250 Tgas, no deposit). */
  signCollect(livemode: boolean, onchainId: number): Promise<SignedCollect>;
  /** Broadcasts and waits for the final outcome. */
  send(livemode: boolean, signed: SignedCollect): Promise<CollectTxResult>;
  /** Status of a sent transaction (after a transport error or a restart). */
  status(livemode: boolean, txHash: string): Promise<CollectTxResult>;
}

/** A simulated payer's transaction on the sandbox vault stand-in (test mode, §14 d12). */
export interface SimOutcome {
  readonly txHash: string;
  /** The panic message of a failed call (`ERR_…`), else null. */
  readonly failure: string | null;
  /** Every log line of receipts executed by the vault, in order. */
  readonly vaultLogs: readonly string[];
}

export interface SandboxVaultPort {
  ftTransferCall(o: {
    readonly payer: string;
    readonly token: string;
    readonly amount: bigint;
    readonly msg: string;
  }): Promise<SimOutcome>;
  call(o: {
    readonly signer: string;
    readonly method: "cancel" | "withdraw" | "storage_deposit";
    readonly args: Readonly<Record<string, unknown>>;
    readonly gas?: string | undefined;
    readonly deposit?: string | undefined;
  }): Promise<SimOutcome>;
  /** `secs` omitted: up to the mandate's `next_collect_at` (no-op when already due; sandbox §3.1). */
  advance(onchainId: number, secs?: number): Promise<void>;
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
  /** Public API origin (`invoice_pdf` = `<apiOrigin>/v1/invoices/<id>/pdf`). */
  readonly apiOrigin: string;
  /** Fiat pricing currencies payments accepts. */
  readonly pricingCurrencies: ReadonlySet<string>;
  /** Anonymous session creations per minute per client network and per invoice. */
  readonly publicSessionsPerClient: number;
  readonly publicSessionsPerInvoice: number;
  /** USD stablecoins paid at par, default first (USDC, USDT; §14 d2). */
  readonly vaultUsdTokens: readonly string[];
  /** The vault's allowed tokens as configured (checked without RPC at subscription create/update). */
  readonly vaultTokens: readonly string[];
  /** The vault's `max_fee_bps` (constructor value; linkage checks without RPC). */
  readonly vaultMaxFeeBps: number;
  /** The simulated NEAR payer of the test helpers (sandbox §4.1). */
  readonly simulatedPayer: string;
}

/** Everything a use case may touch. */
/** Keeper `collect` outcomes (§7.1) for `nearpay_billing_keeper_collect_total{outcome,livemode}`. */
export type KeeperCollectOutcome =
  | "collected"
  | "collect_failed"
  | "insufficient"
  | "in_flight"
  | "not_due"
  | "gas"
  | "other";

export interface BillingMetrics {
  keeperCollect(outcome: KeeperCollectOutcome, livemode: boolean): void;
}

export interface Billing {
  readonly store: BillingStore;
  /** Optional (tests, ops CLI): keeper outcome counters. */
  readonly metrics?: BillingMetrics;
  readonly payments: PaymentsPort;
  readonly merchant: MerchantPort;
  readonly assets: AssetsPort;
  readonly vault: VaultPort;
  readonly sandbox: SandboxVaultPort;
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

export type IdKind = "prod" | "price" | "txr" | "in" | "il" | "sub" | "si" | "md";
