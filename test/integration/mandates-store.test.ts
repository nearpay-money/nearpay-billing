/**
 * Migration 0003 and the Postgres mandate repos (Testcontainers Postgres, app role with DML only).
 * Mandate events need the 0.4.0 kit (aggregate `mandate`); until the bump this suite writes mandate rows
 * through the repos directly (Phase B adds the end-to-end consumer/keeper suite over NATS).
 */
import { createDb, type Database, migrate, sql } from "@nearpay-internal/db";
import { encodeUuid, uuidv7 } from "@nearpay-internal/ids";
import { provisionServiceDatabase, type Started, startPostgres } from "@nearpay-internal/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eventRenderer } from "../../src/api/views.js";
import * as catalog from "../../src/app/catalog.js";
import type { Ctx } from "../../src/app/commit.js";
import * as subs from "../../src/app/subscriptions.js";
import { markPaidByCollection } from "../../src/domain/invoice/invoice.js";
import { applyCollected, type Mandate, release } from "../../src/domain/mandate/mandate.js";
import { markSent } from "../../src/domain/mandate/keeper.js";
import { MIGRATIONS_DIR } from "../../src/infra/db/migrations.js";
import type { DB } from "../../src/infra/db/schema.js";
import { postgresStore } from "../../src/infra/db/store.js";
import { SCOPE, T0 } from "../support/fixtures.js";
import { mandate, meta } from "../support/mandates.js";
import { testBilling } from "../support/memory.js";

let pg: Started;
let db: Database<DB>;
const c: Ctx = { scope: SCOPE, actor: "user:usr_1" };
const id = (k: string) => `${k}_${encodeUuid(uuidv7())}`;

beforeAll(async () => {
  pg = await startPostgres({ database: "postgres" });
  const { migratorUrl, appUrl } = await provisionServiceDatabase(pg.url, "billing");
  const migrator = createDb<DB>({ url: migratorUrl });
  await migrate(migrator.db, MIGRATIONS_DIR);
  await migrator.close();
  db = createDb<DB>({ url: appUrl, applicationName: "billing-test" });
});

afterAll(async () => {
  await db?.close();
  await pg?.stop();
});

