/**
 * Auto-debit use cases with in-memory fakes (lld/billing.md v1.7 §5–§7.1, §14): prepare has no side effects,
 * mandate rows come only from vault events, linkage, the keeper's collect, outcomes per §7.1 (paid with
 * evidence, insufficient funds, collect failures, short share, late/unapplied collections), parking, release,
 * amount lock, test helpers and the notification context.
 */

import type { VaultEvent } from "@nearpay/spec";
import { beforeEach, describe, expect, it } from "vitest";
import * as catalog from "../../src/app/catalog.js";
import type { Ctx } from "../../src/app/commit.js";
import * as inv from "../../src/app/invoices.js";
import * as md from "../../src/app/mandates.js";
import { mandateNotificationContext } from "../../src/app/notification.js";
import * as subs from "../../src/app/subscriptions.js";
import { onVaultEvent, retryParkedVaultEvents, type VaultEventRecord } from "../../src/app/vault-events.js";
import type { Invoice } from "../../src/domain/invoice/invoice.js";
import type { Mandate } from "../../src/domain/mandate/mandate.js";
import { DAY, DomainError } from "../../src/domain/shared.js";
import type { Subscription } from "../../src/domain/subscription/subscription.js";
import { jobHandlers } from "../../src/workers/jobs.js";
import { LIVE, SCOPE, T0 } from "../support/fixtures.js";
import { runDueJobs, type TestBilling, testBilling } from "../support/memory.js";

const c: Ctx = { scope: SCOPE, actor: "user:usr_1" };
const VAULT = "vault.sandbox.near";
const NS = 1_000_000_000n;

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
  return "ok";
}

let b: TestBilling;
let monthly: string;
let eurMonthly: string;
let receipt = 0;
let height = 1000;

beforeEach(async () => {
  b = testBilling(T0 * 1000);
  b.fakeVault.blockNs = BigInt(T0) * NS;
  b.pay.addCustomer(SCOPE, { id: "cus_1" });
  const p = await catalog.createProduct(b, c, { name: "Pro" });
  monthly = (
    await catalog.createPrice(b, c, {
      productId: p.id,
      unitAmount: 2_500n,
      currency: "usd",
      assetId: null,
      recurring: { interval: "month" },
    })
  ).id;
  eurMonthly = (
    await catalog.createPrice(b, c, {
      productId: p.id,
      unitAmount: 2_500n,
      currency: "eur",
      assetId: null,
      recurring: { interval: "month" },
    })
  ).id;
});

const jobs = () => runDueJobs(b, jobHandlers(b));
const subjects = () => b.mem.state.outbox.map((e) => e.subject);
const mandates = () => [...b.mem.state.mandates.values()];
const invoice = (id: string) => b.mem.state.invoices.get(id) as Invoice;
const sub = (id: string) => b.mem.state.subscriptions.get(id) as Subscription;
const at = (secs: number) => {
  b.clock.ms = secs * 1000;
  b.fakeVault.blockNs = BigInt(secs) * NS;
};

function record(event: VaultEvent, o: { vault?: string; time?: number } = {}): VaultEventRecord {
  receipt += 1;
  height += 1;
  return {
    vault_contract: o.vault ?? VAULT,
    tx_hash: `tx_${receipt}`,
    receipt_id: `receipt_${receipt}`,
    log_index: 0,
    block_height: height,
    block_hash: `bh_${height}`,
    block_timestamp: (BigInt(o.time ?? Math.floor(b.clock.ms / 1000)) * NS).toString(),
    event,
  };
}
const ev = <N extends VaultEvent["event"]>(event: N, data: Record<string, unknown>) =>
  ({ standard: "nearpay_vault", version: "1.0.0", event, data: [data] }) as unknown as VaultEvent;

const deliver = (r: VaultEventRecord, livemode = false) => onVaultEvent(b, { livemode, record: r });

