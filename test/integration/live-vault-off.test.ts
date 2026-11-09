/**
 * Boot and HTTP with `NP_VAULT_CONTRACT` unset (live auto-debit off until the owner-controlled vault is deployed):
 * the service starts, `nearpay_billing_live_vault_configured` is 0, live `auto_debit` subscriptions and live mandate
 * funding are refused with the spec's `auto_debit_unavailable` (422), and test mode keeps the sandbox stand-in.
 */
import { MandateFundingInstructions } from "@nearpay/spec";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Merchant, type Stack, startStack } from "../support/stack.js";

let s: Stack;
let m: Merchant;

beforeAll(async () => {
  s = await startStack({ vaultContract: null });
  m = s.merchant();
});

afterAll(async () => {
  await s?.stop();
});

const gauge = async (stack: Stack) =>
  (await stack.api.metrics.registry.getSingleMetric("nearpay_billing_live_vault_configured")?.get())?.values[0]?.value;

async function monthlyPrice(token: string, tag: string) {
  const prod = await s.call("POST", "/v1/products", { token, body: { name: `Club ${tag}` } });
  const price = await s.call("POST", "/v1/prices", {
    token,
    body: { product: prod.body.id, unit_amount: 1500, currency: "usd", recurring: { interval: "month" } },
  });
  expect(price.status).toBe(201);
  return price.body.id as string;
}

describe("NP_VAULT_CONTRACT unset", () => {
  it("boots ready with the gauge at 0", async () => {
    expect((await s.call("GET", "/readyz")).status).toBe(200);
    expect(await gauge(s)).toBe(0);
  });

  it("refuses live auto_debit and live funding with auto_debit_unavailable", async () => {
    const live = await s.token(m, { livemode: true });
    const cus = s.customer(m, { livemode: true });
    const price = await monthlyPrice(live, "live");
    const ad = await s.call("POST", "/v1/subscriptions", {
      token: live,
      body: { customer: cus, items: [{ price }], collection_method: "auto_debit" },
      headers: { "idempotency-key": `live-ad-${price}` },
    });
    expect(ad.status).toBe(422);
    expect(ad.body.error).toMatchObject({ code: "auto_debit_unavailable", param: "collection_method" });
    expect(ad.body.error.message).toContain("live auto-debit is not available yet");

    const plain = await s.call("POST", "/v1/subscriptions", {
      token: live,
      body: { customer: cus, items: [{ price }] },
      headers: { "idempotency-key": `live-plain-${price}` },
    });
    expect(plain.status).toBe(201);
    const upd = await s.call("PATCH", `/v1/subscriptions/${plain.body.id}`, {
      token: live,
      body: { collection_method: "auto_debit" },
      headers: { "idempotency-key": `live-upd-${price}` },
    });
    expect(upd.status).toBe(422);
    expect(upd.body.error.code).toBe("auto_debit_unavailable");

    const prep = await s.call("POST", "/v1/mandates/prepare", {
      token: live,
      body: { subscription: plain.body.id, payer: "alice.near" },
      headers: { "idempotency-key": `live-prep-${price}` },
    });
    expect(prep.status).toBe(422);
    expect(prep.body.error.code).toBe("auto_debit_unavailable");
  });

  it("test mode is unaffected (sandbox stand-in)", async () => {
    const tok = await s.token(m);
    const cus = s.customer(m);
    const price = await monthlyPrice(tok, "test");
    const sub = await s.call("POST", "/v1/subscriptions", {
      token: tok,
      body: { customer: cus, items: [{ price }], collection_method: "auto_debit" },
      headers: { "idempotency-key": `test-ad-${price}` },
    });
    expect(sub.status).toBe(201);
    const prep = await s.call("POST", "/v1/mandates/prepare", {
      token: tok,
      body: { subscription: sub.body.id, payer: "alice.near" },
      headers: { "idempotency-key": `test-prep-${price}` },
    });
    expect(prep.status).toBe(200);
    expect(MandateFundingInstructions.parse(prep.body).vault_contract).toBe("vault.sandbox.near");
  });
});

describe("NP_VAULT_CONTRACT set", () => {
  it("the gauge is 1", async () => {
    const on = await startStack({ vaultContract: "v1.vault.example.near" });
    try {
      expect(await gauge(on)).toBe(1);
    } finally {
      await on.stop();
    }
  });
});