describe("mandates in Postgres", () => {
  it("round-trips mandates, collections, invoices paid by collection, vault events and cases", async () => {
    const b = testBilling(T0 * 1000, postgresStore(db.db, eventRenderer("https://api.nearpay.test")));
    (b as { newId: typeof b.newId }).newId = (k) => id(k);
    const cus = id("cus");
    b.pay.addCustomer(SCOPE, { id: cus });
    const p = await catalog.createProduct(b, c, { name: "Pro" });
    const price = await catalog.createPrice(b, c, {
      productId: p.id,
      unitAmount: 2_500n,
      currency: "usd",
      assetId: null,
      recurring: { interval: "month" },
    });
    b.merchantFacts = { ...b.merchantFacts, destinations: [{ ...b.merchantFacts.destinations[0], id: id("sd") } as never] };
    b.merchantFacts = { ...b.merchantFacts, defaults: { "*": b.merchantFacts.destinations[0]?.id as string } };
    const s = await subs.createSubscription(b, c, { customerId: cus, items: [{ priceId: price.id }], collectionMethod: "auto_debit" });
    expect(s.collectionMethod).toBe("auto_debit");

    const m0: Mandate = {
      ...mandate({ id: id("md"), subscriptionId: s.id, customerId: cus, settlementDestinationId: id("sd") }, { onchainId: 7 }),
      lastEventHeight: 2 ** 40,
      startAtNs: 18_446_744_073_709_551_615n, // u64 max fits
      amountPerPeriod: 10n ** 38n,
    };
    await b.store.transaction(async (tx) => {
      await tx.mandates.insert(m0);
      await tx.recordTransition({ aggregate: "mandate", id: m0.id, from: null, to: "active/linked", cause: "t", actor: "a" });
    });
    const back = await b.store.transaction((tx) => tx.mandates.get(SCOPE, m0.id));
    expect(back).toEqual(m0);
    const other = await b.store.transaction((tx) => tx.mandates.get({ ...SCOPE, livemode: true }, m0.id));
    expect(other).toBeUndefined();
    const byChain = await b.store.transaction((tx) => tx.mandates.byOnchain("vault.sandbox.near", 7));
    expect(byChain?.id).toBe(m0.id);
    expect((await b.store.transaction((tx) => tx.mandates.collectingFor(SCOPE, s.id)))?.id).toBe(m0.id);

    // one collecting mandate per subscription (unique index)
    await expect(
      b.store.transaction((tx) => tx.mandates.insert({ ...m0, id: id("md"), onchainId: 8 })),
    ).rejects.toThrow();

    // keeper state + collection + optimistic version
    const sent = { ...markSent(m0, s.latestInvoiceId as string, "txhash", T0), version: 1 };
    await b.store.transaction((tx) => tx.mandates.update(m0, sent));
    await expect(b.store.transaction((tx) => tx.mandates.update(m0, { ...sent, version: 2 }))).rejects.toThrow(/concurrently/);
    const coll = {
      period: 1,
      amount: 10n ** 38n,
      merchantShare: 9n * 10n ** 37n,
      fee: 10n ** 37n,
      short: false,
      invoiceId: s.latestInvoiceId,
      txHash: "txhash",
      receiptId: "receipt-1",
      collectedAt: T0,
    };
    await b.store.transaction(async (tx) => {
      expect(await tx.mandates.recordCollection(sent, coll, "paid")).toBe(true);
      expect(await tx.mandates.recordCollection(sent, coll, "paid")).toBe(false);
      expect(await tx.mandates.recordCollection(sent, { ...coll, receiptId: "receipt-2" }, "paid")).toBe(false); // same period
      await tx.mandates.update(sent, { ...applyCollected(sent, coll, 5n, meta({ blockHeight: 2 ** 41 }), T0), version: 2 });
      expect(await tx.mandates.recordCollection(sent, { ...coll, period: 2, receiptId: "receipt-3", invoiceId: null }, "unapplied")).toBe(true);
      expect((await tx.mandates.unappliedCollection(sent))?.period).toBe(2);
    });
    const after = (await b.store.transaction((tx) => tx.mandates.get(SCOPE, m0.id))) as Mandate;
    expect(after).toMatchObject({ collectedPeriods: 1, balance: 5n });
    expect(after.lastCollection?.merchantShare).toBe(9n * 10n ** 37n);

    // an invoice paid by a collection (no payment intent) satisfies the evidence constraint
    const invId = s.latestInvoiceId as string;
    await b.store.transaction(async (tx) => {
      const i = await tx.invoices.get(SCOPE, invId, { lock: true });
      if (!i) throw new Error("no invoice");
      const paid = markPaidByCollection({ ...i, collectionMethod: "auto_debit", mandateId: m0.id }, T0, {
        mandateId: m0.id,
        period: 1,
        assetId: "nep141:usdc.near",
        merchantShare: 24_750_000n,
        fee: 250_000n,
        txHash: "txhash",
        receiptId: "receipt-1",
      });
      await tx.invoices.update(i, { ...paid, version: i.version + 1 });
    });
    const paid = await b.store.transaction((tx) => tx.invoices.get(SCOPE, invId));
    expect(paid).toMatchObject({ status: "paid", collectionMethod: "auto_debit", mandateId: m0.id });
    expect(paid?.mandateCollection?.merchantShare).toBe(24_750_000n);
    // paid without any evidence is refused by the database
    await expect(
      sql`update invoices set mandate_collection = null where id = ${paid ? (await import("../../src/infra/db/store.js")).uuidOf(paid.id) : ""}::uuid`.execute(db.db),
    ).rejects.toThrow();

    // vault event dedupe, parking and cases
    await b.store.transaction(async (tx) => {
      const e = { dedupeKey: "r:0", vaultContract: "vault.sandbox.near", livemode: false, onchainId: 7, event: "topped_up", blockHeight: 1, outcome: "applied" };
      expect(await tx.vaultEvents.markApplied(e)).toBe(true);
      expect(await tx.vaultEvents.markApplied(e)).toBe(false);
      await tx.vaultEvents.park({ dedupeKey: "r:1", vaultContract: "vault.sandbox.near", livemode: false, onchainId: 9, event: "collected", reason: "unknown_mandate", error: "x", payload: { a: 1 }, retryAt: T0 });
      await tx.vaultEvents.park({ dedupeKey: "r:1", vaultContract: "vault.sandbox.near", livemode: false, onchainId: 9, event: "collected", reason: "unknown_mandate", error: "x", payload: { a: 1 }, retryAt: T0 });
      await tx.openCase({ scope: SCOPE, mandateId: m0.id, invoiceId: invId, kind: "short_share", detail: { shortfall: 5n } });
    });
    const due = await b.store.transaction((tx) => tx.vaultEvents.dueParked(T0 + 1, 10));
    expect(due).toEqual([{ dedupeKey: "r:1", payload: { a: 1 }, attempts: 2 }]);
    expect(await b.store.transaction((tx) => tx.vaultEvents.parkedFor("vault.sandbox.near", 9))).toHaveLength(1);
    await b.store.transaction((tx) => tx.vaultEvents.resolveParked("r:1"));
    expect(await b.store.transaction((tx) => tx.vaultEvents.dueParked(T0 + 1, 10))).toHaveLength(0);

    // release and list filters
    const cur = (await b.store.transaction((tx) => tx.mandates.get(SCOPE, m0.id))) as Mandate;
    await b.store.transaction((tx) => tx.mandates.update(cur, { ...(release(cur, T0) as Mandate), version: cur.version + 1 }));
    expect(await b.store.transaction((tx) => tx.mandates.collectingFor(SCOPE, s.id))).toBeUndefined();
    const page = await b.store.transaction((tx) => tx.mandates.list(SCOPE, { limit: 10, subscription: s.id, linkStatus: "linked" }));
    expect(page.data.map((x) => x.id)).toEqual([m0.id]);
    expect((await b.store.transaction((tx) => tx.mandates.newestFor(SCOPE, s.id)))?.id).toBe(m0.id);
    const n = await sql<{ n: string }>`select count(*)::text as n from mandate_transitions`.execute(db.db);
    expect(n.rows[0]?.n).toBe("1");
  });
});
