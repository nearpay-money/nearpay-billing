/**
 * Domain → spec objects (`@nearpay/spec` 0.3.0 `billing-catalog.ts`, `invoices.ts`, `subscriptions.ts`;
 * internal `billing.ts`; events). Amounts: fiat as JSON integers (minor units), asset as base-unit
 * strings. The hosted invoice URL (it embeds the invoice secret) appears only on merchant reads and in the
 * notification context — never in events.
 */
import type {
  Invoice as InvoiceObj,
  InvoicePaymentSession,
  MandateCancelInstructions,
  MandateFundingInstructions,
  Mandate as MandateObj,
  MandateSimulation,
  NearTransactionRequest,
  Price as PriceObj,
  Product as ProductObj,
  PublicInvoice,
  PublicMandate,
  SubscriptionClockAdvance,
  Subscription as SubscriptionObj,
  TaxRate as TaxRateObj,
  z,
} from "@nearpay/spec";
import { encodeUuid } from "@nearpay-internal/ids";
import { fiatToJson, toBaseUnits } from "@nearpay-internal/money";
import type {
  InvoiceNotificationContext,
  InvoiceReminderEvent,
  MandateNotificationContext,
  SubscriptionNotificationContext,
} from "@nearpay-internal/spec";
import type { InvoicePaymentSessionData, PublicInvoiceData } from "../app/hosted.js";
import type { FundingData, PublicMandateData, SimulationData } from "../app/mandates.js";
import type {
  InvoiceNotificationData,
  MandateNotificationData,
  SubscriptionNotificationData,
} from "../app/notification.js";
import type { AssetFacts, EventObject } from "../app/ports.js";
import type { ClockAdvance } from "../app/subscriptions.js";
import type { Reminder } from "../domain/dunning/dunning.js";
import { nextReminder } from "../domain/dunning/dunning.js";
import type { Invoice } from "../domain/invoice/invoice.js";
import type { TaxAmount } from "../domain/invoice/lines.js";
import type { NearTx } from "../domain/mandate/funding.js";
import {
  canceledByRole,
  fundedPeriods,
  type Mandate,
  nextCollectAt,
  onchainActive,
} from "../domain/mandate/mandate.js";
import { tokenAssetId } from "../domain/mandate/terms.js";
import type { Price } from "../domain/price/price.js";
import type { Product } from "../domain/product/product.js";
import type { Pricing } from "../domain/shared.js";
import type { Subscription } from "../domain/subscription/subscription.js";
import { ppmToPercentage, type TaxRate } from "../domain/tax-rate/tax-rate.js";

type PublicInvoiceObj = z.infer<typeof PublicInvoice>;
type InvoicePaymentSessionObj = z.infer<typeof InvoicePaymentSession>;
type Id<P extends string> = `${P}_${string}`;
const pid = <P extends string>(s: string): Id<P> => s as Id<P>;
const opt = <P extends string>(s: string | null): Id<P> | null => (s === null ? null : pid<P>(s));
type AssetIdT = NonNullable<PriceObj["asset_id"]>;
const asset = (s: string | null): AssetIdT | null => s as AssetIdT | null;
const iso = (unix: number): string => new Date(unix * 1000).toISOString();
const optIso = (unix: number | null): string | null => (unix === null ? null : iso(unix));

/** A pricing amount: fiat → integer minor units (JSON number), asset → base-unit string. */
export function amount(p: Pricing, v: bigint): number | string {
  return p.currency === "asset" ? toBaseUnits(v) : fiatToJson(v);
}

export const accountId = (uuid: string): Id<"acct"> => pid<"acct">(`acct_${encodeUuid(uuid)}`);

export function productView(p: Product): ProductObj {
  return {
    id: pid<"prod">(p.id),
    object: "product",
    created: p.created,
    updated: p.updated,
    livemode: p.livemode,
    name: p.name,
    description: p.description,
    active: p.active,
    metadata: { ...p.metadata },
  };
}

