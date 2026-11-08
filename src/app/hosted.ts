/**
 * Hosted invoice page `/i/<in_…>#<invoice secret>` (lld/billing.md §5, §11 d3–d4). Anonymous at the
 * gateway; billing checks `X-NearPay-Invoice-Secret` in constant time against the stored hash and then
 * acts in the invoice's own scope. `GET …/public` is read-only; `POST …/public/sessions` creates (or
 * continues) the invoice's payments checkout session — billing never sees funds (INV-1).
 */
import { timingSafeEqual } from "node:crypto";
import { scheduleOf } from "../domain/dunning/dunning.js";
import { amountRemaining, type Invoice, isPayable } from "../domain/invoice/invoice.js";
import { DAY, DomainError, missing } from "../domain/shared.js";
import { saveInvoice } from "./commit.js";
import { billToOf, clientSecretAad, nowS, secretHash } from "./invoices.js";
import type { AssetFacts, Billing, MerchantFacts } from "./ports.js";

/** The invoice behind a hosted-page request: finalized (drafts look missing) and the secret matches. */
export function checkSecret(inv: Invoice | undefined, id: string, secret: string): Invoice {
  if (!inv || inv.status === "draft" || !inv.hosted) throw missing("invoice", id);
  const want = Buffer.from(inv.hosted.secretHash);
  const got = secretHash(secret);
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw new DomainError("invoice_secret_invalid");
  return inv;
}

export interface PublicInvoiceData {
  readonly invoice: Invoice;
  readonly payable: boolean;
  readonly billTo: { readonly name: string | null; readonly email: string | null };
  readonly merchantName: string;
  readonly pricingAsset: AssetFacts | null;
  readonly settlement: { readonly assetId: string; readonly chain: string; readonly type: string } | null;
}

function destinationFor(inv: Invoice, m: MerchantFacts): MerchantFacts["destinations"][number] | null {
  const id =
    inv.settlementDestinationId ?? (inv.assetId ? m.defaults[inv.assetId] : undefined) ?? m.defaults["*"] ?? null;
  return m.destinations.find((d) => d.id === id) ?? null;
}

const accepts = (inv: Invoice, m: MerchantFacts): boolean =>
  (!inv.livemode || m.liveEnabled) && destinationFor(inv, m) !== null;

export async function getPublicInvoice(b: Billing, id: string, secret: string): Promise<PublicInvoiceData> {
  const inv = checkSecret(await b.store.transaction((tx) => tx.invoices.getByIdUnscoped(id)), id, secret);
  const m = await b.merchant.context(inv);
  const dest = destinationFor(inv, m);
  return {
    invoice: inv,
    payable: isPayable(inv) && accepts(inv, m),
    billTo: billToOf(b, inv),
    merchantName: inv.merchantName ?? m.displayName,
    pricingAsset: inv.assetId ? ((await b.assets.asset(inv.assetId)) ?? null) : null,
    settlement: dest ? { assetId: dest.assetId, chain: dest.chain, type: dest.type } : null,
  };
}

export interface InvoicePaymentSessionData {
  readonly checkoutSession: string;
  readonly clientSecret: string;
  readonly expiresAt: number;
  readonly reused: boolean;
}

/**
 * When the session stops taking new payments: the earlier of now + 30 days and the last reminder, but at
 * least an hour ahead (payments accepts 5 min – 30 d; uncollectible invoices stay payable).
 */
export function sessionExpiry(inv: Invoice, now: number): number {
  const s = scheduleOf(inv);
  const last = s[s.length - 1]?.at ?? now + 30 * DAY;
  return Math.max(now + 3600, Math.min(now + 30 * DAY, last));
}

/** Session metadata: the invoice's own (≤ 49 keys kept) plus `invoice_number` (≤ 50, api-conventions). */
export function sessionMetadata(inv: Invoice): Record<string, string> {
  const kept = Object.entries(inv.metadata)
    .filter(([k]) => k !== "invoice_number")
    .slice(0, 49);
  return { ...Object.fromEntries(kept), invoice_number: inv.number ?? "" };
}

