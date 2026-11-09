/**
 * In-memory adapters of the billing ports for use-case tests: a store with real transaction semantics
 * (serialised, all-or-nothing with rollback), optimistic versions, the database's unique constraints, and
 * fake peers (payments, identity, rails). The Postgres adapter is tested against the same use cases in the
 * integration suite.
 */
import { createEnvelopeCipher } from "@nearpay-internal/db";
import type { PdfRenderer } from "../../src/app/pdf.js";
import {
  type Billing,
  type BillingStore,
  type BillingTx,
  CLOCK_JOB_KINDS,
  type CollectionUse,
  type CollectTxResult,
  type CustomerFacts,
  type IdKind,
  type InvoiceListQuery,
  type JobRequest,
  type ListQuery,
  type MerchantFacts,
  type OutgoingEvent,
  type Page,
  type SandboxVaultPort,
  type SessionFacts,
  type SimOutcome,
  type Transition,
  type VaultConfigFacts,
  type VaultPort,
} from "../../src/app/ports.js";
import type { Invoice } from "../../src/domain/invoice/invoice.js";
import type { Collection, Mandate } from "../../src/domain/mandate/mandate.js";
import type { Price } from "../../src/domain/price/price.js";
import type { Product } from "../../src/domain/product/product.js";
import { DomainError, type Scope } from "../../src/domain/shared.js";
import type { Subscription } from "../../src/domain/subscription/subscription.js";
import type { TaxRate } from "../../src/domain/tax-rate/tax-rate.js";

interface Row extends Scope {
  id: string;
  created: number;
  version: number;
}

export interface MemoryState {
  products: Map<string, Product>;
  prices: Map<string, Price>;
  taxRates: Map<string, TaxRate>;
  invoices: Map<string, Invoice>;
  subscriptions: Map<string, Subscription>;
  sequences: Map<string, { prefix: string; next: number }>;
  transitions: Transition[];
  outbox: OutgoingEvent[];
  jobs: Map<string, JobRequest & { done: boolean }>;
  inbox: Set<string>;
  counters: Map<string, { window: number; count: number }>;
  mandates: Map<string, Mandate>;
  collections: Map<string, { mandateId: string; c: Collection; use: CollectionUse }>;
  vaultEvents: Set<string>;
  parked: Map<
    string,
    {
      reason: string;
      retryAt: number | null;
      attempts: number;
      payload: unknown;
      vaultContract: string | null;
      onchainId: number | null;
      resolved: boolean;
    }
  >;
  cases: { mandateId: string; invoiceId: string | null; kind: string; detail: Readonly<Record<string, unknown>> }[];
}

const empty = (): MemoryState => ({
  products: new Map(),
  prices: new Map(),
  taxRates: new Map(),
  invoices: new Map(),
  subscriptions: new Map(),
  sequences: new Map(),
  transitions: [],
  outbox: [],
  jobs: new Map(),
  inbox: new Set(),
  counters: new Map(),
  mandates: new Map(),
  collections: new Map(),
  vaultEvents: new Set(),
  parked: new Map(),
  cases: [],
});

const inScope = (r: Scope, s: Scope) => r.accountId === s.accountId && r.livemode === s.livemode;

function page<T extends Row>(
  rows: Iterable<T>,
  scope: Scope,
  q: ListQuery,
  keep: (r: T) => boolean = () => true,
): Page<T> {
  let all = [...rows]
    .filter((r) => inScope(r, scope) && keep(r))
    .filter((r) => {
      const c = q.created;
      return (
        !c ||
        ((c.gt === undefined || r.created > c.gt) &&
          (c.gte === undefined || r.created >= c.gte) &&
          (c.lt === undefined || r.created < c.lt) &&
          (c.lte === undefined || r.created <= c.lte))
      );
    })
    .sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1));
  if (q.startingAfter) all = all.slice(all.findIndex((r) => r.id === q.startingAfter) + 1);
  if (q.endingBefore)
    all = all.slice(
      0,
      Math.max(
        0,
        all.findIndex((r) => r.id === q.endingBefore),
      ),
    );
  return { data: all.slice(0, q.limit), hasMore: all.length > q.limit };
}

