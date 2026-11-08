-- nearpay-billing, Stage 3 (lld/billing.md §3, §11). Kit tables (outbox, inbox, idempotency_keys, jobs,
-- dead_letters) come from @nearpay-internal/db migrations. Mandates (Stage 4) arrive with their own migration.
--
-- Amounts: every amount column is numeric(78,0) in integer units of the row's currency (fiat minor units
-- or asset base units; asset amounts can exceed 2^63), so one column serves both pricings (LLD v1.3 §3).
-- Customers (`cus_`) are owned by payments; billing stores their uuid only, never personal data in clear
-- (the hosted page's `bill_to` snapshot is envelope-encrypted, §11 d6).

create table products (
  id uuid primary key,
  account_id uuid not null,
  livemode boolean not null,
  name text not null check (length(name) between 1 and 250),
  description text,
  active boolean not null default true,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 0);
create index products_account_created on products (account_id, livemode, created_at desc, id desc);

create table prices (
  id uuid primary key,
  account_id uuid not null,
  livemode boolean not null,
  product_id uuid not null references products(id),
  type text not null check (type in ('one_time','recurring')),
  unit_amount numeric(78,0) not null check (unit_amount >= 0),
  currency text not null check (currency = 'asset' or currency ~ '^[a-z]{3}$'),
  asset_id text,
  interval text check (interval in ('day','week','month','year')),
  interval_count smallint check (interval_count between 1 and 12),
  nickname text,
  active boolean not null default true,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 0,
  check ((type = 'recurring') = (interval is not null and interval_count is not null)),
  check ((currency = 'asset') = (asset_id is not null)));
create index prices_account_created on prices (account_id, livemode, created_at desc, id desc);
create index prices_product on prices (account_id, livemode, product_id, created_at desc);

create table tax_rates (
  id uuid primary key,
  account_id uuid not null,
  livemode boolean not null,
  display_name text not null check (length(display_name) between 1 and 50),
  rate_ppm integer not null check (rate_ppm between 0 and 1000000),   -- §11 d1: percentage × 10 000, exact
  inclusive boolean not null,
  jurisdiction text,
  country char(2),
  description text,
  active boolean not null default true,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 0);
create index tax_rates_account_created on tax_rates (account_id, livemode, created_at desc, id desc);

-- Invoice numbers `<prefix>-<5+ digits>`, allocated at finalize (`update … returning`, row lock).
create table invoice_sequences (
  account_id uuid not null,
  livemode boolean not null,
  prefix text not null check (prefix ~ '^[A-Z0-9]{1,8}[LT]$'),
  next_number integer not null default 1 check (next_number >= 1),
  primary key (account_id, livemode));

create table subscriptions (
  id uuid primary key,
  account_id uuid not null,
  livemode boolean not null,
  customer_id uuid not null,
  status text not null check (status in ('incomplete','trialing','active','past_due','canceled','unpaid')),
  collection_method text not null default 'send_invoice' check (collection_method in ('send_invoice')),
  currency text not null,
  asset_id text,
  interval text not null check (interval in ('day','week','month','year')),
  interval_count smallint not null check (interval_count between 1 and 12),
  billing_cycle_anchor timestamptz not null,
  next_period_index integer not null default 0 check (next_period_index >= 0),  -- n of the period the next renewal invoices (periodBoundary)
  current_period_start timestamptz not null,
  current_period_end timestamptz not null,
  days_until_due smallint not null default 7 check (days_until_due between 0 and 90),
  default_tax_rate_ids uuid[] not null default '{}',
  reminder_days smallint[] not null default '{-3,0,1,3,7}',
  on_exhausted text not null default 'cancel' check (on_exhausted in ('cancel','unpaid')),
  trial_start timestamptz,
  trial_end timestamptz,
  cancel_at_period_end boolean not null default false,
  canceled_at timestamptz,
  ended_at timestamptz,
  cancellation_reason text check (cancellation_reason in ('requested','dunning_exhausted','incomplete_expired')),
  latest_invoice_id uuid,
  settlement_destination_id uuid,
  description text,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 0,
  check (current_period_end > current_period_start),
  check ((currency = 'asset') = (asset_id is not null)));
create index subs_account_created on subscriptions (account_id, livemode, created_at desc, id desc);
create index subs_customer on subscriptions (account_id, livemode, customer_id, created_at desc);
create index subs_status on subscriptions (account_id, livemode, status);

create table subscription_items (
  id uuid primary key,
  subscription_id uuid not null references subscriptions(id),
  position smallint not null,
  price_id uuid not null references prices(id),
  quantity integer not null default 1 check (quantity between 1 and 1000000),
  tax_rate_ids uuid[],                                       -- null = the subscription's default_tax_rate_ids
  unique (subscription_id, position));
create index sub_items_price on subscription_items (price_id);

create table invoices (
  id uuid primary key,
  account_id uuid not null,
  livemode boolean not null,
  customer_id uuid not null,
  subscription_id uuid references subscriptions(id),
  billing_reason text not null default 'manual'
    check (billing_reason in ('manual','subscription_create','subscription_cycle')),
  number text,
  status text not null check (status in ('draft','open','paid','void','uncollectible')),
  collection_method text not null default 'send_invoice' check (collection_method in ('send_invoice')),
  currency text not null,
  asset_id text,
  description text,
  footer text,
  default_tax_rate_ids uuid[] not null default '{}',
  subtotal numeric(78,0) not null default 0,
  tax numeric(78,0) not null default 0,
  total numeric(78,0) not null default 0,
  total_excluding_tax numeric(78,0) not null default 0,
  total_tax_amounts jsonb not null default '[]',             -- [{tax_rate, display_name, percentage, inclusive, amount, taxable_amount}]
  amount_paid numeric(78,0) not null default 0,
  days_until_due smallint check (days_until_due between 0 and 365),
  due_date timestamptz,
  period_start timestamptz,
  period_end timestamptz,
  settlement_destination_id uuid,
  reminder_days smallint[] not null default '{-3,0,1,3,7}',
  reminders_sent smallint not null default 0,
  overdue_at timestamptz,                                    -- `invoice.overdue` emitted (once)
  -- hosted invoice (§11 d3): secret stored as hash (constant-time check) and envelope-encrypted (URL rebuild)
  invoice_secret_hash bytea,
  invoice_secret_enc bytea,
  bill_to_enc bytea,                                         -- {name, email} at finalize (PII, encrypted)
  merchant_name text,                                        -- display name at finalize (PDF, hosted page)
  -- payments checkout session paying the invoice (created on demand by the hosted page)
  checkout_session_id uuid,
  checkout_session_expires_at timestamptz,
  checkout_client_secret_enc bytea,
  checkout_sessions_created integer not null default 0,      -- n of the `in:<invoice>:s<n>` idempotency key
  payment_intent_id uuid,                                    -- the intent that paid it
  payment_intent_ids uuid[] not null default '{}',           -- every intent seen for it, newest first
  pdf_object_key text,
  uncollectible_reason text check (uncollectible_reason in ('merchant','dunning_exhausted')),
  finalized_at timestamptz,
  sent_at timestamptz,
  paid_at timestamptz,
  voided_at timestamptz,
  marked_uncollectible_at timestamptz,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version integer not null default 0,
  unique (account_id, livemode, number),
  check ((currency = 'asset') = (asset_id is not null)),
  check (status = 'draft' or (number is not null and finalized_at is not null and due_date is not null
    and invoice_secret_hash is not null)),
  check (total_excluding_tax = total - tax and total >= subtotal and amount_paid in (0, total)),
  check (status <> 'paid' or (payment_intent_id is not null and paid_at is not null)));
create unique index invoices_sub_period on invoices (subscription_id, period_start) where subscription_id is not null;
create index invoices_account_created on invoices (account_id, livemode, created_at desc, id desc);
create index invoices_customer on invoices (account_id, livemode, customer_id, created_at desc);
create index invoices_subscription on invoices (account_id, livemode, subscription_id, created_at desc)
  where subscription_id is not null;
create index invoices_status on invoices (account_id, livemode, status, created_at desc);
create index invoices_due on invoices (account_id, livemode, due_date) where due_date is not null;
create index invoices_session on invoices (checkout_session_id) where checkout_session_id is not null;

create table invoice_lines (
  id uuid primary key,
  invoice_id uuid not null references invoices(id) on delete cascade,
  position smallint not null check (position between 0 and 99),
  type text not null check (type in ('invoiceitem','subscription')),
  price_id uuid references prices(id),
  product_id uuid references products(id),
  subscription_item_id uuid,
  description text not null,
  quantity integer not null check (quantity between 1 and 1000000),
  unit_amount numeric(78,0) not null check (unit_amount >= 0),
  amount numeric(78,0) not null check (amount >= 0),
  amount_excluding_tax numeric(78,0) not null check (amount_excluding_tax >= 0),
  tax_rate_ids uuid[] not null default '{}',
  tax_rates_explicit boolean not null default false,         -- false = follows the invoice's default_tax_rates
  tax_amounts jsonb not null default '[]',                   -- tax snapshot per rate (§11 d2)
  period_start timestamptz,
  period_end timestamptz,
  unique (invoice_id, position),
  check (amount = unit_amount * quantity));

-- Transitions (foundations §7, INV-9): append-only.
create table invoice_transitions (
  id uuid primary key, invoice_id uuid not null,              -- no FK: a deleted draft keeps its history
  from_state text, to_state text not null, cause text not null, actor text not null, evidence jsonb,
  created_at timestamptz not null default now());
create index invt_invoice on invoice_transitions (invoice_id, created_at);

create table subscription_transitions (
  id uuid primary key, subscription_id uuid not null references subscriptions(id),
  from_state text, to_state text not null, cause text not null, actor text not null, evidence jsonb,
  created_at timestamptz not null default now());
create index subt_subscription on subscription_transitions (subscription_id, created_at);

create function billing_append_only() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name;
end $$;
create trigger invt_append_only before update or delete on invoice_transitions
  for each row execute function billing_append_only();
create trigger subt_append_only before update or delete on subscription_transitions
  for each row execute function billing_append_only();

-- A draft may be deleted; an issued invoice never (void instead).
create function billing_invoice_delete_guard() returns trigger language plpgsql as $$
begin
  if old.status <> 'draft' then
    raise exception 'invoice % is % and cannot be deleted', old.id, old.status;
  end if;
  return old;
end $$;
create trigger invoices_delete_guard before delete on invoices
  for each row execute function billing_invoice_delete_guard();

-- Fixed-window counters for anonymous hosted-invoice session creation (per client network, per invoice).
create table rate_counters (
  key text primary key,
  window_start timestamptz not null,
  count integer not null);
