/**
 * Invoice aggregate (domain-model §4.5, lld/billing.md §4, §11). Lifecycle
 * `draft → open → paid | void | uncollectible`, `uncollectible → paid` (late payment, INV-3); `paid` and
 * `void` are final; drafts may be deleted. There is no "paid out of band": `paid` only follows a succeeded
 * payment intent of payments (INV-2, `./payment.ts`). Pure.
 */
import { DEFAULT_REMINDER_DAYS } from "@nearpay/spec";
import { DAY, DomainError, type Metadata, mergeMetadata, type Pricing, type Scope, stateConflict } from "../shared.js";
import { type InvoiceLine, type Period, type Totals, totalsOf } from "./lines.js";

export type InvoiceStatus = "draft" | "open" | "paid" | "void" | "uncollectible";
export type BillingReason = "manual" | "subscription_create" | "subscription_cycle";
export type UncollectibleReason = "merchant" | "dunning_exhausted";

export const INVOICE_TRANSITIONS: Readonly<Record<InvoiceStatus, readonly InvoiceStatus[]>> = {
  draft: ["open"],
  open: ["paid", "void", "uncollectible"],
  uncollectible: ["paid"],
  paid: [],
  void: [],
};

export const canTransition = (from: InvoiceStatus, to: InvoiceStatus): boolean =>
  INVOICE_TRANSITIONS[from].includes(to);

/** Days after finalize until due when neither `days_until_due` nor `due_date` is given (manual invoices). */
export const DEFAULT_DAYS_UNTIL_DUE = 30;
/** `send` is limited to one mail per invoice per 10 minutes (§11 d5). */
export const SEND_INTERVAL_SECONDS = 600;
export const MAX_REMINDERS = 10;

/** Hosted-invoice secrets (§11 d3): opaque bytes produced by the app layer (hash + envelope ciphertexts). */
export interface HostedSecrets {
  readonly secretHash: Uint8Array;
  readonly secretEnc: Uint8Array;
  /** `{name, email}` of the customer at finalize, envelope-encrypted (§11 d6). */
  readonly billToEnc: Uint8Array | null;
}

/** The payments checkout session currently paying the invoice (§11 d3–d4). */
export interface OpenSession {
  readonly id: string;
  readonly expiresAt: number;
  readonly clientSecretEnc: Uint8Array;
}

export interface Invoice extends Scope, Pricing, Totals {
  readonly id: string;
  readonly customerId: string;
  readonly subscriptionId: string | null;
  readonly billingReason: BillingReason;
  readonly number: string | null;
  readonly status: InvoiceStatus;
  readonly description: string | null;
  readonly footer: string | null;
  readonly defaultTaxRateIds: readonly string[];
  readonly lines: readonly InvoiceLine[];
  readonly amountPaid: bigint;
  readonly daysUntilDue: number | null;
  readonly dueDate: number | null;
  readonly period: Period | null;
  readonly settlementDestinationId: string | null;
  readonly reminderDays: readonly number[];
  readonly remindersSent: number;
  readonly overdueAt: number | null;
  readonly merchantName: string | null;
  readonly hosted: HostedSecrets | null;
  readonly session: OpenSession | null;
  /** Sessions created so far (`n` of the `in:<invoice>:s<n>` idempotency key). */
  readonly sessionsCreated: number;
  readonly paymentIntentId: string | null;
  /** Every intent seen for the invoice, newest first (late settlements stay listed, §11 d10). */
  readonly paymentIntentIds: readonly string[];
  readonly pdfObjectKey: string | null;
  /**
   * Fingerprint of the settlement destination the paying intent settled to (payments' destination
   * snapshot), recorded when the invoice is paid; null/absent while unknown (spec 0.3.1).
   */
  readonly destinationFingerprint?: string | null | undefined;
  /**
   * Billing clock offset (seconds) of the invoice's subscription — read-only, 0/absent for manual
   * invoices and live mode. Every date of a subscription invoice is on that clock (lld/billing.md §13).
   */
  readonly clockOffset?: number | undefined;
  readonly uncollectibleReason: UncollectibleReason | null;
  readonly finalizedAt: number | null;
  readonly sentAt: number | null;
  readonly paidAt: number | null;
  readonly voidedAt: number | null;
  readonly markedUncollectibleAt: number | null;
  readonly metadata: Metadata;
  readonly created: number;
  readonly updated: number;
  /** Optimistic version; also the public `sequence`. */
  readonly version: number;
}

