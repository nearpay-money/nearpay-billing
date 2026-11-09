/**
 * Integration harness: Postgres provisioned like nearpay-deploy (migrator owns the database, the app role
 * has DML only); the real `api` and `worker` from the factories `main.ts` uses; payments, identity, rails
 * and the sandbox vault stand-in (NEAR JSON-RPC + `/sim/vault/*`, answered with the spec's vault vectors)
 * mocked from the spec (`mockPeer`); NATS for events when a test asks for the worker.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Bus, connectBus, type Envelope, publish } from "@nearpay-internal/bus";
import { createDb, type Database, migrate } from "@nearpay-internal/db";
import { newId, toUuid } from "@nearpay-internal/ids";
import type { Service } from "@nearpay-internal/service";
import {
  createInvoiceCheckoutSession,
  expireInvoiceCheckoutSession,
  getInternalAsset,
  getInternalCheckoutSession,
  getInternalCustomer,
  getSettlementContext,
  INTERNAL_ROUTES,
  sandboxNearRpc,
  sandboxVaultAdvance,
  sandboxVaultCall,
  sandboxVaultFtTransferCall,
} from "@nearpay-internal/spec";
import {
  account,
  checkoutSession,
  type EventProbe,
  eventProbe,
  internalSettlementDestination,
  type MockPeer,
  mintServiceToken,
  mintTestToken,
  mockError,
  mockPeer,
  provisionServiceDatabase,
  type Started,
  startNats,
  startPostgres,
  testKeySource,
  testServiceToken,
  USDC_NEAR,
} from "@nearpay-internal/testing";
import bs58 from "bs58";
import type { Billing } from "../../src/app/ports.js";
import { createApi, createWorker } from "../../src/app/services.js";
import type { WorkerConfig } from "../../src/config.js";
import { MIGRATIONS_DIR } from "../../src/infra/db/migrations.js";
import type { DB } from "../../src/infra/db/schema.js";

export { USDC_NEAR };

export interface Merchant {
  readonly account: `acct_${string}`;
  readonly destination: `sd_${string}`;
}

interface MockCustomer {
  id: string;
  account: string;
  livemode: boolean;
  email: string | null;
  name: string | null;
  deleted: boolean;
}

interface MockSession {
  id: string;
  invoice: string;
  status: "open" | "expiring" | "complete" | "expired";
  expires_at: number;
  amount: number | string;
  key: string;
  clientSecret: string;
}

export interface Stack {
  readonly pg: Started;
  readonly admin: Database<DB>;
  readonly api: Service;
  readonly billing: Billing;
  readonly url: string;
  readonly payments: MockPeer;
  readonly identity: MockPeer;
  readonly rails: MockPeer;
  /** The sandbox vault stand-in (NEAR JSON-RPC and `/sim/vault/*`). */
  readonly sandbox: MockPeer;
  /** Knobs of the stand-in: `next_collect_at` per mandate (ns; absent = due), the next `collect` failure. */
  readonly vault: { nextCollectAt: Map<number, string | null>; collectFailure: string | null; sentTx: string[] };
  readonly sessions: Map<string, MockSession>;
  readonly customers: Map<string, MockCustomer>;
  /** What `expireInvoiceCheckoutSession` does next. */
  expireMode: "expire" | "in_flight";
  merchant(o?: { liveEnabled?: boolean }): Merchant;
  customer(m: Merchant, o?: { livemode?: boolean; email?: string | null; deleted?: boolean }): string;
  token(m: Merchant, o?: { livemode?: boolean }): Promise<string>;
  sessionToken(m: Merchant, o?: { role?: string; livemode?: boolean }): Promise<string>;
  serviceToken(service: string): Promise<string>;
  call(
    method: string,
    path: string,
    o?: { token?: string; body?: unknown; headers?: Record<string, string> },
    // biome-ignore lint/suspicious/noExplicitAny: responses are asserted structurally in tests
  ): Promise<{ status: number; body: any; headers: Headers; bytes: Buffer }>;
  publishEvent(e: Envelope): Promise<void>;
  probe(filter?: string): Promise<EventProbe>;
  stop(): Promise<void>;
}

