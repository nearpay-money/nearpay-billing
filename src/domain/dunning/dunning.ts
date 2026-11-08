/**
 * Dunning (lld/billing.md §7, §11 d8). Every finalized invoice carries `reminder_days` (offsets in days
 * from the due date); offsets already past at finalize are skipped. Reminder `n` is the 1-based position in
 * `reminder_days` (stable, so job keys `in:<id>:r<n>` and `?reminder=n` agree). At the due date an unpaid
 * invoice is overdue (once). Dunning is exhausted at `max(due date, last remaining reminder)`: subscription
 * invoices become `uncollectible` (`dunning_exhausted`) and their subscription `canceled` or `unpaid`
 * (`on_exhausted`; the first invoice of an `incomplete` subscription cancels it, `incomplete_expired`);
 * manual invoices stay `open`. Pure.
 */
import { type Invoice, markUncollectible } from "../invoice/invoice.js";
import { DAY } from "../shared.js";

export interface Reminder {
  /** 1-based position in `reminder_days`. */
  readonly number: number;
  readonly offsetDays: number;
  readonly at: number;
  /** The last entry of `reminder_days`. */
  readonly last: boolean;
}

/** Reminders still to send for an invoice due at `dueDate` and finalized at `finalizedAt`, in order. */
export function reminderSchedule(dueDate: number, reminderDays: readonly number[], finalizedAt: number): Reminder[] {
  return reminderDays
    .map((offsetDays, i) => ({
      number: i + 1,
      offsetDays,
      at: dueDate + offsetDays * DAY,
      last: i === reminderDays.length - 1,
    }))
    .filter((r) => r.at >= finalizedAt);
}

export function scheduleOf(inv: Invoice): Reminder[] {
  if (inv.dueDate === null || inv.finalizedAt === null) return [];
  return reminderSchedule(inv.dueDate, inv.reminderDays, inv.finalizedAt);
}

/** Next reminder of an `open` invoice (`next_reminder_at`); null when none is due any more. */
export function nextReminder(inv: Invoice): Reminder | null {
  if (inv.status !== "open" || inv.collectionMethod === "auto_debit") return null;
  return scheduleOf(inv)[inv.remindersSent] ?? null;
}

/** When dunning is exhausted: the due date or the last remaining reminder, whichever is later. */
export function exhaustAt(inv: Invoice): number | null {
  if (inv.dueDate === null) return null;
  const s = scheduleOf(inv);
  const last = s[s.length - 1];
  return last && last.at > inv.dueDate ? last.at : inv.dueDate;
}

/**
 * Whether reminder `number` should go out now. It must be the next one in order (`reminders_sent`
 * counts sent ones; a stale or repeated job is skipped), and the invoice still unpaid: `open`, or
 * `uncollectible` because dunning just exhausted at the same instant (the last reminder still goes out).
 */
export function reminderToSend(
  inv: Invoice,
  number: number,
  now: number,
): { reminder: Reminder; invoice: Invoice } | null {
  // an auto-debit invoice is collected by the keeper: no reminder mail while it is (reminders that pass
  // meanwhile are skipped when it falls back to `send_invoice`, mandate/collection.ts)
  if (inv.collectionMethod === "auto_debit") return null;
  const unpaid =
    inv.status === "open" || (inv.status === "uncollectible" && inv.uncollectibleReason === "dunning_exhausted");
  if (!unpaid) return null;
  const s = scheduleOf(inv);
  const next = s[inv.remindersSent];
  if (!next || next.number !== number || now < next.at) return null;
  return { reminder: next, invoice: { ...inv, remindersSent: inv.remindersSent + 1, updated: now } };
}

/**
 * Reminder `number` is due but an earlier reminder that is also due has not gone out yet: its job has not
 * run (jobs that became due together, e.g. after a test-clock advance, may run concurrently). The caller
 * retries later instead of skipping, so reminders still go out in order and none is lost (§13).
 */
export function reminderWaitsForEarlier(inv: Invoice, number: number, now: number): boolean {
  if (inv.collectionMethod === "auto_debit") return false;
  const unpaid =
    inv.status === "open" || (inv.status === "uncollectible" && inv.uncollectibleReason === "dunning_exhausted");
  if (!unpaid) return false;
  const s = scheduleOf(inv);
  const next = s[inv.remindersSent];
  const mine = s.find((r) => r.number === number);
  return next !== undefined && mine !== undefined && next.number < number && now >= mine.at;
}

/** At the due date: an `open` invoice becomes overdue once (`invoice.overdue`). */
export function markOverdue(inv: Invoice, now: number): Invoice | null {
  if (inv.status !== "open" || inv.overdueAt !== null || inv.dueDate === null || now < inv.dueDate) return null;
  return { ...inv, overdueAt: now, updated: now };
}

export type SubscriptionEffect =
  | { readonly to: "canceled"; readonly reason: "dunning_exhausted" | "incomplete_expired" }
  | { readonly to: "unpaid" };

/**
 * Exhaustion of an unpaid invoice. Manual invoices stay `open` (null). Subscription invoices become
 * `uncollectible` and the subscription follows `on_exhausted` (or cancels when it never started).
 */
export function exhaust(
  inv: Invoice,
  now: number,
  subscription: { readonly status: string; readonly onExhausted: "cancel" | "unpaid" } | null,
): { invoice: Invoice; subscription: SubscriptionEffect | null } | null {
  if (inv.status !== "open" || inv.subscriptionId === null || subscription === null) return null;
  const at = exhaustAt(inv);
  if (at === null || now < at) return null;
  const invoice = markUncollectible(inv, now, "dunning_exhausted");
  if (subscription.status === "canceled") return { invoice, subscription: null };
  if (subscription.status === "incomplete")
    return { invoice, subscription: { to: "canceled", reason: "incomplete_expired" } };
  if (subscription.status === "unpaid") return { invoice, subscription: null };
  return {
    invoice,
    subscription:
      subscription.onExhausted === "cancel" ? { to: "canceled", reason: "dunning_exhausted" } : { to: "unpaid" },
  };
}