export function priceView(p: Price): PriceObj {
  return {
    id: pid<"price">(p.id),
    object: "price",
    created: p.created,
    livemode: p.livemode,
    product: pid<"prod">(p.productId),
    active: p.active,
    type: p.type,
    unit_amount: amount(p, p.unitAmount),
    currency: p.currency as PriceObj["currency"],
    asset_id: asset(p.assetId),
    recurring: p.recurring ? { interval: p.recurring.interval, interval_count: p.recurring.intervalCount } : null,
    nickname: p.nickname,
    metadata: { ...p.metadata },
  };
}

export function taxRateView(t: TaxRate): TaxRateObj {
  return {
    id: pid<"txr">(t.id),
    object: "tax_rate",
    created: t.created,
    livemode: t.livemode,
    display_name: t.displayName,
    description: t.description,
    jurisdiction: t.jurisdiction,
    country: t.country as TaxRateObj["country"],
    percentage: ppmToPercentage(t.ratePpm),
    rate_ppm: t.ratePpm,
    inclusive: t.inclusive,
    active: t.active,
    metadata: { ...t.metadata },
  };
}

const taxView = (p: Pricing, t: TaxAmount): InvoiceObj["total_tax_amounts"][number] => ({
  tax_rate: pid<"txr">(t.taxRateId),
  display_name: t.displayName,
  percentage: t.percentage,
  inclusive: t.inclusive,
  amount: amount(p, t.amount),
  taxable_amount: amount(p, t.taxableAmount),
});

export interface InvoiceViewOptions {
  /** `<payOrigin>/i/<id>#<secret>` (null on the bus). */
  readonly hostedInvoiceUrl: string | null;
  readonly apiOrigin: string;
}

export function invoiceView(inv: Invoice, o: InvoiceViewOptions): InvoiceObj {
  const next = nextReminder(inv);
  return {
    id: pid<"in">(inv.id),
    object: "invoice",
    created: inv.created,
    livemode: inv.livemode,
    status: inv.status,
    number: inv.number,
    customer: pid<"cus">(inv.customerId),
    subscription: opt<"sub">(inv.subscriptionId),
    billing_reason: inv.billingReason,
    collection_method: "send_invoice",
    currency: inv.currency as InvoiceObj["currency"],
    asset_id: asset(inv.assetId),
    description: inv.description,
    footer: inv.footer,
    lines: inv.lines.map((l) => ({
      id: pid<"il">(l.id),
      object: "line_item",
      type: l.type,
      price: opt<"price">(l.priceId),
      product: opt<"prod">(l.productId),
      subscription_item: opt<"si">(l.subscriptionItemId),
      description: l.description,
      quantity: l.quantity,
      unit_amount: amount(inv, l.unitAmount),
      amount: amount(inv, l.amount),
      amount_excluding_tax: amount(inv, l.amountExcludingTax),
      tax_rates: l.taxRateIds.map((t) => pid<"txr">(t)),
      tax_amounts: l.taxAmounts.map((t) => taxView(inv, t)),
      period: l.period ? { start: l.period.start, end: l.period.end } : null,
    })),
    default_tax_rates: inv.defaultTaxRateIds.map((t) => pid<"txr">(t)),
    subtotal: amount(inv, inv.subtotal),
    tax: amount(inv, inv.tax),
    total: amount(inv, inv.total),
    total_excluding_tax: amount(inv, inv.totalExcludingTax),
    total_tax_amounts: inv.totalTaxAmounts.map((t) => taxView(inv, t)),
    amount_due: amount(inv, inv.total),
    amount_paid: amount(inv, inv.amountPaid),
    amount_remaining: amount(inv, inv.total - inv.amountPaid),
    days_until_due: inv.daysUntilDue,
    due_date: inv.dueDate,
    period_start: inv.period?.start ?? null,
    period_end: inv.period?.end ?? null,
    settlement_destination: opt<"sd">(inv.settlementDestinationId),
    reminder_days: [...inv.reminderDays],
    reminders_sent: inv.remindersSent,
    next_reminder_at: next?.at ?? null,
    hosted_invoice_url: o.hostedInvoiceUrl,
    invoice_pdf: inv.status === "draft" ? null : `${o.apiOrigin}/v1/invoices/${inv.id}/pdf`,
    checkout_session: inv.session ? pid<"cs">(inv.session.id) : null,
    payment_intent: opt<"pi">(inv.paymentIntentId),
    payment_intents: inv.paymentIntentIds.map((p) => pid<"pi">(p)),
    status_transitions: {
      finalized_at: inv.finalizedAt,
      sent_at: inv.sentAt,
      paid_at: inv.paidAt,
      voided_at: inv.voidedAt,
      marked_uncollectible_at: inv.markedUncollectibleAt,
    },
    uncollectible_reason: inv.uncollectibleReason,
    metadata: { ...inv.metadata },
    sequence: inv.version,
    // stage 4 (spec 0.4.0 optional fields; the 0.3.1 type does not know them yet)
    ...({
      collection_method: inv.collectionMethod,
      mandate: inv.mandateId,
      mandate_collection: inv.mandateCollection
        ? {
            mandate: inv.mandateCollection.mandateId,
            period: inv.mandateCollection.period,
            token: inv.mandateCollection.assetId,
            merchant_share: inv.mandateCollection.merchantShare.toString(),
            fee: inv.mandateCollection.fee.toString(),
            tx_hash: inv.mandateCollection.txHash,
            receipt_id: inv.mandateCollection.receiptId,
          }
        : null,
    } as object),
  };
}