export interface StackOptions {
  worker?: boolean;
  /** `NP_VAULT_CONTRACT` (default `v1.vault.example.near`); null = unset (live auto-debit off). */
  vaultContract?: string | null;
}

/** The sandbox vault stand-in (NEAR JSON-RPC + `/sim/vault/*`), answered with the spec's vault vectors. */
export async function startSandboxMock(): Promise<{ sandbox: MockPeer; vault: Stack["vault"] }> {
  const V = JSON.parse(readFileSync(new URL("../fixtures/vault.json", import.meta.url), "utf8")) as {
    views: { method: string; args: Record<string, unknown>; result_json: string }[];
  };
  const viewOf = (method: string) => V.views.find((v) => v.method === method)?.result_json ?? "null";
  const vault = {
    nextCollectAt: new Map<number, string | null>(),
    collectFailure: null as string | null,
    sentTx: [] as string[],
  };
  const hash32 = () => bs58.encode(randomBytes(32));
  const nowNs = () => (BigInt(Date.now()) * 1_000_000n).toString();
  const outcome = (o: { signer: string; receiver: string; failure?: string | null; logs?: string[] }) => {
    const hash = hash32();
    const bh = hash32();
    const status = o.failure
      ? {
          Failure: {
            ActionError: {
              index: 0,
              kind: { FunctionCallError: { ExecutionError: `Smart contract panicked: ${o.failure}` } },
            },
          },
        }
      : { SuccessValue: "dHJ1ZQ==" };
    const out = (executor: string, logs: string[], st: unknown) => ({
      logs,
      receipt_ids: [],
      gas_burnt: 1,
      tokens_burnt: "0",
      executor_id: executor,
      status: st,
    });
    return {
      final_execution_status: "FINAL",
      status,
      transaction: { signer_id: o.signer, public_key: `ed25519:${hash32()}`, nonce: 1, receiver_id: o.receiver, hash },
      transaction_outcome: { id: hash, block_hash: bh, outcome: out(o.signer, [], { SuccessReceiptId: hash32() }) },
      receipts_outcome: [{ id: hash32(), block_hash: bh, outcome: out("vault.sandbox.near", o.logs ?? [], status) }],
    };
  };
  const sandbox = await mockPeer({ service: "sandbox", routes: INTERNAL_ROUTES });
  sandbox.on(sandboxNearRpc, async (ctx) => {
    const req = ctx.body as { id: string | number; method: string; params: Record<string, string> };
    const reply = (result: unknown) => ({ jsonrpc: "2.0", id: req.id, result }) as never;
    const block = { height: 1000, hash: hash32() };
    if (req.method === "block") return reply({ header: { ...block, timestamp_nanosec: nowNs() } });
    if (req.method === "query" && req.params.request_type === "view_access_key")
      return reply({
        nonce: 0,
        permission: {
          FunctionCall: { allowance: null, receiver_id: "vault.sandbox.near", method_names: ["collect"] },
        },
        block_height: block.height,
        block_hash: block.hash,
      });
    if (req.method === "query") {
      const method = req.params.method_name as string;
      const args = JSON.parse(Buffer.from(req.params.args_base64 ?? "", "base64").toString("utf8") || "{}") as {
        mandate_id?: number;
      };
      const json =
        method === "next_collect_at"
          ? JSON.stringify(
              vault.nextCollectAt.has(args.mandate_id ?? -1) ? vault.nextCollectAt.get(args.mandate_id ?? -1) : "1",
            )
          : method === "get_mandate"
            ? JSON.stringify({ status: "active" })
            : viewOf(method);
      return reply({
        result: [...Buffer.from(json, "utf8")],
        logs: [],
        block_height: block.height,
        block_hash: block.hash,
      });
    }
    // send_tx / broadcast_tx_commit / tx: the keeper's collect
    if (req.method !== "tx") vault.sentTx.push(req.method);
    const failure = req.method === "tx" ? null : vault.collectFailure;
    if (req.method !== "tx") vault.collectFailure = null;
    return reply(outcome({ signer: "keeper.sandbox.near", receiver: "vault.sandbox.near", failure }));
  });
  sandbox.on(sandboxVaultFtTransferCall, async (ctx) => {
    const b = ctx.body as { payer: string; token: string };
    return outcome({ signer: b.payer, receiver: b.token }) as never;
  });
  sandbox.on(sandboxVaultCall, async (ctx) => {
    const b = ctx.body as { signer: string };
    return outcome({ signer: b.signer, receiver: "vault.sandbox.near" }) as never;
  });
  sandbox.on(sandboxVaultAdvance, async (ctx) => {
    const b = ctx.body as { mandate_id: number; secs?: number };
    return {
      mandate_id: b.mandate_id,
      clock_offset_secs: b.secs ?? 0,
      now_ns: nowNs(),
      next_collect_at: null,
    } as never;
  });
  return { sandbox, vault };
}

