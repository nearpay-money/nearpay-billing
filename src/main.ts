/**
 * Process entry (foundations §15, lld/billing.md §2): `node dist/main.js api|worker|migrate|healthcheck`.
 * - `api`      merchant, hosted-invoice and internal routes (`billing-api`, 2 replicas)
 * - `worker`   consumers, jobs, recurring jobs, outbox relay (`billing-worker`)
 * - `migrate`  applies kit + billing migrations with the migrator role (one-shot)
 */
import { createDb, migrate } from "@nearpay-internal/db";
import { loadConfig, runMain } from "@nearpay-internal/service";
import { migrateShape, readApiConfig, readWorkerConfig } from "./config.js";
import { MIGRATIONS_DIR } from "./infra/db/migrations.js";

await runMain({
  api: async () => {
    const { createApi } = await import("./app/services.js");
    return createApi(readApiConfig()).service;
  },
  worker: async () => {
    const { createWorker } = await import("./app/services.js");
    return (await createWorker(readWorkerConfig())).service;
  },
  migrate: async () => {
    const config = loadConfig(migrateShape);
    const database = createDb({ url: config.dbUrl, applicationName: "billing-migrate" });
    try {
      const applied = await migrate(database.db, MIGRATIONS_DIR, (m) => process.stdout.write(`${m}\n`));
      process.stdout.write(`migrations up to date (${applied.length} applied)\n`);
    } finally {
      await database.close();
    }
    return undefined;
  },
});