export function subscriptionView(s: Subscription, prices: ReadonlyMap<string, Price>): SubscriptionObj {
  return {
    id: pid<"sub">(s.id),
    object: "subscription",
    created: s.created,
    livemode: s.livemode,
    customer: pid<"cus">(s.customerId),
    status: s.status,
    collection_method: "send_invoice",
    items: s.items.map((it) => {
      const p = prices.get(it.priceId);
      if (!p) throw new Error(`price ${it.priceId} of ${s.id} not loaded`);
      return {
        id: pid<"si">(it.id),
        object: "subscription_item",
        price: priceView(p),
        quantity: it.quantity,
        tax_rates: it.taxRateIds === null ? null : it.taxRateIds.map((t) => pid<"txr">(t)),
      };
    }),
    currency: s.currency as SubscriptionObj["currency"],
    asset_id: asset(s.assetId),
    recurring: { interval: s.recurring.interval, interval_count: s.recurring.intervalCount },
    billing_cycle_anchor: s.anchor,
    current_period_start: s.currentPeriodStart,
    current_period_end: s.currentPeriodEnd,
    days_until_due: s.daysUntilDue,
    default_tax_rates: s.defaultTaxRateIds.map((t) => pid<"txr">(t)),
    dunning: { reminder_days: [...s.dunning.reminderDays], on_exhausted: s.dunning.onExhausted },
    trial_start: s.trialStart,
    trial_end: s.trialEnd,
    cancel_at_period_end: s.cancelAtPeriodEnd,
    canceled_at: s.canceledAt,
    ended_at: s.endedAt,
    cancellation_reason: s.cancellationReason,
    latest_invoice: opt<"in">(s.latestInvoiceId),
    settlement_destination: opt<"sd">(s.settlementDestinationId),
    description: s.description,
    metadata: { ...s.metadata },
    sequence: s.version,
    // stage 4 (spec 0.4.0)
    ...({ collection_method: s.collectionMethod, mandate: s.mandateId } as object),
  };
}

