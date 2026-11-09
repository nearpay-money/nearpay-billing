import { describe, expect, it } from "vitest";
import { nextReminder, reminderToSend, reminderWaitsForEarlier } from "../../src/domain/dunning/dunning.js";
import {
  type Invoice,
  markPaidByCollection,
  newDraft,
  voidAfterShortCollection,
} from "../../src/domain/invoice/invoice.js";
import {
  classifyCollection,
  evidenceOf,
  fallbackToSendInvoice,
  isShort,
  switchToAutoDebit,
} from "../../src/domain/mandate/collection.js";
import {
  cancelTx,
  createMandateMsg,
  fundingInstructions,
  storageDepositNeeded,
  topUpMsg,
  withdrawTx,
} from "../../src/domain/mandate/funding.js";
import {
  afterCollectFailed,
  clearPending,
  dueCheck,
  errorBackoff,
  keeperErrorsAfter,
  markSent,
  onTxFailure,
  planCollect,
} from "../../src/domain/mandate/keeper.js";
import {
  applyCanceled,
  applyCollected,
  applyCollectFailed,
  applyExhausted,
  applyToppedUp,
  applyWithdrawn,
  type Collection,
  canceledByRole,
  expectedShare,
  fundedPeriods,
  isCollecting,
  liveStatus,
  nextCollectAt,
  release,
} from "../../src/domain/mandate/mandate.js";
import {
  computeTerms,
  decideLink,
  fromTokenUnitsCeil,
  prepareTerms,
  receiverDestination,
  tokenOfAsset,
  toTokenUnits,
  vaultPricingProblem,
} from "../../src/domain/mandate/terms.js";
import { DomainError } from "../../src/domain/shared.js";
import { SCOPE, T0 } from "../support/fixtures.js";
import { autoDebitSub, created, DEST, linkInput, mandate, meta, termsInput, VAULT } from "../support/mandates.js";

const DAY = 86_400;
const coll = (o: Partial<Collection> = {}): Collection => ({
  period: 1,
  amount: 10_000_000n,
  merchantShare: 9_900_000n,
  fee: 100_000n,
  short: false,
  invoiceId: null,
  txHash: "tx",
  receiptId: "r1",
  collectedAt: T0,
  ...o,
});

function openInvoice(o: Partial<Invoice> = {}): Invoice {
  const d = newDraft(SCOPE, "in_00000000000000000000000001", T0, {
    currency: "usd",
    assetId: null,
    customerId: "cus_00000000000000000000000001",
    subscriptionId: "sub_00000000000000000000000001",
    lines: [],
    totals: { subtotal: 1000n, tax: 0n, total: 1000n, totalExcludingTax: 1000n, totalTaxAmounts: [] },
    collectionMethod: "auto_debit",
    mandateId: "md_00000000000000000000000001",
  });
  return { ...d, status: "open", number: "ACME-1", finalizedAt: T0, dueDate: T0 + 7 * DAY, ...o };
}

