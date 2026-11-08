/**
 * Dunning jobs (lld/billing.md §7, §11 d8): reminders (`evt.billing.invoice.reminder`, notify mails),
 * overdue at the due date (subscription → `past_due`), exhaustion (subscription invoices →
 * `uncollectible`, subscription → `canceled`/`unpaid`). Every handler re-reads and locks, so a repeated
 * or stale job changes nothing (INV-4).
 */
import { exhaust, markOverdue, reminderToSend } from "../domain/dunning/dunning.js";
import type { Scope } from "../domain/shared.js";
import { onDunningExhausted, onInvoiceOverdue } from "../domain/subscription/subscription.js";
import { saveInvoice, saveSubscription } from "./commit.js";
import { nowS, renderPdfLater } from "./invoices.js";
import type { Billing } from "./ports.js";

export interface InvoiceJob {
  readonly invoice: string;
  readonly scope: Scope;
  /** When the job was scheduled for (decisions use `max(now, at)`, see `JobRequest`). */
  readonly at?: number | undefined;
}

const jobNow = (b: Billing, j: { readonly at?: number | undefined }): number => Math.max(nowS(b), j.at ?? 0);

const SYSTEM = "system:dunning";

export function remindJob(b: Billing, j: InvoiceJob & { readonly number: number }): Promise<void> {
  return b.store.transaction(async (tx) => {
    const inv = await tx.invoices.get(j.scope, j.invoice, { lock: true });
    if (!inv) return;
    const due = reminderToSend(inv, j.number, jobNow(b, j));
    if (!due) return;
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

export function overdueJob(b: Billing, j: InvoiceJob): Promise<void> {
  return b.store.transaction(async (tx) => {
    const inv = await tx.invoices.get(j.scope, j.invoice, { lock: true });
    if (!inv) return;
    const now = jobNow(b, j);
    const next = markOverdue(inv, now);
    if (!next) return;
    const saved = await saveInvoice(tx, inv, next, { actor: SYSTEM, cause: "overdue" }, [
      "evt.billing.invoice.overdue",
    ]);
    if (!saved.subscriptionId) return;
    const sub = await tx.subscriptions.get(j.scope, saved.subscriptionId, { lock: true });
    const moved = sub ? onInvoiceOverdue(sub, now) : null;
    if (sub && moved)
      await saveSubscription(tx, sub, moved, { actor: SYSTEM, cause: `invoice ${saved.id} overdue` }, [
        "evt.billing.subscription.updated",
      ]);
  });
}

export function exhaustJob(b: Billing, j: InvoiceJob): Promise<void> {
  return b.store.transaction(async (tx) => {
    const inv = await tx.invoices.get(j.scope, j.invoice, { lock: true });
    if (!inv?.subscriptionId) return;
    const sub = await tx.subscriptions.get(j.scope, inv.subscriptionId, { lock: true });
    const now = jobNow(b, j);
    const out = exhaust(inv, now, sub ? { status: sub.status, onExhausted: sub.dunning.onExhausted } : null);
    if (!out) return;
    const saved = await saveInvoice(tx, inv, out.invoice, { actor: SYSTEM, cause: "dunning exhausted" }, [
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