export function reminderEvent(inv: Invoice, r: Reminder): z.infer<typeof InvoiceReminderEvent> {
  return {
    invoice: pid<"in">(inv.id),
    customer: pid<"cus">(inv.customerId),
    subscription: opt<"sub">(inv.subscriptionId),
    number: r.number,
    offset_days: r.offsetDays,
    due_date: iso(inv.dueDate as number),
    last: r.last,
  };
}

/** The outbox renderer: events never carry the hosted URL (secrets stay off the bus). */
export function eventRenderer(apiOrigin: string): (o: EventObject) => Record<string, unknown> {
  return (o) => {
    if (o.kind === "subscription") return subscriptionView(o.subscription, o.prices);
    if (o.kind === "invoice_reminder") return reminderEvent(o.invoice, o.reminder);
    if (o.kind === "mandate") return mandateView(o.mandate);
    return invoiceView(o.invoice, { hostedInvoiceUrl: null, apiOrigin });
  };
}

const publicTax = (p: Pricing, t: TaxAmount): PublicInvoiceObj["total_tax_amounts"][number] => ({
  display_name: t.displayName,
  jurisdiction: t.jurisdiction,
  percentage: t.percentage,
  inclusive: t.inclusive,
  amount: amount(p, t.amount),
});

export function publicInvoiceView(d: PublicInvoiceData): PublicInvoiceObj {
  const inv = d.invoice;
  return {
    id: pid<"in">(inv.id),
    object: "invoice",
    livemode: inv.livemode,
    status: inv.status,
    number: inv.number ?? "",
    payable: d.payable,
    currency: inv.currency as PublicInvoiceObj["currency"],
    asset_id: asset(inv.assetId),
    pricing_asset: d.pricingAsset
      ? {
          asset_id: d.pricingAsset.assetId as AssetIdT,
          symbol: d.pricingAsset.symbol,
          decimals: d.pricingAsset.decimals,
        }
      : null,
    display: { merchant_name_unverified: d.merchantName, description: inv.description, footer: inv.footer },
    bill_to: { name: d.billTo.name, email: d.billTo.email },
    lines: inv.lines.map((l) => ({
      description: l.description,
      quantity: l.quantity,
      unit_amount: amount(inv, l.unitAmount),
      amount: amount(inv, l.amount),
      period: l.period ? { start: iso(l.period.start), end: iso(l.period.end) } : null,
      tax_amounts: l.taxAmounts.map((t) => publicTax(inv, t)),
    })),
    subtotal: amount(inv, inv.subtotal),
    tax: amount(inv, inv.tax),
    total: amount(inv, inv.total),
    total_excluding_tax: amount(inv, inv.totalExcludingTax),
    total_tax_amounts: inv.totalTaxAmounts.map((t) => publicTax(inv, t)),
    amount_due: amount(inv, inv.total),
    amount_paid: amount(inv, inv.amountPaid),
    amount_remaining: amount(inv, inv.total - inv.amountPaid),
    issued_at: iso(inv.finalizedAt as number),
    due_date: optIso(inv.dueDate),
    paid_at: optIso(inv.paidAt),
    voided_at: optIso(inv.voidedAt),
    period_start: optIso(inv.period?.start ?? null),
    period_end: optIso(inv.period?.end ?? null),
    settlement: d.settlement
      ? {
          asset_id: d.settlement.assetId as AssetIdT,
          chain: d.settlement.chain as NonNullable<PublicInvoiceObj["settlement"]>["chain"],
          type: d.settlement.type as NonNullable<PublicInvoiceObj["settlement"]>["type"],
        }
      : null,
    checkout_session: inv.session ? pid<"cs">(inv.session.id) : null,
    auto_debit: publicAutoDebitView(d.autoDebit ?? null),
  };
}

export function invoicePaymentSessionView(s: InvoicePaymentSessionData): InvoicePaymentSessionObj {
  return {
    object: "invoice_payment_session",
    checkout_session: pid<"cs">(s.checkoutSession),
    client_secret: s.clientSecret,
    expires_at: iso(s.expiresAt),
    reused: s.reused,
  };
}