describe("mandate mirror", () => {
  it("starts from mandate_created: balance, status by funded periods, linkage", () => {
    const m = mandate();
    expect(m.balance).toBe(30_000_000n);
    expect(m.status).toBe("active");
    expect(fundedPeriods(m)).toBe(3);
    expect(isCollecting(m)).toBe(true);
    expect(mandate({}, { balance: 1n }).status).toBe("insufficient");
    expect(liveStatus(10n, 10n)).toBe("active");
  });

  it("takes absolute balances only from events not older than the last one", () => {
    const m = mandate();
    const up = applyToppedUp(m, 50_000_000n, meta({ blockHeight: 120 }), T0);
    expect(up.balance).toBe(50_000_000n);
    const stale = applyToppedUp(up, 40_000_000n, meta({ blockHeight: 110 }), T0);
    expect(stale.balance).toBe(50_000_000n);
    expect(stale.lastEventHeight).toBe(120);
  });

  it("collected counts the period, resets the failure streak and clears the pending collect", () => {
    let m = markSent(mandate(), "in_1", "tx1", T0);
    m = applyCollectFailed(m, meta(), T0 + 10);
    expect(m.keeper.collectFailures).toBe(1);
    expect(m.keeper.collectFailuresSince).toBe(T0 + 10);
    expect(m.keeper.pendingTxHash).toBeNull();
    m = markSent(m, "in_1", "tx2", T0 + 100);
    const after = applyCollected(m, coll(), 20_000_000n, meta({ blockHeight: 130 }), T0 + 200);
    expect(after.collectedPeriods).toBe(1);
    expect(after.balance).toBe(20_000_000n);
    expect(after.keeper).toMatchObject({
      collectFailures: 0,
      collectFailuresSince: null,
      pendingTxHash: null,
      collectingInvoiceId: null,
    });
    expect(after.lastCollection?.receiptId).toBe("r1");
    // an older collection never replaces the latest
    const older = applyCollected(after, coll({ period: 1, receiptId: "r0" }), 1n, meta({ blockHeight: 90 }), T0);
    expect(older.lastCollection?.receiptId).toBe("r1");
    expect(older.balance).toBe(20_000_000n);
  });

  it("canceled is final: refunded is subtracted (0 = refund failed, balance stays); withdrawn after", () => {
    const m = mandate();
    const failed = applyCanceled(m, "alice.near", 0n, meta(), T0);
    expect(failed.status).toBe("canceled");
    expect(failed.balance).toBe(30_000_000n);
    expect(canceledByRole(failed, "alice.near")).toBe("payer");
    expect(canceledByRole(failed, "acme.near")).toBe("merchant_receiver");
    const w = applyWithdrawn(failed, 30_000_000n, meta(), T0);
    expect(w.balance).toBe(0n);
    expect(w.withdrawn).toBe(30_000_000n);
    expect(applyCanceled(m, "alice.near", 30_000_000n, meta(), T0).balance).toBe(0n);
    expect(applyExhausted(failed, meta(), T0).status).toBe("canceled");
    expect(applyCanceled(applyExhausted(m, meta(), T0), "alice.near", 0n, meta(), T0).status).toBe("exhausted");
    expect(applyToppedUp(failed, 99n, meta({ blockHeight: 200 }), T0).status).toBe("canceled");
    expect(isCollecting(failed)).toBe(false);
    expect(nextCollectAt(failed)).toBeNull();
  });

  it("next due time from the mirror; none after max_periods", () => {
    const m = mandate();
    expect(nextCollectAt(m)).toBe(T0);
    expect(nextCollectAt({ ...m, collectedPeriods: 2 })).toBe(T0 + 2 * 2_629_746);
    expect(nextCollectAt({ ...m, maxPeriods: 2, collectedPeriods: 2 })).toBeNull();
  });

  it("release stops collecting once; unlinked mandates are never released", () => {
    const m = mandate();
    const r = release(m, T0 + 5) as NonNullable<ReturnType<typeof release>>;
    expect(r.releasedAt).toBe(T0 + 5);
    expect(isCollecting(r)).toBe(false);
    expect(release(r, T0 + 6)).toBeNull();
    expect(release({ ...m, linkStatus: "unlinked", unlinkedReason: "fee_mismatch" }, T0)).toBeNull();
  });

  it("expected share is the vault split", () => {
    expect(expectedShare(mandate())).toBe(9_900_000n);
    expect(isShort(mandate(), 9_899_999n)).toBe(true);
    expect(isShort(mandate(), 9_900_000n)).toBe(false);
  });
});

