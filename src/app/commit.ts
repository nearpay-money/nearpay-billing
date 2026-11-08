/**
 * Every state change writes the aggregate row (optimistic version), a transition row when the status
 * changed, and its outbox events in ONE transaction (foundations §7, INV-4, INV-9). The aggregate's
 * `version` (= public `sequence`) bumps once per change and once more per extra event, so every event of
 * an aggregate carries its own increasing version (consumers drop stale ones).
 */
import type { Invoice } from "../domain/invoice/invoice.js";
import type { Subscription } from "../domain/subscription/subscription.js";
import type { BillingSubject, BillingTx, EventObject } from "./ports.js";

/** Who acted and why (transition rows, INV-9). */
export interface Meta {
  readonly actor: string;
  readonly cause: string;
  readonly evidence?: unknown;
}

/** The request context of a merchant use case. */
export interface Ctx {
  readonly scope: { readonly accountId: string; readonly livemode: boolean };
  /** `user:<usr_…>`, `key:<key_…>`, `system`, `customer` (hosted page), `service:<name>`. */
  readonly actor: string;
}

type Subjects = readonly BillingSubject[];

function versions(prev: { version: number } | null, events: number): { first: number; final: number } {
  const base = prev ? prev.version : -1;
  return { first: base + 1, final: base + Math.max(1, events) };
}

export async function saveInvoice(
  tx: BillingTx,
  prev: Invoice | null,
  next: Invoice,
  meta: Meta,
  subjects: Subjects = [],
  extra: (inv: Invoice) => EventObject = (invoice) => ({ kind: "invoice", invoice }),
): Promise<Invoice> {
  const v = versions(prev, subjects.length);
  const row: Invoice = { ...next, version: v.final };
  if (prev) await tx.invoices.update(prev, row);
  else await tx.invoices.insert(row);
  if (!prev || prev.status !== row.status)
    await tx.recordTransition({
      aggregate: "invoice",
      id: row.id,
      from: prev?.status ?? null,
      to: row.status,
      cause: meta.cause,
      actor: meta.actor,
      evidence: meta.evidence,
    });
  for (const [i, subject] of subjects.entries()) {
    const version = v.first + i;
    const snapshot: Invoice = { ...row, version };
    await tx.emit({
      subject,
      aggregate: { type: "invoice", id: row.id, version },
      scope: { accountId: row.accountId, livemode: row.livemode },
      object: subject === "evt.billing.invoice.reminder" ? extra(snapshot) : { kind: "invoice", invoice: snapshot },
      ...(prev && prev.status !== row.status ? { previous: { status: prev.status } } : {}),
    });
  }
  return row;
}

export async function saveSubscription(
  tx: BillingTx,
  prev: Subscription | null,
  next: Subscription,
  meta: Meta,
  subjects: Subjects = [],
): Promise<Subscription> {
  const v = versions(prev, subjects.length);
  const row: Subscription = { ...next, version: v.final };
  if (prev) await tx.subscriptions.update(prev, row);
  else await tx.subscriptions.insert(row);
  if (!prev || prev.status !== row.status)
    await tx.recordTransition({
      aggregate: "subscription",
      id: row.id,
      from: prev?.status ?? null,
      to: row.status,
      cause: meta.cause,
      actor: meta.actor,
      evidence: meta.evidence,
    });
  for (const [i, subject] of subjects.entries()) {
    const version = v.first + i;
    await tx.emit({
      subject,
      aggregate: { type: "subscription", id: row.id, version },
      scope: { accountId: row.accountId, livemode: row.livemode },
      object: { kind: "subscription", subscription: { ...row, version } },
      ...(prev && prev.status !== row.status ? { previous: { status: prev.status } } : {}),
    });
  }
  return row;
}