const display = (a: InvoiceNotificationData["pricingAsset"]) =>
  a ? { asset_id: a.assetId as AssetIdT, symbol: a.symbol, decimals: a.decimals } : null;

export function invoiceNotificationView(d: InvoiceNotificationData): z.infer<typeof InvoiceNotificationContext> {
  const inv = d.invoice;
  return {
    account_id: accountId(inv.accountId),
    livemode: inv.livemode,
    merchant_display_name: d.merchantDisplayName,
    customer: pid<"cus">(inv.customerId),
    customer_email: d.customerEmail,
    customer_name: d.customerName,
    invoice: pid<"in">(inv.id),
    number: inv.number ?? "",
    status: inv.status,
    currency: inv.currency as InvoiceObj["currency"],
    asset_id: asset(inv.assetId),
    pricing_asset: display(d.pricingAsset),
    total: amount(inv, inv.total),
    subtotal: amount(inv, inv.subtotal),
    tax: amount(inv, inv.tax),
    line_count: inv.lines.length,
    destination_fingerprint: inv.destinationFingerprint ?? null,
    amount_due: amount(inv, inv.total),
    amount_remaining: amount(inv, d.amountRemaining),
    due_date: optIso(inv.dueDate),
    period_start: optIso(inv.period?.start ?? null),
    period_end: optIso(inv.period?.end ?? null),
    subscription: opt<"sub">(inv.subscriptionId),
    lines: inv.lines
      .slice(0, 20)
      .map((l) => ({ description: l.description, quantity: l.quantity, amount: amount(inv, l.amount) })),
    hosted_invoice_url: d.hostedInvoiceUrl,
    payment_intent: opt<"pi">(inv.paymentIntentId),
    reminder: d.reminder
      ? { number: d.reminder.number, offset_days: d.reminder.offsetDays, last: d.reminder.last }
      : null,
  };
}

export function subscriptionNotificationView(
  d: SubscriptionNotificationData,
): z.infer<typeof SubscriptionNotificationContext> {
  const s = d.subscription;
  return {
    account_id: accountId(s.accountId),
    livemode: s.livemode,
    merchant_display_name: d.merchantDisplayName,
    customer: pid<"cus">(s.customerId),
    customer_email: d.customerEmail,
    customer_name: d.customerName,
    subscription: pid<"sub">(s.id),
    status: s.status,
    renews_at: iso(d.renewsAt),
    recurring: { interval: s.recurring.interval, interval_count: s.recurring.intervalCount },
    currency: s.currency as SubscriptionObj["currency"],
    asset_id: asset(s.assetId),
    pricing_asset: display(d.pricingAsset),
    next_amount: amount(s, d.nextAmount),
    items: d.items.map((i) => ({ description: i.description, quantity: i.quantity })),
    cancel_at_period_end: s.cancelAtPeriodEnd,
  };
}

/** `advanceSubscriptionClock` response (spec 0.3.1, lld/billing.md §13). */
export function clockAdvanceView(a: ClockAdvance): z.infer<typeof SubscriptionClockAdvance> {
  return {
    object: "subscription_clock_advance",
    subscription: pid<"sub">(a.subscription.id),
    target: a.target,
    clock_time: a.clockTime,
    advanced_by: a.advancedBy,
  };
}

// ---------------------------------------------------------------------------------------------
// Stage 4: mandates (spec 0.4.0 `public/mandates.ts`, internal `billing.ts`)
// ---------------------------------------------------------------------------------------------

type MandateT = z.infer<typeof MandateObj>;

export function nearTxView(tx: NearTx): z.infer<typeof NearTransactionRequest> {
  return {
    signer_id: tx.signerId,
    receiver_id: tx.receiverId,
    actions: [
      { type: "FunctionCall", method_name: tx.methodName, args: { ...tx.args }, gas: tx.gas, deposit: tx.deposit },
    ],
  } as z.infer<typeof NearTransactionRequest>;
}