async function autoDebitSub(): Promise<Subscription> {
  return subs.createSubscription(b, c, {
    customerId: "cus_1",
    items: [{ priceId: monthly }],
    collectionMethod: "auto_debit",
  });
}

function createdFor(s: Subscription, o: Record<string, unknown> = {}) {
  return ev("mandate_created", {
    mandate_id: 7,
    payer: "alice.near",
    merchant_receiver: "acme.near",
    token: "usdc.near",
    amount_per_period: "25000000",
    period_secs: 2_629_746,
    start_at: (BigInt(Math.floor(b.clock.ms / 1000)) * NS).toString(),
    max_periods: null,
    fee_bps: 100,
    ext_ref: s.id,
    receiver_kind: "intents_account",
    balance: "75000000",
    ...o,
  });
}

const collected = (o: Record<string, unknown> = {}) =>
  ev("collected", {
    mandate_id: 7,
    period: 1,
    amount: "25000000",
    merchant_share: "24750000",
    fee: "250000",
    balance: "50000000",
    ...o,
  });

/** An auto-debit subscription with a linked mandate (#7) and its first invoice switched to auto-debit. */
let lastCreated: VaultEventRecord;
async function linked(): Promise<{ s: Subscription; m: Mandate; first: Invoice }> {
  const s = await autoDebitSub();
  lastCreated = record(createdFor(s));
  expect(await deliver(lastCreated)).toBe("applied");
  const m = mandates()[0] as Mandate;
  return { s: sub(s.id), m, first: invoice(s.latestInvoiceId as string) };
}

describe("subscriptions with auto_debit", () => {
  it("needs vault-compatible pricing", async () => {
    expect(
      await code(
        subs.createSubscription(b, c, {
          customerId: "cus_1",
          items: [{ priceId: eurMonthly }],
          collectionMethod: "auto_debit",
        }),
      ),
    ).toBe("auto_debit_unavailable");
    const s = await autoDebitSub();
    expect(s.collectionMethod).toBe("auto_debit");
    // without a mandate the first invoice is a normal emailed send_invoice invoice
    const first = invoice(s.latestInvoiceId as string);
    expect(first.collectionMethod).toBe("send_invoice");
    expect(subjects()).toContain("evt.billing.invoice.sent");
  });
});

