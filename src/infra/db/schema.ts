/** Kysely table types (migrations/0001_billing.sql). numeric(78,0) columns read as decimal strings. */
import type { ColumnType, KitTables } from "@nearpay-internal/db";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;
type OptTs = ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
type Json<T> = ColumnType<T, string, string>;
/** numeric(78,0) */
type Num = ColumnType<string, string | bigint, string | bigint>;
type Def<T> = ColumnType<T, T | undefined, T>;

/** A tax snapshot entry as stored (amounts as decimal strings). */
export interface TaxAmountJson {
  tax_rate: string;
  display_name: string;
  jurisdiction: string | null;
  percentage: string;
  inclusive: boolean;
  amount: string;
  taxable_amount: string;
}

export interface ProductsTable {
  id: string;
  account_id: string;
  livemode: boolean;
  name: string;
  description: string | null;
  active: boolean;
  metadata: Json<Record<string, string>>;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: number;
}

export interface PricesTable {
  id: string;
  account_id: string;
  livemode: boolean;
  product_id: string;
  type: string;
  unit_amount: Num;
  currency: string;
  asset_id: string | null;
  interval: string | null;
  interval_count: number | null;
  nickname: string | null;
  active: boolean;
  metadata: Json<Record<string, string>>;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: number;
}

export interface TaxRatesTable {
  id: string;
  account_id: string;
  livemode: boolean;
  display_name: string;
  rate_ppm: number;
  inclusive: boolean;
  jurisdiction: string | null;
  country: string | null;
  description: string | null;
  active: boolean;
  metadata: Json<Record<string, string>>;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: number;
}

export interface InvoiceSequencesTable {
  account_id: string;
  livemode: boolean;
  prefix: string;
  next_number: Def<number>;
}

export interface SubscriptionsTable {
  id: string;
  account_id: string;
  livemode: boolean;
  customer_id: string;
  status: string;
  collection_method: Def<string>;
  currency: string;
  asset_id: string | null;
  interval: string;
  interval_count: number;
  billing_cycle_anchor: Timestamp;
  next_period_index: number;
  current_period_start: Timestamp;
  current_period_end: Timestamp;
  days_until_due: number;
  default_tax_rate_ids: string[];
  reminder_days: number[];
  on_exhausted: string;
  trial_start: OptTs;
  trial_end: OptTs;
  cancel_at_period_end: boolean;
  canceled_at: OptTs;
  ended_at: OptTs;
  cancellation_reason: string | null;
  latest_invoice_id: string | null;
  settlement_destination_id: string | null;
  description: string | null;
  metadata: Json<Record<string, string>>;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: number;
}

export interface SubscriptionItemsTable {
  id: string;
  subscription_id: string;
  position: number;
  price_id: string;
  quantity: number;
  tax_rate_ids: string[] | null;
}

export interface InvoicesTable {
  id: string;
  account_id: string;
  livemode: boolean;
  customer_id: string;
  subscription_id: string | null;
  billing_reason: string;
  number: string | null;
  status: string;
  collection_method: Def<string>;
  currency: string;
  asset_id: string | null;
  description: string | null;
  footer: string | null;
  default_tax_rate_ids: string[];
  subtotal: Num;
  tax: Num;
  total: Num;
  total_excluding_tax: Num;
  total_tax_amounts: Json<TaxAmountJson[]>;
  amount_paid: Num;
  days_until_due: number | null;
  due_date: OptTs;
  period_start: OptTs;
  period_end: OptTs;
  settlement_destination_id: string | null;
  reminder_days: number[];
  reminders_sent: number;
  overdue_at: OptTs;
  invoice_secret_hash: Buffer | null;
  invoice_secret_enc: Buffer | null;
  bill_to_enc: Buffer | null;
  merchant_name: string | null;
  checkout_session_id: string | null;
  checkout_session_expires_at: OptTs;
  checkout_client_secret_enc: Buffer | null;
  checkout_sessions_created: number;
  payment_intent_id: string | null;
  payment_intent_ids: string[];
  pdf_object_key: string | null;
  uncollectible_reason: string | null;
  finalized_at: OptTs;
  sent_at: OptTs;
  paid_at: OptTs;
  voided_at: OptTs;
  marked_uncollectible_at: OptTs;
  metadata: Json<Record<string, string>>;
  created_at: Timestamp;
  updated_at: Timestamp;
  version: number;
}

export interface InvoiceLinesTable {
  id: string;
  invoice_id: string;
  position: number;
  type: string;
  price_id: string | null;
  product_id: string | null;
  subscription_item_id: string | null;
  description: string;
  quantity: number;
  unit_amount: Num;
  amount: Num;
  amount_excluding_tax: Num;
  tax_rate_ids: string[];
  tax_rates_explicit: boolean;
  tax_amounts: Json<TaxAmountJson[]>;
  period_start: OptTs;
  period_end: OptTs;
}

export interface TransitionsTable {
  id: string;
  from_state: string | null;
  to_state: string;
  cause: string;
  actor: string;
  evidence: ColumnType<unknown | null, string | null | undefined, string | null>;
  created_at: Timestamp;
}

export interface RateCountersTable {
  key: string;
  window_start: Timestamp;
  count: number;
}

export interface DB extends KitTables {
  products: ProductsTable;
  prices: PricesTable;
  tax_rates: TaxRatesTable;
  invoice_sequences: InvoiceSequencesTable;
  subscriptions: SubscriptionsTable;
  subscription_items: SubscriptionItemsTable;
  invoices: InvoicesTable;
  invoice_lines: InvoiceLinesTable;
  invoice_transitions: TransitionsTable & { invoice_id: string };
  subscription_transitions: TransitionsTable & { subscription_id: string };
  rate_counters: RateCountersTable;
}
