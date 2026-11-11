/**
 * Billing's vault code against the spec's test vectors (`test-vectors/vault.json`, the contract's own wire
 * strings; Phase A reads the copy in `test/fixtures/vault.json`, Phase B the published package file).
 */
import { readFileSync } from "node:fs";
import { VAULT_KEEPER_ON_TX_FAILURE } from "@nearpay-internal/spec";
import {
  formatVaultEventLog,
  parseVaultEventLog,
  type VaultEvent,
  vaultErrorCodeOf,
  vaultPeriodSecs,
  vaultSplit,
} from "@nearpay-money/spec";
import { describe, expect, it } from "vitest";
import { createdData } from "../../src/app/vault-events.js";
import { createMandateMsg, topUpMsg } from "../../src/domain/mandate/funding.js";
import { RULES } from "../../src/domain/mandate/keeper.js";
import type { Terms } from "../../src/domain/mandate/terms.js";
import { classifyOutcome } from "../../src/infra/near/vault.js";

const V = JSON.parse(readFileSync(new URL("../fixtures/vault.json", import.meta.url), "utf8")) as {
  events: { case: string; event: VaultEvent; log: string }[];
  msgs: {
    case: string;
    msg: { create_mandate?: Record<string, unknown>; top_up?: { mandate_id: number } };
    json: string;
  }[];
  split: { amount_per_period: string; fee_bps: number; merchant_share: string; fee: string }[];
  period_secs_per_interval: Record<"day" | "week" | "month" | "year", number>;
  errors: { codes: string[]; panic_messages: Record<string, string> | string[] };
  rpc: {
    collect_not_due_status: unknown;
    collect_success: { status: unknown; vault_receipt: { executor_id: string; logs: string[] } };
  };
  keeper: { on_tx_failure: Record<string, string>; rules: Record<string, number> };
};

const outcome = (status: unknown, logs: string[] = []) =>
  ({
    status,
    transaction: { signer_id: "keeper.near", public_key: "ed25519:x", nonce: 1, receiver_id: "v.near", hash: "h" },
    transaction_outcome: {
      id: "h",
      block_hash: "b",
      outcome: {
        logs: [],
        receipt_ids: [],
        gas_burnt: 0,
        tokens_burnt: "0",
        executor_id: "keeper.near",
        status: { SuccessReceiptId: "r" },
      },
    },
    receipts_outcome: [
      {
        id: "r",
        block_hash: "b",
        outcome: {
          logs,
          receipt_ids: [],
          gas_burnt: 0,
          tokens_burnt: "0",
          executor_id: "v1.vault.nearpay.near",
          status,
        },
      },
    ],
  }) as never;

describe("vault vectors", () => {
  it("parses and re-formats every event line byte for byte", () => {
    for (const e of V.events) {
      const parsed = parseVaultEventLog(e.log);
      expect(parsed, e.case).toEqual(e.event);
      expect(formatVaultEventLog(parsed as VaultEvent), e.case).toBe(e.log);
    }
  });

  it("decodes mandate_created into the mirror's numbers (bigint amounts, ns start)", () => {
    const e = V.events.find((x) => x.case === "mandate_created") as { event: VaultEvent };
    const d = createdData({
      vault_contract: "v1.vault.nearpay.near",
      tx_hash: "h",
      receipt_id: "r",
      log_index: 0,
      block_height: 1,
      block_hash: "b",
      block_timestamp: "0",
      event: e.event,
    });
    const raw = e.event.data[0] as Record<string, unknown>;
    expect(d.amountPerPeriod).toBe(BigInt(raw.amount_per_period as string));
    expect(d.startAtNs).toBe(BigInt(raw.start_at as string));
    expect(d.balance).toBe(BigInt(raw.balance as string));
    expect(d.receiverKind).toBe(raw.receiver_kind);
  });

  it("builds the create_mandate msg exactly as the contract serialises it", () => {
    for (const m of V.msgs) {
      if (m.msg.top_up) {
        expect(topUpMsg(m.msg.top_up.mandate_id)).toBe(m.json);
        continue;
      }
      const cm = m.msg.create_mandate as Record<string, unknown>;
      const terms: Terms = {
        token: "usdc.near",
        assetId: "nep141:usdc.near",
        amountPerPeriod: BigInt(cm.amount_per_period as string),
        periodSecs: cm.period_secs as number,
        feeBps: cm.fee_bps as number,
        merchantReceiver: cm.merchant_receiver as string,
        receiverKind: "intents_account",
        settlementDestinationId: "sd_x",
        extRef: cm.ext_ref as string,
        startAtNs: cm.start_at === null ? null : BigInt(cm.start_at as string),
        maxPeriods: cm.max_periods as null,
      };
      expect(createMandateMsg({ ...terms, maxPeriods: (cm.max_periods ?? null) as null }), m.case).toBe(m.json);
    }
  });

  it("splits like the contract and maps intervals to vault periods", () => {
    for (const s of V.split) {
      const r = vaultSplit(BigInt(s.amount_per_period), s.fee_bps);
      expect(r.merchantShare.toString()).toBe(s.merchant_share);
      expect(r.fee.toString()).toBe(s.fee);
    }
    for (const [k, v] of Object.entries(V.period_secs_per_interval)) expect(vaultPeriodSecs(k as "day", 1)).toBe(v);
  });

  it("keeper rules are the spec's data", () => {
    expect(VAULT_KEEPER_ON_TX_FAILURE).toEqual(V.keeper.on_tx_failure);
    expect(RULES).toEqual(V.keeper.rules);
  });

  it("classifies the RPC shapes: ERR_NOT_DUE failure and collect success", () => {
    const notDue = classifyOutcome("h", outcome(V.rpc.collect_not_due_status));
    expect(notDue).toMatchObject({ kind: "failure", code: "ERR_NOT_DUE" });
    const ok = classifyOutcome("h", outcome(V.rpc.collect_success.status, V.rpc.collect_success.vault_receipt.logs));
    expect(ok).toEqual({ kind: "success", txHash: "h" });
    expect(classifyOutcome("h", outcome("Unknown")).kind).toBe("unknown");
  });

  it("finds the vault code in every error string", () => {
    for (const c of V.errors.codes) expect(vaultErrorCodeOf(`Smart contract panicked: ${c}`)).toBe(c);
    expect(vaultErrorCodeOf("ERR_CAP_EXCEEDED: mandate")).toBe("ERR_CAP_EXCEEDED");
  });
});