describe("prepared terms", () => {
  it("USD at par in USDC: cents × 10^(decimals − 2), fee, receiver, start now while the latest invoice is open", () => {
    const t = computeTerms(termsInput());
    expect(t).toMatchObject({
      token: "usdc.near",
      assetId: "nep141:usdc.near",
      amountPerPeriod: 10_000_000n,
      periodSecs: 2_629_746,
      feeBps: 100,
      merchantReceiver: "acme.near",
      settlementDestinationId: DEST.id,
      extRef: "sub_00000000000000000000000001",
      startAtNs: null,
      maxPeriods: null,
    });
  });

  it("start_at = current period end in real time when the latest invoice is paid (clock offset translated)", () => {
    const sub = autoDebitSub({ currentPeriodEnd: T0 + 10 * DAY, clockOffset: 3 * DAY });
    const t = computeTerms(termsInput({ subscription: sub, latestInvoicePayable: false }));
    expect(t.startAtNs).toBe(BigInt(T0 + 7 * DAY) * 1_000_000_000n);
    const far = autoDebitSub({ currentPeriodEnd: T0 + 400 * DAY });
    expect(() => computeTerms(termsInput({ subscription: far, latestInvoicePayable: false }))).toThrow(DomainError);
    const past = autoDebitSub({ currentPeriodEnd: T0 - DAY });
    expect(computeTerms(termsInput({ subscription: past, latestInvoicePayable: false })).startAtNs).toBeNull();
  });

  it("refuses what the vault cannot carry", () => {
    const code = (o: Parameters<typeof termsInput>[0]) => {
      const r = prepareTerms(termsInput(o));
      return r.ok ? "ok" : `${r.problem}:${r.error.code}`;
    };
    expect(code({ subscription: autoDebitSub({ currency: "eur" }) })).toBe("token:auto_debit_unavailable");
    expect(code({ token: "dai.near" })).toBe("token:auto_debit_unavailable");
    expect(code({ token: "usdt.near" })).toBe("destination:destination_not_intents_account");
    expect(
      code({
        token: "usdt.near",
        destinations: [DEST, { ...DEST, id: "sd_usdt", assetId: "nep141:usdt.near" }],
        defaults: { "nep141:usdt.near": "sd_usdt", "*": DEST.id },
      }),
    ).toBe("ok");
    expect(code({ allowedTokens: ["usdt.near"] })).toBe("token:auto_debit_unavailable");
    expect(code({ tokenDecimals: () => undefined })).toBe("token:auto_debit_unavailable");
    expect(code({ tokenDecimals: () => 1 })).toBe("amount:auto_debit_unavailable");
    expect(code({ perPeriodTotal: 0n })).toBe("amount:auto_debit_unavailable");
    expect(code({ feeBps: 501 })).toBe("fee:auto_debit_unavailable");
    expect(code({ feeBps: 10_000, maxFeeBps: 10_000 })).toBe("amount:auto_debit_unavailable");
    expect(code({ destinations: [] })).toBe("destination:destination_not_intents_account");
    expect(code({ destinations: [{ ...DEST, type: "chain_address" }] })).toBe(
      "destination:destination_not_intents_account",
    );
    expect(code({ subscription: autoDebitSub({ collectionMethod: "send_invoice" }) })).toBe("state:state_conflict");
    expect(code({ subscription: autoDebitSub({ status: "canceled" }) })).toBe("state:state_conflict");
    expect(code({ subscription: autoDebitSub({ recurring: { interval: "year", intervalCount: 13 } }) })).toBe(
      "period:auto_debit_unavailable",
    );
  });

  it("asset pricing: the asset's own token 1:1; another token is refused", () => {
    const sub = autoDebitSub({ currency: "asset", assetId: "nep141:usdt.near" });
    expect(
      computeTerms(
        termsInput({
          subscription: sub,
          perPeriodTotal: 5_000_000n,
          destinations: [{ ...DEST, assetId: "nep141:usdt.near" }],
        }),
      ).amountPerPeriod,
    ).toBe(5_000_000n);
    expect(prepareTerms(termsInput({ subscription: sub, token: "usdc.near" })).ok).toBe(false);
    expect(
      prepareTerms(termsInput({ subscription: autoDebitSub({ currency: "asset", assetId: "nep245:x" }) })).ok,
    ).toBe(false);
  });

  it("receiver: the subscription's destination when it fits, else the asset default, else the account default", () => {
    const other = { ...DEST, id: "sd_other", address: "other.near" };
    expect(
      receiverDestination({ settlementDestinationId: "sd_other" }, DEST.assetId, [DEST, other], { "*": DEST.id })?.id,
    ).toBe("sd_other");
    expect(
      receiverDestination({ settlementDestinationId: null }, DEST.assetId, [DEST, other], {
        [DEST.assetId]: "sd_other",
        "*": DEST.id,
      })?.id,
    ).toBe("sd_other");
    expect(
      receiverDestination({ settlementDestinationId: "sd_missing" }, DEST.assetId, [DEST], { "*": DEST.id })?.id,
    ).toBe(DEST.id);
    expect(
      receiverDestination({ settlementDestinationId: null }, "nep141:usdt.near", [DEST], { "*": DEST.id }),
    ).toBeNull();
  });

  it("unit conversion and pricing checks", () => {
    expect(toTokenUnits(1234n, { currency: "usd", assetId: null }, "usdc.near", 6)).toBe(12_340_000n);
    expect(toTokenUnits(1n, { currency: "eur", assetId: null }, "usdc.near", 6)).toBeNull();
    expect(fromTokenUnitsCeil(12_340_001n, { currency: "usd", assetId: null }, 6)).toBe(1235n);
    expect(fromTokenUnitsCeil(7n, { currency: "asset", assetId: "nep141:x" }, 6)).toBe(7n);
    expect(tokenOfAsset("nep141:usdc.near")).toBe("usdc.near");
    expect(tokenOfAsset(null)).toBeNull();
    expect(vaultPricingProblem({ currency: "usd", assetId: null }, ["usdc.near"], ["usdc.near"])).toBeNull();
    expect(vaultPricingProblem({ currency: "usd", assetId: null }, [], [])).not.toBeNull();
    expect(vaultPricingProblem({ currency: "asset", assetId: "nep141:usdc.near" }, [], ["usdc.near"])).toBeNull();
    expect(vaultPricingProblem({ currency: "asset", assetId: "nep141:x.near" }, [], ["usdc.near"])).not.toBeNull();
    expect(vaultPricingProblem({ currency: "eur", assetId: null }, ["usdc.near"], ["usdc.near"])).not.toBeNull();
  });
});

