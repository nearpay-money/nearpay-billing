/**
 * Dunning jobs (lld/billing.md §7, §11 d8): reminders (`evt.billing.invoice.reminder`, notify mails),
 * overdue at the due date (subscription → `past_due`), exhaustion (subscription invoices →
 * `uncollectible`, subscription → `canceled`/`unpaid`). Every handler re-reads and locks, so a repeated
 * or stale job changes nothing (INV-4).
 */
import { exhaust, markOverdue, reminderToSend, reminderWaitsForEarlier } from "../domain/dunning/dunning.js";
import type { Invoice } from "../domain/invoice/invoice.js";
import type { Scope } from "../domain/shared.js";
import { onDunningExhausted, onInvoiceOverdue, type Subscription } from "../domain/subscription/subscription.js";
import { saveInvoice, saveSubscription } from "./commit.js";
import { clockS, renderPdfLater } from "./invoices.js";
import type { Billing, BillingTx } from "./ports.js";

export interface InvoiceJob {
  readonly invoice: string;
  readonly scope: Scope;
  /** When the job was scheduled for (decisions use `max(now, at)`, see `JobRequest`). */
  readonly at?: number | undefined;
}

/** `max(clock now, at)` on the invoice's billing clock (§12 d17, §13). */
const jobNow = (b: Billing, inv: Invoice, j: { readonly at?: number | undefined }): number =>
  Math.max(clockS(b, inv), j.at ?? 0);

const SYSTEM = "system:dunning";

export function remindJob(b: Billing, j: InvoiceJob & { readonly number: number }): Promise<void> {
  return b.store.transaction(async (tx) => {
    const inv = await tx.invoices.get(j.scope, j.invoice, { lock: true });
    if (!inv) return;
    const now = jobNow(b, inv, j);
    const due = reminderToSend(inv, j.number, now);
    if (!due) {
      // an earlier due reminder's job has not run yet: retry (the job runner backs off) rather than skip it
      if (reminderWaitsForEarlier(inv, j.number, now))
        throw new Error(`reminder ${j.number} of ${inv.id} waits for reminder ${inv.remindersSent + 1}`);
      return;
    }
    await saveInvoice(
      tx,
      inv,
      due.invoice,
      { actor: SYSTEM, cause: `reminder ${due.reminder.number}` },
      ["evt.billing.invoice.reminder"],
      (invoice) => ({ kind: "invoice_reminder", invoice, reminder: due.reminder }),
    );
  });
}

/**
 * Marks a due `open` invoice overdue (`invoice.overdue`) and moves its subscription `active → past_due`,
 * inside `tx`. Returns the invoice and subscription as now stored; unchanged when not (yet) applicable.
 */
async function applyOverdue(
  tx: BillingTx,
  inv: Invoice,
  sub: Subscription | undefined,
  now: number,
): Promise<{ inv: Invoice; sub: Subscription | undefined }> {
  const next = markOverdue(inv, now);
  if (!next) return { inv, sub };
  const saved = await saveInvoice(tx, inv, next, { actor: SYSTEM, cause: "overdue" }, ["evt.billing.invoice.overdue"]);
  const moved = sub ? onInvoiceOverdue(sub, now) : null;
  if (!sub || !moved) return { inv: saved, sub };
  const savedSub = await saveSubscription(tx, sub, moved, { actor: SYSTEM, cause: `invoice ${saved.id} overdue` }, [
    "evt.billing.subscription.updated",
  ]);
  return { inv: saved, sub: savedSub };
}

export function overdueJob(b: Billing, j: InvoiceJob): Promise<void> {
  return b.store.transaction(async (tx) => {
    const inv = await tx.invoices.get(j.scope, j.invoice, { lock: true });
    if (!inv) return;
    const now = jobNow(b, inv, j);
    if (!markOverdue(inv, now)) return;
    const sub = inv.subscriptionId
      ? await tx.subscriptions.get(j.scope, inv.subscriptionId, { lock: true })
      : undefined;
    await applyOverdue(tx, inv, sub, now);
  });
}

export function exhaustJob(b: Billing, j: InvoiceJob): Promise<void> {
  return b.store.transaction(async (tx) => {
    const inv = await tx.invoices.get(j.scope, j.invoice, { lock: true });
    if (!inv?.subscriptionId) return;
    const locked = await tx.subscriptions.get(j.scope, inv.subscriptionId, { lock: true });
    const now = jobNow(b, inv, j);
    if (!exhaust(inv, now, locked ? { status: locked.status, onExhausted: locked.dunning.onExhausted } : null)) return;
    // exhaustion at the due date may run before (or alongside) the overdue job: become overdue first, so
    // `invoice.overdue` and `past_due` are never skipped (same instant, normal order)
    const od = await applyOverdue(tx, inv, locked, now);
    const sub = od.sub;
    const out = exhaust(od.inv, now, sub ? { status: sub.status, onExhausted: sub.dunning.onExhausted } : null);
    if (!out) return;
    const saved = await saveInvoice(tx, od.inv, out.invoice, { actor: SYSTEM, cause: "dunning exhausted" }, [
      "evt.billing.invoice.marked_uncollectible",
    ]);
    await renderPdfLater(tx, saved);
    if (!sub || !out.subscription) return;
    let prev = sub;
    for (const step of onDunningExhausted(sub, out.subscription, now)) {
      const subject =
        step.status === "canceled" ? "evt.billing.subscription.deleted" : "evt.billing.subscription.updated";
      prev = await saveSubscription(tx, prev, step, { actor: SYSTEM, cause: `invoice ${inv.id} dunning exhausted` }, [
        subject,
      ]);
    }
  });
}