/** `reminder_days`: ≤ 10, strictly increasing, each −30…+60 (spec `ReminderDays`). */
export function checkReminderDays(days: readonly number[], param = "reminder_days"): readonly number[] {
  const ok =
    days.length <= MAX_REMINDERS &&
    days.every((d, i) => Number.isInteger(d) && d >= -30 && d <= 60 && (i === 0 || d > (days[i - 1] as number)));
  if (!ok)
    throw new DomainError(
      "invalid_request",
      { detail: "reminder_days must be strictly increasing, at most 10, each between -30 and 60" },
      param,
    );
  return days;
}

export interface DraftInput extends Pricing {
  readonly customerId: string;
  readonly subscriptionId?: string | null | undefined;
  readonly billingReason?: BillingReason | undefined;
  readonly lines: readonly InvoiceLine[];
  readonly totals: Totals;
  readonly defaultTaxRateIds?: readonly string[] | undefined;
  readonly description?: string | null | undefined;
  readonly footer?: string | null | undefined;
  readonly daysUntilDue?: number | undefined;
  readonly dueDate?: number | undefined;
  readonly period?: Period | null | undefined;
  readonly reminderDays?: readonly number[] | undefined;
  readonly settlementDestinationId?: string | null | undefined;
  readonly metadata?: Metadata | undefined;
  /** The subscription's billing clock offset (subscription invoices only, lld/billing.md §13). */
  readonly clockOffset?: number | undefined;
}

export function newDraft(scope: Scope, id: string, now: number, input: DraftInput): Invoice {
  if (input.daysUntilDue !== undefined && input.dueDate !== undefined)
    throw new DomainError("invalid_request", { detail: "give days_until_due or due_date, not both" }, "due_date");
  const reminderDays = checkReminderDays(input.reminderDays ?? DEFAULT_REMINDER_DAYS);
  return {
    ...scope,
    ...totalsOf(input.totals),
    id,
    customerId: input.customerId,
    subscriptionId: input.subscriptionId ?? null,
    billingReason: input.billingReason ?? "manual",
    number: null,
    status: "draft",
    currency: input.currency,
    assetId: input.assetId,
    description: input.description ?? null,
    footer: input.footer ?? null,
    defaultTaxRateIds: input.defaultTaxRateIds ?? [],
    lines: input.lines,
    amountPaid: 0n,
    daysUntilDue: input.dueDate !== undefined ? null : (input.daysUntilDue ?? DEFAULT_DAYS_UNTIL_DUE),
    dueDate: input.dueDate ?? null,
    period: input.period ?? null,
    settlementDestinationId: input.settlementDestinationId ?? null,
    reminderDays,
    remindersSent: 0,
    overdueAt: null,
    merchantName: null,
    hosted: null,
    session: null,
    sessionsCreated: 0,
    paymentIntentId: null,
    paymentIntentIds: [],
    pdfObjectKey: null,
    destinationFingerprint: null,
    clockOffset: input.clockOffset ?? 0,
    uncollectibleReason: null,
    finalizedAt: null,
    sentAt: null,
    paidAt: null,
    voidedAt: null,
    markedUncollectibleAt: null,
    metadata: input.metadata ?? {},
    created: now,
    updated: now,
    version: 0,
  };
}

