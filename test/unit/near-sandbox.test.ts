/**
 * The keeper's NEAR JSON-RPC adapter against the sandbox stand-in mocked from the spec (`mockPeer` enforces
 * the internal service-token auth and the route schemas): the token travels as `X-NearPay-Token` (an
 * `Authorization` bearer is refused), views parse with the vault's view schemas, a collect is signed and sent.
 */
import { testServiceToken } from "@nearpay-internal/testing";
import { afterAll, beforeAll, expect, it } from "vitest";
import { nearRpc } from "../../src/infra/near/rpc.js";
import { ephemeralKeeperKey, nearVault } from "../../src/infra/near/vault.js";
import { startSandboxMock } from "../support/stack.js";

const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
let mock: Awaited<ReturnType<typeof startSandboxMock>>;

beforeAll(async () => {
  mock = await startSandboxMock();
});
afterAll(async () => {
  await mock?.sandbox.stop();
});

const vaultOn = (url: string) => {
  const t = {
    rpc: nearRpc({ urls: [url], bearer: testServiceToken("billing") }),
    contract: "vault.sandbox.near",
    keeper: ephemeralKeeperKey("keeper.sandbox.near"),
    strictKeyPermission: false,
  };
  return nearVault({ live: t, test: t });
};

it("views, signing and sending through the stand-in with billing's service token", async () => {
  const v = vaultOn(`${mock.sandbox.url}/sim/near-rpc`);
  expect(await v.blockTimeNs(false)).toBeGreaterThan(0n);
  const config = await v.config(false);
  expect(config).toMatchObject({ maxFeeBps: 500, allowedTokens: [USDC, "usdt.tether-token.near"] });
  expect(config.caps.get(USDC)?.mandateCap).toBe(100_000_000_000n);
  expect(await v.tokenTvl(false, USDC)).toEqual({ tvl: 30_000_000n, cap: 1_000_000_000_000n });
  expect(await v.storageBalanceOf(false, "alice.near")).toEqual({ total: 12n * 10n ** 21n, available: 0n });
  mock.vault.nextCollectAt.set(41, "1796898546000000000");
  expect(await v.nextCollectAt(false, 41)).toBe(1_796_898_546_000_000_000n);
  const signed = await v.signCollect(false, 41);
  expect(await v.send(false, signed)).toEqual({ kind: "success", txHash: signed.txHash });
  mock.vault.collectFailure = "ERR_NOT_DUE";
  expect(await v.send(false, await v.signCollect(false, 41))).toMatchObject({ kind: "failure", code: "ERR_NOT_DUE" });
});

it("an Authorization bearer is not a service credential (the stand-in refuses it)", async () => {
  const res = await fetch(`${mock.sandbox.url}/sim/near-rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${await testServiceToken("billing")()}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "1", method: "block", params: { finality: "final" } }),
  });
  expect(res.status).toBe(401);
});
