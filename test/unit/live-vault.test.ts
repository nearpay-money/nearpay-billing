/**
 * Live vault optional (`NP_VAULT_CONTRACT`, no default): unset or empty parses as no live vault; the adapter then
 * has no live contract, no live keeper and fails every live call before NEAR RPC; the boot notice sets
 * `nearpay_billing_live_vault_configured` and warns on the server stage. Test mode is unaffected.
 */
import { loadConfig } from "@nearpay-internal/service";
import { describe, expect, it } from "vitest";
import { announceLiveVault } from "../../src/app/services.js";
import { apiShape } from "../../src/config.js";
import type { NearRpc } from "../../src/infra/near/rpc.js";
import { ephemeralKeeperKey, NoLiveVaultError, nearVault } from "../../src/infra/near/vault.js";

const ENV = {
  NP_ENV: "server",
  NP_DB_URL_FILE: "/run/secrets/db",
  NP_IDENTITY_URL: "http://identity:8080",
  NP_SERVICE_CLIENT_SECRET_FILE: "/run/secrets/client",
  NP_PAYMENTS_URL: "http://payments:8080",
  NP_RAILS_URL: "http://rails:8080",
  NP_PII_KEK_FILE: "/run/secrets/kek",
};
const files = (p: string) => (p.endsWith("db") ? "postgres://u:p@db/billing" : "secret");

describe("NP_VAULT_CONTRACT", () => {
  it("has no default; unset and empty both mean no live vault", () => {
    expect(loadConfig(apiShape, { env: ENV, readFile: files }).vaultContract).toBeUndefined();
    expect(loadConfig(apiShape, { env: { ...ENV, NP_VAULT_CONTRACT: "" }, readFile: files }).vaultContract).toBe(
      undefined,
    );
    const set = loadConfig(apiShape, { env: { ...ENV, NP_VAULT_CONTRACT: "v1.vault.example.near" }, readFile: files });
    expect(set.vaultContract).toBe("v1.vault.example.near");
    expect(set.testVaultContract).toBe("vault.sandbox.near");
  });
});

describe("nearVault without a live target", () => {
  const calls: string[] = [];
  const rpc = new Proxy({} as NearRpc, {
    get: (_t, k) => async () => {
      calls.push(String(k));
      throw new Error("unexpected RPC");
    },
  });
  const test = {
    rpc,
    contract: "vault.sandbox.near",
    keeper: ephemeralKeeperKey("k.near"),
    strictKeyPermission: false,
  };
  const v = nearVault({ live: null, test });

  it("has no live contract or keeper and refuses every live call before NEAR RPC", async () => {
    expect(v.contract(true)).toBeNull();
    expect(v.keeperEnabled(true)).toBe(false);
    expect(v.contract(false)).toBe("vault.sandbox.near");
    expect(v.keeperEnabled(false)).toBe(true);
    await expect(v.config(true)).rejects.toBeInstanceOf(NoLiveVaultError);
    await expect(v.tokenTvl(true, "usdc.near")).rejects.toBeInstanceOf(NoLiveVaultError);
    await expect(v.storageBalanceOf(true, "alice.near")).rejects.toBeInstanceOf(NoLiveVaultError);
    await expect(v.nextCollectAt(true, 1)).rejects.toBeInstanceOf(NoLiveVaultError);
    await expect(v.blockTimeNs(true)).rejects.toBeInstanceOf(NoLiveVaultError);
    await expect(v.signCollect(true, 1)).rejects.toBeInstanceOf(NoLiveVaultError);
    expect(await v.status(true, "h")).toMatchObject({ kind: "unknown" });
    expect(calls).toEqual([]);
    // test mode still reaches its RPC
    await expect(v.blockTimeNs(false)).rejects.toThrow("unexpected RPC");
    expect(calls).toEqual(["block"]);
  });
});

describe("announceLiveVault (boot)", () => {
  const run = (env: "server" | "local" | "test", vaultContract: string | undefined) => {
    const logs: { level: string; msg: string }[] = [];
    const gauges: Record<string, number> = {};
    const log = (level: string) => (_o: object, msg: string) => logs.push({ level, msg });
    const service = {
      log: { info: log("info"), warn: log("warn"), error: log("error") },
      metrics: { gauge: (name: string) => ({ set: (v: number) => (gauges[name] = v) }) },
    };
    const configured = announceLiveVault({ env, vaultContract }, service as never);
    return { configured, logs, gauges };
  };

  it("unset on the server stage: gauge 0 and a warning", () => {
    const r = run("server", undefined);
    expect(r.configured).toBe(false);
    expect(r.gauges).toEqual({ live_vault_configured: 0 });
    expect(r.logs).toEqual([{ level: "warn", msg: expect.stringContaining("live auto-debit is off") }]);
  });

  it("unset locally: gauge 0, info only; set: gauge 1", () => {
    expect(run("local", undefined).logs.map((l) => l.level)).toEqual(["info"]);
    const r = run("server", "v1.vault.example.near");
    expect(r.configured).toBe(true);
    expect(r.gauges).toEqual({ live_vault_configured: 1 });
    expect(r.logs.map((l) => l.level)).toEqual(["info"]);
  });
});