/** The public `Mandate` (events, webhooks and API reads; public chain data only, no email). */
export function mandateView(m: Mandate): MandateT {
  const next = nextCollectAt(m);
  const c = m.lastCollection;
  return {
    id: pid<"md">(m.id),
    object: "mandate",
    created: m.created,
    livemode: m.livemode,
    status: m.status,
    link_status: m.linkStatus,
    unlinked_reason: m.unlinkedReason,
    collecting: m.linkStatus === "linked" && m.releasedAt === null && onchainActive(m),
    subscription: pid<"sub">(m.subscriptionId),
    customer: pid<"cus">(m.customerId),
    vault_contract: m.vaultContract,
    onchain_id: m.onchainId,
    payer: m.payer,
    token: m.token,
    asset_id: tokenAssetId(m.token),
    merchant_receiver: m.merchantReceiver,
    receiver_kind: m.receiverKind,
    settlement_destination: opt<"sd">(m.settlementDestinationId),
    amount_per_period: m.amountPerPeriod.toString(),
    period_secs: m.periodSecs,
    start_at: Number(m.startAtNs / 1_000_000_000n),
    max_periods: m.maxPeriods,
    fee_bps: m.feeBps,
    collected_periods: m.collectedPeriods,
    balance: m.balance.toString(),
    funded_periods: fundedPeriods(m),
    next_collect_at: next,
    last_collection: c
      ? {
          period: c.period,
          amount: c.amount.toString(),
          merchant_share: c.merchantShare.toString(),
          fee: c.fee.toString(),
          short: c.short,
          invoice: opt<"in">(c.invoiceId),
          tx_hash: c.txHash,
          receipt_id: c.receiptId,
          collected_at: c.collectedAt,
        }
      : null,
    collect_failures: m.keeper.collectFailures,
    canceled: m.canceled
      ? {
          by: m.canceled.by,
          by_role: canceledByRole(m, m.canceled.by),
          refunded: m.canceled.refunded.toString(),
          canceled_at: m.canceled.at,
        }
      : null,
    withdrawn: m.withdrawn.toString(),
    ext_ref: m.extRef,
    sequence: m.version,
  } as MandateT;
}

/** Optional `token_asset` (spec 0.4.1) of the funding instructions / payer view: omitted when unknown. */
function tokenAssetView(a: AssetFacts | null): {
  token_asset?: { asset_id: AssetIdT; symbol: string; decimals: number };
} {
  return a ? { token_asset: { asset_id: a.assetId as AssetIdT, symbol: a.symbol, decimals: a.decimals } } : {};
}

export function fundingView(d: FundingData): z.infer<typeof MandateFundingInstructions> {
  const f = d.funding;
  const t = f.terms;
  return {
    object: "mandate_funding_instructions",
    livemode: d.livemode,
    subscription: pid<"sub">(d.subscriptionId),
    vault_contract: f.vaultContract,
    token: t.token,
    asset_id: t.assetId,
    ...tokenAssetView(d.tokenAsset),
    amount: f.amount.toString(),
    periods: f.periods,
    amount_per_period: t.amountPerPeriod.toString(),
    period_secs: t.periodSecs,
    start_at: t.startAtNs === null ? null : t.startAtNs.toString(),
    fee_bps: t.feeBps,
    merchant_receiver: t.merchantReceiver,
    receiver_kind: t.receiverKind,
    settlement_destination: pid<"sd">(t.settlementDestinationId),
    ext_ref: t.extRef,
    msg: f.msg,
    payer: f.payer,
    storage: { payer_registered: f.payerRegistered, deposit: f.storageDeposit.toString() },
    payer_notice: f.payerNotice,
    transactions: f.transactions.map(nearTxView),
  } as z.infer<typeof MandateFundingInstructions>;
}

