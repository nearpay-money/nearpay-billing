/**
 * Invoice use cases (lld/billing.md §4–§7, §11): drafts (create/update/delete), finalize (number, due date,
 * invoice secret, hosted URL, reminders), send (event → notify mail), void (after payments expired the
 * session), mark uncollectible. Billing never marks an invoice paid itself (no "paid out of band", INV-2).
 */
import { createHash } from "node:crypto";
import { exhaustAt, scheduleOf } from "../domain/dunning/dunning.js";
import {
  assertDeletable,
  assertFinalizable,
  type DraftPatch,
  finalize,
  formatInvoiceNumber,
  type HostedSecrets,
  type Invoice,
  invoicePrefix,
  markSent,
  markUncollectible,
  newDraft,
  patchInvoice,
  voidInvoice,
} from "../domain/invoice/invoice.js";
import {
  type Catalog,
  type LineDraft,
  type LineInput,
  priceLines,
  resolveLines,
  toDraft,
} from "../domain/invoice/lines.js";
import {
  DomainError,
  distinct,
  type Metadata,
  missing,
  type Pricing,
  type Scope,
  stateConflict,
} from "../domain/shared.js";
import { clockOf } from "../domain/subscription/subscription.js";
import { assertPricingSupported } from "./catalog.js";
import { type Ctx, type Meta, saveInvoice } from "./commit.js";
import type { Billing, BillingTx, CustomerFacts, InvoiceListQuery, MerchantFacts, Page } from "./ports.js";

export const nowS = (b: Billing): number => Math.floor(b.now() / 1000);

/**
 * The billing clock of a subscription or of a subscription invoice: real time + the subscription's
 * test-mode offset (lld/billing.md §13). Every date and decision of a subscription and its invoices uses it;
 * manual invoices and live mode have offset 0. Event envelopes, sessions, rate counters stay on real time.
 */
export const clockS = (b: Billing, x: { readonly clockOffset?: number | undefined }): number => clockOf(x, nowS(b));

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

/** Prices, their products and tax rates referenced by lines/items, in one scope. */
export async function loadCatalog(
  tx: BillingTx,
  scope: Scope,
  o: { readonly priceIds: readonly string[]; readonly taxRateIds: readonly string[] },
): Promise<Catalog> {
  const prices = await tx.prices.getMany(scope, distinct(o.priceIds));
  const products = await tx.products.getMany(scope, distinct([...prices.values()].map((p) => p.productId)));
  const taxRates = await tx.taxRates.getMany(scope, distinct(o.taxRateIds));
  return { prices, products, taxRates };
}

const lineTaxIds = (lines: readonly LineInput[]): string[] => lines.flatMap((l) => l.taxRateIds ?? []);
const linePriceIds = (lines: readonly LineInput[]): string[] =>
  lines.flatMap((l) => ("priceId" in l ? [l.priceId] : []));

/** The customer exists in this scope (`resource_missing`) and is not deleted (`customer_deleted`). */
export async function liveCustomer(
  b: Billing,
  scope: Scope,
  customerId: string,
  param = "customer",
): Promise<CustomerFacts> {
  const c = await b.payments.getCustomer(scope, customerId);
  if (!c) throw missing("customer", customerId, param);
  if (c.deleted) throw new DomainError("customer_deleted", { customer: customerId }, param);
  return c;
}

/**
 * The account can take payments for this invoice now: live mode enabled when live (`account_not_live`), and
 * the chosen destination (or a default) active (`destination_not_active`). The destination minimum is
 * enforced by payments when the hosted page opens the session (`amount_below_destination_minimum`).
 */
export async function assertCanCollect(
  b: Billing,
  scope: Scope,
  o: { readonly pricing: Pricing; readonly settlementDestinationId: string | null },
): Promise<MerchantFacts> {
  const m = await b.merchant.context(scope);
  if (scope.livemode && !m.liveEnabled)
    throw new DomainError("account_not_live", { missing: m.liveMissing ?? "live mode" });
  if (o.settlementDestinationId !== null) {
    if (!m.destinations.some((d) => d.id === o.settlementDestinationId))
      throw new DomainError(
        "destination_not_active",
        { destination: o.settlementDestinationId },
        "settlement_destination",
      );
  } else {
    const def = (o.pricing.assetId ? m.defaults[o.pricing.assetId] : undefined) ?? m.defaults["*"];
    if (!def || !m.destinations.some((d) => d.id === def))
      throw new DomainError("destination_not_active", { destination: def ?? "default" });
  }
  await assertPricingSupported(b, o.pricing);
  return m;
}

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** 32 base62 characters, unbiased (rejection sampling over random bytes). */
export function base62(b: Billing, n = 32): string {
  let out = "";
  while (out.length < n) {
    for (const x of b.randomBytes(n * 2)) {
      if (x < 248 && out.length < n) out += BASE62[x % 62];
    }
  }
  return out;
}