/** Fields of `updateInvoice`; everything except `metadata` needs a draft. Lines arrive already priced. */
export interface DraftPatch {
  readonly customerId?: string | undefined;
  readonly pricing?: Pricing | undefined;
  readonly priced?: { readonly lines: readonly InvoiceLine[]; readonly totals: Totals } | undefined;
  readonly defaultTaxRateIds?: readonly string[] | undefined;
  readonly description?: string | null | undefined;
  readonly footer?: string | null | undefined;
  readonly daysUntilDue?: number | undefined;
  readonly dueDate?: number | null | undefined;
  readonly reminderDays?: readonly number[] | undefined;
  readonly settlementDestinationId?: string | null | undefined;
  readonly metadata?: Metadata | undefined;
}

export function patchInvoice(cur: Invoice, patch: DraftPatch, now: number): Invoice {
  const draftOnly = Object.entries(patch).some(([k, v]) => k !== "metadata" && v !== undefined);
  if (draftOnly && cur.status !== "draft") throw stateConflict("invoice", cur.status);
  if (patch.daysUntilDue !== undefined && patch.dueDate !== undefined && patch.dueDate !== null)
    throw new DomainError("invalid_request", { detail: "give days_until_due or due_date, not both" }, "due_date");
  let due: Pick<Invoice, "daysUntilDue" | "dueDate"> = { daysUntilDue: cur.daysUntilDue, dueDate: cur.dueDate };
  if (patch.dueDate !== undefined && patch.dueDate !== null) due = { daysUntilDue: null, dueDate: patch.dueDate };
  else if (patch.daysUntilDue !== undefined) due = { daysUntilDue: patch.daysUntilDue, dueDate: null };
  else if (patch.dueDate === null) due = { daysUntilDue: cur.daysUntilDue ?? DEFAULT_DAYS_UNTIL_DUE, dueDate: null };
  return {
    ...cur,
    ...(patch.customerId !== undefined ? { customerId: patch.customerId } : {}),
    ...(patch.pricing !== undefined ? { currency: patch.pricing.currency, assetId: patch.pricing.assetId } : {}),
    ...(patch.priced !== undefined ? { lines: patch.priced.lines, ...totalsOf(patch.priced.totals) } : {}),
    ...(patch.defaultTaxRateIds !== undefined ? { defaultTaxRateIds: patch.defaultTaxRateIds } : {}),
    ...(patch.description !== undefined ? { description: patch.description } : {}),
    ...(patch.footer !== undefined ? { footer: patch.footer } : {}),
    ...(patch.reminderDays !== undefined ? { reminderDays: checkReminderDays(patch.reminderDays) } : {}),
    ...(patch.settlementDestinationId !== undefined ? { settlementDestinationId: patch.settlementDestinationId } : {}),
    ...due,
    metadata: mergeMetadata(cur.metadata, patch.metadata),
    updated: now,
  };
}

export function assertDeletable(inv: Invoice): void {
  if (inv.status !== "draft") throw stateConflict("invoice", inv.status);
}

/** Moves along an allowed edge; anything else is `state_conflict` (never a silent overwrite). */
function moveTo(inv: Invoice, to: InvoiceStatus, now: number): Invoice {
  if (!canTransition(inv.status, to)) throw stateConflict("invoice", inv.status);
  return { ...inv, status: to, updated: now };
}

/** Finalize guards that do not need I/O: ≥ 1 line and `total > 0` (`invoice_empty`), a future fixed due date. */
export function assertFinalizable(inv: Invoice, now: number): void {
  if (inv.status !== "draft") throw stateConflict("invoice", inv.status);
  if (inv.lines.length === 0 || inv.total <= 0n) throw new DomainError("invoice_empty", { invoice: inv.id });
  if (inv.dueDate !== null && inv.dueDate <= now)
    throw new DomainError("invalid_request", { detail: "due_date must be in the future at finalize" }, "due_date");
}

/**
 * `draft → open`: number, due date (fixed, or now + `days_until_due`), hosted secrets and the merchant name
 * snapshot. The priced lines passed in must have been recomputed with active rates/prices just before.
 */
