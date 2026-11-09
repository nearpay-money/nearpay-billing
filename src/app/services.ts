/**
 * Process wiring (lld/billing.md §2):
 * - `api`     merchant, hosted-invoice and internal routes, with automatic idempotency
 * - `worker`  payments-event consumers, renewal/dunning/PDF jobs, recurring jobs and the outbox relay
 */

import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import type { KeySource } from "@nearpay-internal/auth";
import { serviceTokenClient } from "@nearpay-internal/auth";
import {
  type Bus,
  busReady,
  connectBus,
  consumerLag,
  domainConsumersTask,
  durablesOf,
  ensureStreams,
  publish,
} from "@nearpay-internal/bus";
import {
  createDb,
  createEnvelopeCipher,
  type Database,
  deadLettersOpen,
  type EnvelopeCipher,
  idempotencyStore,
  jobsDue,
  jobWorkerTask,
  migrationStatus,
  outboxLagSeconds,
  outboxRelayTask,
  parseKek,
  recurringJobsTask,
  sql,
} from "@nearpay-internal/db";
import { createService, type Service } from "@nearpay-internal/service";
import { STREAMS, type Subject } from "@nearpay-internal/spec";
import { billingRoutes } from "../api/routes.js";
import { eventRenderer } from "../api/views.js";
import type { ApiConfig, SharedConfig, WorkerConfig } from "../config.js";
import { billingHandlers, deadLetters } from "../consumers/handlers.js";
import { clientIpRule } from "../domain/client-ip.js";
import { identityMerchant, paymentsClient, railsAssets } from "../infra/clients/peers.js";
import { sandboxVault } from "../infra/clients/sandbox.js";
import { MIGRATIONS_DIR } from "../infra/db/migrations.js";
import type { DB } from "../infra/db/schema.js";
import { postgresStore } from "../infra/db/store.js";
import { newBillingId } from "../infra/ids.js";
import { nearRpc } from "../infra/near/rpc.js";
import { ephemeralKeeperKey, nearVault, parseKeeperKey } from "../infra/near/vault.js";
import { objectStore } from "../infra/objects.js";
import { invoicePdfRenderer } from "../infra/pdf/invoice-pdf.js";
import { RECURRING, recurringHandlers } from "../scheduler/recurring.js";
import { jobHandlers } from "../workers/jobs.js";
import type { PdfRenderer } from "./pdf.js";
import type {
  AssetsPort,
  Billing,
  BillingMetrics,
  Logger,
  MerchantPort,
  ObjectStore,
  PaymentsPort,
  SandboxVaultPort,
  VaultPort,
} from "./ports.js";

export interface ServiceDeps {
  database?: Database<DB>;
  keys?: KeySource;
  serviceToken?: () => Promise<string>;
  payments?: PaymentsPort;
  merchant?: MerchantPort;
  assets?: AssetsPort;
  vault?: VaultPort;
  sandbox?: SandboxVaultPort;
  objects?: ObjectStore;
  pdf?: PdfRenderer;
  cipher?: EnvelopeCipher;
  fetch?: typeof fetch;
  now?: () => number;
}

interface Built {
  billing: Billing;
  database: Database<DB>;
  setLog(l: Logger): void;
  setMetrics(m: Service["metrics"]): void;
}

function build(config: SharedConfig, deps: ServiceDeps, app: string): Built {
  const f = deps.fetch ? { fetch: deps.fetch } : {};
  const database = deps.database ?? createDb<DB>({ url: config.dbUrl, applicationName: `billing-${app}` });
  const serviceToken =
    deps.serviceToken ??
    (() => {
      const c = serviceTokenClient({
        identityUrl: config.identityUrl,
        clientId: "billing",
        secret: config.serviceClientSecret,
        ...f,
      });
      return () => c.getToken();
    })();
  const peer = { serviceToken, ...f };
  let log: Logger = { info() {}, warn() {}, error() {} };
  let keeperCollect: BillingMetrics["keeperCollect"] = () => {};
  const sandboxBase = config.sandboxBaseUrl?.replace(/\/$/, "");
  const vault =
    deps.vault ??
    nearVault({
      live: {
        rpc: nearRpc({ urls: config.nearRpcUrls, ...f }),
        contract: config.vaultContract,
        keeper: config.keeperKey ? parseKeeperKey(config.keeperKey, config.keeperAccount) : null,
        strictKeyPermission: true,
      },
      test: {
        rpc: nearRpc({
          urls:
            config.testNearRpcUrls ??
            (sandboxBase ? [`${sandboxBase}/sim/near-rpc`] : ["http://sandbox.invalid/sim/near-rpc"]),
          bearer: serviceToken,
          ...f,
        }),
        contract: config.testVaultContract,
        keeper: config.testKeeperKey
          ? parseKeeperKey(config.testKeeperKey, config.testKeeperAccount)
          : sandboxBase
            ? ephemeralKeeperKey(config.testKeeperAccount)
            : null,
        strictKeyPermission: false,
      },
    });
  const sandbox =
    deps.sandbox ??
    sandboxVault({
      ...peer,
      baseUrl: sandboxBase ?? "http://sandbox.invalid",
      vaultContract: config.testVaultContract,
    });
  const billing: Billing = {
    metrics: { keeperCollect: (o, live) => keeperCollect(o, live) },
    store: postgresStore(database.db, eventRenderer(config.apiOrigin.replace(/\/$/, ""))),
    payments: deps.payments ?? paymentsClient({ ...peer, baseUrl: config.paymentsUrl }),
    merchant: deps.merchant ?? identityMerchant({ ...peer, baseUrl: config.identityUrl }),
    assets: deps.assets ?? railsAssets({ ...peer, baseUrl: config.railsUrl }),
    vault,
    sandbox,
    cipher: deps.cipher ?? createEnvelopeCipher(parseKek(config.piiKek)),
    objects: deps.objects ?? objectStore(config.objectStore),
    pdf: deps.pdf ?? invoicePdfRenderer(),
    log: {
      info: (o, m) => log.info(o, m),
      warn: (o, m) => log.warn(o, m),
      error: (o, m) => log.error(o, m),
    },
    settings: {
      payOrigin: config.payOrigin.replace(/\/$/, ""),
      apiOrigin: config.apiOrigin.replace(/\/$/, ""),
      pricingCurrencies: new Set(config.pricingCurrencies),
      publicSessionsPerClient: config.publicSessionsPerClient,
      publicSessionsPerInvoice: config.publicSessionsPerInvoice,
      vaultUsdTokens: config.vaultUsdTokens,
      vaultTokens: config.vaultTokens,
      vaultMaxFeeBps: config.vaultMaxFeeBps,
      simulatedPayer: config.simulatedPayer,
    },
    newId: newBillingId,
    randomBytes: (n) => new Uint8Array(randomBytes(n)),
    now: deps.now ?? Date.now,
  };
  return {
    billing,
    database,
    setLog: (l) => {
      log = l;
    },
    setMetrics: (m) => {
      const c = m.counter(
        "keeper_collect_total",
        "Keeper collect outcomes (§7.1): collected / collect_failed (forwarded vault events), insufficient, in_flight, not_due, gas, other.",
        ["outcome", "livemode"],
      );
      keeperCollect = (outcome, live) => c.inc({ outcome, livemode: String(live) });
    },
  };
}

