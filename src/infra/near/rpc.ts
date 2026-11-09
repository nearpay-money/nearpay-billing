/**
 * NEAR JSON-RPC client for the keeper (lld/billing.md v1.7 §7, §14 d12–d13; spec `internal/vault.ts`
 * `NearRpcRequest`/`NearRpcResponse`). Exactly the subset the spec lists: `block`, `query` (`call_function`,
 * `view_access_key`), `send_tx`, `tx`. Live mode talks to NEAR RPC providers (tried in order); test mode to
 * the sandbox stand-in `POST /sim/near-rpc` (identical shapes; billing's service token, scope `sandbox.use`).
 * Responses are validated with the spec schemas; anything unexpected is an error, never a guess.
 */
import { HEADERS } from "@nearpay/spec";
import {
  NearAccessKeyResult,
  NearBlockResult,
  NearCallFunctionResult,
  NearFinalExecutionOutcome,
  type NearRpcRequest,
} from "@nearpay-internal/spec";

export class NearRpcError extends Error {
  constructor(
    message: string,
    /** JSON-RPC structured error `cause.name` (e.g. `UNKNOWN_TRANSACTION`, `INVALID_TRANSACTION`), if any. */
    readonly causeName: string | null,
    /** True when no provider answered (transport / timeout / HTTP error). */
    readonly transport: boolean,
  ) {
    super(message);
    this.name = "NearRpcError";
  }
}

export interface NearRpcOptions {
  readonly urls: readonly string[];
  readonly timeoutMs?: number | undefined;
  /** Billing's service token for the sandbox stand-in (sent as `X-NearPay-Token`). */
  readonly bearer?: (() => Promise<string>) | undefined;
  readonly fetch?: typeof fetch | undefined;
}

type Method = NearRpcRequest["method"];

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

export function nearRpc(o: NearRpcOptions) {
  if (o.urls.length === 0) throw new RangeError("at least one NEAR RPC URL is required");
  const f = o.fetch ?? fetch;
  let seq = 0;

  async function call(method: Method, params: unknown, timeoutMs = o.timeoutMs ?? 5_000): Promise<unknown> {
    const failures: string[] = [];
    for (const url of o.urls) {
      let res: Response;
      try {
        const headers: Record<string, string> = { "content-type": "application/json" };
        // internal service token (spec `HEADERS.token`); `Authorization` is for public API keys only
        if (o.bearer) headers[HEADERS.token] = await o.bearer();
        res = await f(url, {
          method: "POST",
          headers,
          body: JSON.stringify({ jsonrpc: "2.0", id: `billing-${++seq}`, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        failures.push(`${new URL(url).host}: ${(e as Error).message}`);
        continue;
      }
      if (!res.ok) {
        failures.push(`${new URL(url).host}: HTTP ${res.status}`);
        continue;
      }
      const json = (await res.json().catch(() => null)) as {
        result?: unknown;
        error?: { name?: string; cause?: { name?: string }; message?: string; data?: unknown };
      } | null;
      if (!json) {
        failures.push(`${new URL(url).host}: invalid JSON`);
        continue;
      }
      if (json.error) {
        const cause = json.error.cause?.name ?? null;
        // a provider timeout is transport-like (the transaction may still execute)
        if (cause === "TIMEOUT_ERROR") {
          failures.push(`${new URL(url).host}: TIMEOUT_ERROR`);
          continue;
        }
        throw new NearRpcError(`${method}: ${JSON.stringify(json.error).slice(0, 500)}`, cause, false);
      }
      return json.result;
    }
    throw new NearRpcError(`${method}: no NEAR RPC provider answered (${failures.join("; ")})`, null, true);
  }

  return {
    /** Latest final block (hash and time). */
    async block() {
      const r = NearBlockResult.parse(await call("block", { finality: "final" }));
      return { height: r.header.height, hash: r.header.hash, timestampNs: BigInt(r.header.timestamp_nanosec) };
    },
    /** A view call; the JSON result (validated by the caller). */
    async view(accountId: string, method: string, args: unknown): Promise<unknown> {
      const r = NearCallFunctionResult.parse(
        await call("query", {
          request_type: "call_function",
          finality: "final",
          account_id: accountId,
          method_name: method,
          args_base64: b64(new TextEncoder().encode(JSON.stringify(args))),
        }),
      );
      return JSON.parse(new TextDecoder().decode(Uint8Array.from(r.result)));
    },
    /** The access key (nonce, permission, recent block hash); null when the key is unknown. */
    async accessKey(accountId: string, publicKey: string) {
      try {
        return NearAccessKeyResult.parse(
          await call("query", {
            request_type: "view_access_key",
            finality: "final",
            account_id: accountId,
            public_key: publicKey,
          }),
        );
      } catch (e) {
        if (e instanceof NearRpcError && e.causeName === "UNKNOWN_ACCESS_KEY") return null;
        throw e;
      }
    },
    /** Broadcasts a signed transaction and waits for `FINAL`. */
    async sendTx(bytes: Uint8Array, timeoutMs = 20_000) {
      return NearFinalExecutionOutcome.parse(
        await call("send_tx", { signed_tx_base64: b64(bytes), wait_until: "FINAL" }, timeoutMs),
      );
    },
    /** Final status of a transaction; null when the RPC does not know it. */
    async tx(txHash: string, senderId: string) {
      try {
        return NearFinalExecutionOutcome.parse(
          await call("tx", { tx_hash: txHash, sender_account_id: senderId, wait_until: "FINAL" }, 10_000),
        );
      } catch (e) {
        if (e instanceof NearRpcError && e.causeName === "UNKNOWN_TRANSACTION") return null;
        throw e;
      }
    },
  };
}

export type NearRpc = ReturnType<typeof nearRpc>;