export async function createPublicInvoiceSession(
  b: Billing,
  id: string,
  secret: string,
  o: { readonly locale?: string | undefined; readonly clientNetwork: string },
): Promise<InvoicePaymentSessionData> {
  const now = nowS(b);
  const inv = await b.store.transaction(async (tx) => {
    const cur = checkSecret(await tx.invoices.getByIdUnscoped(id), id, secret);
    if (!isPayable(cur)) throw new DomainError("invoice_not_payable", { invoice: id, status: cur.status });
    const perClient = await tx.hit(`inv-session:net:${o.clientNetwork}`, 60, now);
    const perInvoice = await tx.hit(`inv-session:in:${id}`, 60, now);
    if (perClient > b.settings.publicSessionsPerClient || perInvoice > b.settings.publicSessionsPerInvoice)
      throw new DomainError("rate_limited", { retry_after: 60 });
    return cur;
  });

  const reuse = (session: NonNullable<Invoice["session"]>): InvoicePaymentSessionData => ({
    checkoutSession: session.id,
    clientSecret: b.cipher.decrypt(Buffer.from(session.clientSecretEnc), clientSecretAad(id)).toString("utf8"),
    expiresAt: session.expiresAt,
    reused: true,
  });

  if (inv.session) {
    const s = await b.payments.getSession(inv.session.id);
    if (s.status === "open" && s.expiresAt > now) return reuse(inv.session);
  }

  const n = inv.sessionsCreated + 1;
  const r = await b.payments.createInvoiceSession(
    {
      scope: { accountId: inv.accountId, livemode: inv.livemode },
      invoiceId: inv.id,
      amount: amountRemaining(inv),
      currency: inv.currency,
      assetId: inv.assetId,
      customerId: inv.customerId,
      description: `Invoice ${inv.number}`,
      settlementDestinationId: inv.settlementDestinationId,
      successUrl: `${b.settings.payOrigin}/i/${inv.id}`,
      expiresAt: sessionExpiry(inv, now),
      locale: o.locale,
      metadata: sessionMetadata(inv),
    },
    `in:${inv.id}:s${n}`,
  );

  const out = await b.store.transaction(
    async (tx): Promise<InvoicePaymentSessionData | { orphan: string; status: string }> => {
      const cur = await tx.invoices.getByIdUnscoped(id, { lock: true });
      if (!cur) throw missing("invoice", id);
      if (r.kind === "conflict") {
        // another request opened (and stored) the invoice's session meanwhile
        if (cur.session) return reuse(cur.session);
        throw new DomainError("state_conflict", { object: "invoice", state: "opening a payment session" });
      }
      if (cur.sessionsCreated >= n && cur.session) return reuse(cur.session);
      if (!isPayable(cur)) return { orphan: r.session.id, status: cur.status };
      const session = {
        id: r.session.id,
        expiresAt: r.session.expiresAt,
        clientSecretEnc: b.cipher.encrypt(r.clientSecret, clientSecretAad(id)),
      };
      await saveInvoice(
        tx,
        cur,
        { ...cur, session, sessionsCreated: n, updated: now },
        { actor: "customer", cause: "session opened" },
      );
      return { checkoutSession: session.id, clientSecret: r.clientSecret, expiresAt: session.expiresAt, reused: false };
    },
  );
  if ("orphan" in out) {
    // paid or voided while the session opened: close it again (a late settlement would still be recorded, INV-3)
    await b.payments
      .expireSession(out.orphan, "superseded")
      .catch((e: unknown) =>
        b.log.warn(
          { invoice: id, session: out.orphan, err: String(e) },
          "could not expire a superseded invoice session",
        ),
      );
    throw new DomainError("invoice_not_payable", { invoice: id, status: out.status });
  }
  return out;
}
