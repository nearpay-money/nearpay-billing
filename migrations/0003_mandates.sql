-- Stage 4 (lld/billing.md v1.7 §3, §6, §7.1, §14; spec 0.4.0): auto-debit mandates mirrored from the
-- subscription vault's events, the keeper's per-mandate state, collections as payment evidence (INV-2),
-- parked vault events and ops cases. Additive and forward-only: existing rows keep `send_invoice`.

-- collection methods (§14 d6)
alter table subscriptions drop constraint subscriptions_collection_method_check;
alter table subscriptions add constraint subscriptions_collection_method_check
  check (collection_method in ('send_invoice','auto_debit'));
alter table invoices drop constraint invoices_collection_method_check;
alter table invoices add constraint invoices_collection_method_check
  check (collection_method in ('send_invoice','auto_debit'));

-- Mandates: one row per vault mandate whose `ext_ref` names a subscription (§14 d1). Rows are created only
-- from a forwarded `mandate_created` (never by prepare); amounts/counters are bigint/numeric so every value
-- the vault accepts fits (contracts-vault v1.5 §3.1). `livemode` is the vault's mode (true = mainnet vault,
-- false = sandbox stand-in); `account_id` is the named subscription's account.
create table mandates (
  id uuid primary key,
  account_id uuid not null,
  livemode boolean not null,
  subscription_id uuid not null references subscriptions(id),
  customer_id uuid not null,
  vault_contract text not null,
  onchain_id bigint not null check (onchain_id >= 0),
  payer text not null,
  token text not null,
  amount_per_period numeric(78,0) not null check (amount_per_period > 0),
  period_secs bigint not null check (period_secs >= 86400),
  start_at_ns numeric(20,0) not null,                         -- vault `start_at` (ns since epoch, u64)
  max_periods bigint check (max_periods is null or max_periods >= 1),
  collected_periods bigint not null default 0 check (collected_periods >= 0),
  balance numeric(78,0) not null default 0 check (balance >= 0),
  withdrawn numeric(78,0) not null default 0 check (withdrawn >= 0),
  merchant_receiver text not null,
  receiver_kind text not null check (receiver_kind in ('intents_account','near_account')),
  fee_bps integer not null check (fee_bps between 0 and 10000),
  ext_ref text not null,
  settlement_destination_id uuid,                             -- the destination `merchant_receiver` matched (linked)
  link_status text not null default 'pending' check (link_status in ('pending','linked','unlinked')),
  unlinked_reason text,
  status text not null check (status in ('pending_funding','active','insufficient','exhausted','canceled')),
  released_at timestamptz,                                    -- `collecting` false for good (§14 d7)
  -- keeper (§7.1)
  collect_failures integer not null default 0,                -- consecutive `collect_failed`
  collect_failures_since timestamptz,                         -- first failure of the streak (24 h rule)
  keeper_errors integer not null default 0,                   -- consecutive other errors (retry ×5 then case)
  pending_tx_hash text,                                       -- a `collect` sent, its forwarded outcome not seen yet
  pending_since timestamptz,
  collecting_invoice_id uuid,                                 -- the invoice the keeper is collecting
  last_attempt_at timestamptz,
  -- mirror of events
  canceled_by text,
  canceled_refunded numeric(78,0),
  canceled_at timestamptz,
  last_collection jsonb,                                      -- MandateCollection of the latest `collected`
  last_event_height bigint,
  created_at timestamptz not null,                            -- block time of `mandate_created`
  updated_at timestamptz not null default now(),
  version integer not null default 0,
  unique (vault_contract, onchain_id),
  check ((link_status = 'unlinked') = (unlinked_reason is not null)));
create index mandates_account_created on mandates (account_id, livemode, created_at desc, id desc);
create index mandates_subscription on mandates (account_id, livemode, subscription_id, created_at desc);
create index mandates_payer on mandates (account_id, livemode, payer);
-- at most one linked, collecting mandate per subscription (§14 d1 `already_linked`)
create unique index mandates_one_collecting on mandates (subscription_id)
  where link_status = 'linked' and released_at is null and status in ('active','insufficient');

