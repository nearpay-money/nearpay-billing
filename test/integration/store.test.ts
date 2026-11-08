/**
 * The Postgres adapter under the real use cases (Testcontainers Postgres, provisioned like nearpay-deploy:
 * migrator owns the database, the app role has DML only). Peers are fakes; events are rendered by a stub
 * until the spec 0.3.0 views land. Jobs run against the use cases' fake clock.
 */
import { createDb, type Database, migrate, sql } from "@nearpay-internal/db";
import { provisionServiceDatabase, type Started, startPostgres } from "@nearpay-internal/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import * as catalog from "../../src/app/catalog.js";
import type { Ctx } from "../../src/app/commit.js";
import { createPublicInvoiceSession } from "../../src/app/hosted.js";
import * as inv from "../../src/app/invoices.js";
import { onPaymentIntentSucceeded } from "../../src/app/payment-events.js";
import type { EventObject } from "../../src/app/ports.js";
import * as subs from "../../src/app/subscriptions.js";
import type { Invoice } from "../../src/domain/invoice/invoice.js";
import { DAY, DomainError } from "../../src/domain/shared.js";
import { MIGRATIONS_DIR } from "../../src/infra/db/migrations.js";
import type { DB } from "../../src/infra/db/schema.js";
import { postgresStore } from "../../src/infra/db/store.js";
import { jobHandlers } from "../../src/workers/jobs.js";
import { OTHER, SCOPE, T0 } from "../support/fixtures.js";
import { type TestBilling, testBilling } from "../support/memory.js";

let pg: Started;
let db: Database<DB>;
const c: Ctx = { scope: SCOPE, actor: "user:usr_1" };
const render = (o: EventObject) =>
  o.kind === "subscription"
    ? { id: o.subscription.id, status: o.subscription.status }
    : { id: o.invoice.id, status: o.invoice.status };

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

let b: TestBilling;
beforeEach(() => {
  b = testBilling(T0 * 1000, postgresStore(db.db, render));
  // real-format ids (TypeID suffixes) for the uuid columns
  (b as { newId: TestBilling["newId"] }).newId = (k) => `${k}_${encodeV7()}`;
  b.pay.addCustomer(SCOPE, { id: cus("1") });
  b.pay.addCustomer(OTHER, { id: cus("2") });
});

let seq = 0;
function encodeV7(): string {
  // UUIDv7 from the fake clock + counter, TypeID-encoded (26 chars, first 0–7)
  const ms = BigInt(b.clock.ms) + BigInt(++seq);
  const hex = `${ms.toString(16).padStart(12, "0")}7${(seq % 4096).toString(16).padStart(3, "0")}8${seq.toString(16).padStart(15, "0")}`;
  let n = BigInt(`0x${hex}`);
  const A = "0123456789abcdefghjkmnpqrstvwxyz";
  let s = "";
  for (let i = 0; i < 26; i++) {
    s = A[Number(n & 31n)] + s;
    n >>= 5n;
  }
  return s;
}
const cus = (n: string) => `cus_${"0".repeat(25)}${n}`;

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DomainError) return e.code;
    throw e;
  }
  return "ok";
}

/** Due jobs at the fake clock, kit table semantics (done_at), oldest first. */
async function runJobs(): Promise<number> {
  const handlers = jobHandlers(b);
  let n = 0;
  for (;;) {
    const job = await db.db
      .selectFrom("jobs")
      .selectAll()
      .where("done_at", "is", null)
      .where("run_at", "<=", new Date(b.clock.ms))
      .orderBy("run_at")
      .limit(1)
      .executeTakeFirst();
    if (!job) return n;
    await (handlers as Record<string, (p: unknown) => Promise<void>>)[job.kind]?.(job.payload);
    await db.db.updateTable("jobs").set({ done_at: new Date() }).where("id", "=", job.id).execute();
    n++;
  }
}

async function setup() {
  const p = await catalog.createProduct(b, c, { name: "Consulting" });
  const price = await catalog.createPrice(b, c, {
    productId: p.id,
    unitAmount: 10_000n,
    currency: "usd",
    assetId: null,
  });
  const monthly = await catalog.createPrice(b, c, {
    productId: p.id,
    unitAmount: 2_500n,
    currency: "usd",
    assetId: null,
    recurring: { interval: "month" },
  });
  const vat = await catalog.createTaxRate(b, c, { displayName: "VAT", percentage: "8.875", inclusive: false });
  return { p, price, monthly, vat };
}