describe("linkage rule (§6)", () => {
  it("links exactly the prepared terms", () => {
    expect(decideLink(created(), linkInput())).toEqual({ linked: true, settlementDestinationId: DEST.id });
    const usdt = { ...DEST, id: "sd_usdt", assetId: "nep141:usdt.near" };
    expect(
      decideLink(
        created({ token: "usdt.near" }),
        linkInput({ destinations: [DEST, usdt], defaults: { "nep141:usdt.near": "sd_usdt", "*": DEST.id } }),
      ).linked,
    ).toBe(true);
    expect(decideLink(created({ token: "usdt.near" }), linkInput())).toEqual({
      linked: false,
      reason: "receiver_not_destination",
    });
  });

  it("names the first failing term", () => {
    const reason = (d: Parameters<typeof created>[0], i: Parameters<typeof linkInput>[0] = {}) => {
      const r = decideLink(created(d), linkInput(i));
      return r.linked ? "linked" : r.reason;
    };
    expect(reason({}, { vaultLivemode: true })).toBe("mode_mismatch");
    expect(reason({}, { subscription: autoDebitSub({ collectionMethod: "send_invoice" }) })).toBe(
      "subscription_not_auto_debit",
    );
    expect(reason({}, { subscription: autoDebitSub({ status: "canceled" }) })).toBe("subscription_ended");
    expect(reason({}, { alreadyLinked: true })).toBe("already_linked");
    expect(reason({ receiverKind: "near_account" })).toBe("receiver_kind_mismatch");
    expect(reason({ merchantReceiver: "evil.near" })).toBe("receiver_not_destination");
    expect(reason({}, { destinations: [] })).toBe("receiver_not_destination");
    expect(reason({ token: "dai.near" })).toBe("token_mismatch");
    expect(reason({ amountPerPeriod: 9_999_999n })).toBe("amount_mismatch");
    expect(reason({ periodSecs: 2_592_000 })).toBe("period_mismatch");
    expect(reason({ feeBps: 0 })).toBe("fee_mismatch");
    expect(reason({}, { feeBps: 900 })).toBe("fee_mismatch");
    expect(reason({ startAtNs: BigInt(T0 + 40 * DAY) * 1_000_000_000n })).toBe("start_too_late");
    expect(reason({ maxPeriods: 12 })).toBe("max_periods_too_low");
    expect(reason({ maxPeriods: 1 }, { subscription: autoDebitSub({ cancelAtPeriodEnd: true }) })).toBe("linked");
    expect(
      reason(
        { maxPeriods: 1 },
        { subscription: autoDebitSub({ cancelAtPeriodEnd: true }), latestInvoicePayable: false },
      ),
    ).toBe("linked");
  });
});