describe("prepareMandate", () => {
  it("computes the funding without any side effect", async () => {
    const s = await autoDebitSub();
    const before = structuredClone(b.mem.state);
    const f = await md.prepareMandate(b, c, { subscriptionId: s.id });
    expect(f.funding.terms).toMatchObject({
      token: "usdc.near",
      amountPerPeriod: 25_000_000n,
      startAtNs: null,
      feeBps: 100,
      merchantReceiver: "acme.near",
    });
    expect(f.funding.amount).toBe(75_000_000n);
    expect(f.funding.msg).toBe(
      `{"create_mandate":{"merchant_receiver":"acme.near","receiver_kind":"intents_account","amount_per_period":"25000000","period_secs":2629746,"start_at":null,"max_periods":null,"fee_bps":100,"ext_ref":"${s.id}"}}`,
    );
    expect(f.funding.transactions.map((t) => t.methodName)).toEqual(["storage_deposit", "ft_transfer_call"]);
    expect(f.tokenAsset).toEqual({ assetId: "nep141:usdc.near", symbol: "USDC", decimals: 6 });
    expect(b.mem.state).toEqual(before);
  });

  it("token_asset is omitted, never fatal, when rails' registry fails after the decimals lookup", async () => {
    const s = await autoDebitSub();
    const asset = b.assets.asset;
    let calls = 0;
    let failAfter = Number.POSITIVE_INFINITY;
    b.assets.asset = async (id) => {
      calls += 1;
      if (calls > failAfter) throw new Error("rails down");
      return asset.call(b.assets, id);
    };
    try {
      await md.prepareMandate(b, c, { subscriptionId: s.id });
      failAfter = calls - 1; // every lookup but the last (token_asset) succeeds
      calls = 0;
      const f = await md.prepareMandate(b, c, { subscriptionId: s.id });
      expect(f.funding.terms.token).toBe("usdc.near");
      expect(f.tokenAsset).toBeNull();
    } finally {
      b.assets.asset = asset;
    }
  });

  it("refuses: not auto_debit, already linked, RPC down, live account not live", async () => {
    const plain = await subs.createSubscription(b, c, { customerId: "cus_1", items: [{ priceId: monthly }] });
    expect(await code(md.prepareMandate(b, c, { subscriptionId: plain.id }))).toBe("state_conflict");
    const { s } = await linked();
    expect(await code(md.prepareMandate(b, c, { subscriptionId: s.id }))).toBe("state_conflict");
    const s2 = await autoDebitSub();
    b.fakeVault.rpcDown = true;
    expect(await code(md.prepareMandate(b, c, { subscriptionId: s2.id }))).toBe("rail_unavailable");
    b.fakeVault.rpcDown = false;
    expect(await code(md.prepareMandate(b, c, { subscriptionId: s2.id, periods: 36, token: "usdt.near" }))).toBe(
      "destination_not_intents_account",
    );
    b.fakeVault.tvl = 10n ** 15n;
    expect(await code(md.prepareMandate(b, c, { subscriptionId: s2.id }))).toBe("vault_cap_exceeded");
    expect(await code(md.prepareMandate(b, c, { subscriptionId: "sub_00000000000000000000000099" }))).toBe(
      "resource_missing",
    );
  });

  it("the hosted page computes the same funding behind the invoice secret", async () => {
    const s = await autoDebitSub();
    const first = invoice(s.latestInvoiceId as string);
    const secret = inv.invoiceSecretOf(b, first) as string;
    const f = await md.createPublicInvoiceMandateFunding(b, first.id, secret, { payer: "alice.near" });
    expect(f.funding.payer).toBe("alice.near");
    expect(f.funding.transactions).toHaveLength(2); // alice has no storage yet
    expect(
      await code(md.createPublicInvoiceMandateFunding(b, first.id, `${first.id}_secret_${"x".repeat(32)}`, {})),
    ).toBe("invoice_secret_invalid");
  });
});

describe("vault events", () => {
  it("mandate_created with the prepared terms links, switches the open invoice and enqueues the collect", async () => {
    const { s, m, first } = await linked();
    expect(m).toMatchObject({
      linkStatus: "linked",
      status: "active",
      onchainId: 7,
      balance: 75_000_000n,
      settlementDestinationId: "sd_default",
    });
    expect(s.mandateId).toBe(m.id);
    expect(first).toMatchObject({ collectionMethod: "auto_debit", mandateId: m.id });
    expect(subjects()).toContain("evt.billing.mandate.activated");
    expect([...b.mem.state.jobs.keys()].some((k) => k.startsWith(`mandate.collect:${m.id}:${first.id}`))).toBe(true);
    // a redelivery changes nothing
    expect(await deliver(lastCreated)).toBe("duplicate");
    // the same mandate forwarded under another receipt never creates a second row
    await deliver({ ...lastCreated, receipt_id: "other-receipt" });
    expect(mandates()).toHaveLength(1);
  });

  it("payer-edited terms are recorded unlinked (fee 0 never bypasses the fee)", async () => {
    const s = await autoDebitSub();
    await deliver(record(createdFor(s, { fee_bps: 0 })));
    const m = mandates()[0] as Mandate;
    expect(m).toMatchObject({ linkStatus: "unlinked", unlinkedReason: "fee_mismatch" });
    expect(sub(s.id).mandateId).toBeNull();
    expect(subjects()).toContain("evt.billing.mandate.unlinked");
    // a test-vault mandate never links to a live subscription (and the reverse)
    await deliver(record(createdFor(s, { mandate_id: 8 }), { vault: "v1.vault.nearpay.near" }), true);
    expect(mandates().find((x) => x.onchainId === 8)).toMatchObject({
      linkStatus: "unlinked",
      unlinkedReason: "mode_mismatch",
      livemode: true,
    });
  });

  it("parks what it cannot apply and never throws: wrong vault, unknown subscription, unknown mandate (replayed later)", async () => {
    const s = await autoDebitSub();
    expect(await deliver(record(createdFor(s), { vault: "evil.near" }))).toBe("parked");
    expect(await deliver(record(createdFor(s, { ext_ref: "sub_0000000000000000000000zzzz" })))).toBe("parked");
    expect(await deliver(record(createdFor(s, { ext_ref: "not-a-sub" })))).toBe("parked");
    // rails forwarded the top-up (a later block) before the creation
    const create = record(createdFor(s));
    const early = record(ev("topped_up", { mandate_id: 7, amount: "25000000", balance: "100000000" }));
    expect(await deliver(early)).toBe("parked");
    expect([...b.mem.state.parked.values()].filter((p) => p.retryAt !== null)).toHaveLength(1);
    expect(b.logs.some((l) => l.msg === "ALERT vault event parked")).toBe(true);
    await deliver(create);
    // the early top-up was replayed right after the mandate appeared
    expect((mandates()[0] as Mandate).balance).toBe(100_000_000n);
    expect([...b.mem.state.parked.values()].filter((p) => !p.resolved && p.retryAt !== null)).toHaveLength(0);
    expect(await retryParkedVaultEvents(b)).toBe(0);
  });
});