export async function startStack(o: StackOptions = {}): Promise<Stack> {
  const [pg, nats] = await Promise.all([startPostgres({ database: "postgres" }), o.worker ? startNats() : null]);
  const { migratorUrl, appUrl } = await provisionServiceDatabase(pg.url, "billing");
  const migrator = createDb<DB>({ url: migratorUrl });
  await migrate(migrator.db, MIGRATIONS_DIR);
  await migrator.close();
  const admin = createDb<DB>({ url: appUrl, applicationName: "billing-test" });

  // ---- identity: settlement context per merchant
  const merchants = new Map<string, { liveEnabled: boolean; sd: string }>();
  const identity = await mockPeer({ service: "identity", routes: INTERNAL_ROUTES });
  identity.on(getSettlementContext, async (ctx) => {
    const m = merchants.get(ctx.params.id);
    if (!m) throw new Error(`unknown account ${ctx.params.id}`);
    const lm = (ctx.query.livemode as unknown as boolean) ?? false;
    return {
      account: account({
        id: ctx.params.id as `acct_${string}`,
        display_name: "Acme Coffee",
        live_enabled: m.liveEnabled,
      }),
      fee_schedule: {
        id: newId("fs"),
        name: "standard",
        rules: {
          same_asset: { total_bps: 30, min_fee_usd_micros: 0 },
          stable_pair: { total_bps: 50, min_fee_usd_micros: 0 },
          volatile: { total_bps: 100, min_fee_usd_micros: 0 },
          intents_transfer: { total_bps: 30, min_fee_usd_micros: 0 },
        },
        provider_split: { oneclick: { share_bps: 5000, floor_bps: 20, stable_floor_bps: 1 } },
      },
      destinations: [
        internalSettlementDestination({
          id: m.sd as `sd_${string}`,
          account: ctx.params.id as `acct_${string}`,
          livemode: lm,
          asset_id: USDC_NEAR,
          type: "intents_account",
          chain: "near:mainnet",
          address: "acme.near",
          address_norm: "acme.near",
          status: "active",
          verification: "test",
        }),
      ],
      defaults: { "*": m.sd as `sd_${string}` },
      context_version: new Date().toISOString(),
    } as never;
  });

  // ---- rails: asset display data
  const rails = await mockPeer({ service: "rails", routes: INTERNAL_ROUTES });
  rails.on(getInternalAsset, async (ctx) => {
    if (ctx.params.asset_id !== USDC_NEAR) mockError("asset_unsupported", { params: { asset: ctx.params.asset_id } });
    return {
      asset_id: USDC_NEAR,
      chain: "near:mainnet",
      blockchain: "near",
      symbol: "USDC",
      decimals: 6,
      family: "usdc",
      is_usd_stable: true,
      price_usd: "1",
      price_ok: true,
      as_of: new Date().toISOString(),
    } as never;
  });

  // ---- payments: customers and invoice sessions
  const customers = new Map<string, MockCustomer>();
  const sessions = new Map<string, MockSession>();
  const knobs = { expireMode: "expire" as "expire" | "in_flight" };
  const payments = await mockPeer({ service: "payments", routes: INTERNAL_ROUTES });
  const sessionObject = (s: MockSession, withSecret: boolean) =>
    checkoutSession({
      id: s.id as `cs_${string}`,
      status: s.status,
      expires_at: s.expires_at,
      amount: s.amount as never,
      invoice: s.invoice as `in_${string}`,
      client_secret: withSecret ? s.clientSecret : null,
      url: withSecret ? `https://pay.nearpay.localhost/c/${s.id}#${s.clientSecret}` : null,
    } as never);
  payments.on(getInternalCustomer, async (ctx) => {
    const c = customers.get(ctx.params.id);
    if (!c) mockError("resource_missing", { params: { object: "customer", id: ctx.params.id } });
    return {
      id: c.id,
      object: "customer",
      created: Math.floor(Date.now() / 1000),
      livemode: c.livemode,
      email: c.deleted ? null : c.email,
      name: c.deleted ? null : c.name,
      description: null,
      wallets: [],
      metadata: {},
      account_id: c.account,
      deleted: c.deleted,
    } as never;
  });
  payments.on(createInvoiceCheckoutSession, async (ctx) => {
    const key = (ctx.request.headers["idempotency-key"] as string) ?? "";
    const replay = [...sessions.values()].find((s) => s.key === key);
    if (replay) return sessionObject(replay, true) as never;
    if ([...sessions.values()].some((s) => s.invoice === ctx.body.invoice && s.status === "open"))
      mockError("state_conflict", { params: { object: "checkout_session", state: "open" } });
    const id = newId("cs");
    const s: MockSession = {
      id,
      invoice: ctx.body.invoice,
      status: "open",
      expires_at: Math.floor(Date.parse(ctx.body.expires_at) / 1000),
      amount: ctx.body.amount,
      key,
      clientSecret: `${id}_secret_${randomBytes(24).toString("base64url").replace(/[-_]/g, "x").slice(0, 32)}`,
    };
    sessions.set(id, s);
    return sessionObject(s, true) as never;
  });
  payments.on(getInternalCheckoutSession, async (ctx) => {
    const s = sessions.get(ctx.params.id);
    if (!s) mockError("resource_missing", { params: { object: "checkout_session", id: ctx.params.id } });
    return sessionObject(s, false) as never;
  });
  payments.on(expireInvoiceCheckoutSession, async (ctx) => {
    const s = sessions.get(ctx.params.id);
    if (!s) mockError("resource_missing", { params: { object: "checkout_session", id: ctx.params.id } });
    if (knobs.expireMode === "in_flight") mockError("attempt_in_flight");
    s.status = "expired";
    return sessionObject(s, false) as never;
  });

  const { sandbox, vault } = await startSandboxMock();

  const config: WorkerConfig = {
    env: "test",
    logLevel: (process.env.NP_TEST_LOG ?? "silent") as never,
    host: "127.0.0.1",
    port: 0,
    metricsPort: 0,
    dbUrl: appUrl,
    identityUrl: identity.url,
    serviceClientSecret: "unused",
    paymentsUrl: payments.url,
    railsUrl: rails.url,
    payOrigin: "https://pay.nearpay.localhost",
    apiOrigin: "https://api.nearpay.localhost",
    piiKek: randomBytes(32).toString("base64"),
    objectStore: `fs:${mkdtempSync(join(tmpdir(), "billing-pdf-"))}`,
    pricingCurrencies: ["usd", "eur"],
    publicSessionsPerClient: 1000,
    publicSessionsPerInvoice: 1000,
    natsUrl: nats?.url ?? "nats://127.0.0.1:9",
    // Stage 4 (no keeper key: the live keeper is off; test mode uses the stand-in when configured)
    ...(o.vaultContract === null ? {} : { vaultContract: o.vaultContract ?? "v1.vault.example.near" }),
    nearRpcUrls: ["http://127.0.0.1:9/near-rpc"],
    testVaultContract: "vault.sandbox.near",
    sandboxBaseUrl: sandbox.url,
    testKeeperAccount: "keeper.sandbox.near",
    vaultUsdTokens: ["17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "usdt.tether-token.near"],
    vaultTokens: ["17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1", "usdt.tether-token.near"],
    vaultMaxFeeBps: 500,
    simulatedPayer: "sandbox-payer.near",
  } as WorkerConfig;
  const deps = { keys: testKeySource(), serviceToken: testServiceToken("billing") };
  const { service: api, billing } = createApi(config, {
    ...deps,
    database: createDb<DB>({ url: appUrl, applicationName: "billing-api-test" }),
  });
  const { port } = await api.start();

  let worker: Service | null = null;
  let bus: Bus | null = null;
  if (o.worker && nats) {
    bus = await connectBus({ url: nats.url, name: "billing-test-publisher" });
    const w = await createWorker(config, {
      ...deps,
      database: createDb<DB>({ url: appUrl, applicationName: "billing-worker-test" }),
      tickMs: 50,
    });
    await w.service.start();
    worker = w.service;
  }
  const url = `http://127.0.0.1:${port}`;

  return {
    pg,
    admin,
    api,
    billing,
    url,
    payments,
    identity,
    rails,
    sandbox,
    vault,
    sessions,
    customers,
    get expireMode() {
      return knobs.expireMode;
    },
    set expireMode(v) {
      knobs.expireMode = v;
    },
    merchant(m = {}) {
      const acct = newId("acct");
      const sd = newId("sd");
      merchants.set(acct, { liveEnabled: m.liveEnabled ?? true, sd });
      return { account: acct, destination: sd };
    },
    customer(m, c = {}) {
      const id = newId("cus");
      customers.set(id, {
        id,
        account: m.account,
        livemode: c.livemode ?? false,
        email: c.email === undefined ? "payer@example.com" : c.email,
        name: "Pat Payer",
        deleted: c.deleted ?? false,
      });
      return id;
    },
    token: (m, t = {}) =>
      mintTestToken({ sub: newId("key"), acct: m.account, lm: t.livemode ?? false, ptype: "secret_key", scp: [] }),
    sessionToken: (m, t = {}) =>
      mintTestToken({
        sub: newId("usr"),
        acct: m.account,
        lm: t.livemode ?? false,
        ptype: "session",
        scp: [],
        role: (t.role ?? "owner") as never,
      }),
    serviceToken: (service) => mintServiceToken(service as never),
    async call(method, path, c = {}) {
      const res = await fetch(`${url}${path}`, {
        method,
        headers: {
          ...(c.token ? { "x-nearpay-token": c.token } : {}),
          ...(c.body !== undefined ? { "content-type": "application/json" } : {}),
          ...c.headers,
        },
        body: c.body === undefined ? undefined : JSON.stringify(c.body),
      });
      const bytes = Buffer.from(await res.arrayBuffer());
      let body: unknown;
      try {
        body =
          bytes.length && (res.headers.get("content-type") ?? "").includes("json")
            ? JSON.parse(bytes.toString("utf8"))
            : undefined;
      } catch {
        body = bytes.toString("utf8");
      }
      // biome-ignore lint/suspicious/noExplicitAny: responses are asserted structurally in tests
      return { status: res.status, body: body as any, headers: res.headers, bytes };
    },
    async publishEvent(e) {
      if (!bus) throw new Error("no bus (start the stack with a worker)");
      await publish(bus, e.subject, e, e.id);
    },
    async probe(filter = "evt.billing.>") {
      if (!nats) throw new Error("no NATS");
      return eventProbe(nats.url, filter);
    },
    async stop() {
      await worker?.stop().catch(() => {});
      await api.stop().catch(() => {});
      await bus?.close().catch(() => {});
      for (const m of [payments, identity, rails, sandbox]) await m.stop().catch(() => {});
      await admin.close();
      await nats?.stop().catch(() => {});
      await pg.stop().catch(() => {});
    },
  };
}

export const uuid = (id: string, prefix: Parameters<typeof toUuid>[1]) => toUuid(id, prefix);
