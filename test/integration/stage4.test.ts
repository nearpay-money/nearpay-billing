/**
 * Stage 4 auto-debit over HTTP with the worker (Testcontainers Postgres + NATS, spec-mocked peers and the
 * sandbox vault stand-in): mandate routes, `evt.rails.vault.event` from the bus (linkage, parking), the
 * keeper's `collect` through the stand-in's NEAR JSON-RPC, the invoice paid only by the forwarded
 * `collected` (INV-2), merchant cancel, the payer view, notification context, test helpers, amount lock.
 */

import { MandateNotificationContext, sandboxNearRpc, sandboxVaultCall } from "@nearpay-internal/spec";
import { domainEvent } from "@nearpay-internal/testing";
import {
  Invoice as InvoiceSchema,
  MandateCancelInstructions,
  MandateFundingInstructions,
  Mandate as MandateSchema,
  MandateSimulation,
  PublicInvoice,
  PublicMandate,
} from "@nearpay-money/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Merchant, type Stack, startStack, USDC_NEAR, uuid } from "../support/stack.js";

let s: Stack;
let m: Merchant;
let tok: string;
let cus: string;

const TOKEN = USDC_NEAR.slice("nep141:".length);
const VAULT = "vault.sandbox.near";
const NS = 1_000_000_000n;
let seq = 0;

beforeAll(async () => {
  s = await startStack({ worker: true });
  m = s.merchant();
  tok = await s.token(m);
  cus = s.customer(m);
});

afterAll(async () => {
  await s?.stop();
});

async function until<T>(f: () => Promise<T | undefined> | T | undefined, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v !== undefined && v !== false) return v as T;
    if (Date.now() > end) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 100));
  }
}

function record(event: string, data: Record<string, unknown>, o: { vault?: string } = {}) {
  seq += 1;
  return {
    vault_contract: o.vault ?? VAULT,
    tx_hash: `TxHash${String(seq).padStart(38, "1")}`,
    receipt_id: `Receipt${String(seq).padStart(37, "1")}`,
    log_index: 0,
    block_height: 5000 + seq,
    block_hash: `BlockHash${String(seq).padStart(35, "1")}`,
    block_timestamp: (BigInt(Math.floor(Date.now() / 1000)) * NS).toString(),
    event: { standard: "nearpay_vault", version: "1.0.0", event, data: [data] },
  };
}

const vaultEvent = (r: ReturnType<typeof record>) =>
  s.publishEvent(domainEvent("evt.rails.vault.event", r, { accountUuid: null, livemode: false }) as never);

async function autoDebitSubscription() {
  const prod = await s.call("POST", "/v1/products", { token: tok, body: { name: "Coffee club" } });
  const price = await s.call("POST", "/v1/prices", {
    token: tok,
    body: { product: prod.body.id, unit_amount: 1500, currency: "usd", recurring: { interval: "month" } },
  });
  const sub = await s.call("POST", "/v1/subscriptions", {
    token: tok,
    body: { customer: cus, items: [{ price: price.body.id }], collection_method: "auto_debit" },
    headers: { "idempotency-key": `sub-ad-${price.body.id}` },
  });
  expect(sub.status).toBe(201);
  expect(sub.body).toMatchObject({ collection_method: "auto_debit", mandate: null });
  const first = await s.call("GET", `/v1/invoices/${sub.body.latest_invoice}`, { token: tok });
  const secret = (first.body.hosted_invoice_url as string).split("#")[1] as string;
  return { sub: sub.body, price: price.body, first: first.body, secret };
}

const createdData = (id: number, subId: string, o: Record<string, unknown> = {}) => ({
  mandate_id: id,
  payer: "alice.near",
  merchant_receiver: "acme.near",
  token: TOKEN,
  amount_per_period: "15000000",
  period_secs: 2_629_746,
  start_at: (BigInt(Math.floor(Date.now() / 1000)) * NS).toString(),
  max_periods: null,
  fee_bps: 30,
  ext_ref: subId,
  receiver_kind: "intents_account",
  balance: "45000000",
  ...o,
});