export const secretHash = (secret: string): Buffer => createHash("sha256").update(secret, "utf8").digest();
const secretAad = (id: string) => `billing:invoice-secret:${id}`;
const billToAad = (id: string) => `billing:bill-to:${id}`;
export const clientSecretAad = (id: string): string => `billing:checkout-client-secret:${id}`;

/** Invoice secret `in_<26>_secret_<32 base62>` (spec `InvoiceSecret`), stored as hash + ciphertext (§11 d3). */
export function newHostedSecrets(
  b: Billing,
  invoiceId: string,
  customer: CustomerFacts,
): { secret: string; hosted: HostedSecrets } {
  const secret = `${invoiceId}_secret_${base62(b)}`;
  const billTo =
    customer.email || customer.name ? JSON.stringify({ name: customer.name, email: customer.email }) : null;
  return {
    secret,
    hosted: {
      secretHash: secretHash(secret),
      secretEnc: b.cipher.encrypt(secret, secretAad(invoiceId)),
      billToEnc: billTo ? b.cipher.encrypt(billTo, billToAad(invoiceId)) : null,
    },
  };
}

export function invoiceSecretOf(b: Billing, inv: Invoice): string | null {
  return inv.hosted ? b.cipher.decrypt(Buffer.from(inv.hosted.secretEnc), secretAad(inv.id)).toString("utf8") : null;
}

/** `<pay origin>/i/<in_…>#<invoice secret>` — PII-grade: never logged, never on the bus. */
export function hostedInvoiceUrl(b: Billing, inv: Invoice): string | null {
  const s = invoiceSecretOf(b, inv);
  return s ? `${b.settings.payOrigin}/i/${inv.id}#${s}` : null;
}

export function billToOf(b: Billing, inv: Invoice): { name: string | null; email: string | null } {
  if (!inv.hosted?.billToEnc) return { name: null, email: null };
  const v = JSON.parse(b.cipher.decrypt(Buffer.from(inv.hosted.billToEnc), billToAad(inv.id)).toString("utf8")) as {
    name: string | null;
    email: string | null;
  };
  return { name: v.name ?? null, email: v.email ?? null };
}

/** Reminder, overdue, exhaustion and PDF jobs of a freshly finalized invoice (deduped by key). */
export async function scheduleInvoiceJobs(tx: BillingTx, inv: Invoice): Promise<void> {
  const payload = { invoice: inv.id, account_id: inv.accountId, livemode: inv.livemode };
  const clockOffset = inv.clockOffset ?? 0;
  for (const r of scheduleOf(inv))
    await tx.enqueue({
      kind: "invoice.remind",
      dedupeKey: `invoice.remind:${inv.id}:r${r.number}`,
      runAt: r.at,
      clockOffset,
      payload: { ...payload, number: r.number },
    });
  if (inv.dueDate !== null)
    await tx.enqueue({
      kind: "invoice.overdue",
      dedupeKey: `invoice.overdue:${inv.id}`,
      runAt: inv.dueDate,
      clockOffset,
      payload,
    });
  const ex = exhaustAt(inv);
  if (inv.subscriptionId !== null && ex !== null)
    await tx.enqueue({
      kind: "invoice.dunning_exhausted",
      dedupeKey: `invoice.dunning_exhausted:${inv.id}`,
      runAt: ex,
      clockOffset,
      payload,
    });
  await renderPdfLater(tx, inv);
}

/** (Re-)render the PDF after a status change (§11 d11); one job per status. */
export async function renderPdfLater(tx: BillingTx, inv: Invoice): Promise<void> {
  if (inv.status === "draft") return;
  await tx.enqueue({
    kind: "invoice.render_pdf",
    dedupeKey: `invoice.render_pdf:${inv.id}:${inv.status}`,
    // `updated` is on the invoice's clock; rendering itself runs in real time (now)
    runAt: inv.updated,
    clockOffset: inv.clockOffset ?? 0,
    payload: { invoice: inv.id, account_id: inv.accountId, livemode: inv.livemode },
  });
}