create table mandate_transitions (
  id uuid primary key, mandate_id uuid not null references mandates(id),
  from_state text, to_state text not null, cause text not null, actor text not null, evidence jsonb,
  created_at timestamptz not null default now());
create index mandt_mandate on mandate_transitions (mandate_id, created_at);
create trigger mandt_append_only before update or delete on mandate_transitions
  for each row execute function billing_append_only();

-- Every `collected` event (the evidence, INV-2): one row per counted vault period.
create table mandate_collections (
  receipt_id text primary key,
  mandate_id uuid not null references mandates(id),
  period bigint not null check (period >= 1),
  amount numeric(78,0) not null,
  merchant_share numeric(78,0) not null,
  fee numeric(78,0) not null,
  short boolean not null,
  invoice_id uuid,                                            -- invoice it paid / applied to; null = unapplied
  applied text not null check (applied in ('paid','short','late','unapplied')),
  tx_hash text not null,
  collected_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (mandate_id, period));
create index mandate_collections_unapplied on mandate_collections (mandate_id) where applied = 'unapplied';

-- Invoices paid by auto-debit (§14 d6): the evidence replaces the payment intent.
alter table invoices add column mandate_id uuid;
alter table invoices add column collect_period bigint;
alter table invoices add column mandate_collection jsonb;     -- {mandate, period, token, merchant_share, fee, tx_hash, receipt_id}
do $$
declare c text;
begin
  -- the anonymous 0001 check `status <> 'paid' or (payment_intent_id is not null and paid_at is not null)`
  for c in select conname from pg_constraint
    where conrelid = 'invoices'::regclass and contype = 'c'
      and pg_get_constraintdef(oid) like '%payment_intent_id IS NOT NULL%'
  loop
    execute format('alter table invoices drop constraint %I', c);
  end loop;
end $$;
alter table invoices add constraint invoices_paid_evidence
  check (status <> 'paid' or ((payment_intent_id is not null or mandate_collection is not null) and paid_at is not null));
alter table invoices add constraint invoices_auto_debit_subscription
  check (collection_method = 'send_invoice' or subscription_id is not null);
create index invoices_mandate on invoices (mandate_id, period_start) where mandate_id is not null;

alter table subscriptions add column mandate_id uuid;         -- the linked collecting mandate

-- Vault events already applied (dedupe `receipt_id:log_index`, at-least-once delivery).
create table vault_events (
  dedupe_key text primary key,
  vault_contract text not null,
  livemode boolean not null,
  onchain_id bigint not null,
  event text not null,
  block_height bigint not null,
  outcome text not null,
  received_at timestamptz not null default now());

-- Events that failed validation or storage: parked so the stream never blocks (§6), alerted, retried when
-- `retriable` (e.g. a peer was unavailable or the mandate row was not there yet).
create table vault_events_parked (
  id uuid primary key,
  dedupe_key text not null unique,
  vault_contract text,
  livemode boolean,
  onchain_id bigint,
  event text,
  reason text not null,
  retriable boolean not null,
  attempts integer not null default 1,
  error text,
  payload jsonb not null,
  next_attempt_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz not null default now());
create index vault_parked_retry on vault_events_parked (next_attempt_at) where resolved_at is null and retriable;

-- Ops cases opened by the keeper (§7.1: collect failures, short shares, repeated errors).
create table vault_cases (
  id uuid primary key,
  account_id uuid not null,
  livemode boolean not null,
  mandate_id uuid not null references mandates(id),
  invoice_id uuid,
  kind text not null check (kind in ('collect_failures','short_share','keeper_errors','late_collection','fee_leg_failed')),
  detail jsonb not null default '{}',
  created_at timestamptz not null default now(),
  resolved_at timestamptz);
create index vault_cases_open on vault_cases (created_at) where resolved_at is null;
