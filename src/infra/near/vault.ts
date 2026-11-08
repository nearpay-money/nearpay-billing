/**
 * The vault adapter (lld/billing.md v1.7 §7, §8, §14 d12–d13): views and the keeper's `collect` for the
 * mainnet vault (live mode) and the sandbox stand-in (test mode) through the same JSON-RPC client.
 *
 * Keeper key (INV-1): a funded NEAR account used only for gas, read from a secret file (never logged, never
 * committed). In live mode its access key must be a function-call key for the vault (methods `collect`
 * only, or any method of the vault — the keeper account is neither payer nor receiver of any mandate);
 * a full-access key is refused, so the process cannot be used to move funds even if misconfigured. The
 * stand-in has no permission model (keys register on first use), so test mode skips that check.
 */
import { KeyPair, PublicKey } from "@near-js/crypto";
import { actionCreators, createTransaction, Signature, SignedTransaction } from "@near-js/transactions";
import { sha256 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";
import type { CollectTxResult, SignedCollect, VaultConfigFacts, VaultPort } from "../../app/ports.js";
import { type NearFinalExecutionOutcome, VAULT_GAS, VAULT_VIEWS, vaultErrorCodeOf } from "../../spec-0.4.0.js";
import { type NearRpc, NearRpcError } from "./rpc.js";

export interface KeeperKey {
  readonly accountId: string;
  readonly keyPair: KeyPair;
}

/**
 * Parses the keeper key file's content (`NP_KEEPER_KEY_FILE`): near-cli credentials JSON
 * (`{"account_id", "private_key": "ed25519:…"}`) or a bare `ed25519:<base58>` secret key (then `accountId`
 * must be configured). Errors never include the key.
 */
export function parseKeeperKey(content: string, accountId: string | undefined): KeeperKey {
  const raw = content.trim();
  let secret = raw;
  let account = accountId;
  if (raw.startsWith("{")) {
    const j = JSON.parse(raw) as { account_id?: string; private_key?: string; secret_key?: string };
    secret = j.private_key ?? j.secret_key ?? "";
    account = accountId ?? j.account_id;
  }
  if (!account) throw new Error("keeper key: account id missing (NP_KEEPER_ACCOUNT or account_id in the file)");
  if (!secret.startsWith("ed25519:")) throw new Error("keeper key: expected an ed25519 secret key");
  try {
    return { accountId: account, keyPair: KeyPair.fromString(secret as `ed25519:${string}`) };
  } catch {
    throw new Error("keeper key: not a valid ed25519 secret key");
  }
}

/** A throwaway key for the sandbox stand-in (it registers keys on first use; test mode only). */
export function ephemeralKeeperKey(accountId: string): KeeperKey {
  return { accountId, keyPair: KeyPair.fromRandom("ed25519") };
}

export interface VaultTarget {
  readonly rpc: NearRpc;
  readonly contract: string;
  readonly keeper: KeeperKey | null;
  /** Live mode: refuse full-access keeper keys and keys not scoped to the vault (INV-1). */
  readonly strictKeyPermission: boolean;
}

/** The vault error code of a failed outcome (the first panic in the status or a receipt), else null. */
export function failureOf(o: NearFinalExecutionOutcome): { message: string } | null {
  const msgOf = (s: unknown): string | null => {
    if (!s || typeof s !== "object" || !("Failure" in s)) return null;
    return JSON.stringify((s as { Failure: unknown }).Failure);
  };
  const top = msgOf(o.status);
  if (top) return { message: top };
  return null;
}

/** Classifies a final outcome of the keeper's `collect`. */
export function classifyOutcome(txHash: string, o: NearFinalExecutionOutcome): CollectTxResult {
  const f = failureOf(o);
  if (!f)
    return o.status === "Unknown" ? { kind: "unknown", txHash, error: "status Unknown" } : { kind: "success", txHash };
  return { kind: "failure", txHash, code: vaultErrorCodeOf(f.message), message: f.message };
}

/** The larger of two bigints (no `Math.max` for bigint). */
function maxBig(a: bigint, b: bigint): bigint {
  if (a >= b) return a;
  return b;
}

export function nearVault(targets: { readonly live: VaultTarget; readonly test: VaultTarget }): VaultPort {
  const t = (livemode: boolean) => (livemode ? targets.live : targets.test);
  // one signer per process: serialise nonce allocation so parallel collects never reuse a nonce
  const lastNonce = new Map<string, bigint>();
  let lock: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const p = lock.then(f, f);
    lock = p.catch(() => undefined);
    return p;
  };
  const view = async <M extends keyof typeof VAULT_VIEWS>(livemode: boolean, method: M, args: unknown) =>
    VAULT_VIEWS[method].parse(await t(livemode).rpc.view(t(livemode).contract, method, args));

  return {
    contract: (livemode) => t(livemode).contract,
    keeperEnabled: (livemode) => t(livemode).keeper !== null,
    async config(livemode): Promise<VaultConfigFacts> {
      const c = (await view(livemode, "get_config", {})) as {
        allowed_tokens: string[];
        max_fee_bps: number;
        caps: { token: string; cap: string; mandate_cap: string }[];
      };
      return {
        allowedTokens: c.allowed_tokens,
        maxFeeBps: c.max_fee_bps,
        caps: new Map(c.caps.map((x) => [x.token, { cap: BigInt(x.cap), mandateCap: BigInt(x.mandate_cap) }])),
      };
    },
    async tokenTvl(livemode, token) {
      const r = (await view(livemode, "get_token_tvl", { token })) as { tvl: string; cap: string } | null;
      return r ? { tvl: BigInt(r.tvl), cap: BigInt(r.cap) } : null;
    },
    async storageBalanceOf(livemode, account) {
      const r = (await view(livemode, "storage_balance_of", { account_id: account })) as {
        total: string;
        available: string;
      } | null;
      return r ? { total: BigInt(r.total), available: BigInt(r.available) } : null;
    },
    async nextCollectAt(livemode, onchainId) {
      const r = (await view(livemode, "next_collect_at", { mandate_id: onchainId })) as string | null;
      return r === null ? null : BigInt(r);
    },
    async mandateView(livemode, onchainId) {
      const r = (await view(livemode, "get_mandate", { mandate_id: onchainId })) as { status: string } | null;
      return r ? { status: r.status } : null;
    },
    async blockTimeNs(livemode) {
      return (await t(livemode).rpc.block()).timestampNs;
    },
    signCollect(livemode, onchainId): Promise<SignedCollect> {
      const target = t(livemode);
      const key = target.keeper;
      if (!key) return Promise.reject(new Error(`no keeper key for ${livemode ? "live" : "test"} mode`));
      return serial(async () => {
        const pub = key.keyPair.getPublicKey().toString();
        const ak = await target.rpc.accessKey(key.accountId, pub);
        if (target.strictKeyPermission) {
          if (!ak) throw new Error("keeper access key unknown to NEAR RPC");
          const p = ak.permission;
          if (p === "FullAccess") throw new Error("ALERT keeper key is a full-access key: refused (INV-1)");
          if (p.FunctionCall.receiver_id !== target.contract) throw new Error("keeper key is not scoped to the vault");
          if (p.FunctionCall.method_names.some((m) => m !== "collect"))
            throw new Error("keeper key allows methods other than collect");
        }
        const blockHash = ak ? ak.block_hash : (await target.rpc.block()).hash;
        const k = `${livemode}:${key.accountId}:${pub}`;
        const nonce = maxBig(BigInt(ak?.nonce ?? 0) + 1n, (lastNonce.get(k) ?? 0n) + 1n);
        lastNonce.set(k, nonce);
        const tx = createTransaction(
          key.accountId,
          PublicKey.fromString(pub),
          target.contract,
          nonce,
          [actionCreators.functionCall("collect", { mandate_id: onchainId }, BigInt(VAULT_GAS.keeper_collect), 0n)],
          bs58.decode(blockHash),
        );
        const hash = sha256(tx.encode());
        const signed = new SignedTransaction({
          transaction: tx,
          signature: new Signature({ keyType: 0, data: key.keyPair.sign(hash).signature }),
        });
        return { txHash: bs58.encode(hash), bytes: signed.encode() };
      });
    },
    async send(livemode, signed): Promise<CollectTxResult> {
      try {
        return classifyOutcome(signed.txHash, await t(livemode).rpc.sendTx(signed.bytes));
      } catch (e) {
        if (e instanceof NearRpcError && !e.transport && e.causeName === "INVALID_TRANSACTION")
          return { kind: "failure", txHash: signed.txHash, code: null, message: e.message };
        return { kind: "unknown", txHash: signed.txHash, error: e instanceof Error ? e.message : String(e) };
      }
    },
    async status(livemode, txHash): Promise<CollectTxResult> {
      const target = t(livemode);
      if (!target.keeper) return { kind: "unknown", txHash, error: "no keeper key" };
      const o = await target.rpc.tx(txHash, target.keeper.accountId);
      return o ? classifyOutcome(txHash, o) : { kind: "unknown", txHash, error: "UNKNOWN_TRANSACTION" };
    },
  };
}