/**
 * Finalizes a locked draft inside `tx`: reprices the lines (manual invoices need active prices and
 * rates; subscription invoices keep billing deactivated ones), allocates the number, creates the invoice
 * secret and bill-to snapshot, emits `invoice.finalized` and schedules dunning.
 */
export async function finalizeInTx(
  b: Billing,
  tx: BillingTx,
  cur: Invoice,
  o: { readonly merchant: MerchantFacts; readonly customer: CustomerFacts; readonly meta: Meta },
): Promise<Invoice> {
  const now = clockS(b, cur);
  assertFinalizable(cur, now);
  const manual = cur.subscriptionId === null;
  const drafts = cur.lines.map(toDraft);
  const catalog = await loadCatalog(tx, cur, {
    priceIds: drafts.flatMap((l) => (l.priceId ? [l.priceId] : [])),
    taxRateIds: [...cur.defaultTaxRateIds, ...drafts.flatMap((l) => l.taxRateIds)],
  });
  if (manual)
    for (const [i, l] of drafts.entries()) {
      if (!l.priceId) continue;
      const p = catalog.prices.get(l.priceId);
      const product = p ? catalog.products.get(p.productId) : undefined;
      if (!p?.active || !product?.active)
        throw new DomainError("price_inactive", { price: l.priceId }, `lines[${i}][price]`);
    }
  const priced = priceLines(drafts, cur.defaultTaxRateIds, {
    scope: cur,
    taxRates: catalog.taxRates,
    requireActive: manual,
  });
  const seq = await tx.sequences.next(cur, invoicePrefix(o.merchant.displayName, cur.livemode));
  const { hosted } = newHostedSecrets(b, cur.id, o.customer);
  const next = finalize(cur, {
    now,
    number: formatInvoiceNumber(seq.prefix, seq.number),
    hosted,
    merchantName: o.merchant.displayName,
    priced,
  });
  const saved = await saveInvoice(tx, cur, next, o.meta, ["evt.billing.invoice.finalized"]);
  await scheduleInvoiceJobs(tx, saved);
  return saved;
}

// ---------------------------------------------------------------------------------------------
// Merchant use cases
// ---------------------------------------------------------------------------------------------

export interface InvoiceCreateInput {
  readonly customerId: string;
  readonly currency?: string | undefined;
  readonly assetId?: string | undefined;
  readonly lines?: readonly LineInput[] | undefined;
  readonly defaultTaxRateIds?: readonly string[] | undefined;
  readonly description?: string | undefined;
  readonly footer?: string | undefined;
  readonly daysUntilDue?: number | undefined;
  readonly dueDate?: number | undefined;
  readonly reminderDays?: readonly number[] | undefined;
  readonly settlementDestinationId?: string | undefined;
  readonly metadata?: Metadata | undefined;
}

const pricingOf = (currency: string | undefined, assetId: string | null | undefined): Pricing | null =>
  currency === undefined ? null : { currency, assetId: currency === "asset" ? (assetId ?? null) : null };

export async function createInvoice(b: Billing, c: Ctx, input: InvoiceCreateInput): Promise<Invoice> {
  await liveCustomer(b, c.scope, input.customerId);
  const lines = input.lines ?? [];
  return b.store.transaction(async (tx) => {
    const catalog = await loadCatalog(tx, c.scope, {
      priceIds: linePriceIds(lines),
      taxRateIds: [...(input.defaultTaxRateIds ?? []), ...lineTaxIds(lines)],
    });
    const resolved = resolveLines(lines, {
      scope: c.scope,
      pricing: pricingOf(input.currency, input.assetId),
      catalog,
      newId: () => b.newId("il"),
    });
    if (!resolved.pricing) throw new DomainError("invalid_request", { detail: "currency is required" }, "currency");
    await assertPricingSupported(b, resolved.pricing);
    const priced = priceLines(resolved.lines, input.defaultTaxRateIds ?? [], {
      scope: c.scope,
      taxRates: catalog.taxRates,
      requireActive: true,
    });
    const inv = newDraft(c.scope, b.newId("in"), nowS(b), {
      ...resolved.pricing,
      customerId: input.customerId,
      lines: priced.lines,
      totals: priced.totals,
      defaultTaxRateIds: input.defaultTaxRateIds,
      description: input.description,
      footer: input.footer,
      daysUntilDue: input.daysUntilDue,
      dueDate: input.dueDate,
      reminderDays: input.reminderDays,
      settlementDestinationId: input.settlementDestinationId,
      metadata: input.metadata,
    });
    return saveInvoice(tx, null, inv, { actor: c.actor, cause: "created" }, ["evt.billing.invoice.created"]);
  });
}