describe("keeper and outcomes (§7.1)", () => {
  it("collects once; the forwarded collected pays the invoice with evidence and activates the subscription", async () => {
    const { s, m, first } = await linked();
    await jobs();
    expect(b.fakeVault.sent).toHaveLength(1);
    expect(b.mem.state.mandates.get(m.id)?.keeper.pendingTxHash).toBe("tx1");
    // later ticks never send a second collect while the outcome is pending
    at(T0 + 600);
    await jobs();
    expect(b.fakeVault.sent).toHaveLength(1);
    await deliver(record(collected()));
    const paid = invoice(first.id);
    expect(paid.status).toBe("paid");
    expect(paid.paymentIntentId).toBeNull();
    expect(paid.mandateCollection).toMatchObject({
      mandateId: m.id,
      period: 1,
      merchantShare: 24_750_000n,
      fee: 250_000n,
    });
    expect(sub(s.id).status).toBe("active");
    const after = b.mem.state.mandates.get(m.id) as Mandate;
    expect(after).toMatchObject({ collectedPeriods: 1, balance: 50_000_000n });
    expect(after.keeper.pendingTxHash).toBeNull();
    expect(subjects()).toEqual(expect.arrayContaining(["evt.billing.invoice.paid", "evt.billing.mandate.collected"]));
    at(T0 + 1200);
    await jobs();
    expect(b.fakeVault.sent).toHaveLength(1);
  });

  it("renewal: an auto-debit invoice (not emailed) collected by the keeper", async () => {
    const { s } = await linked();
    await jobs();
    await deliver(record(collected()));
    const sentBefore = subjects().filter((x) => x === "evt.billing.invoice.sent").length;
    at(sub(s.id).currentPeriodEnd + 5);
    b.fakeVault.next.set(7, b.fakeVault.blockNs);
    await jobs();
    const renewal = invoice(sub(s.id).latestInvoiceId as string);
    expect(renewal).toMatchObject({
      collectionMethod: "auto_debit",
      status: "open",
      billingReason: "subscription_cycle",
    });
    expect(subjects().filter((x) => x === "evt.billing.invoice.sent").length).toBe(sentBefore);
    expect(b.fakeVault.sent).toHaveLength(2);
    await deliver(record(collected({ period: 2, balance: "25000000" })));
    expect(invoice(renewal.id).status).toBe("paid");
  });

  it("ERR_NOT_DUE waits for next_collect_at; ERR_INSUFFICIENT_BALANCE falls back to send_invoice", async () => {
    const { first, m } = await linked();
    b.fakeVault.next.set(7, BigInt(T0 + 3600) * NS);
    await jobs();
    expect(b.fakeVault.sent).toHaveLength(0);
    at(T0 + 3601);
    b.fakeVault.results.push((h) => ({
      kind: "failure",
      txHash: h,
      code: "ERR_INSUFFICIENT_BALANCE",
      message: "Smart contract panicked: ERR_INSUFFICIENT_BALANCE",
    }));
    await jobs();
    expect(b.fakeVault.sent).toHaveLength(1);
    expect(invoice(first.id)).toMatchObject({ collectionMethod: "send_invoice", status: "open" });
    expect(subjects()).toContain("evt.billing.mandate.insufficient_funds");
    expect(b.mem.state.mandates.get(m.id)?.keeper.pendingTxHash).toBeNull();
  });

  it("collect_failed retries, then falls back after 5 and opens a case (no insufficient_funds)", async () => {
    const { first } = await linked();
    for (let i = 1; i <= 5; i++) {
      await jobs();
      await deliver(record(ev("collect_failed", { mandate_id: 7, period: 1, reason: "merchant_transfer_failed" })));
      at(Math.floor(b.clock.ms / 1000) + 120);
    }
    expect(b.fakeVault.sent).toHaveLength(5);
    expect(invoice(first.id).collectionMethod).toBe("send_invoice");
    expect(b.mem.state.cases.map((x) => x.kind)).toContain("collect_failures");
    expect(subjects()).not.toContain("evt.billing.mandate.insufficient_funds");
  });

  it("a short merchant share voids the invoice, bills the shortfall and opens a case", async () => {
    const { first, s } = await linked();
    await jobs();
    await deliver(record(collected({ amount: "12375000", merchant_share: "12375000", fee: "0", balance: "62625000" })));
    const voided = invoice(first.id);
    expect(voided.status).toBe("void");
    expect(voided.mandateCollection?.merchantShare).toBe(12_375_000n);
    const balance = [...b.mem.state.invoices.values()].find((i) => i.id !== first.id && i.subscriptionId === s.id);
    expect(balance).toMatchObject({ status: "open", collectionMethod: "send_invoice", total: 1_263n });
    expect(b.mem.state.cases.map((x) => x.kind)).toContain("short_share");
  });

  it("fee leg failed: paid, ops case; a collection for a paid invoice is late; unapplied pays the next invoice", async () => {
    const { first, s, m } = await linked();
    await jobs();
    await deliver(record(collected({ fee: "0", amount: "24750000" })));
    expect(invoice(first.id).status).toBe("paid");
    expect(b.mem.state.cases.map((x) => x.kind)).toContain("fee_leg_failed");
    // someone else's permissionless collect counts period 2 before billing renews: unapplied
    await deliver(record(collected({ period: 2, balance: "25000000" })));
    expect([...b.mem.state.collections.values()].find((x) => x.c.period === 2)?.use).toBe("unapplied");
    at(sub(s.id).currentPeriodEnd + 5);
    await jobs();
    const renewal = invoice(sub(s.id).latestInvoiceId as string);
    expect(renewal.status).toBe("paid");
    expect(renewal.mandateCollection?.period).toBe(2);
    expect(b.fakeVault.sent).toHaveLength(1);
    expect(b.mem.state.mandates.get(m.id)?.collectedPeriods).toBe(2);
  });

  it("canceled by the payer: the mandate stops, auto-debit invoices fall back, the subscription unlinks", async () => {
    const { first, s } = await linked();
    await deliver(record(ev("canceled", { mandate_id: 7, by: "alice.near", refunded: "75000000" })));
    const m = mandates()[0] as Mandate;
    expect(m).toMatchObject({ status: "canceled", balance: 0n });
    expect(m.canceled?.by).toBe("alice.near");
    expect(invoice(first.id).collectionMethod).toBe("send_invoice");
    expect(sub(s.id).mandateId).toBeNull();
    expect(subjects()).toContain("evt.billing.mandate.canceled");
    await jobs();
    expect(b.fakeVault.sent).toHaveLength(0);
  });
});

