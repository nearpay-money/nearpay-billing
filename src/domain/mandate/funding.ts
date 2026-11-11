/**
 * What the payer (or the merchant receiver) signs (lld/billing.md v1.7 §5, §14 d4–d5, d8–d9;
 * contracts-vault.md v1.6 §3.1, §3.4, §3.7). The `msg` is built with the spec's `vaultMsgJson` (compact JSON,
 * the contract's key order) and checked against the vault's own rules before it is handed out, so a
 * prepared funding is never refunded for a malformed message. NearPay holds no key that could move these
 * funds (INV-1): every transaction here is signed by the payer or the merchant receiver. Pure.
 */
import {
  MANDATE_FUNDING_PAYER_NOTICE,
  ONE_YOCTO,
  VAULT_GAS,
  VAULT_LIMITS,
  VaultCreateMandateArgs,
  vaultMsgJson,
} from "@nearpay-money/spec";
import { DomainError } from "../shared.js";
import type { Terms } from "./terms.js";

export const DEFAULT_FUNDED_PERIODS = 3;
export const MAX_FUNDED_PERIODS = 36;

/** A NEAR function-call transaction for a wallet (spec `NearTransactionRequest`, snake_case). */
export interface NearTx {
  readonly signerId: string | null;
  readonly receiverId: string;
  readonly methodName: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly gas: string;
  readonly deposit: string;
}

/** The vault's caps for the token (`get_config` caps entry + `get_token_tvl`). */
export interface VaultCaps {
  readonly mandateCap: bigint;
  readonly tvlCap: bigint;
  readonly tvl: bigint;
}

/** NEP-145 storage of the payer on the vault (`storage_balance_of`; null = not registered). */
export interface PayerStorage {
  readonly total: bigint;
  readonly available: bigint;
}

export interface Funding {
  readonly terms: Terms;
  readonly vaultContract: string;
  readonly periods: number;
  readonly amount: bigint;
  readonly msg: string;
  readonly payer: string | null;
  readonly payerRegistered: boolean | null;
  readonly storageDeposit: bigint;
  readonly payerNotice: string;
  readonly transactions: readonly NearTx[];
}

/** The `create_mandate` msg for these terms; validated against the vault's msg schema and limits. */
export function createMandateMsg(t: Terms): string {
  const args = {
    merchant_receiver: t.merchantReceiver,
    receiver_kind: t.receiverKind,
    amount_per_period: t.amountPerPeriod.toString(),
    period_secs: t.periodSecs,
    start_at: t.startAtNs === null ? null : t.startAtNs.toString(),
    max_periods: t.maxPeriods,
    fee_bps: t.feeBps,
    ext_ref: t.extRef,
  };
  // the vault rejects (refunds) anything its parser refuses: check with the mirrored schema first
  const parsed = VaultCreateMandateArgs.safeParse(args);
  if (!parsed.success) throw new Error(`prepared create_mandate violates the vault msg rules: ${parsed.error.message}`);
  const msg = vaultMsgJson({ create_mandate: args });
  if (new TextEncoder().encode(msg).length > VAULT_LIMITS.max_msg_len) throw new Error("prepared msg too long");
  return msg;
}

/** yoctoNEAR the payer still has to deposit: registration (if new) + one mandate's lock − what is available. */
export function storageDepositNeeded(storage: PayerStorage | null | undefined): bigint {
  const perMandate = BigInt(VAULT_LIMITS.mandate_storage_cost);
  if (!storage) return BigInt(VAULT_LIMITS.storage_registration_cost) + perMandate;
  return storage.available >= perMandate ? 0n : perMandate - storage.available;
}

/**
 * The funding instructions (§14 d5). `periods` 1–36 (default 3); `amount_per_period` above the per-mandate
 * cap is `auto_debit_unavailable`, a funding above the per-mandate cap or the remaining TVL headroom is
 * `vault_cap_exceeded`. `storage` undefined = no payer given (the storage transaction is always included).
 */
export function fundingInstructions(o: {
  readonly terms: Terms;
  readonly vaultContract: string;
  readonly periods?: number | undefined;
  readonly caps: VaultCaps;
  readonly payer: string | null;
  readonly storage: PayerStorage | null | undefined;
  readonly subscriptionId: string;
}): Funding {
  const periods = o.periods ?? DEFAULT_FUNDED_PERIODS;
  if (!Number.isInteger(periods) || periods < 1 || periods > MAX_FUNDED_PERIODS)
    throw new DomainError("invalid_request", { detail: `periods must be 1–${MAX_FUNDED_PERIODS}` }, "periods");
  const t = o.terms;
  if (t.amountPerPeriod > o.caps.mandateCap)
    throw new DomainError("auto_debit_unavailable", {
      subscription: o.subscriptionId,
      reason: "the per-period total exceeds the vault's per-mandate cap",
    });
  const amount = BigInt(periods) * t.amountPerPeriod;
  const headroom = o.caps.tvlCap > o.caps.tvl ? o.caps.tvlCap - o.caps.tvl : 0n;
  if (amount > o.caps.mandateCap)
    throw new DomainError(
      "vault_cap_exceeded",
      { amount: amount.toString(), cap: "per-mandate", token: t.assetId },
      "periods",
    );
  if (amount > headroom)
    throw new DomainError("vault_cap_exceeded", { amount: amount.toString(), cap: "TVL", token: t.assetId }, "periods");
  const msg = createMandateMsg(t);
  const deposit = o.payer === null ? storageDepositNeeded(null) : storageDepositNeeded(o.storage);
  const txs: NearTx[] = [];
  if (o.payer === null || deposit > 0n)
    txs.push({
      signerId: null,
      receiverId: o.vaultContract,
      methodName: "storage_deposit",
      args: {},
      gas: VAULT_GAS.storage_deposit,
      deposit: deposit.toString(),
    });
  txs.push({
    signerId: null,
    receiverId: t.token,
    methodName: "ft_transfer_call",
    args: { receiver_id: o.vaultContract, amount: amount.toString(), msg },
    gas: VAULT_GAS.ft_transfer_call,
    deposit: ONE_YOCTO,
  });
  return {
    terms: t,
    vaultContract: o.vaultContract,
    periods,
    amount,
    msg,
    payer: o.payer,
    payerRegistered: o.payer === null ? null : Boolean(o.storage),
    storageDeposit: deposit,
    payerNotice: MANDATE_FUNDING_PAYER_NOTICE,
    transactions: txs,
  };
}

/** `cancel({mandate_id})` signed by the payer or the merchant receiver (100 Tgas, 1 yoctoNEAR; §3.4). */
export function cancelTx(vaultContract: string, onchainId: number, signer: string): NearTx {
  return {
    signerId: signer,
    receiverId: vaultContract,
    methodName: "cancel",
    args: { mandate_id: onchainId },
    gas: VAULT_GAS.exit,
    deposit: ONE_YOCTO,
  };
}

/** `withdraw({mandate_id})` signed by the payer after cancel/exhaustion. */
export function withdrawTx(vaultContract: string, onchainId: number, payer: string): NearTx {
  return { ...cancelTx(vaultContract, onchainId, payer), methodName: "withdraw" };
}

/** `{"top_up":{"mandate_id":n}}`. */
export const topUpMsg = (onchainId: number): string => vaultMsgJson({ top_up: { mandate_id: onchainId } });