export function getInvoice(b: Billing, c: Ctx, id: string): Promise<Invoice> {
  return b.store.transaction(
    async (tx) => (await tx.invoices.get(c.scope, id)) ?? Promise.reject(missing("invoice", id)),
  );
}

export function listInvoices(b: Billing, c: Ctx, q: InvoiceListQuery): Promise<Page<Invoice>> {
  return b.store.transaction((tx) => tx.invoices.list(c.scope, q));
}

export interface InvoiceUpdateInput {
  readonly customerId?: string | undefined;
  readonly currency?: string | undefined;
  readonly assetId?: string | null | undefined;
  readonly lines?: readonly LineInput[] | undefined;
  readonly defaultTaxRateIds?: readonly string[] | undefined;
  readonly description?: string | null | undefined;
  readonly footer?: string | null | undefined;
  readonly daysUntilDue?: number | undefined;
  readonly dueDate?: number | null | undefined;
  readonly reminderDays?: readonly number[] | undefined;
  readonly settlementDestinationId?: string | null | undefined;
  readonly metadata?: Metadata | undefined;
}

export async function updateInvoice(b: Billing, c: Ctx, id: string, input: InvoiceUpdateInput): Promise<Invoice> {
  if (input.customerId !== undefined) await liveCustomer(b, c.scope, input.customerId);
  return b.store.transaction(async (tx) => {
    const cur = await tx.invoices.get(c.scope, id, { lock: true });
    if (!cur) throw missing("invoice", id);
    const draftFields = Object.entries(input).some(([k, v]) => k !== "metadata" && v !== undefined);
    if (draftFields && cur.status !== "draft") throw stateConflict("invoice", cur.status);
    const patch: { -readonly [K in keyof DraftPatch]: DraftPatch[K] } = {
      customerId: input.customerId,
      defaultTaxRateIds: input.defaultTaxRateIds,
      description: input.description,
      footer: input.footer,
      daysUntilDue: input.daysUntilDue,
      dueDate: input.dueDate,
      reminderDays: input.reminderDays,
      settlementDestinationId: input.settlementDestinationId,
      metadata: input.metadata,
    };
    const wantPricing = pricingOf(input.currency, input.assetId);
    const pricingChanged =
      wantPricing !== null && (wantPricing.currency !== cur.currency || wantPricing.assetId !== cur.assetId);
    if (pricingChanged && input.lines === undefined && cur.lines.length > 0)
      throw new DomainError("invalid_request", { detail: "replace lines when changing the currency" }, "lines");
    if (input.lines !== undefined || pricingChanged || input.defaultTaxRateIds !== undefined) {
      const lineInputs = input.lines ?? [];
      const catalog = await loadCatalog(tx, c.scope, {
        priceIds: linePriceIds(lineInputs),
        taxRateIds: [
          ...(input.defaultTaxRateIds ?? cur.defaultTaxRateIds),
          ...lineTaxIds(lineInputs),
          ...cur.lines.flatMap((l) => (l.taxRatesExplicit ? l.taxRateIds : [])),
        ],
      });
      let pricing: Pricing = { currency: cur.currency, assetId: cur.assetId };
      let drafts: LineDraft[] = cur.lines.map(toDraft);
      if (input.lines !== undefined) {
        const r = resolveLines(lineInputs, {
          scope: c.scope,
          pricing: wantPricing,
          catalog,
          newId: () => b.newId("il"),
        });
        pricing = r.pricing ?? wantPricing ?? pricing;
        drafts = r.lines;
      } else if (wantPricing) pricing = wantPricing;
      await assertPricingSupported(b, pricing);
      patch.pricing = pricing;
      patch.priced = priceLines(drafts, input.defaultTaxRateIds ?? cur.defaultTaxRateIds, {
        scope: c.scope,
        taxRates: catalog.taxRates,
        requireActive: true,
      });
    }
    const next = patchInvoice(cur, patch, clockS(b, cur));
    return saveInvoice(tx, cur, next, { actor: c.actor, cause: "updated" });
  });
}