function repo<T extends Row>(m: Map<string, T>, name: string) {
  return {
    async get(scope: Scope, id: string) {
      const r = m.get(id);
      return r && inScope(r, scope) ? structuredClone(r) : undefined;
    },
    async getMany(scope: Scope, ids: readonly string[]) {
      const out = new Map<string, T>();
      for (const id of ids) {
        const r = m.get(id);
        if (r && inScope(r, scope)) out.set(id, structuredClone(r));
      }
      return out;
    },
    async insert(row: T) {
      if (m.has(row.id)) throw new Error(`duplicate ${name} ${row.id}`);
      m.set(row.id, structuredClone(row));
    },
    async update(prev: T, next: T) {
      const cur = m.get(prev.id);
      if (!cur || cur.version !== prev.version) throw new Error(`${name} ${prev.id} changed concurrently`);
      if (next.version <= prev.version) throw new Error(`${name} ${prev.id}: version must increase`);
      m.set(prev.id, structuredClone(next));
    },
  };
}

function txOf(s: MemoryState): BillingTx {
  const base = repo(s.invoices, "invoice");
  /** Like the Postgres adapter: an invoice carries its subscription's clock offset (read-only). */
  const withClock = (i: Invoice | undefined): Invoice | undefined =>
    i && { ...i, clockOffset: i.subscriptionId ? (s.subscriptions.get(i.subscriptionId)?.clockOffset ?? 0) : 0 };
  const invoices = {
    ...base,
    get: async (scope: Scope, id: string) => withClock(await base.get(scope, id)),
  };
  const subscriptions = repo(s.subscriptions, "subscription");
  const checkInvoiceUniques = (row: Invoice) => {
    for (const o of s.invoices.values()) {
      if (o.id === row.id) continue;
      if (row.number && o.number === row.number && inScope(o, row))
        throw new Error("unique (account_id, livemode, number)");
      if (
        row.subscriptionId &&
        row.period &&
        o.subscriptionId === row.subscriptionId &&
        o.period?.start === row.period.start
      )
        throw new Error("unique invoices_sub_period");
    }
  };
  const mandateRepo = repo(s.mandates, "mandate");
  const collecting = (m: Mandate) =>
    m.linkStatus === "linked" && m.releasedAt === null && (m.status === "active" || m.status === "insufficient");
  const payable = (i: Invoice) =>
    i.collectionMethod === "auto_debit" && (i.status === "open" || i.status === "uncollectible");
  const byPeriod = (a: Invoice, b: Invoice) => (a.period?.start ?? 0) - (b.period?.start ?? 0) || a.created - b.created;
  return {
    mandates: {
      ...mandateRepo,
      async getByIdUnscoped(id) {
        const r = s.mandates.get(id);
        return r ? structuredClone(r) : undefined;
      },
      async byOnchain(vault, onchainId) {
        const r = [...s.mandates.values()].find((m) => m.vaultContract === vault && m.onchainId === onchainId);
        return r ? structuredClone(r) : undefined;
      },
      async insert(row) {
        if (
          [...s.mandates.values()].some((m) => m.vaultContract === row.vaultContract && m.onchainId === row.onchainId)
        )
          throw new Error("unique (vault_contract, onchain_id)");
        if (
          collecting(row) &&
          [...s.mandates.values()].some((m) => m.subscriptionId === row.subscriptionId && collecting(m))
        )
          throw new Error("unique mandates_one_collecting");
        await mandateRepo.insert(row);
      },
      list: async (scope, q) =>
        page(
          s.mandates.values(),
          scope,
          q,
          (r) =>
            (q.subscription === undefined || r.subscriptionId === q.subscription) &&
            (q.customer === undefined || r.customerId === q.customer) &&
            (q.status === undefined || r.status === q.status) &&
            (q.linkStatus === undefined || r.linkStatus === q.linkStatus) &&
            (q.payer === undefined || r.payer === q.payer),
        ),
      async collectingFor(scope, subscriptionId) {
        const r = [...s.mandates.values()].find(
          (m) => inScope(m, scope) && m.subscriptionId === subscriptionId && collecting(m),
        );
        return r ? structuredClone(r) : undefined;
      },
      async newestFor(scope, subscriptionId) {
        const r = [...s.mandates.values()]
          .filter((m) => inScope(m, scope) && m.subscriptionId === subscriptionId)
          .sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1))[0];
        return r ? structuredClone(r) : undefined;
      },
      async recordCollection(m, c, use) {
        if (s.collections.has(c.receiptId)) return false;
        if ([...s.collections.values()].some((x) => x.mandateId === m.id && x.c.period === c.period)) return false;
        s.collections.set(c.receiptId, { mandateId: m.id, c: structuredClone(c), use });
        return true;
      },
      async unappliedCollection(m) {
        const r = [...s.collections.values()]
          .filter((x) => x.mandateId === m.id && x.use === "unapplied" && !x.c.short)
          .sort((a, b) => a.c.period - b.c.period)[0];
        return r ? structuredClone(r.c) : undefined;
      },
      async applyCollection(receiptId, invoiceId, use) {
        const r = s.collections.get(receiptId);
        if (r) s.collections.set(receiptId, { ...r, use, c: { ...r.c, invoiceId } });
      },
    },
    mandateInvoices: {
      async payableAutoDebit(m) {
        return [...s.invoices.values()]
          .filter((i) => inScope(i, m) && i.mandateId === m.id && payable(i))
          .sort(byPeriod)
          .map((i) => withClock(structuredClone(i)) as Invoice);
      },
      async payableAutoDebitOfSubscription(scope, subscriptionId) {
        return [...s.invoices.values()]
          .filter((i) => inScope(i, scope) && i.subscriptionId === subscriptionId && payable(i))
          .sort(byPeriod)
          .map((i) => withClock(structuredClone(i)) as Invoice);
      },
    },
    vaultEvents: {
      async markApplied(e) {
        if (s.vaultEvents.has(e.dedupeKey)) return false;
        s.vaultEvents.add(e.dedupeKey);
        return true;
      },
      async park(e) {
        const cur = s.parked.get(e.dedupeKey);
        s.parked.set(e.dedupeKey, {
          reason: e.reason,
          retryAt: e.retryAt,
          attempts: (cur?.attempts ?? 0) + 1,
          payload: structuredClone(e.payload),
          vaultContract: e.vaultContract,
          onchainId: e.onchainId,
          resolved: false,
        });
      },
      async dueParked(now, limit) {
        return [...s.parked.entries()]
          .filter(([, p]) => !p.resolved && p.retryAt !== null && p.retryAt <= now)
          .slice(0, limit)
          .map(([k, p]) => ({ dedupeKey: k, payload: structuredClone(p.payload), attempts: p.attempts }));
      },
      async resolveParked(key) {
        const p = s.parked.get(key);
        if (p) s.parked.set(key, { ...p, resolved: true });
      },
      async parkedFor(vault, onchainId) {
        return [...s.parked.entries()]
          .filter(
            ([, p]) => !p.resolved && p.retryAt !== null && p.vaultContract === vault && p.onchainId === onchainId,
          )
          .map(([k, p]) => ({ dedupeKey: k, payload: structuredClone(p.payload), attempts: p.attempts }));
      },
    },
    async openCase(c) {
      s.cases.push({ mandateId: c.mandateId, invoiceId: c.invoiceId, kind: c.kind, detail: structuredClone(c.detail) });
    },
    products: {
      ...repo(s.products, "product"),
      list: async (scope, q) =>
        page(s.products.values(), scope, q, (r) => q.active === undefined || r.active === q.active),
    },
    prices: {
      ...repo(s.prices, "price"),
      list: async (scope, q) =>
        page(
          s.prices.values(),
          scope,
          q,
          (r) =>
            (q.active === undefined || r.active === q.active) &&
            (q.product === undefined || r.productId === q.product) &&
            (q.type === undefined || r.type === q.type) &&
            (q.currency === undefined || r.currency === q.currency),
        ),
    },
    taxRates: {
      ...repo(s.taxRates, "tax_rate"),
      list: async (scope, q) =>
        page(
          s.taxRates.values(),
          scope,
          q,
          (r) =>
            (q.active === undefined || r.active === q.active) &&
            (q.inclusive === undefined || r.inclusive === q.inclusive),
        ),
    },
    invoices: {
      ...invoices,
      async insert(row) {
        checkInvoiceUniques(row);
        await invoices.insert(row);
      },
      async update(prev, next) {
        checkInvoiceUniques(next);
        await invoices.update(prev, next);
      },
      async getByIdUnscoped(id) {
        const r = s.invoices.get(id);
        return r ? withClock(structuredClone(r)) : undefined;
      },
      async delete(row) {
        const cur = s.invoices.get(row.id);
        if (cur?.status !== "draft") throw new Error("only drafts can be deleted");
        s.invoices.delete(row.id);
      },
      list: async (scope, q: InvoiceListQuery) =>
        page(
          s.invoices.values(),
          scope,
          q,
          (r) =>
            (q.status === undefined || r.status === q.status) &&
            (q.customer === undefined || r.customerId === q.customer) &&
            (q.subscription === undefined || r.subscriptionId === q.subscription) &&
            (q.dueDate?.gte === undefined || (r.dueDate !== null && r.dueDate >= q.dueDate.gte)) &&
            (q.dueDate?.lte === undefined || (r.dueDate !== null && r.dueDate <= q.dueDate.lte)) &&
            (q.collectionMethod === undefined || r.collectionMethod === q.collectionMethod),
        ),
      async bySubscriptionPeriod(scope, subscriptionId, periodStart) {
        const r = [...s.invoices.values()].find(
          (i) => inScope(i, scope) && i.subscriptionId === subscriptionId && i.period?.start === periodStart,
        );
        return r ? withClock(structuredClone(r)) : undefined;
      },
      async openDueDates(scope, subscriptionId) {
        return [...s.invoices.values()].flatMap((i) =>
          inScope(i, scope) && i.subscriptionId === subscriptionId && i.status === "open" && i.dueDate !== null
            ? [i.dueDate]
            : [],
        );
      },
      async countOverdueOpen(scope, subscriptionId, exceptId) {
        return [...s.invoices.values()].filter(
          (i) =>
            inScope(i, scope) &&
            i.subscriptionId === subscriptionId &&
            i.id !== exceptId &&
            i.status === "open" &&
            i.overdueAt !== null,
        ).length;
      },
    },
    subscriptions: {
      ...subscriptions,
      async getByIdUnscoped(id) {
        const r = s.subscriptions.get(id);
        return r ? structuredClone(r) : undefined;
      },
      async update(prev, next) {
        // like the adapter: `update` never writes the clock offset
        const cur = s.subscriptions.get(prev.id);
        await subscriptions.update(prev, { ...next, clockOffset: cur?.clockOffset ?? 0 });
      },
      async advanceClock(prev, delta) {
        const cur = s.subscriptions.get(prev.id);
        if (!cur || prev.livemode || delta <= 0 || (cur.clockOffset ?? 0) !== (prev.clockOffset ?? 0))
          throw new Error(`subscription ${prev.id}: clock advance refused`);
        const next = { ...cur, clockOffset: (cur.clockOffset ?? 0) + delta };
        s.subscriptions.set(prev.id, structuredClone(next));
        return { ...prev, clockOffset: next.clockOffset };
      },
      list: async (scope, q) =>
        page(
          s.subscriptions.values(),
          scope,
          q,
          (r) =>
            (q.status === undefined || r.status === q.status) &&
            (q.customer === undefined || r.customerId === q.customer) &&
            (q.price === undefined || r.items.some((i) => i.priceId === q.price)),
        ),
    },
    sequences: {
      async next(scope, prefixIfNew) {
        const k = `${scope.accountId}:${scope.livemode}`;
        const cur = s.sequences.get(k) ?? { prefix: prefixIfNew, next: 1 };
        s.sequences.set(k, { prefix: cur.prefix, next: cur.next + 1 });
        return { prefix: cur.prefix, number: cur.next };
      },
    },
    async recordTransition(t) {
      s.transitions.push(t);
    },
    async emit(e) {
      s.outbox.push(structuredClone(e));
    },
    async enqueue(j) {
      if (!j.dedupeKey.startsWith(`${j.kind}:`)) throw new Error("dedupe key must start with the kind");
      // like the adapter: stored `runAt` is real time (clock time − offset), `at` stays on the clock
      if (!s.jobs.has(j.dedupeKey))
        s.jobs.set(j.dedupeKey, {
          ...structuredClone(j),
          runAt: j.runAt - (j.clockOffset ?? 0),
          payload: { ...j.payload, at: j.runAt },
          done: false,
        });
    },
    async shiftClockJobs(scope, subscriptionId, delta, now) {
      const invoiceIds = new Set(
        [...s.invoices.values()]
          .filter(
            (i) =>
              inScope(i, scope) &&
              i.subscriptionId === subscriptionId &&
              (i.status === "open" || i.status === "uncollectible"),
          )
          .map((i) => i.id),
      );
      let n = 0;
      for (const [k, j] of s.jobs) {
        const p = j.payload;
        if (j.done || j.runAt <= now || !(CLOCK_JOB_KINDS as readonly string[]).includes(j.kind)) continue;
        if (p.account_id !== scope.accountId || p.livemode !== scope.livemode) continue;
        if (p.subscription !== subscriptionId && !invoiceIds.has(String(p.invoice))) continue;
        s.jobs.set(k, { ...j, runAt: j.runAt - delta });
        n++;
      }
      return n;
    },
    async consume(eventId) {
      if (s.inbox.has(eventId)) return false;
      s.inbox.add(eventId);
      return true;
    },
    async hit(key, windowSeconds, now) {
      const w = Math.floor(now / windowSeconds);
      const c = s.counters.get(key);
      const next = c && c.window === w ? { window: w, count: c.count + 1 } : { window: w, count: 1 };
      s.counters.set(key, next);
      return next.count;
    },
  };
}