describe("funding instructions", () => {
  const terms = computeTerms(termsInput());
  const caps = { mandateCap: 10n ** 12n, tvlCap: 10n ** 15n, tvl: 0n };
  const base = { terms, vaultContract: VAULT, caps, subscriptionId: "sub_1" };

  it("unknown payer: storage_deposit (registration + one mandate) then ft_transfer_call on the token", () => {
    const f = fundingInstructions({ ...base, payer: null, storage: undefined });
    expect(f.amount).toBe(30_000_000n);
    expect(f.periods).toBe(3);
    expect(f.payerRegistered).toBeNull();
    expect(f.storageDeposit).toBe(12_000_000_000_000_000_000_000n);
    expect(f.transactions.map((t) => [t.receiverId, t.methodName, t.gas, t.deposit])).toEqual([
      [VAULT, "storage_deposit", "30000000000000", "12000000000000000000000"],
      ["usdc.near", "ft_transfer_call", "100000000000000", "1"],
    ]);
    expect(f.transactions[1]?.args).toEqual({ receiver_id: VAULT, amount: "30000000", msg: createMandateMsg(terms) });
    expect(f.payerNotice).toMatch(/own NEAR account/);
    expect(f.transactions.every((t) => t.signerId === null)).toBe(true);
  });

  it("a registered payer with enough storage signs only the transfer", () => {
    const f = fundingInstructions({
      ...base,
      payer: "alice.near",
      storage: { total: 1n, available: 10n ** 22n },
      periods: 1,
    });
    expect(f.transactions).toHaveLength(1);
    expect(f.payerRegistered).toBe(true);
    expect(storageDepositNeeded({ total: 0n, available: 4n * 10n ** 21n })).toBe(6n * 10n ** 21n);
  });

  it("caps: per-period above the mandate cap is unavailable; funding above a cap is vault_cap_exceeded", () => {
    const err = (o: Partial<Parameters<typeof fundingInstructions>[0]>) => {
      try {
        fundingInstructions({ ...base, payer: null, storage: undefined, ...o });
        return "ok";
      } catch (e) {
        return (e as DomainError).code;
      }
    };
    expect(err({ caps: { ...caps, mandateCap: 9_999_999n } })).toBe("auto_debit_unavailable");
    expect(err({ caps: { ...caps, mandateCap: 20_000_000n } })).toBe("vault_cap_exceeded");
    expect(err({ caps: { ...caps, tvl: 10n ** 15n - 1n } })).toBe("vault_cap_exceeded");
    expect(err({ caps: { ...caps, tvl: 10n ** 16n } })).toBe("vault_cap_exceeded");
    expect(err({ periods: 37 })).toBe("invalid_request");
    expect(err({ periods: 0 })).toBe("invalid_request");
    expect(err({ periods: 36 })).toBe("ok");
  });

  it("refuses a msg the vault would reject", () => {
    expect(() => createMandateMsg({ ...terms, extRef: "x".repeat(65) })).toThrow();
    expect(() => createMandateMsg({ ...terms, periodSecs: 3600 })).toThrow();
  });

  it("payer and merchant transactions", () => {
    expect(cancelTx(VAULT, 7, "acme.near")).toEqual({
      signerId: "acme.near",
      receiverId: VAULT,
      methodName: "cancel",
      args: { mandate_id: 7 },
      gas: "100000000000000",
      deposit: "1",
    });
    expect(withdrawTx(VAULT, 7, "alice.near").methodName).toBe("withdraw");
    expect(topUpMsg(7)).toBe('{"top_up":{"mandate_id":7}}');
  });
});

