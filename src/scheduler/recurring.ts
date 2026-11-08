/**
 * Recurring worker jobs (lld/billing.md §7): kit table retention, and a renewal sweep that re-enqueues the
 * renewal of any subscription whose period ended more than 10 minutes ago without one (belt and braces:
 * renewals are idempotent per subscription × period, so a duplicate does nothing). "Ended" is on the
 * subscription's billing clock (`now() + clock_offset_s`, lld/billing.md §13; the offset is 0 in live mode).
 * Stage 4: parked retriable vault events are re-applied every minute (§6).
 */
import { enqueueJob, type Kysely, purgeKitTables, type RecurringJob, sql } from "@nearpay-internal/db";
import type { Billing } from "../app/ports.js";
import { retryParkedVaultEvents } from "../app/vault-events.js";
import type { DB } from "../infra/db/schema.js";
import { idOf } from "../infra/db/store.js";

const MINUTE = 60_000;

export const RECURRING: readonly RecurringJob[] = [
  { kind: "kit.purge", everyMs: 60 * MINUTE },
  { kind: "subscription.sweep", everyMs: 5 * MINUTE },
  // Stage 4: parked retriable vault events (lld/billing.md §6) — every minute
  { kind: "vault.parked_retry", everyMs: MINUTE },
];

export function recurringHandlers(db: Kysely<DB>, b?: Billing): Record<string, (payload: unknown) => Promise<void>> {
  return {
    "vault.parked_retry": async () => {
      if (b) await retryParkedVaultEvents(b);
    },
    "kit.purge": async () => {
      await purgeKitTables(db);
      await sql`delete from rate_counters where window_start < now() - interval '1 day'`.execute(db);
    },
    "subscription.sweep": async () => {
      const due = await db
        .selectFrom("subscriptions")
        .select(["id", "account_id", "livemode", "current_period_end"])
        .where("status", "in", ["active", "past_due", "trialing"])
        .where(
          "current_period_end",
          "<",
          sql<Date>`now() + make_interval(secs => clock_offset_s) - interval '10 minutes'`,
        )
        .orderBy("current_period_end")
        .limit(200)
        .execute();
      for (const s of due) {
        const end = Math.floor(s.current_period_end.getTime() / 1000);
        const id = idOf("sub", s.id);
        await enqueueJob(db, {
          kind: "subscription.renew",
          dedupeKey: `subscription.renew:${id}:${end}:sweep`,
          payload: { subscription: id, account_id: s.account_id, livemode: s.livemode, at: end },
        });
      }
    },
  };
}