describe("keeper failure paths", () => {
  const fail = (code: string | null) => (h: string) =>
    ({ kind: "failure", txHash: h, code, message: `Smart contract panicked: ${code}` }) as never;

  it("ERR_IN_FLIGHT waits 30 s; ERR_GAS alerts and retries; ERR_NOT_ACTIVE reconciles and falls back", async () => {
    const { first } = await linked();
    b.fakeVault.results.push(fail("ERR_IN_FLIGHT"), fail("ERR_GAS"), fail("ERR_NOT_ACTIVE"));
    await jobs();
    expect(b.fakeVault.sent).toHaveLength(1);
    at(T0 + 61);
    await jobs();
    expect(b.fakeVault.sent).toHaveLength(2);
    expect(b.logs.some((l) => l.msg.includes("ERR_GAS"))).toBe(true);
    at(T0 + 700);
    await jobs();
    expect(b.fakeVault.sent).toHaveLength(3);
    expect(invoice(first.id).collectionMethod).toBe("send_invoice");
  });

  it("unknown results keep the collect pending and re-check its status; never a second send", async () => {
    const { m } = await linked();
    b.fakeVault.results.push((h) => ({ kind: "unknown", txHash: h, error: "timeout" }));
    await jobs();
    expect(b.mem.state.mandates.get(m.id)?.keeper.pendingTxHash).toBe("tx1");
    b.fakeVault.statusResult = (h) => ({ kind: "success", txHash: h });
    at(T0 + 120);
    await jobs();
    expect(b.fakeVault.sent).toHaveLength(1);
    // the status says it failed for good: the pending mark is cleared and the table applies
    b.fakeVault.statusResult = (h) => fail("ERR_INSUFFICIENT_BALANCE")(h);
    at(T0 + 1000);
    await jobs();
    expect(b.mem.state.mandates.get(m.id)?.keeper.pendingTxHash).toBeNull();
    expect(subjects()).toContain("evt.billing.mandate.insufficient_funds");
  });

  it("no keeper key: alert and wait; NEAR RPC down 5 times: case and fall back", async () => {
    const { first } = await linked();
    b.fakeVault.enabled = false;
    await jobs();
    expect(b.fakeVault.sent).toHaveLength(0);
    expect(b.logs.some((l) => l.msg.startsWith("ALERT keeper key not configured"))).toBe(true);
    b.fakeVault.enabled = true;
    b.fakeVault.rpcDown = true;
    for (let i = 0; i < 12; i++) {
      at(Math.floor(b.clock.ms / 1000) + 3600);
      await jobs();
    }
    expect(invoice(first.id).collectionMethod).toBe("send_invoice");
    expect(b.mem.state.cases.map((x) => x.kind)).toContain("keeper_errors");
  });

  it("a vault error §7.1 does not list retries ×5 then case and fall back (the streak is not reset)", async () => {
    const { m, first } = await linked();
    for (let i = 0; i < 12; i++) b.fakeVault.results.push((h) => fail("ERR_UNAUTHORIZED")(h));
    for (let i = 0; i < 12 && invoice(first.id).collectionMethod === "auto_debit"; i++) {
      at(Math.floor(b.clock.ms / 1000) + 3600);
      await jobs();
    }
    expect(b.fakeVault.sent).toHaveLength(5);
    expect(b.mem.state.mandates.get(m.id)?.keeper.keeperErrors).toBe(5);
    expect(invoice(first.id).collectionMethod).toBe("send_invoice");
    expect(b.mem.state.cases.map((x) => x.kind)).toContain("keeper_errors");
  });

  it("ERR_GAS alerts and retries without counting toward the case", async () => {
    const { m, first } = await linked();
    for (let i = 0; i < 8; i++) b.fakeVault.results.push((h) => fail("ERR_GAS")(h));
    for (let i = 0; i < 8; i++) {
      at(Math.floor(b.clock.ms / 1000) + 3600);
      await jobs();
    }
    expect(b.fakeVault.sent.length).toBeGreaterThanOrEqual(6);
    expect(b.mem.state.mandates.get(m.id)?.keeper.keeperErrors).toBe(0);
    expect(invoice(first.id).collectionMethod).toBe("auto_debit");
    expect(b.logs.some((l) => l.msg.startsWith("ALERT keeper collect refused with ERR_GAS"))).toBe(true);
  });
});