export function deleteInvoice(b: Billing, c: Ctx, id: string): Promise<{ id: string; livemode: boolean }> {
  return b.store.transaction(async (tx) => {
    const cur = await tx.invoices.get(c.scope, id, { lock: true });
    if (!cur) throw missing("invoice", id);
    assertDeletable(cur);
    await tx.invoices.delete(cur);
    await tx.recordTransition({
      aggregate: "invoice",
      id,
      from: "draft",
      to: "deleted",
      cause: "deleted",
      actor: c.actor,
    });
    return { id, livemode: cur.livemode };
  });
}

export async function finalizeInvoice(b: Billing, c: Ctx, id: string): Promise<Invoice> {
  const before = await getInvoice(b, c, id);
  if (before.status !== "draft") throw stateConflict("invoice", before.status);
  const customer = await liveCustomer(b, c.scope, before.customerId);
  const merchant = await assertCanCollect(b, c.scope, {
    pricing: { currency: before.currency, assetId: before.assetId },
    settlementDestinationId: before.settlementDestinationId,
  });
  return b.store.transaction(async (tx) => {
    const cur = await tx.invoices.get(c.scope, id, { lock: true });
    if (!cur) throw missing("invoice", id);
    if (
      cur.customerId !== before.customerId ||
      cur.settlementDestinationId !== before.settlementDestinationId ||
      cur.currency !== before.currency ||
      cur.assetId !== before.assetId
    )
      throw new DomainError("state_conflict", { object: "invoice", state: "changed during finalize" });
    return finalizeInTx(b, tx, cur, { merchant, customer, meta: { actor: c.actor, cause: "finalized" } });
  });
}

export async function sendInvoice(b: Billing, c: Ctx, id: string): Promise<Invoice> {
  const before = await getInvoice(b, c, id);
  if (before.status !== "open" && before.status !== "uncollectible") throw stateConflict("invoice", before.status);
  const customer = await liveCustomer(b, c.scope, before.customerId);
  if (!customer.email) throw new DomainError("customer_email_missing", { customer: customer.id });
  return b.store.transaction(async (tx) => {
    const cur = await tx.invoices.get(c.scope, id, { lock: true });
    if (!cur) throw missing("invoice", id);
    return saveInvoice(tx, cur, markSent(cur, clockS(b, cur)), { actor: c.actor, cause: "sent" }, [
      "evt.billing.invoice.sent",
    ]);
  });
}

/**
 * Void: expire the open session through payments first (`attempt_in_flight` while money may move), then
 * `open → void` — refused if a new session appeared meanwhile.
 */
export async function voidInvoiceUseCase(b: Billing, c: Ctx, id: string): Promise<Invoice> {
  const before = await getInvoice(b, c, id);
  if (before.status !== "open") throw stateConflict("invoice", before.status);
  let mayStillSettle = false;
  if (before.session) {
    const s = await b.payments.expireSession(before.session.id, "invoice_voided");
    mayStillSettle = s.status !== "expired";
  }
  return b.store.transaction(async (tx) => {
    const cur = await tx.invoices.get(c.scope, id, { lock: true });
    if (!cur) throw missing("invoice", id);
    if ((cur.session?.id ?? null) !== (before.session?.id ?? null)) throw new DomainError("attempt_in_flight");
    const next = voidInvoice(cur, clockS(b, cur), mayStillSettle);
    const saved = await saveInvoice(tx, cur, next, { actor: c.actor, cause: "voided" }, ["evt.billing.invoice.voided"]);
    await renderPdfLater(tx, saved);
    return saved;
  });
}

export function markInvoiceUncollectible(b: Billing, c: Ctx, id: string): Promise<Invoice> {
  return b.store.transaction(async (tx) => {
    const cur = await tx.invoices.get(c.scope, id, { lock: true });
    if (!cur) throw missing("invoice", id);
    const next = markUncollectible(cur, clockS(b, cur), "merchant");
    const saved = await saveInvoice(tx, cur, next, { actor: c.actor, cause: "marked uncollectible" }, [
      "evt.billing.invoice.marked_uncollectible",
    ]);
    await renderPdfLater(tx, saved);
    return saved;
  });
}