function readiness(b: Built) {
  return {
    db: () => sql`select 1`.execute(b.database.db),
    migrations: async () => {
      const s = await migrationStatus(b.database.db, MIGRATIONS_DIR);
      if (s.pending.length || s.drift.length)
        throw new Error(`pending ${s.pending.join(",") || "-"} drift ${s.drift.join(",") || "-"}`);
    },
  };
}

function attach(b: Built, service: Service, deps: ServiceDeps) {
  b.setLog(service.log);
  b.setMetrics(service.metrics);
  service.onShutdown(async () => {
    if (!deps.database) await b.database.close();
  });
}

export function createApi(config: ApiConfig, deps: ServiceDeps = {}): { service: Service; billing: Billing } {
  const b = build(config, deps, "api");
  const service = createService({
    name: "billing",
    config,
    ...(deps.keys ? { keys: deps.keys } : {}),
    routes: billingRoutes(
      b.billing,
      config.env,
      clientIpRule(config.env, { header: config.clientIpHeader, trustedProxies: config.trustedProxies }),
    ),
    idempotency: idempotencyStore(b.database.db, b.billing.cipher),
    readiness: readiness(b),
  });
  attach(b, service, deps);
  return { service, billing: b.billing };
}

export interface WorkerDeps extends ServiceDeps {
  bus?: Bus;
  tickMs?: number;
}

export async function createWorker(
  config: WorkerConfig,
  deps: WorkerDeps = {},
): Promise<{ service: Service; billing: Billing }> {
  const b = build(config, deps, "worker");
  const service = createService({ name: "billing", config, readiness: readiness(b) });
  attach(b, service, deps);
  const db = b.database;

  const bus = deps.bus ?? (await connectBus({ url: config.natsUrl, name: `billing-worker@${hostname()}` }));
  await ensureStreams(bus, [STREAMS.billing]);
  service.addReadiness("bus", () => {
    if (!busReady(bus)) throw new Error("NATS connection is closed");
  });
  const handlers = billingHandlers(b.billing);
  const durables = durablesOf("billing", Object.keys(handlers) as Subject[]);
  service.metrics.collectConsumerLag(async () =>
    Object.fromEntries(
      await Promise.all(durables.map(async (d) => [d.durable, await consumerLag(bus, d.stream, d.durable)])),
    ),
  );
  service.metrics.collectOutboxLag(() => outboxLagSeconds(db.db));
  service.metrics.collectJobsDue(() => jobsDue(db.db));
  service.metrics.collectDeadLettersOpen(() => deadLettersOpen(db.db));

  const onError = (e: unknown) => service.log.error({ err: e }, "background error");
  service.addBackground(
    outboxRelayTask({
      db: db.db,
      pool: db.pool,
      publish: (sub, e, mid) => publish(bus, sub, e, mid).then(() => {}),
      onError,
    }),
  );
  service.addBackground(
    domainConsumersTask({ bus, consumer: "billing", handlers, onDeadLetter: deadLetters(db.db), onError }),
  );
  service.addBackground(
    jobWorkerTask({
      db: db.db,
      workerId: `billing-worker@${hostname()}:${process.pid}`,
      handlers: { ...jobHandlers(b.billing), ...recurringHandlers(db.db, b.billing) },
      onError: (e, job) => service.log.warn({ err: e instanceof Error ? e.message : String(e), job }, "job failed"),
      onDeadLetter: (j) => service.log.error({ job: j }, "ALERT job dead-lettered"),
      ...(deps.tickMs ? { pollMs: deps.tickMs } : {}),
    }),
  );
  service.addBackground(
    recurringJobsTask({
      db: db.db,
      pool: db.pool,
      name: "billing:recurring-jobs",
      jobs: RECURRING,
      onError,
      ...(deps.tickMs ? { tickMs: deps.tickMs } : {}),
    }),
  );
  if (!deps.bus) service.onShutdown(() => bus.close());
  return { service, billing: b.billing };
}