export function finalize(
  inv: Invoice,
  o: {
    readonly now: number;
    readonly number: string;
    readonly hosted: HostedSecrets;
    readonly merchantName: string;
    readonly priced: { readonly lines: readonly InvoiceLine[]; readonly totals: Totals };
  },
): Invoice {
  const repriced = { ...inv, lines: o.priced.lines, ...totalsOf(o.priced.totals) };
  assertFinalizable(repriced, o.now);
  return {
    ...moveTo(repriced, "open", o.now),
    number: o.number,
    dueDate: inv.dueDate ?? o.now + (inv.daysUntilDue ?? DEFAULT_DAYS_UNTIL_DUE) * DAY,
    hosted: o.hosted,
    merchantName: o.merchantName,
    finalizedAt: o.now,
  };
}

/** `open | uncollectible`: records `sent_at`; a repeat within 10 minutes is `rate_limited`. */
export function markSent(inv: Invoice, now: number): Invoice {
  if (inv.status !== "open" && inv.status !== "uncollectible") throw stateConflict("invoice", inv.status);
  if (inv.sentAt !== null && now - inv.sentAt < SEND_INTERVAL_SECONDS) {
    const retry = SEND_INTERVAL_SECONDS - (now - inv.sentAt);
    throw new DomainError("rate_limited", { retry_after: retry });
  }
  return { ...inv, sentAt: now, updated: now };
}

/**
 * `open → void`. `sessionMaySettle` is the app's finding after expiring the session through payments: a
 * session that could still settle refuses the void with `attempt_in_flight` (§11 d10).
 */
export function voidInvoice(inv: Invoice, now: number, sessionMaySettle: boolean): Invoice {
  if (inv.status !== "open") throw stateConflict("invoice", inv.status);
  if (sessionMaySettle) throw new DomainError("attempt_in_flight");
  return { ...moveTo(inv, "void", now), voidedAt: now, session: null };
}

/** `open → uncollectible` by the merchant or by exhausted dunning; the invoice stays payable (INV-3). */
export function markUncollectible(inv: Invoice, now: number, reason: UncollectibleReason): Invoice {
  if (inv.status !== "open") throw stateConflict("invoice", inv.status);
  return { ...moveTo(inv, "uncollectible", now), markedUncollectibleAt: now, uncollectibleReason: reason };
}

/** Payable on the hosted page: `open` or `uncollectible`. */
export const isPayable = (inv: Invoice): boolean => inv.status === "open" || inv.status === "uncollectible";

export const amountRemaining = (inv: Invoice): bigint => inv.total - inv.amountPaid;

/** `open | uncollectible → paid` after a succeeded intent of payments (only `./payment.ts` calls it). */
export function markPaid(
  inv: Invoice,
  now: number,
  intentId: string,
  destinationFingerprint: string | null = null,
): Invoice {
  return {
    ...moveTo(inv, "paid", now),
    paymentIntentId: intentId,
    destinationFingerprint,
    paidAt: now,
    amountPaid: inv.total,
    session: null,
  };
}

/** Records an intent of the invoice, newest first, once. */
export function recordIntent(inv: Invoice, intentId: string): Invoice {
  if (inv.paymentIntentIds.includes(intentId)) return inv;
  return { ...inv, paymentIntentIds: [intentId, ...inv.paymentIntentIds] };
}

// ---------------------------------------------------------------------------------------------
// Numbering (lld/billing.md §3)
// ---------------------------------------------------------------------------------------------

/** Prefix: the first 6 letters/digits of the account display name, upper-cased (`INV` if none), + `L`/`T`. */
export function invoicePrefix(displayName: string, livemode: boolean): string {
  const slug = displayName
    .normalize("NFKD")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, 6);
  return `${slug || "INV"}${livemode ? "L" : "T"}`;
}

/** `<prefix>-<5+ digits>` (`ACME01T-00042`). */
export function formatInvoiceNumber(prefix: string, n: number): string {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`invalid invoice number ${n}`);
  return `${prefix}-${String(n).padStart(5, "0")}`;
}