describe("keeper decisions (§7.1)", () => {
  const inv = openInvoice();

  it("plans a collect only for a payable auto-debit invoice of a collecting mandate", () => {
    const m = mandate();
    expect(planCollect(m, inv, T0)).toEqual({ kind: "send" });
    expect(planCollect(m, { ...inv, status: "paid" }, T0).kind).toBe("done");
    expect(planCollect(m, { ...inv, collectionMethod: "send_invoice" }, T0).kind).toBe("done");
    expect(planCollect(m, { ...inv, mandateId: "md_other" }, T0).kind).toBe("done");
    expect(planCollect({ ...m, status: "canceled" }, inv, T0).kind).toBe("fallback");
    expect(planCollect({ ...m, releasedAt: T0 }, inv, T0).kind).toBe("fallback");
    expect(planCollect(markSent(m, inv.id, "tx", T0), inv, T0 + 1000).kind).toBe("wait");
    const spaced = clearPending(markSent(m, inv.id, "tx", T0), T0, "ERR_NOT_DUE");
    expect(planCollect(spaced, inv, T0 + 30)).toMatchObject({ kind: "wait", at: T0 + 60 });
    expect(planCollect(spaced, inv, T0 + 60).kind).toBe("send");
  });

  it("due check against the chain clock", () => {
    expect(dueCheck(100n, 100n)).toEqual({ kind: "send" });
    expect(dueCheck(5_000_000_000n, 1n)).toMatchObject({ kind: "wait", at: 6 });
    expect(dueCheck(null, 1n).kind).toBe("fallback");
  });

  it("maps every vault error per the table; unknown errors retry ×5 then case", () => {
    expect(onTxFailure("ERR_INSUFFICIENT_BALANCE", 0, T0).kind).toBe("fallback_insufficient");
    expect(onTxFailure("ERR_NOT_DUE", 0, T0).kind).toBe("retry_at_next_collect_at");
    expect(onTxFailure("ERR_IN_FLIGHT", 0, T0)).toEqual({ kind: "await_outcome", at: T0 + 30 });
    expect(onTxFailure("ERR_GAS", 0, T0).kind).toBe("alert_gas");
    for (const c of ["ERR_NOT_ACTIVE", "ERR_MAX_PERIODS", "ERR_NOT_FOUND"] as const)
      expect(onTxFailure(c, 0, T0).kind).toBe("reconcile");
    expect(onTxFailure(null, 0, T0)).toEqual({ kind: "retry", at: T0 + 60 });
    expect(onTxFailure("ERR_UNAUTHORIZED", 3, T0)).toEqual({ kind: "retry", at: T0 + 480 });
    expect(onTxFailure(null, 4, T0).kind).toBe("case");
    expect(errorBackoff(1)).toBe(60);
  });

  it("an unlisted vault error keeps the error streak, so the case is reached; ERR_GAS neither counts nor resets", () => {
    const inv = { id: "in_x" };
    let m = mandate();
    let action = onTxFailure("ERR_UNAUTHORIZED", 0, T0);
    for (let i = 0; i < 10 && action.kind === "retry"; i++) {
      const before = m.keeper.keeperErrors;
      m = clearPending(markSent(m, inv.id, `tx${i}`, T0), T0, "ERR_UNAUTHORIZED");
      expect(m.keeper.keeperErrors).toBe(before + 1);
      action = onTxFailure("ERR_UNAUTHORIZED", before, T0);
    }
    expect(action.kind).toBe("case");
    expect(m.keeper.keeperErrors).toBe(5);
    expect(keeperErrorsAfter("ERR_GAS", 3)).toBe(3);
    expect(keeperErrorsAfter(null, 3)).toBe(4);
    for (const c of ["ERR_NOT_DUE", "ERR_IN_FLIGHT", "ERR_INSUFFICIENT_BALANCE", "ERR_NOT_ACTIVE"] as const)
      expect(keeperErrorsAfter(c, 3)).toBe(0);
  });

  it("falls back after 5 collect failures or 24 h", () => {
    const k = (n: number, since: number) => ({ ...mandate().keeper, collectFailures: n, collectFailuresSince: since });
    expect(afterCollectFailed(k(4, T0), T0 + 100)).toEqual({ fallback: false, retryAt: T0 + 160 });
    expect(afterCollectFailed(k(5, T0), T0 + 100).fallback).toBe(true);
    expect(afterCollectFailed(k(1, T0), T0 + DAY).fallback).toBe(true);
  });
});