describe("postgres store", () => {
  it("catalogue round-trips, pages newest first and stays in scope", async () => {
    const { p, price, vat } = await setup();
    expect(await catalog.getProduct(b, c, p.id)).toEqual(p);
    expect(await catalog.getPrice(b, c, price.id)).toEqual(price);
    expect(await catalog.getTaxRate(b, c, vat.id)).toEqual(vat);
    const big = await catalog.createPrice(b, c, {
      productId: p.id,
      unitAmount: 10n ** 30n,
      currency: "asset",
      assetId: "nep141:usdc.near",
    });
    expect((await catalog.getPrice(b, c, big.id)).unitAmount).toBe(10n ** 30n);
    for (let i = 0; i < 3; i++) await catalog.createProduct(b, c, { name: `P${i}` });
    const first = await catalog.listProducts(b, c, { limit: 2 });
    expect(first.hasMore).toBe(true);
    const next = await catalog.listProducts(b, c, { limit: 2, startingAfter: first.data[1]?.id });
    const back = await catalog.listProducts(b, c, { limit: 2, endingBefore: next.data[0]?.id });
    expect(back.data.map((x) => x.id)).toEqual(first.data.map((x) => x.id));
    expect(await code(catalog.getProduct(b, { ...c, scope: OTHER }, p.id))).toBe("resource_missing");
    expect((await catalog.listProducts(b, { ...c, scope: OTHER }, { limit: 10 })).data).toHaveLength(0);
    expect(
      (await catalog.listPrices(b, c, { limit: 10, product: p.id, currency: "asset" })).data.map((x) => x.id),
    ).toEqual([big.id]);
    expect(await code(catalog.getProduct(b, c, "prod_malformed"))).toBe("resource_missing");
    const u = await catalog.updateTaxRate(b, c, vat.id, { active: false, country: "US" });
    expect(await catalog.getTaxRate(b, c, vat.id)).toEqual(u);
  });

  it("invoices: lines replaced, numbers allocated, paid from a payments event (inbox dedupe)", async () => {
    const { price, vat } = await setup();
    const d = await inv.createInvoice(b, c, {
      customerId: cus("1"),
      lines: [{ priceId: price.id, quantity: 3 }],
      defaultTaxRateIds: [vat.id],
    });
    expect(await inv.getInvoice(b, c, d.id)).toEqual(d);
    const u = await inv.updateInvoice(b, c, d.id, {
      lines: [{ priceId: price.id }, { unitAmount: 1n, description: "x", quantity: 7 }],
    });
    expect(u.lines).toHaveLength(2);
    expect(await inv.getInvoice(b, c, d.id)).toEqual(u);
    const o = await inv.finalizeInvoice(b, c, d.id);
    expect(o.number).toBe("ACMECOT-00001");
    expect(await inv.getInvoice(b, c, o.id)).toEqual(o);
    const o2 = await inv.finalizeInvoice(
      b,
      c,
      (await inv.createInvoice(b, c, { customerId: cus("1"), lines: [{ priceId: price.id }] })).id,
    );
    expect(o2.number).toBe("ACMECOT-00002");

    const secret = inv.invoiceSecretOf(b, o) as string;
    const s = await createPublicInvoiceSession(b, o.id, secret, { clientNetwork: "198.51.100.0/24" });
    expect((await createPublicInvoiceSession(b, o.id, secret, { clientNetwork: "198.51.100.0/24" })).reused).toBe(true);
    const event = {
      eventId: "0190f0c4-0000-7000-8000-0000000000e1",
      subject: "evt.payments.payment_intent.succeeded",
      scope: SCOPE,
      object: {
        id: "pi_01jbz9k3m4n5p6q7r8s9t0v1w2",
        status: "succeeded",
        invoiceId: o.id,
        ...SCOPE,
        currency: "usd",
        assetId: null,
        amount: o.total,
      },
    };
    await onPaymentIntentSucceeded(b, event);
    await onPaymentIntentSucceeded(b, event);
    const paid = await inv.getInvoice(b, c, o.id);
    expect(paid).toMatchObject({ status: "paid", paymentIntentId: event.object.id, session: null });
    expect(s.checkoutSession).toMatch(/^cs_/);

    const outbox = await db.db
      .selectFrom("outbox")
      .select(["subject", "aggregate_version"])
      .where("aggregate_id", "=", toUuid(o.id))
      .orderBy("created_at")
      .execute();
    expect(outbox.map((r) => r.subject)).toEqual([
      "evt.billing.invoice.created",
      "evt.billing.invoice.finalized",
      "evt.billing.invoice.paid",
    ]);
    expect(new Set(outbox.map((r) => r.aggregate_version)).size).toBe(3);
    const trans = await db.db
      .selectFrom("invoice_transitions")
      .select(["from_state", "to_state"])
      .where("invoice_id", "=", toUuid(o.id))
      .orderBy("created_at")
      .execute();
    expect(trans.map((t) => `${t.from_state}->${t.to_state}`)).toEqual(["null->draft", "draft->open", "open->paid"]);
    await expect(sql`update invoice_transitions set cause = 'x'`.execute(db.db)).rejects.toThrow(/append-only/);
    await expect(sql`delete from invoices where id = ${toUuid(o.id)}::uuid`.execute(db.db)).rejects.toThrow(
      /cannot be deleted/,
    );

    const gone = await inv.createInvoice(b, c, { customerId: cus("1"), currency: "usd" });
    await inv.deleteInvoice(b, c, gone.id);
    expect(await code(inv.getInvoice(b, c, gone.id))).toBe("resource_missing");
    expect((await inv.listInvoices(b, c, { limit: 10, status: "paid" })).data.map((i) => i.id)).toEqual([o.id]);
  });

  it("concurrent writes fail on the optimistic version instead of overwriting", async () => {
    const { p } = await setup();
    await db.db.updateTable("products").set({ version: 5 }).where("id", "=", toUuid(p.id)).execute();
    await expect(
      b.store.transaction(async (tx) => {
        await tx.products.update(p, { ...p, name: "X", version: p.version + 1 });
      }),
    ).rejects.toThrow(/changed concurrently/);
  });

  it("subscriptions: create, renew via jobs once per period, dunning to past_due and cancel", async () => {
    const { monthly } = await setup();
    const s = await subs.createSubscription(b, c, {
      customerId: cus("1"),
      items: [{ priceId: monthly.id, quantity: 2 }],
      dunning: { reminderDays: [0, 1] },
    });
    expect(await subs.getSubscription(b, c, s.id)).toEqual(s);
    const list = async () => (await inv.listInvoices(b, c, { limit: 50, subscription: s.id })).data.slice().reverse();
    const [first] = await list();
    await onPaymentIntentSucceeded(b, {
      eventId: "0190f0c4-0000-7000-8000-0000000000e2",
      subject: "evt.payments.payment_intent.succeeded",
      scope: SCOPE,
      object: {
        id: "pi_01jbz9k3m4n5p6q7r8s9t0v1w3",
        status: "succeeded",
        invoiceId: (first as Invoice).id,
        ...SCOPE,
        currency: "usd",
        assetId: null,
        amount: (first as Invoice).total,
      },
    });
    expect((await subs.getSubscription(b, c, s.id)).status).toBe("active");
    b.clock.ms = s.currentPeriodEnd * 1000;
    await runJobs();
    await subs.renewJob(b, { subscription: s.id, scope: SCOPE, at: s.currentPeriodEnd });
    const all = await list();
    expect(all).toHaveLength(2);
    const renewal = all[1] as Invoice;
    expect(renewal).toMatchObject({
      billingReason: "subscription_cycle",
      status: "open",
      period: { start: s.currentPeriodEnd },
    });
    b.clock.ms = ((renewal.dueDate as number) + DAY) * 1000;
    await runJobs();
    expect(await inv.getInvoice(b, c, renewal.id)).toMatchObject({ status: "uncollectible", remindersSent: 2 });
    expect(await subs.getSubscription(b, c, s.id)).toMatchObject({
      status: "canceled",
      cancellationReason: "dunning_exhausted",
    });
    const st = await db.db
      .selectFrom("subscription_transitions")
      .select(["to_state"])
      .where("subscription_id", "=", toUuid(s.id))
      .orderBy("created_at")
      .execute();
    expect(st.map((x) => x.to_state)).toEqual(["incomplete", "active", "past_due", "canceled"]);
  });

  it("rate counters count per fixed window", async () => {
    const hit = (now: number) => b.store.transaction((tx) => tx.hit("k", 60, now));
    expect(await hit(T0)).toBe(1);
    expect(await hit(T0 + 1)).toBe(2);
    expect(await hit(T0 + 60)).toBe(1);
  });
});

import { decodeSuffix } from "@nearpay-internal/ids";

function toUuid(id: string): string {
  return decodeSuffix(id.slice(id.lastIndexOf("_") + 1));
}
