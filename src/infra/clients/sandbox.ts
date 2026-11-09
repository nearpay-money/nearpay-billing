/**
 * The sandbox vault stand-in for the test helpers (lld/billing.md v1.7 §14 d12, lld/sandbox.md §3.1):
 * `POST /sim/vault/ft_transfer_call` (simulated payer funding / top-up), `POST /sim/vault/call` (payer
 * cancel/withdraw, storage) and `POST /sim/vault/advance` (mandate clock). Service scope `sandbox.use`.
 * Test mode only by construction: nothing here is reachable from live-mode code paths.
 */

import { SMART_CONTRACT_PANICKED_PREFIX } from "@nearpay/spec";
import { httpClient } from "@nearpay-internal/http";
import {
  type NearFinalExecutionOutcome,
  sandboxVaultAdvance,
  sandboxVaultCall,
  sandboxVaultFtTransferCall,
} from "@nearpay-internal/spec";
import type { SandboxVaultPort, SimOutcome } from "../../app/ports.js";
import type { PeerOptions } from "./peers.js";

const BREAKER = { failureRate: 0.5, minCalls: 10, windowMs: 30_000, halfOpenAfterMs: 15_000 } as const;

/** Logs of the vault's receipts and the panic message of a failed call. */
export function simOutcome(vault: string, o: NearFinalExecutionOutcome): SimOutcome {
  const status = o.status as {
    Failure?: { ActionError?: { kind?: { FunctionCallError?: { ExecutionError?: string } } } };
  };
  const exec = status.Failure?.ActionError?.kind?.FunctionCallError?.ExecutionError;
  const failure =
    status.Failure === undefined
      ? null
      : exec
        ? exec.startsWith(SMART_CONTRACT_PANICKED_PREFIX)
          ? exec.slice(SMART_CONTRACT_PANICKED_PREFIX.length)
          : exec
        : JSON.stringify(status.Failure);
  const vaultLogs = o.receipts_outcome.filter((r) => r.outcome.executor_id === vault).flatMap((r) => r.outcome.logs);
  return { txHash: o.transaction.hash, failure, vaultLogs };
}

export function sandboxVault(o: PeerOptions & { baseUrl: string; vaultContract: string }): SandboxVaultPort {
  const c = httpClient({
    target: "sandbox",
    baseUrl: o.baseUrl,
    timeoutMs: 10_000,
    attempts: 1,
    breaker: BREAKER,
    serviceToken: o.serviceToken,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  });
  return {
    async ftTransferCall(x) {
      const r = await c.call(sandboxVaultFtTransferCall, {
        body: { payer: x.payer, token: x.token, amount: x.amount.toString(), msg: x.msg } as never,
      });
      return simOutcome(o.vaultContract, r as NearFinalExecutionOutcome);
    },
    async call(x) {
      const r = await c.call(sandboxVaultCall, {
        body: {
          signer: x.signer,
          method: x.method,
          args: { ...x.args },
          ...(x.gas ? { gas: x.gas } : {}),
          ...(x.deposit ? { deposit: x.deposit } : {}),
        } as never,
      });
      return simOutcome(o.vaultContract, r as NearFinalExecutionOutcome);
    },
    async advance(onchainId, secs) {
      await c.call(sandboxVaultAdvance, {
        body: (secs === undefined ? { mandate_id: onchainId } : { mandate_id: onchainId, secs }) as never,
      });
    },
  };
}