describe("subscription hooks", () => {
  it("canceling the subscription releases the mandate (NearPay cannot cancel it on chain)", async () => {
    const { s, first } = await linked();
    await subs.cancelSubscription(b, c, s.id, false);
    const m = mandates()[0] as Mandate;
    expect(m.releasedAt).not.toBeNull();
    expect(m.status).toBe("active");
    expect(subjects()).toContain("evt.billing.mandate.released");
    expect(invoice(first.id).collectionMethod).toBe("send_invoice");
    expect(sub(s.id).mandateId).toBeNull();
  });

  it("amount lock while a mandate is active; leaving auto_debit releases it", async () => {
    const { s } = await linked();
    expect(await code(subs.updateSubscription(b, c, s.id, { items: [{ priceId: monthly, quantity: 2 }] }))).toBe(
      "state_conflict",
    );
    expect(await code(subs.updateSubscription(b, c, s.id, { metadata: { a: "b" } }))).toBe("ok");
    const after = await subs.updateSubscription(b, c, s.id, { collectionMethod: "send_invoice" });
    expect(after).toMatchObject({ collectionMethod: "send_invoice", mandateId: null });
    expect((mandates()[0] as Mandate).releasedAt).not.toBeNull();
    expect(await code(subs.updateSubscription(b, c, s.id, { items: [{ priceId: monthly, quantity: 2 }] }))).toBe("ok");
  });

  it("test clock advance moves the linked mandate's stand-in clock", async () => {
    const { s } = await linked();
    await jobs();
    await deliver(record(collected()));
    const a = await subs.advanceSubscriptionClock(b, c, s.id, "renewal_upcoming");
    expect(b.fakeSandbox.advanced).toEqual([{ onchainId: 7, secs: a.advancedBy }]);
    // a renewal also moves it up to next_collect_at (calendar billing months vs average vault months)
    const r = await subs.advanceSubscriptionClock(b, c, s.id, "renewal");
    expect(b.fakeSandbox.advanced.slice(1)).toEqual([{ onchainId: 7, secs: r.advancedBy }, { onchainId: 7 }]);
  });
});