describe("auto-debit end to end", () => {
  it("prepare → hosted setup → vault event links → keeper collects → forwarded collected pays the invoice", async () => {
    const { sub, first, secret } = await autoDebitSubscription();
    const h = { "x-nearpay-invoice-secret": secret };

    // prepare: side-effect free, idempotent, the vault's msg rules and the payer notice
    const key = { "idempotency-key": `prep-${sub.id}` };
    const prep = await s.call("POST", "/v1/mandates/prepare", {
      token: tok,
      body: { subscription: sub.id, payer: "alice.near" },
      headers: key,
    });
    expect(prep.status).toBe(200);
    const f = MandateFundingInstructions.parse(prep.body);
    expect(f).toMatchObject({ subscription: sub.id, amount_per_period: "15000000", periods: 3, amount: "45000000" });
    expect(f.payer_notice.length).toBeGreaterThan(20);
    expect(f.transactions.map((t) => t.actions[0]?.method_name)).toEqual(["storage_deposit", "ft_transfer_call"]);
    expect(f.transactions[1]).toMatchObject({ signer_id: null, receiver_id: TOKEN });
    const again = await s.call("POST", "/v1/mandates/prepare", {
      token: tok,
      body: { subscription: sub.id, payer: "alice.near" },
      headers: key,
    });
    expect(again.body).toEqual(prep.body);
    expect((await s.call("GET", `/v1/mandates?subscription=${sub.id}`, { token: tok })).body.data).toHaveLength(0);

    // the hosted invoice page offers the setup (invoice secret)
    const pub = await s.call("GET", `/v1/invoices/${first.id}/public`, { headers: h });
    expect(PublicInvoice.parse(pub.body).auto_debit).toMatchObject({ available: true, mandate: null });
    const hf = await s.call("POST", `/v1/invoices/${first.id}/public/mandate_funding`, { body: {}, headers: h });
    expect(hf.status).toBe(200);
    MandateFundingInstructions.parse(hf.body);
    expect(
      (await s.call("POST", `/v1/invoices/${first.id}/public/mandate_funding`, { body: {}, headers: {} })).status,
    ).toBeGreaterThanOrEqual(400);

    // the payer funds; rails forwards mandate_created → linked, the open invoice is collected
    const probe = await s.probe();
    await vaultEvent(record("mandate_created", createdData(41, sub.id)));
    const act = await probe.next("evt.billing.mandate.activated", () => true, 15_000);
    const md = MandateSchema.parse(act.data.object);
    expect(md).toMatchObject({ subscription: sub.id, link_status: "linked", status: "active", fee_bps: 30 });
    // envelope: the mandate's merchant account (the vault event had none) and the payload's mode
    expect(act.account_id).toBe(uuid(m.account, "acct"));
    expect(act.livemode).toBe(false);
    expect(md.livemode).toBe(act.livemode);

    // the keeper sends collect through the stand-in's NEAR JSON-RPC (signed, 250 Tgas; outcome not trusted)
    await until(() => s.vault.sentTx.length > 0 || undefined);
    const sending = await s.call("GET", `/v1/invoices/${first.id}`, { token: tok });
    expect(sending.body).toMatchObject({ status: "open", collection_method: "auto_debit", mandate: md.id });

    // INV-2: only the forwarded `collected` pays it
    await vaultEvent(
      record("collected", {
        mandate_id: 41,
        period: 1,
        amount: "15000000",
        merchant_share: "14955000",
        fee: "45000",
        balance: "30000000",
      }),
    );
    await probe.next("evt.billing.invoice.paid", (e) => e.aggregate.id === first.id, 15_000);
    await probe.next("evt.billing.mandate.collected", (e) => e.aggregate.id === md.id, 15_000);
    const paid = InvoiceSchema.parse((await s.call("GET", `/v1/invoices/${first.id}`, { token: tok })).body);
    expect(paid).toMatchObject({ status: "paid", collection_method: "auto_debit", mandate: md.id });
    expect(paid.mandate_collection).toMatchObject({ mandate: md.id, period: 1, merchant_share: "14955000" });
    expect(
      (await s.call("GET", `/v1/invoices?collection_method=auto_debit&subscription=${sub.id}`, { token: tok })).body
        .data,
    ).toHaveLength(1);

    // reads, merchant cancel, payer view, notify context
    const list = await s.call("GET", `/v1/mandates?subscription=${sub.id}&link_status=linked`, { token: tok });
    expect(list.body.data.map((x: { id: string }) => x.id)).toEqual([md.id]);
    const got = MandateSchema.parse((await s.call("GET", `/v1/mandates/${md.id}`, { token: tok })).body);
    expect(got).toMatchObject({ balance: "30000000", collected_periods: 1 });
    expect((await s.call("GET", `/v1/mandates/${md.id}`, { token: await s.token(s.merchant()) })).status).toBe(404);
    expect((await s.call("GET", `/v1/mandates/${md.id}`, { token: await s.token(m, { livemode: true }) })).status).toBe(
      404,
    );
    const cancel = await s.call("POST", `/v1/mandates/${md.id}/prepare_cancel`, { token: tok, body: {} });
    expect(cancel.status).toBe(200);
    const ct = MandateCancelInstructions.parse(cancel.body).transaction;
    expect(ct).toMatchObject({ signer_id: "acme.near", receiver_id: VAULT });
    expect(ct.actions[0]?.method_name).toBe("cancel");
    const pm = await s.call("GET", `/v1/invoices/${first.id}/public/mandate`, { headers: h });
    expect(PublicMandate.parse(pm.body)).toMatchObject({ collecting: true });
    const nctx = await s.call("GET", `/internal/mandates/${md.id}/notification-context`, {
      token: await s.serviceToken("notify"),
    });
    expect(nctx.status).toBe(200);
    expect(MandateNotificationContext.parse(nctx.body)).toMatchObject({ customer_email: "payer@example.com" });

    // amount lock: a change of the per-period total while the mandate is active
    const price2 = await s.call("POST", "/v1/prices", {
      token: tok,
      body: {
        product: sub.items[0].price.product,
        unit_amount: 2500,
        currency: "usd",
        recurring: { interval: "month" },
      },
    });
    const locked = await s.call("PATCH", `/v1/subscriptions/${sub.id}`, {
      token: tok,
      body: { items: [{ price: price2.body.id }] },
    });
    expect(locked.body.error?.code).toBe("state_conflict");

    // test helper: a payer action on the stand-in (vault outcome is data, not an API error)
    const sim = await s.call("POST", `/v1/test_helpers/mandates/${md.id}/payer_action`, {
      token: tok,
      body: { action: "withdraw" },
    });
    expect(sim.status).toBe(200);
    expect(MandateSimulation.parse(sim.body)).toMatchObject({ action: "withdraw", accepted: true });
    expect(s.sandbox.callsTo(sandboxVaultCall).length).toBeGreaterThan(0);

    // the payer cancels on chain → mirrored; the subscription unlinks
    await vaultEvent(record("canceled", { mandate_id: 41, by: "alice.near", refunded: "30000000" }));
    const canceled = await probe.next("evt.billing.mandate.canceled", (e) => e.aggregate.id === md.id, 15_000);
    expect(canceled.account_id).toBe(uuid(m.account, "acct"));
    const cctx = await s.call("GET", `/internal/mandates/${md.id}/notification-context`, {
      token: await s.serviceToken("notify"),
    });
    expect(MandateNotificationContext.parse(cctx.body)).toMatchObject({
      refunded: "30000000",
      cancel_transaction: null,
    });
    await until(async () => {
      const r = await s.call("GET", `/v1/subscriptions/${sub.id}`, { token: tok });
      return r.body.mandate === null || undefined;
    });
    expect(s.sandbox.callsTo(sandboxNearRpc).length).toBeGreaterThan(0);
    await probe.close();
  });

  it("parks events that fail the rules (wrong vault, unknown subscription) and keeps consuming", async () => {
    const { sub } = await autoDebitSubscription();
    const probe = await s.probe();
    await vaultEvent(record("mandate_created", createdData(51, sub.id), { vault: "evil.near" }));
    await vaultEvent(record("mandate_created", createdData(52, "sub_0000000000000000000000000z")));
    // a payer-edited fee is recorded unlinked (and the payer is told to cancel)
    await vaultEvent(record("mandate_created", createdData(53, sub.id, { fee_bps: 0 })));
    const un = await probe.next("evt.billing.mandate.unlinked", () => true, 15_000);
    expect(MandateSchema.parse(un.data.object)).toMatchObject({
      link_status: "unlinked",
      unlinked_reason: "fee_mismatch",
    });
    const parked = await until(async () => {
      const rows = await s.admin.db.selectFrom("vault_events_parked").select(["reason", "retriable"]).execute();
      return rows.length >= 2 ? rows : undefined;
    });
    expect(parked.map((r) => r.reason).sort()).toEqual(["unknown_subscription", "wrong_vault"]);
    expect(parked.every((r) => r.retriable === false)).toBe(true);
    const all = await s.call("GET", `/v1/mandates?subscription=${sub.id}`, { token: tok });
    expect(all.body.data).toHaveLength(1);
    await probe.close();
  });

  it("ERR_INSUFFICIENT_BALANCE falls back to send_invoice and emits mandate.insufficient_funds", async () => {
    const { sub, first } = await autoDebitSubscription();
    const probe = await s.probe();
    s.vault.collectFailure = "ERR_INSUFFICIENT_BALANCE";
    const sent = s.vault.sentTx.length;
    await vaultEvent(record("mandate_created", createdData(61, sub.id)));
    const ins = await probe.next("evt.billing.mandate.insufficient_funds", () => true, 20_000);
    expect(MandateSchema.parse(ins.data.object).subscription).toBe(sub.id);
    expect(s.vault.sentTx.length).toBe(sent + 1);
    const inv = await s.call("GET", `/v1/invoices/${first.id}`, { token: tok });
    expect(inv.body).toMatchObject({ status: "open", collection_method: "send_invoice" });
    await probe.close();
  });
});