export function cancelInstructionsView(m: Mandate, tx: NearTx): z.infer<typeof MandateCancelInstructions> {
  return { object: "mandate_cancel_instructions", mandate: pid<"md">(m.id), transaction: nearTxView(tx) } as z.infer<
    typeof MandateCancelInstructions
  >;
}

export function publicMandateView(d: PublicMandateData): z.infer<typeof PublicMandate> {
  const m = d.mandate;
  return {
    id: pid<"md">(m.id),
    object: "mandate",
    livemode: m.livemode,
    status: m.status,
    link_status: m.linkStatus,
    payer: m.payer,
    vault_contract: m.vaultContract,
    onchain_id: m.onchainId,
    token: m.token,
    asset_id: tokenAssetId(m.token),
    ...tokenAssetView(d.tokenAsset),
    amount_per_period: m.amountPerPeriod.toString(),
    period_secs: m.periodSecs,
    balance: m.balance.toString(),
    funded_periods: fundedPeriods(m),
    collected_periods: m.collectedPeriods,
    next_collect_at: nextCollectAt(m),
    collecting: d.collecting,
    top_up_msg: d.tx.topUpMsg,
    transactions: {
      cancel: d.tx.cancel ? nearTxView(d.tx.cancel) : null,
      withdraw: d.tx.withdraw ? nearTxView(d.tx.withdraw) : null,
    },
  } as z.infer<typeof PublicMandate>;
}

export function simulationView(s: SimulationData): z.infer<typeof MandateSimulation> {
  return {
    object: "mandate_simulation",
    action: s.action,
    tx_hash: s.txHash,
    accepted: s.accepted,
    rejection: s.rejection,
    onchain_id: s.onchainId,
    logs: [...s.logs],
  } as z.infer<typeof MandateSimulation>;
}

export function mandateNotificationView(d: MandateNotificationData): z.infer<typeof MandateNotificationContext> {
  const m = d.mandate;
  const s = d.subscription;
  return {
    account_id: accountId(m.accountId),
    livemode: m.livemode,
    merchant_display_name: d.merchantDisplayName,
    customer: pid<"cus">(m.customerId),
    customer_email: d.customerEmail,
    customer_name: d.customerName,
    mandate: pid<"md">(m.id),
    subscription: pid<"sub">(m.subscriptionId),
    status: m.status,
    link_status: m.linkStatus,
    unlinked_reason: m.unlinkedReason,
    payer: m.payer,
    vault_contract: m.vaultContract,
    onchain_id: m.onchainId,
    token_asset: d.tokenAsset
      ? { asset_id: d.tokenAsset.assetId as AssetIdT, symbol: d.tokenAsset.symbol, decimals: d.tokenAsset.decimals }
      : { asset_id: tokenAssetId(m.token) as AssetIdT, symbol: m.token, decimals: 0 },
    amount_per_period: m.amountPerPeriod.toString(),
    recurring: s ? { interval: s.recurring.interval, interval_count: s.recurring.intervalCount } : null,
    balance: m.balance.toString(),
    next_collect_at: optIso(nextCollectAt(m)),
    refunded: m.canceled ? m.canceled.refunded.toString() : null,
    cancel_transaction: d.cancelTx ? nearTxView(d.cancelTx) : null,
    withdraw_transaction: d.withdrawTx ? nearTxView(d.withdrawTx) : null,
    invoice: opt<"in">(d.invoiceId),
    manage_url: d.manageUrl,
  } as z.infer<typeof MandateNotificationContext>;
}

/** `PublicInvoice.auto_debit` (spec 0.4.0). */
export function publicAutoDebitView(a: { available: boolean; mandate: string | null; collecting: boolean } | null) {
  return a ? { available: a.available, mandate: opt<"md">(a.mandate), collecting: a.collecting } : null;
}