describe("test helpers, reads and notification context", () => {
  it("simulated funding: storage + ft_transfer_call as the simulated payer; vault rejections are data", async () => {
    const s = await autoDebitSub();
    const created = `EVENT_JSON:{"standard":"nearpay_vault","version":"1.0.0","event":"mandate_created","data":[{"mandate_id":9,"payer":"sandbox-payer.near","merchant_receiver":"acme.near","token":"usdc.near","amount_per_period":"25000000","period_secs":2629746,"start_at":"1","max_periods":null,"fee_bps":100,"ext_ref":"${s.id}","receiver_kind":"intents_account","balance":"75000000"}]}`;
    b.fakeSandbox.outcomes.push(
      { txHash: "s1", failure: null, vaultLogs: [] },
      { txHash: "s2", failure: null, vaultLogs: [created] },
    );
    const r = await md.simulateMandateFunding(b, c, { subscriptionId: s.id });
    expect(r).toMatchObject({ action: "fund", accepted: true, onchainId: 9, rejection: null, txHash: "s2" });
    expect(b.fakeSandbox.calls.map((x) => x.kind)).toEqual(["call", "ft_transfer_call"]);
    expect(b.fakeSandbox.calls[1]?.body).toMatchObject({ payer: "sandbox-payer.near" });
    b.fakeSandbox.outcomes.push({ txHash: "s3", failure: null, vaultLogs: ["ERR_CAP_EXCEEDED: mandate"] });
    b.fakeVault.storage.set("sandbox-payer.near", { total: 1n, available: 10n ** 22n });
    const rej = await md.simulateMandateFunding(b, c, { subscriptionId: s.id });
    expect(rej).toMatchObject({ accepted: false, rejection: "ERR_CAP_EXCEEDED: mandate" });
    expect(await code(md.simulateMandateFunding(b, { ...c, scope: LIVE }, { subscriptionId: s.id }))).toBe(
      "livemode_forbidden",
    );
  });

  it("payer actions: top up, cancel, withdraw (vault errors in rejection)", async () => {
    const { m } = await linked();
    b.fakeSandbox.outcomes.push({ txHash: "t", failure: "ERR_STILL_ACTIVE", vaultLogs: [] });
    expect(await md.simulateMandatePayerAction(b, c, m.id, { action: "withdraw" })).toMatchObject({
      accepted: false,
      rejection: "ERR_STILL_ACTIVE",
    });
    await md.simulateMandatePayerAction(b, c, m.id, { action: "top_up", periods: 2 });
    expect(b.fakeSandbox.calls.at(-1)?.body).toMatchObject({
      payer: "alice.near",
      amount: 50_000_000n,
      msg: '{"top_up":{"mandate_id":7}}',
    });
    await md.simulateMandatePayerAction(b, c, m.id, { action: "cancel" });
    expect(b.fakeSandbox.calls.at(-1)?.body).toMatchObject({
      signer: "alice.near",
      method: "cancel",
      args: { mandate_id: 7 },
      deposit: "1",
    });
  });

  it("reads, merchant cancel, payer view and mail context", async () => {
    const { m, first, s } = await linked();
    expect((await md.getMandate(b, c, m.id)).id).toBe(m.id);
    expect((await md.listMandates(b, c, { limit: 10, subscription: s.id })).data).toHaveLength(1);
    expect(await code(md.getMandate(b, { ...c, scope: LIVE }, m.id))).toBe("resource_missing");
    const cancel = await md.prepareMandateCancel(b, c, m.id);
    expect(cancel.transaction).toMatchObject({ signerId: "acme.near", methodName: "cancel" });
    const secret = inv.invoiceSecretOf(b, first) as string;
    const pub = await md.getPublicInvoiceMandate(b, first.id, secret);
    expect(pub.collecting).toBe(true);
    expect(pub.tx.cancel?.signerId).toBe("alice.near");
    expect(pub.tx.withdraw).toBeNull();
    expect(pub.tokenAsset).toEqual({ assetId: "nep141:usdc.near", symbol: "USDC", decimals: 6 });
    expect(await md.publicAutoDebit(b, invoice(first.id))).toEqual({
      available: false,
      mandate: m.id,
      collecting: true,
    });
    const ctx = await mandateNotificationContext(b, m.id);
    expect(ctx).toMatchObject({ customerEmail: "payer@example.com", merchantDisplayName: "Acme Corp" });
    expect(ctx.manageUrl).toMatch(/^https:\/\/pay\.nearpay\.test\/i\//);
    await deliver(record(ev("canceled", { mandate_id: 7, by: "acme.near", refunded: "0" })));
    expect(await code(md.prepareMandateCancel(b, c, m.id))).toBe("state_conflict");
    const closed = await md.getPublicInvoiceMandate(b, first.id, secret);
    expect(closed.tx.withdraw?.methodName).toBe("withdraw");
    expect(closed.tx.cancel).toBeNull();
  });
});

void DAY;
