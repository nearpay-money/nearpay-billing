/**
 * Property tests for the auto-debit rules (lld/billing.md v1.7 §6, §7.1, §14; INV-2, INV-5):
 * - linkage: the prepared terms always link; any single edited term never does, with the right reason;
 * - the mirror follows a model vault exactly through random event sequences (balances, periods, status);
 * - money: token conversion round-trips, a shortfall is never under-billed, a short share never pays;
 * - keeper: fallback exactly at 5 failures or 24 h; never a second collect while one is pending;
 * - an invoice is `paid` only with evidence (payment intent or vault collection).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Invoice,
  isPayable,
  markPaidByCollection,
  newDraft,
  voidAfterShortCollection,
} from "../../src/domain/invoice/invoice.js";
import { classifyCollection, evidenceOf, fallbackToSendInvoice } from "../../src/domain/mandate/collection.js";
import { afterCollectFailed, markSent, planCollect } from "../../src/domain/mandate/keeper.js";
import {
  applyCanceled,
  applyCollected,
  applyCollectFailed,
  applyExhausted,
  applyToppedUp,
  applyWithdrawn,
  expectedShare,
  type Mandate,
} from "../../src/domain/mandate/mandate.js";
import { computeTerms, decideLink, fromTokenUnitsCeil, toTokenUnits } from "../../src/domain/mandate/terms.js";
import { vaultSplit } from "../../src/spec-0.4.0.js";
import { SCOPE, T0 } from "../support/fixtures.js";
import { autoDebitSub, created, linkInput, mandate, meta, termsInput } from "../support/mandates.js";

const DAY = 86_400;
const intervals = fc.constantFrom("day", "week", "month", "year") as fc.Arbitrary<"day" | "week" | "month" | "year">;

type SubParams = {
  total: bigint;
  interval: "day" | "week" | "month" | "year";
  count: number;
  fee: number;
  payable: boolean;
  offset: number;
  ahead: number;
  usdt: boolean;
};
const subParams: fc.Arbitrary<SubParams> = fc.record({
  total: fc.bigInt({ min: 1n, max: 10_000_000n }),
  interval: intervals,
  count: fc.integer({ min: 1, max: 12 }),
  fee: fc.integer({ min: 0, max: 500 }),
  payable: fc.boolean(),
  offset: fc.integer({ min: 0, max: 30 * DAY }),
  ahead: fc.integer({ min: 1, max: 300 * DAY }),
  usdt: fc.boolean(),
});

function scenario(p: SubParams) {
  const dests = [
    { id: "sd_usdc", assetId: "nep141:usdc.near", type: "intents_account", address: "acme.near" },
    { id: "sd_usdt", assetId: "nep141:usdt.near", type: "intents_account", address: "acme-usdt.near" },
  ];
  const sub = autoDebitSub({
    recurring: { interval: p.interval, intervalCount: p.count },
    currentPeriodEnd: T0 + p.offset + p.ahead,
    clockOffset: p.offset,
  });
  const base = {
    subscription: sub,
    perPeriodTotal: p.total,
    feeBps: p.fee,
    latestInvoicePayable: p.payable,
    destinations: dests,
    defaults: { "nep141:usdt.near": "sd_usdt", "*": "sd_usdc" },
  };
  const t = computeTerms(termsInput({ ...base, token: p.usdt ? "usdt.near" : undefined }));
  const ev = created({
    token: t.token,
    merchantReceiver: t.merchantReceiver,
    amountPerPeriod: t.amountPerPeriod,
    periodSecs: t.periodSecs,
    feeBps: t.feeBps,
    // the vault clamps an omitted start to the block time
    startAtNs: t.startAtNs ?? BigInt(T0) * 1_000_000_000n,
  });
  const li = linkInput(base);
  return { t, ev, li };
}

describe("linkage properties", () => {
  it("prepared terms link; every single edited term is refused with its reason", () => {
    fc.assert(
      fc.property(
        subParams,
        fc.constantFrom("receiver", "token", "amount", "period", "fee", "kind", "late", "max"),
        (p, edit) => {
          const s = scenario(p);
          expect(decideLink(s.ev, s.li)).toMatchObject({ linked: true });
          const e = { ...s.ev };
          const want = {
            receiver: "receiver_not_destination",
            token: "token_mismatch",
            amount: "amount_mismatch",
            period: "period_mismatch",
            fee: "fee_mismatch",
            kind: "receiver_kind_mismatch",
            late: "start_too_late",
            max: "max_periods_too_low",
          }[edit];
          if (edit === "receiver") e.merchantReceiver = "payer-owned.near";
          if (edit === "token") e.token = "fake-usd.near";
          if (edit === "amount") e.amountPerPeriod = s.ev.amountPerPeriod + 1n;
          if (edit === "period") e.periodSecs = s.ev.periodSecs === 86_400 ? 86_401 : s.ev.periodSecs - 1;
          if (edit === "fee") e.feeBps = (s.ev.feeBps + 1) % 501;
          if (edit === "kind") e.receiverKind = "near_account";
          if (edit === "late")
            e.startAtNs =
              BigInt(s.li.subscription.currentPeriodEnd - (s.li.subscription.clockOffset ?? 0) + 1) * 1_000_000_000n;
          if (edit === "max") e.maxPeriods = 1;
          expect(decideLink(e, s.li)).toEqual({ linked: false, reason: want });
        },
      ),
      { numRuns: 300 },
    );
  });

  it("a payer-edited fee never links (A1-L-2)", () => {
    fc.assert(
      fc.property(subParams, fc.integer({ min: 0, max: 10_000 }), (p, fee) => {
        const s = scenario(p);
        fc.pre(fee !== s.ev.feeBps);
        expect(decideLink({ ...s.ev, feeBps: fee }, s.li).linked).toBe(false);
      }),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Mirror vs. a model vault
// ---------------------------------------------------------------------------------------------

type Op =
  | { k: "top_up"; amount: bigint }
  | { k: "collect"; outcome: "full" | "fee_failed" | "partial" | "failed" }
  | { k: "cancel"; refundOk: boolean }
  | { k: "withdraw" };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ k: fc.constant("top_up" as const), amount: fc.bigInt({ min: 1n, max: 50_000_000n }) }),
  fc.record({
    k: fc.constant("collect" as const),
    outcome: fc.constantFrom("full", "fee_failed", "partial", "failed") as fc.Arbitrary<
      "full" | "fee_failed" | "partial" | "failed"
    >,
  }),
  fc.record({ k: fc.constant("cancel" as const), refundOk: fc.boolean() }),
  fc.record({ k: fc.constant("withdraw" as const) }),
);

describe("mirror properties", () => {
  it("follows the vault exactly (balance, periods, status, final states)", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 20_000_000n }),
        fc.integer({ min: 0, max: 500 }),
        fc.option(fc.integer({ min: 1, max: 6 }), { nil: null }),
        fc.bigInt({ min: 0n, max: 100_000_000n }),
        fc.array(opArb, { maxLength: 40 }),
        (app, fee, maxPeriods, funding, ops) => {
          fc.pre(vaultSplit(app, fee).merchantShare > 0n);
          let m: Mandate = mandate({}, { amountPerPeriod: app, feeBps: fee, maxPeriods, balance: funding });
          const v = { balance: funding, periods: 0, status: "active" as "active" | "canceled" | "exhausted" };
          let h = 100;
          for (const op of ops) {
            h += 1;
            const mt = meta({ blockHeight: h });
            if (op.k === "top_up" && v.status === "active") {
              v.balance += op.amount;
              m = applyToppedUp(m, v.balance, mt, T0);
            } else if (op.k === "collect" && v.status === "active" && v.balance >= app) {
              const { merchantShare, fee: f } = vaultSplit(app, fee);
              if (op.outcome === "failed" || (op.outcome === "partial" && merchantShare / 2n === 0n)) {
                m = applyCollectFailed(m, mt, T0);
              } else {
                const share = op.outcome === "partial" ? merchantShare / 2n : merchantShare;
                const paidFee = op.outcome === "full" ? f : 0n;
                v.balance -= share + paidFee;
                v.periods += 1;
                m = applyCollected(
                  m,
                  {
                    period: v.periods,
                    amount: share + paidFee,
                    merchantShare: share,
                    fee: paidFee,
                    short: share < merchantShare,
                    invoiceId: null,
                    txHash: "t",
                    receiptId: `r${h}`,
                    collectedAt: T0,
                  },
                  v.balance,
                  mt,
                  T0,
                );
                if (maxPeriods !== null && v.periods >= maxPeriods) {
                  v.status = "exhausted";
                  m = applyExhausted(m, meta({ blockHeight: h }), T0);
                }
              }
            } else if (op.k === "cancel" && v.status === "active") {
              v.status = "canceled";
              const refunded = op.refundOk ? v.balance : 0n;
              v.balance -= refunded;
              m = applyCanceled(m, "alice.near", refunded, mt, T0);
            } else if (op.k === "withdraw" && v.status !== "active" && v.balance > 0n) {
              const amount = v.balance;
              v.balance = 0n;
              m = applyWithdrawn(m, amount, mt, T0);
            }
            expect(m.balance).toBe(v.balance);
            expect(m.collectedPeriods).toBe(v.periods);
            const want = v.status === "active" ? (v.balance >= app ? "active" : "insufficient") : v.status;
            expect(m.status).toBe(want);
            expect(typeof m.balance).toBe("bigint");
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Money and evidence
// ---------------------------------------------------------------------------------------------

function inv(total: bigint, status: Invoice["status"] = "open"): Invoice {
  return {
    ...newDraft(SCOPE, "in_00000000000000000000000001", T0, {
      currency: "usd",
      assetId: null,
      customerId: "cus_00000000000000000000000001",
      subscriptionId: "sub_00000000000000000000000001",
      lines: [],
      totals: { subtotal: total, tax: 0n, total, totalExcludingTax: total, totalTaxAmounts: [] },
      collectionMethod: "auto_debit",
      mandateId: "md_00000000000000000000000001",
    }),
    status,
    number: "N-1",
    finalizedAt: T0,
    dueDate: T0 + 7 * DAY,
  };
}

describe("money properties", () => {
  it("USD ↔ token units round-trip; a shortfall is never under-billed", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 15n }),
        fc.integer({ min: 2, max: 24 }),
        fc.bigInt({ min: 0n, max: 10n ** 20n }),
        (cents, d, units) => {
          const usd = { currency: "usd", assetId: null };
          expect(fromTokenUnitsCeil(toTokenUnits(cents, usd, "usdc.near", d) as bigint, usd, d)).toBe(cents);
          const billed = fromTokenUnitsCeil(units, usd, d);
          const back = toTokenUnits(billed, usd, "usdc.near", d) as bigint;
          expect(back >= units).toBe(true);
          expect(back - units < 10n ** BigInt(d - 2)).toBe(true);
        },
      ),
    );
  });

  it("a collection pays only a full share covering the invoice; a short share never pays", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 1_000_000n }),
        fc.integer({ min: 0, max: 500 }),
        fc.bigInt({ min: 0n, max: 10n ** 13n }),
        fc.bigInt({ min: 0n, max: 10n ** 13n }),
        fc.boolean(),
        (cents, fee, shareRaw, appExtra, feeFailed) => {
          const app = cents * 10_000n + (appExtra % 3n === 0n ? 0n : appExtra % 10_000_000n);
          fc.pre(vaultSplit(app, fee).merchantShare > 0n);
          const m = mandate({}, { amountPerPeriod: app, feeBps: fee });
          const exp = expectedShare(m);
          const share = shareRaw % (exp + 1n);
          const c = { merchantShare: share, fee: feeFailed || share < exp ? 0n : app - exp };
          const out = classifyCollection(m, c, inv(cents), 6);
          if (share < exp) expect(out.kind).toBe("short");
          if (out.kind === "paid") {
            expect(share).toBe(exp);
            expect(app >= cents * 10_000n).toBe(true);
          }
          if (out.kind === "short") {
            const covered = share < exp ? share : app;
            expect(out.shortfall * 10_000n >= cents * 10_000n - covered).toBe(true);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it("paid ⇒ evidence, whatever the sequence of keeper outcomes", () => {
    type Step = "pay" | "short" | "fallback";
    fc.assert(
      fc.property(fc.array(fc.constantFrom<Step>("pay", "short", "fallback"), { maxLength: 8 }), (steps) => {
        let i = inv(1000n);
        const ev = evidenceOf(mandate(), {
          period: 1,
          amount: 10_000_000n,
          merchantShare: 9_900_000n,
          fee: 100_000n,
          short: false,
          invoiceId: null,
          txHash: "t",
          receiptId: "r",
          collectedAt: T0,
        });
        for (const s of steps) {
          if (!isPayable(i)) break;
          if (s === "pay") i = markPaidByCollection(i, T0, ev);
          if (s === "short") i = voidAfterShortCollection(i, T0, ev);
          if (s === "fallback" && i.collectionMethod === "auto_debit") i = fallbackToSendInvoice(i, T0);
        }
        if (i.status === "paid") expect(i.paymentIntentId !== null || i.mandateCollection !== null).toBe(true);
        if (i.status === "void") expect(i.mandateCollection).not.toBeNull();
      }),
    );
  });
});

describe("keeper properties", () => {
  it("falls back exactly at 5 consecutive failures or 24 h", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 20 }), fc.integer({ min: 0, max: 3 * DAY }), (n, elapsed) => {
        const k = { ...mandate().keeper, collectFailures: n, collectFailuresSince: T0 };
        expect(afterCollectFailed(k, T0 + elapsed).fallback).toBe(n >= 5 || elapsed >= DAY);
      }),
    );
  });

  it("never sends a second collect while one awaits its forwarded outcome", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10 * DAY }), (later) => {
        const m = markSent(mandate(), "in_00000000000000000000000001", "tx", T0);
        expect(planCollect(m, inv(1000n), T0 + later).kind).not.toBe("send");
      }),
    );
  });
});