export class MemoryStore implements BillingStore {
  state: MemoryState = empty();
  private queue: Promise<unknown> = Promise.resolve();

  transaction<T>(fn: (tx: BillingTx) => Promise<T>): Promise<T> {
    const run = async () => {
      const work = structuredClone(this.state);
      const out = await fn(txOf(work));
      this.state = work;
      return out;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    return p;
  }
}

// ---------------------------------------------------------------------------------------------
// Fake peers
// ---------------------------------------------------------------------------------------------

export class FakePayments {
  customers = new Map<string, CustomerFacts & Scope>();
  sessions = new Map<
    string,
    { -readonly [K in keyof SessionFacts]: SessionFacts[K] } & { clientSecret: string; key: string; amount: bigint }
  >();
  created: { key: string; amount: bigint; expiresAt: number; metadata: Record<string, string> }[] = [];
  expireResult: "expired" | "expiring" | "in_flight" = "expired";
  createError: DomainError | null = null;
  private n = 0;

  addCustomer(scope: Scope, c: Partial<CustomerFacts> & { id: string }): void {
    this.customers.set(c.id, { email: "payer@example.com", name: "Pat Payer", deleted: false, ...scope, ...c });
  }

  readonly port = {
    getCustomer: async (scope: Scope, id: string) => {
      const c = this.customers.get(id);
      return c && inScope(c, scope) ? { id: c.id, email: c.email, name: c.name, deleted: c.deleted } : undefined;
    },
    createInvoiceSession: async (req: Parameters<Billing["payments"]["createInvoiceSession"]>[0], key: string) => {
      if (this.createError) throw this.createError;
      const replay = [...this.sessions.values()].find((s) => s.key === key);
      if (replay) return { kind: "created" as const, session: { ...replay }, clientSecret: replay.clientSecret };
      if ([...this.sessions.values()].some((s) => s.invoiceId === req.invoiceId && s.status === "open"))
        return { kind: "conflict" as const };
      const id = `cs_${String(++this.n).padStart(26, "0")}`;
      const s = {
        id,
        status: "open",
        expiresAt: req.expiresAt,
        invoiceId: req.invoiceId,
        clientSecret: `${id}_secret_${"x".repeat(32)}`,
        key,
        amount: req.amount,
      };
      this.sessions.set(id, s);
      this.created.push({ key, amount: req.amount, expiresAt: req.expiresAt, metadata: { ...req.metadata } });
      return { kind: "created" as const, session: { ...s }, clientSecret: s.clientSecret };
    },
    getSession: async (id: string) => {
      const s = this.sessions.get(id);
      if (!s) throw new Error(`no session ${id}`);
      return { ...s };
    },
    expireSession: async (id: string) => {
      const s = this.sessions.get(id);
      if (!s) throw new Error(`no session ${id}`);
      if (this.expireResult === "in_flight") throw new DomainError("attempt_in_flight");
      s.status = this.expireResult;
      return { ...s };
    },
  };
}

export const MERCHANT: MerchantFacts = {
  displayName: "Acme Corp",
  liveEnabled: true,
  liveMissing: null,
  destinations: [
    {
      id: "sd_default",
      assetId: "nep141:usdc.near",
      chain: "near:mainnet",
      type: "intents_account",
      address: "acme.near",
    },
  ],
  defaults: { "*": "sd_default" },
  vaultFeeBps: 100,
};

// ---------------------------------------------------------------------------------------------
// Fake vault (NEAR RPC) and sandbox stand-in
// ---------------------------------------------------------------------------------------------

export class FakeVault {
  config: VaultConfigFacts = {
    allowedTokens: ["usdc.near", "usdt.near"],
    maxFeeBps: 500,
    caps: new Map([
      ["usdc.near", { cap: 10n ** 15n, mandateCap: 10n ** 12n }],
      ["usdt.near", { cap: 10n ** 15n, mandateCap: 10n ** 12n }],
    ]),
  };
  tvl = 0n;
  storage = new Map<string, { total: bigint; available: bigint }>();
  /** `next_collect_at` per onchain id (ns); absent = due now. */
  next = new Map<number, bigint | null>();
  blockNs = 0n;
  enabled = true;
  rpcDown = false;
  /** Results `send` returns, in order (default success). */
  results: ((txHash: string) => CollectTxResult)[] = [];
  statusResult: ((txHash: string) => CollectTxResult) | null = null;
  sent: { livemode: boolean; onchainId: number; txHash: string }[] = [];
  views = new Map<number, { status: string } | null>();
  private n = 0;
  private check() {
    if (this.rpcDown) throw new Error("rpc down");
  }
  readonly port: VaultPort = {
    contract: (livemode) => (livemode ? "v1.vault.nearpay.near" : "vault.sandbox.near"),
    keeperEnabled: () => this.enabled,
    config: async () => {
      this.check();
      return this.config;
    },
    tokenTvl: async (_l, token) => {
      this.check();
      const c = this.config.caps.get(token);
      return c ? { tvl: this.tvl, cap: c.cap } : null;
    },
    storageBalanceOf: async (_l, account) => {
      this.check();
      return this.storage.get(account) ?? null;
    },
    nextCollectAt: async (_l, id) => {
      this.check();
      return this.next.has(id) ? (this.next.get(id) ?? null) : this.blockNs;
    },
    mandateView: async (_l, id) => this.views.get(id) ?? null,
    blockTimeNs: async () => {
      this.check();
      return this.blockNs;
    },
    signCollect: async (livemode, onchainId) => {
      this.check();
      const txHash = `tx${++this.n}`;
      this.sent.push({ livemode, onchainId, txHash });
      return { txHash, bytes: new Uint8Array([this.n]) };
    },
    send: async (_l, signed) => {
      const r = this.results.shift();
      return r ? r(signed.txHash) : { kind: "success", txHash: signed.txHash };
    },
    status: async (_l, txHash) =>
      this.statusResult ? this.statusResult(txHash) : { kind: "unknown", txHash, error: "unknown" },
  };
}

export class FakeSandbox {
  calls: { kind: string; body: unknown }[] = [];
  /** Next outcome (default: accepted with no logs). */
  outcomes: SimOutcome[] = [];
  advanced: { onchainId: number; secs?: number }[] = [];
  readonly port: SandboxVaultPort = {
    ftTransferCall: async (o) => {
      this.calls.push({ kind: "ft_transfer_call", body: o });
      return this.outcomes.shift() ?? { txHash: "simtx", failure: null, vaultLogs: [] };
    },
    call: async (o) => {
      this.calls.push({ kind: "call", body: o });
      return this.outcomes.shift() ?? { txHash: "simtx", failure: null, vaultLogs: [] };
    },
    advance: async (onchainId, secs) => {
      this.advanced.push(secs === undefined ? { onchainId } : { onchainId, secs });
    },
  };
}

export const fakePdf: PdfRenderer = {
  render: (d) => new TextEncoder().encode(`%PDF ${d.invoice.number} ${d.stamp ?? ""}`),
};

export interface TestBilling extends Billing {
  readonly mem: MemoryStore;
  readonly pay: FakePayments;
  readonly clock: { ms: number };
  merchantFacts: MerchantFacts;
  readonly fakeVault: FakeVault;
  readonly fakeSandbox: FakeSandbox;
  readonly objectsMap: Map<string, Uint8Array>;
  readonly logs: { level: string; msg: string; o: object }[];
  /** Keeper collect outcomes counted (`<outcome>:<livemode>`). */
  readonly keeperOutcomes: string[];
}

/** Use cases wired to fakes; `store` defaults to the in-memory store (the Postgres suite passes its own). */
export function testBilling(startMs: number, store?: BillingStore): TestBilling {
  const mem = new MemoryStore();
  const pay = new FakePayments();
  const clock = { ms: startMs };
  const objectsMap = new Map<string, Uint8Array>();
  const logs: TestBilling["logs"] = [];
  const keeperOutcomes: string[] = [];
  const fakeVault = new FakeVault();
  const fakeSandbox = new FakeSandbox();
  let ids = 0;
  const b: TestBilling = {
    mem,
    pay,
    clock,
    objectsMap,
    logs,
    keeperOutcomes,
    metrics: { keeperCollect: (o, live) => keeperOutcomes.push(`${o}:${live}`) },
    merchantFacts: MERCHANT,
    fakeVault,
    fakeSandbox,
    vault: fakeVault.port,
    sandbox: fakeSandbox.port,
    store: store ?? mem,
    payments: pay.port,
    merchant: { context: async () => b.merchantFacts },
    assets: {
      asset: async (id) =>
        id === "nep141:usdc.near" || id === "nep141:usdt.near"
          ? { assetId: id, symbol: id === "nep141:usdc.near" ? "USDC" : "USDT", decimals: 6 }
          : undefined,
    },
    cipher: createEnvelopeCipher(Buffer.alloc(32, 7)),
    objects: {
      put: async (k, bytes) => {
        objectsMap.set(k, bytes);
      },
      get: async (k) => objectsMap.get(k),
    },
    pdf: fakePdf,
    log: {
      info: (o, msg) => logs.push({ level: "info", msg, o }),
      warn: (o, msg) => logs.push({ level: "warn", msg, o }),
      error: (o, msg) => logs.push({ level: "error", msg, o }),
    },
    settings: {
      payOrigin: "https://pay.nearpay.test",
      apiOrigin: "https://api.nearpay.test",
      pricingCurrencies: new Set(["usd", "eur"]),
      publicSessionsPerClient: 10,
      publicSessionsPerInvoice: 30,
      vaultUsdTokens: ["usdc.near", "usdt.near"],
      vaultTokens: ["usdc.near", "usdt.near"],
      vaultMaxFeeBps: 500,
      simulatedPayer: "sandbox-payer.near",
    },
    newId: (k: IdKind) => `${k}_${String(++ids).padStart(26, "0")}`,
    randomBytes: (n) => {
      const out = new Uint8Array(n);
      for (let i = 0; i < n; i++) out[i] = (ids * 31 + i * 7) % 256;
      return out;
    },
    now: () => clock.ms,
  };
  return b;
}

/** Runs due jobs (kit semantics: by run_at, at-least-once) until none is due at the current clock. */
export async function runDueJobs(
  b: TestBilling,
  handlers: Record<string, (payload: unknown) => Promise<void>>,
): Promise<string[]> {
  const ran: string[] = [];
  for (;;) {
    const due = [...b.mem.state.jobs.entries()]
      .filter(([, j]) => !j.done && j.runAt * 1000 <= b.clock.ms)
      .sort((x, y) => x[1].runAt - y[1].runAt);
    const first = due[0];
    if (!first) return ran;
    const [key, job] = first;
    await (handlers[job.kind] as (p: unknown) => Promise<void>)(job.payload);
    const j = b.mem.state.jobs.get(key);
    if (j) j.done = true;
    ran.push(key);
  }
}