describe("collections and auto-debit invoices", () => {
  const m = mandate();

  it("paid when the full share covers the invoice; fee-leg failure is still paid", () => {
    expect(classifyCollection(m, coll(), openInvoice(), 6)).toEqual({ kind: "paid", feeLegFailed: false });
    expect(classifyCollection(m, coll({ fee: 0n }), openInvoice(), 6)).toEqual({ kind: "paid", feeLegFailed: true });
  });

  it("short share: shortfall billed gross, rounded up to cents", () => {
    const r = classifyCollection(m, coll({ merchantShare: 4_950_000n, fee: 0n }), openInvoice(), 6);
    expect(r).toEqual({ kind: "short", shortfallToken: 5_050_000n, shortfall: 505n });
    expect(classifyCollection(m, coll({ merchantShare: 4_950_001n, fee: 0n }), openInvoice(), 6)).toMatchObject({
      shortfall: 505n,
    });
    expect(classifyCollection(m, coll({ merchantShare: 4_949_999n, fee: 0n }), openInvoice(), 6)).toMatchObject({
      shortfall: 506n,
    });
    // a period worth less than the invoice is short as well
    expect(classifyCollection(m, coll(), openInvoice({ total: 1001n }), 6)).toMatchObject({
      kind: "short",
      shortfall: 1n,
    });
  });

  it("late, unapplied, mismatch", () => {
    expect(classifyCollection(m, coll(), openInvoice({ status: "paid" }), 6).kind).toBe("late");
    expect(classifyCollection(m, coll(), null, 6).kind).toBe("unapplied");
    expect(classifyCollection(m, coll(), openInvoice({ currency: "eur" }), 6).kind).toBe("mismatch");
  });

  it("paid by collection carries the evidence (no payment intent)", () => {
    const ev = evidenceOf(m, coll());
    const paid = markPaidByCollection(openInvoice(), T0, ev);
    expect(paid).toMatchObject({ status: "paid", amountPaid: 1000n, paymentIntentId: null, mandateCollection: ev });
    expect(() => markPaidByCollection({ ...openInvoice(), status: "void" }, T0, ev)).toThrow(DomainError);
    const voided = voidAfterShortCollection(openInvoice({ status: "uncollectible" }), T0, ev);
    expect(voided).toMatchObject({ status: "void", mandateCollection: ev });
    expect(() => voidAfterShortCollection(openInvoice({ status: "paid" }), T0, ev)).toThrow(DomainError);
  });

  it("no reminder while auto-debit; past reminders are skipped at fallback", () => {
    const inv = openInvoice({ dueDate: T0 + 7 * DAY, finalizedAt: T0 });
    expect(nextReminder(inv)).toBeNull();
    expect(reminderToSend(inv, 1, T0 + 5 * DAY)).toBeNull();
    expect(reminderWaitsForEarlier(inv, 2, T0 + 8 * DAY)).toBe(false);
    const fb = fallbackToSendInvoice(inv, T0 + 7 * DAY + 10);
    expect(fb.collectionMethod).toBe("send_invoice");
    expect(fb.remindersSent).toBe(2); // -3 and 0 passed
    expect(reminderToSend(fb, 3, T0 + 8 * DAY)?.reminder.number).toBe(3);
    expect(() => fallbackToSendInvoice(fb, T0)).toThrow(DomainError);
    const sw = switchToAutoDebit({ ...fb, collectionMethod: "send_invoice" }, "md_x", T0);
    expect(sw).toMatchObject({ collectionMethod: "auto_debit", mandateId: "md_x" });
    expect(() => switchToAutoDebit({ ...fb, subscriptionId: null }, "md_x", T0)).toThrow(DomainError);
  });
});
