/**
 * PLACEHOLDER — spec 0.4.0 (stage 4 auto-debit) contracts, copied verbatim from the `nearpay-spec` branch
 * `stage-4/4.1-autodebit` @ d9ef8c6 (`src/vault/contract.ts`, `src/public/mandates.ts`,
 * `src/internal/vault.ts`, the stage-4 parts of `src/internal/billing.ts` and `src/internal/sandbox.ts`)
 * until `@nearpay/spec` / `@nearpay-internal/spec` 0.4.0 are published. Nothing here is hand-written:
 * Phase B deletes this file and imports the same names from the packages (brief step 4.2).
 */
/* biome-ignore-all lint: verbatim copy of the spec source (deleted in Phase B) */
import {
  AssetId,
  BaseUnits,
  closedEnum,
  createdFilterShape,
  InvoiceSecretHeaders,
  id,
  inp,
  Livemode,
  listOf,
  listQueryShape,
  MAX_SAFE_INTEGER,
  NearAccountId,
  openEnum,
  out,
  PricingAssetDisplay,
  Recurring,
  route,
  SUBSCRIPTION_ROLES,
  Timestamp,
  TxHash,
  UnixTime,
  Url,
  z,
} from "@nearpay/spec";

const MerchantFields = {
  account_id: id("acct"),
  livemode: z.boolean().describe("Mode (test-mode mails say so)."),
  merchant_display_name: z.string().describe("Merchant name (account display name, or the ops-approved legal name)."),
  customer: id("cus"),
  customer_email: z.email().nullable().describe("Recipient: the customer's email from payments; null = no mail."),
  customer_name: z.string().nullable().describe("Customer name, if known."),
};
const SANDBOX_AUTH = ["service:sandbox.use"] as const;

/** Error codes new in 0.4.0 (`errors/catalogue.ts` e4): not yet in the published `ErrorCode`. */
export type Stage4ErrorCode = "auto_debit_unavailable" | "vault_cap_exceeded";

// ===== src/vault/contract.ts =====
// =============================================================================================
// Constants (contracts-vault §2, §3.1, §3.3, §3.4, §3.7)
// =============================================================================================

/** NEP-297 `standard` of every vault event. */
export const VAULT_EVENT_STANDARD = "nearpay_vault" as const;
/** NEP-297 `version` of every vault event. */
export const VAULT_EVENT_VERSION = "1.0.0" as const;
/** Prefix of a NEP-297 log line. */
export const EVENT_JSON_PREFIX = "EVENT_JSON:" as const;

/** Contract limits and costs (constructor-independent constants of the deployed code). */
export const VAULT_LIMITS = {
  /** `period_secs` minimum (one day). */
  min_period_secs: 86_400,
  /** `period_secs` maximum: 12 × 366 days (v1.5, re-audit N-3). */
  max_period_secs: 379_468_800,
  /** `max_periods` maximum: 2^31 − 1. */
  max_max_periods: 2_147_483_647,
  /** `start_at` may be at most 366 days after the block time (ns). */
  max_start_delay_ns: "31622400000000000",
  /** `ext_ref` maximum length in bytes (printable ASCII 0x20–0x7E). */
  max_ext_ref_len: 64,
  /** `msg` longer than this is rejected unparsed (`ERR_BAD_MSG`). */
  max_msg_len: 2048,
  /** yoctoNEAR each open mandate locks from the payer's NEP-145 storage balance (0.01 NEAR). */
  mandate_storage_cost: "10000000000000000000000",
  /** NEP-145 registration minimum (`storage_balance_bounds.min`, 0.002 NEAR). */
  storage_registration_cost: "2000000000000000000000",
} as const;

/** One Tgas in gas units (decimal string, as wallets take it). */
export const TGAS = "1000000000000" as const;
const tgas = (n: number) => (BigInt(n) * BigInt(TGAS)).toString();

/**
 * Gas rules (contracts-vault §3.3–§3.4, billing §7). Values are gas units as decimal strings.
 * `collect` below `min_collect` and `cancel`/`withdraw` below `min_exit` fail with `ERR_GAS`.
 */
export const VAULT_GAS = {
  /** What billing's keeper attaches to `collect` (unused gas is refunded). */
  keeper_collect: tgas(250),
  /** `MIN_COLLECT_GAS`. */
  min_collect: tgas(170),
  /** `MIN_EXIT_GAS` (`cancel` / `withdraw`). */
  min_exit: tgas(50),
  /** What NearPay's payer transactions attach to `cancel` / `withdraw` (recommended). */
  exit: tgas(100),
  /** The payer's `ft_transfer_call` on the token (create or top up a mandate). */
  ft_transfer_call: tgas(100),
  /** `storage_deposit` on the vault. */
  storage_deposit: tgas(30),
} as const;

/** The deposit every `ft_transfer_call`, `cancel`, `withdraw` and `storage_withdraw` needs. */
export const ONE_YOCTO = "1" as const;

// =============================================================================================
// Error strings (contracts-vault §3 "Error strings", v1.2, v1.4; `src/errors.rs` `ALL`)
// =============================================================================================

/** Every stable error string the vault can emit, in the contract's `errors::ALL` order. */
export const VAULT_ERRORS = [
  "ERR_NOT_FOUND",
  "ERR_NOT_ACTIVE",
  "ERR_NOT_DUE",
  "ERR_IN_FLIGHT",
  "ERR_INSUFFICIENT_BALANCE",
  "ERR_MAX_PERIODS",
  "ERR_UNAUTHORIZED",
  "ERR_TOKEN_NOT_ALLOWED",
  "ERR_BAD_MSG",
  "ERR_CAP_EXCEEDED",
  "ERR_FEE_TOO_HIGH",
  "ERR_NO_STORAGE",
  "ERR_STILL_ACTIVE",
  "ERR_OPEN_MANDATES",
  "ERR_BAD_CONFIG",
  "ERR_UNSUPPORTED_SENDER",
  "ERR_GAS",
] as const;
export type VaultErrorCode = (typeof VAULT_ERRORS)[number];
export const VaultErrorCodeSchema = closedEnum(VAULT_ERRORS, "A stable vault error string.");

/**
 * The only rejection log lines with a detail (contracts-vault v1.3 §3.1): `ERR_CAP_EXCEEDED: mandate`
 * (per-mandate cap) and `ERR_CAP_EXCEEDED: tvl` (per-token TVL cap). Every other rejection logs the
 * bare code.
 */
export const VAULT_CAP_EXCEEDED_LOGS = ["ERR_CAP_EXCEEDED: mandate", "ERR_CAP_EXCEEDED: tvl"] as const;

/**
 * Codes `ft_on_transfer` can log for a rejected deposit (the full amount is refunded; not events).
 * `ERR_TOKEN_NOT_ALLOWED` from a token outside the allow-list is a panic instead (the token
 * refunds); for a top-up in another token it is a logged rejection.
 */
export const VAULT_FUNDING_REJECTIONS = [
  "ERR_UNSUPPORTED_SENDER",
  "ERR_BAD_MSG",
  "ERR_FEE_TOO_HIGH",
  "ERR_NO_STORAGE",
  "ERR_CAP_EXCEEDED",
  "ERR_NOT_FOUND",
  "ERR_UNAUTHORIZED",
  "ERR_TOKEN_NOT_ALLOWED",
  "ERR_NOT_ACTIVE",
] as const satisfies readonly VaultErrorCode[];

/** `collect` failure codes, in the contract's check order (contracts-vault §3.2). */
export const VAULT_COLLECT_ERRORS = [
  "ERR_GAS",
  "ERR_NOT_FOUND",
  "ERR_MAX_PERIODS",
  "ERR_NOT_ACTIVE",
  "ERR_IN_FLIGHT",
  "ERR_NOT_DUE",
  "ERR_INSUFFICIENT_BALANCE",
] as const satisfies readonly VaultErrorCode[];

/** `cancel` failure codes in check order (plus near-sdk's 1-yocto guard), contracts-vault §3.4. */
export const VAULT_CANCEL_ERRORS = [
  "ERR_GAS",
  "ERR_NOT_FOUND",
  "ERR_UNAUTHORIZED",
  "ERR_NOT_ACTIVE",
] as const satisfies readonly VaultErrorCode[];

/** `withdraw` failure codes in check order (plus near-sdk's 1-yocto guard), contracts-vault §3.4. */
export const VAULT_WITHDRAW_ERRORS = [
  "ERR_GAS",
  "ERR_NOT_FOUND",
  "ERR_UNAUTHORIZED",
  "ERR_STILL_ACTIVE",
  "ERR_IN_FLIGHT",
  "ERR_INSUFFICIENT_BALANCE",
] as const satisfies readonly VaultErrorCode[];

/** near-sdk's own guard messages (not vault codes; contracts-vault §3 v1.2). */
export const NEAR_SDK_GUARD_MESSAGES = {
  one_yocto: "Requires attached deposit of exactly 1 yoctoNEAR",
} as const;

/** How a NEAR RPC failure renders a contract panic: `Smart contract panicked: <message>`. */
export const SMART_CONTRACT_PANICKED_PREFIX = "Smart contract panicked: " as const;

/**
 * The vault error code in a panic message, a NEAR RPC `ExecutionError` string or a rejection log
 * line: the first `ERR_[A-Z_]+` token that is a known code (consumers match the code, never the
 * detail after `:`). `null` when the text carries no vault code.
 */
export function vaultErrorCodeOf(text: string): VaultErrorCode | null {
  for (const m of text.matchAll(/ERR_[A-Z_]+/g)) {
    const code = m[0];
    if ((VAULT_ERRORS as readonly string[]).includes(code)) return code as VaultErrorCode;
  }
  return null;
}

// =============================================================================================
// Scalars
// =============================================================================================

const U128 = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,38})$/, "must be a canonical u128 decimal string")
  .describe("u128 decimal string (token base units).");
const U64Ns = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,19})$/, "must be a canonical u64 decimal string")
  .describe("Nanoseconds since the Unix epoch as a u64 decimal string.");
const MandateIdNum = z
  .int()
  .min(0)
  .max(MAX_SAFE_INTEGER)
  .describe("On-chain mandate id (u64, sequential from 0; exact in JSON numbers far beyond any real count).");
const PeriodSecs = z
  .int()
  .min(VAULT_LIMITS.min_period_secs)
  .max(VAULT_LIMITS.max_period_secs)
  .describe("Period length in seconds (86 400 … 379 468 800).");
const MaxPeriods = z
  .int()
  .min(1)
  .max(VAULT_LIMITS.max_max_periods)
  .nullable()
  .describe("Number of periods the mandate may collect; null = unlimited.");
const FeeBps = z.int().min(0).max(10_000).describe("NearPay fee in basis points, fixed at creation.");
const ExtRef = z
  .string()
  .max(VAULT_LIMITS.max_ext_ref_len)
  .regex(/^[\x20-\x7e]*$/, "must be printable ASCII")
  .describe("Free reference (≤ 64 bytes printable ASCII); NearPay puts the subscription id (`sub_…`).");

export const VaultReceiverKind = closedEnum(
  ["intents_account", "near_account"],
  "How the merchant share is delivered: `intents_account` = `ft_transfer_call(intents.near, msg = merchant_receiver)` (credits the merchant's NEAR Intents balance); `near_account` = plain `ft_transfer`.",
);
export const VaultMandateStatus = closedEnum(["active", "canceled", "exhausted"], "On-chain mandate status.");

// =============================================================================================
// Events (contracts-vault §4, §4.1; `src/events.rs`)
// =============================================================================================

/** Event data shapes, fields in the contract's serialisation order. */
export const VaultMandateCreatedData = out({
  mandate_id: MandateIdNum,
  payer: NearAccountId.describe("Payer = the NEP-141 `sender_id`, which is always the transaction signer (v1.5)."),
  merchant_receiver: NearAccountId.describe("Receiver of the merchant share (an Intents account for NearPay)."),
  token: NearAccountId.describe("NEP-141 token contract (the calling token)."),
  amount_per_period: U128.describe("Tokens collected per period (base units)."),
  period_secs: PeriodSecs,
  start_at: U64Ns.describe("When period 1 becomes due (ns); a past or omitted `start_at` became the block time."),
  max_periods: MaxPeriods,
  fee_bps: FeeBps,
  ext_ref: ExtRef,
  receiver_kind: VaultReceiverKind,
  balance: U128.describe("Initial funding (base units)."),
}).describe("`mandate_created` data.");

export const VaultToppedUpData = out({
  mandate_id: MandateIdNum,
  amount: U128.describe("Deposited amount."),
  balance: U128.describe("Balance after the deposit."),
}).describe("`topped_up` data.");

export const VaultCollectedData = out({
  mandate_id: MandateIdNum,
  period: z.int().min(1).describe("1-based period that was counted."),
  amount: U128.describe("`merchant_share + fee` actually paid."),
  merchant_share: U128.describe(
    "Share delivered to the merchant receiver; below `floor(amount_per_period × (10000 − fee_bps) / 10000)` only on partial delivery (the period still counts).",
  ),
  fee: U128.describe('Fee sent to the treasury; `"0"` when the fee leg failed or after a partial delivery.'),
  balance: U128.describe("Balance after the period."),
}).describe("`collected` data.");

export const VaultCollectFailedData = out({
  mandate_id: MandateIdNum,
  period: z.int().min(1).describe("Period that was attempted (not counted)."),
  reason: openEnum(
    ["merchant_transfer_failed"],
    "Why: `merchant_transfer_failed` (the merchant leg delivered nothing; the only reason in v1).",
  ),
}).describe("`collect_failed` data.");

export const VaultCanceledData = out({
  mandate_id: MandateIdNum,
  by: NearAccountId.describe("Who canceled: the payer or the merchant receiver."),
  refunded: U128.describe('Amount actually returned to the payer; `"0"` when the refund failed (then withdrawable).'),
}).describe("`canceled` data.");

export const VaultWithdrawnData = out({
  mandate_id: MandateIdNum,
  amount: U128.describe("Amount returned to the payer."),
}).describe("`withdrawn` data.");

export const VaultExhaustedData = out({ mandate_id: MandateIdNum }).describe("`exhausted` data.");

/** Event name → data schema and field order (the order the contract serialises). */
export const VAULT_EVENTS = {
  mandate_created: {
    data: VaultMandateCreatedData,
    fields: [
      "mandate_id",
      "payer",
      "merchant_receiver",
      "token",
      "amount_per_period",
      "period_secs",
      "start_at",
      "max_periods",
      "fee_bps",
      "ext_ref",
      "receiver_kind",
      "balance",
    ],
  },
  topped_up: { data: VaultToppedUpData, fields: ["mandate_id", "amount", "balance"] },
  collected: {
    data: VaultCollectedData,
    fields: ["mandate_id", "period", "amount", "merchant_share", "fee", "balance"],
  },
  collect_failed: { data: VaultCollectFailedData, fields: ["mandate_id", "period", "reason"] },
  canceled: { data: VaultCanceledData, fields: ["mandate_id", "by", "refunded"] },
  withdrawn: { data: VaultWithdrawnData, fields: ["mandate_id", "amount"] },
  exhausted: { data: VaultExhaustedData, fields: ["mandate_id"] },
} as const;
export type VaultEventName = keyof typeof VAULT_EVENTS;
export const VAULT_EVENT_NAMES = Object.keys(VAULT_EVENTS) as [VaultEventName, ...VaultEventName[]];
export const VaultEventNameSchema = openEnum(VAULT_EVENT_NAMES, "Vault event name.");

function vaultEventVariant<N extends VaultEventName>(name: N) {
  return out({
    standard: z.literal(VAULT_EVENT_STANDARD).describe("Always `nearpay_vault`."),
    version: z.literal(VAULT_EVENT_VERSION).describe("Always `1.0.0`."),
    event: z.literal(name).describe("Event name."),
    data: z.tuple([VAULT_EVENTS[name].data]).describe("One-element array (NEP-141/171 convention)."),
  }).describe(`\`${name}\` event.`);
}

/** A parsed `nearpay_vault` NEP-297 event (the JSON after `EVENT_JSON:`). */
export const VaultEvent = z
  .discriminatedUnion(
    "event",
    VAULT_EVENT_NAMES.map((n) => vaultEventVariant(n)) as unknown as [
      ReturnType<typeof vaultEventVariant>,
      ...ReturnType<typeof vaultEventVariant>[],
    ],
  )
  .meta({
    id: "VaultEvent",
    description:
      "A subscription-vault NEP-297 event (contracts-vault §4.1). Valid only in a successful receipt executed by the vault account itself (rails §8.6).",
  });
export type VaultEvent = {
  [N in VaultEventName]: {
    standard: typeof VAULT_EVENT_STANDARD;
    version: typeof VAULT_EVENT_VERSION;
    event: N;
    data: [z.infer<(typeof VAULT_EVENTS)[N]["data"]>];
  };
}[VaultEventName];

/**
 * Formats a vault event as the contract logs it: `EVENT_JSON:` + compact JSON with the envelope
 * keys `standard, version, event, data` and the data keys in the contract's order. The sandbox
 * stand-in uses it so its logs are byte-identical to the vault's.
 */
export function formatVaultEventLog(event: VaultEvent): string {
  const def = VAULT_EVENTS[event.event];
  const src = event.data[0] as Record<string, unknown>;
  const data: Record<string, unknown> = {};
  for (const f of def.fields) {
    if (!(f in src)) throw new Error(`vault event ${event.event}: missing ${f}`);
    data[f] = src[f];
  }
  return `${EVENT_JSON_PREFIX}${JSON.stringify({
    standard: VAULT_EVENT_STANDARD,
    version: VAULT_EVENT_VERSION,
    event: event.event,
    data: [data],
  })}`;
}

/**
 * Parses one log line into a vault event. `null` when the line is not a `nearpay_vault` NEP-297
 * event or does not match the schema (version other than `1.0.0`, unknown event, bad field).
 * Proves nothing about validity on chain: the caller must also check the receipt (executor =
 * the vault account, successful outcome, final block; rails §8.6).
 */
export function parseVaultEventLog(line: string): VaultEvent | null {
  if (!line.startsWith(EVENT_JSON_PREFIX)) return null;
  let json: unknown;
  try {
    json = JSON.parse(line.slice(EVENT_JSON_PREFIX.length));
  } catch {
    return null;
  }
  const r = VaultEvent.safeParse(json);
  return r.success ? (r.data as VaultEvent) : null;
}

// =============================================================================================
// `ft_on_transfer` msg (contracts-vault §3.1; `src/msg.rs`)
// =============================================================================================

export const VaultCreateMandateArgs = inp({
  merchant_receiver: NearAccountId.describe("Receiver of the merchant share (≠ the vault)."),
  receiver_kind: VaultReceiverKind,
  amount_per_period: U128.describe("Tokens per period (> 0; the merchant share of one period must be > 0)."),
  period_secs: PeriodSecs,
  start_at: U64Ns.nullable()
    .optional()
    .describe("When period 1 becomes due (ns); omitted, null or past = the block time; ≤ block time + 366 days."),
  max_periods: MaxPeriods.optional(),
  fee_bps: FeeBps.describe("NearPay fee; ≤ the vault's `max_fee_bps` (else `ERR_FEE_TOO_HIGH`)."),
  ext_ref: ExtRef,
}).describe(
  "`create_mandate` arguments (unknown or duplicate fields are rejected; `payer`/`token` come from the call).",
);

/** Field order NearPay writes in `create_mandate` (the contract's struct order). */
export const VAULT_CREATE_MANDATE_FIELDS = [
  "merchant_receiver",
  "receiver_kind",
  "amount_per_period",
  "period_secs",
  "start_at",
  "max_periods",
  "fee_bps",
  "ext_ref",
] as const;

export const VaultMsg = z
  .union([
    inp({ create_mandate: VaultCreateMandateArgs }),
    inp({ top_up: inp({ mandate_id: MandateIdNum }).describe("`top_up` arguments (sender must be the payer).") }),
  ])
  .meta({
    id: "VaultMsg",
    description: "The `msg` of the payer's `ft_transfer_call` to the vault: exactly one of `create_mandate`, `top_up`.",
  });
export type VaultMsg = z.infer<typeof VaultMsg>;

/**
 * Serialises a vault `msg` canonically (compact JSON, `create_mandate` keys in the contract's
 * order, optional keys left out when undefined). Billing's prepare route and the stand-in use it.
 */
export function vaultMsgJson(msg: VaultMsg): string {
  const parsed = VaultMsg.parse(msg);
  if ("top_up" in parsed) return JSON.stringify({ top_up: { mandate_id: parsed.top_up.mandate_id } });
  const src = parsed.create_mandate as Record<string, unknown>;
  const cm: Record<string, unknown> = {};
  for (const f of VAULT_CREATE_MANDATE_FIELDS) if (src[f] !== undefined) cm[f] = src[f];
  const s = JSON.stringify({ create_mandate: cm });
  if (new TextEncoder().encode(s).length > VAULT_LIMITS.max_msg_len) throw new Error("vault msg too long");
  return s;
}

// =============================================================================================
// Views (contracts-vault §3.6, §3.7; `src/types.rs`)
// =============================================================================================

export const VaultMandateView = out({
  mandate_id: MandateIdNum,
  payer: NearAccountId.describe("Payer."),
  merchant_receiver: NearAccountId.describe("Merchant receiver."),
  receiver_kind: VaultReceiverKind,
  token: NearAccountId.describe("Token contract."),
  amount_per_period: U128.describe("Tokens per period."),
  period_secs: PeriodSecs,
  start_at: U64Ns.describe("Period 1 due time (ns)."),
  max_periods: MaxPeriods,
  fee_bps: FeeBps,
  collected_periods: z.int().min(0).describe("Periods counted so far."),
  balance: U128.describe("Tokens available to the next collect or refund (excludes in-flight amounts)."),
  status: VaultMandateStatus,
  in_flight: z.boolean().describe("A collect awaits its callbacks."),
  refund_in_flight: U128.describe('Amount of a pending cancel/withdraw refund; `"0"` when none.'),
  ext_ref: ExtRef,
  next_collect_at: U64Ns.nullable().describe(
    "When the next period becomes due (ns); null unless active below `max_periods`.",
  ),
}).meta({ id: "VaultMandateView", description: "`get_mandate` / `get_mandates_by_payer` element." });

export const VaultTokenCap = out({
  token: NearAccountId.describe("Token contract."),
  cap: U128.describe("Per-token TVL cap."),
  mandate_cap: U128.describe("Per-mandate cap (≤ `cap`): max `amount_per_period` and max held by one mandate."),
}).describe("Caps of one allowed token.");

export const VaultConfigView = out({
  allowed_tokens: z.array(NearAccountId).describe("Allowed NEP-141 tokens."),
  fee_receiver: NearAccountId.describe("Treasury that receives fees."),
  max_fee_bps: FeeBps.describe("Maximum `fee_bps` a mandate may set."),
  intents_account: NearAccountId.describe("NEAR Intents Verifier the merchant leg deposits into (`intents.near`)."),
  min_period_secs: z.int().min(1).describe("Minimum period (86 400)."),
  caps: z.array(VaultTokenCap).describe("Caps in `allowed_tokens` order."),
  mandate_storage_cost: U128.describe("yoctoNEAR locked per open mandate."),
  storage_registration_cost: U128.describe("NEP-145 registration minimum (yoctoNEAR)."),
}).meta({ id: "VaultConfigView", description: "`get_config` result (constructor parameters, immutable)." });

export const VaultTokenTvlView = out({
  token: NearAccountId.describe("Token contract."),
  tvl: U128.describe("Tokens the vault holds for the token's mandates."),
  cap: U128.describe("TVL cap."),
  mandate_cap: U128.describe("Per-mandate cap."),
}).meta({ id: "VaultTokenTvlView", description: "`get_token_tvl` result (null for a token that is not allowed)." });

export const VaultStorageBalance = out({
  total: U128.describe("yoctoNEAR deposited."),
  available: U128.describe("yoctoNEAR not locked by the registration or open mandates."),
}).meta({ id: "VaultStorageBalance", description: "NEP-145 `storage_balance_of` result (null when unregistered)." });

export const VaultStorageBalanceBounds = out({
  min: U128.describe("Registration minimum."),
  max: U128.nullable().describe("Always null."),
}).meta({ id: "VaultStorageBalanceBounds", description: "NEP-145 `storage_balance_bounds` result." });

/** View method → JSON result schema (the stand-in answers `query call_function` with the same JSON). */
export const VAULT_VIEWS = {
  get_mandate: VaultMandateView.nullable(),
  get_mandates_by_payer: z.array(VaultMandateView),
  next_collect_at: U64Ns.nullable(),
  get_config: VaultConfigView,
  get_token_tvl: VaultTokenTvlView.nullable(),
  storage_balance_of: VaultStorageBalance.nullable(),
  storage_balance_bounds: VaultStorageBalanceBounds,
} as const;
export type VaultViewMethod = keyof typeof VAULT_VIEWS;

/** Change methods a NearPay component or a payer calls on the vault (besides the token's `ft_transfer_call`). */
export const VAULT_CALL_METHODS = [
  "collect",
  "cancel",
  "withdraw",
  "storage_deposit",
  "storage_withdraw",
  "storage_unregister",
] as const;
export type VaultCallMethod = (typeof VAULT_CALL_METHODS)[number];

// =============================================================================================
// Arithmetic shared by billing, the stand-in and displays (INV-5: bigint only)
// =============================================================================================

/**
 * One period's split (contracts-vault §3): `merchant_share = floor(amount × (10000 − fee_bps) / 10000)`,
 * `fee = amount − merchant_share`.
 */
export function vaultSplit(amountPerPeriod: bigint, feeBps: number): { merchantShare: bigint; fee: bigint } {
  if (amountPerPeriod < 0n || !Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw new Error("invalid split input");
  }
  const merchantShare = (amountPerPeriod * BigInt(10_000 - feeBps)) / 10_000n;
  return { merchantShare, fee: amountPerPeriod - merchantShare };
}

/**
 * Fixed vault period for a billing interval (billing §14 d3). Vault periods are fixed seconds while
 * billing's months and years are calendar-based, so months and years use the mean Gregorian length:
 * the vault then allows exactly 12 periods per average year (never more than billing invoices) and
 * calendar renewals drift from it by at most ~3 days (the keeper retries at `next_collect_at`).
 */
export const VAULT_PERIOD_SECS_PER_INTERVAL = {
  day: 86_400,
  week: 604_800,
  /** 30.436875 days = 365.2425 / 12. */
  month: 2_629_746,
  /** 365.2425 days. */
  year: 31_556_952,
} as const;

export function vaultPeriodSecs(interval: keyof typeof VAULT_PERIOD_SECS_PER_INTERVAL, count: number): number {
  if (!Number.isInteger(count) || count < 1 || count > 12) throw new Error("interval_count must be 1–12");
  const secs = VAULT_PERIOD_SECS_PER_INTERVAL[interval] * count;
  if (secs > VAULT_LIMITS.max_period_secs) throw new Error("period too long for the vault");
  return secs;
}

// ===== src/public/mandates.ts =====
// =============================================================================================
// NEAR transactions for the payer's / merchant's wallet
// =============================================================================================

const GasUnits = z
  .string()
  .regex(/^[1-9][0-9]{0,17}$/)
  .describe("Gas in gas units as a decimal string (1 Tgas = 10^12).");
const Yocto = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,38})$/)
  .describe("Attached deposit in yoctoNEAR as a decimal string.");

export const NearFunctionCallAction = out({
  type: z.literal("FunctionCall").describe("Always `FunctionCall`."),
  method_name: z.string().min(1).max(256).describe("Contract method."),
  args: z.record(z.string(), z.unknown()).describe("JSON arguments, exactly as they must be sent."),
  gas: GasUnits,
  deposit: Yocto,
}).meta({ id: "NearFunctionCallAction", description: "A NEAR function-call action to sign as is." });

export const NearTransactionRequest = out({
  signer_id: NearAccountId.nullable().describe(
    "Account that must sign; null = the connected wallet's account (it becomes the payer).",
  ),
  receiver_id: NearAccountId.describe("Contract the transaction calls."),
  actions: z.array(NearFunctionCallAction).min(1).max(4).describe("Actions, in order."),
}).meta({
  id: "NearTransactionRequest",
  description:
    "A NEAR transaction for a wallet to sign (snake_case; NEAR Connect / wallet-selector take the same fields in camelCase). Clients show a summary and never edit receiver, method, args, gas or deposit.",
});
export type NearTransactionRequest = z.infer<typeof NearTransactionRequest>;

// =============================================================================================
// Mandate
// =============================================================================================

export const MandateStatus = openEnum(
  ["active", "insufficient", "exhausted", "canceled"],
  "Mandate status (domain-model §4.5): `active` = on-chain active with at least one period funded; `insufficient` = on-chain active but the balance is below one period (top up, or the due invoice falls back to `send_invoice`); `exhausted` = `max_periods` collected; `canceled` = canceled by the payer or the merchant receiver.",
);

export const MandateLinkStatus = openEnum(
  ["linked", "unlinked"],
  "`linked`: billing collects this mandate for its subscription. `unlinked`: the on-chain terms do not match what billing prepared; billing never collects it and the payer is asked to cancel it.",
);

export const MandateUnlinkedReason = openEnum(
  [
    "subscription_not_auto_debit",
    "subscription_ended",
    "already_linked",
    "receiver_kind_mismatch",
    "receiver_not_destination",
    "token_mismatch",
    "amount_mismatch",
    "period_mismatch",
    "fee_mismatch",
    "start_too_late",
    "max_periods_too_low",
    "mode_mismatch",
  ],
  "Why a mandate is `unlinked` (billing §6 linkage rule): the subscription is not `auto_debit` or has ended, another mandate is already linked, or a term differs from the prepared one (receiver kind, receiver = an active Intents-account destination of the account, token, amount per period, period, fee, `start_at` after the current period end, `max_periods` below the remaining periods), or a test-vault mandate names a live subscription (or the reverse).",
);

export const MandateCollection = out({
  period: z.int().min(1).describe("1-based vault period."),
  amount: BaseUnits.describe("`merchant_share + fee` actually paid (token base units)."),
  merchant_share: BaseUnits.describe("Share delivered to the merchant receiver."),
  fee: BaseUnits.describe('NearPay fee; `"0"` when the fee leg failed (the fee stayed with the payer).'),
  short: z
    .boolean()
    .describe(
      "The merchant share was below the expected share (partial delivery): the invoice is not marked paid; billing issues a `send_invoice` balance invoice for the shortfall.",
    ),
  invoice: id("in").nullable().describe("Invoice the collection paid (or applied to)."),
  tx_hash: TxHash.describe("NEAR transaction of the `collect`."),
  receipt_id: z.string().min(1).max(64).describe("Vault receipt that logged `collected` (evidence)."),
  collected_at: UnixTime.describe("Block time of the receipt."),
}).meta({ id: "MandateCollection", description: "A period collected by the vault (evidence: the `collected` event)." });

export const Mandate = out({
  id: id("md"),
  object: z.literal("mandate").describe("Always `mandate`."),
  created: UnixTime.describe("Block time of `mandate_created`."),
  livemode: Livemode.describe("`true` for the mainnet vault, `false` for the sandbox vault stand-in."),
  status: MandateStatus,
  link_status: MandateLinkStatus,
  unlinked_reason: MandateUnlinkedReason.nullable().describe("Set when `link_status` is `unlinked`."),
  collecting: z
    .boolean()
    .describe(
      "Billing's keeper collects renewal invoices from this mandate: linked, on-chain active, and its subscription is active and `auto_debit`. Turns false for good when the subscription ends or leaves `auto_debit` (`mandate.released`).",
    ),
  subscription: id("sub").describe("Subscription named by the mandate's `ext_ref`."),
  customer: id("cus").describe("Customer of that subscription."),
  vault_contract: NearAccountId.describe("Vault account (`v1.vault.nearpay.near`; the stand-in's in test mode)."),
  onchain_id: z.int().min(0).describe("The vault's `mandate_id`."),
  payer: NearAccountId.describe("Payer: the NEAR account that signed the funding transaction (always its owner)."),
  token: NearAccountId.describe("NEP-141 token contract."),
  asset_id: AssetId.describe("The token as a NEAR Intents asset id (`nep141:<token>`)."),
  merchant_receiver: NearAccountId.describe("Receiver of the merchant share (the merchant's NEAR Intents account)."),
  receiver_kind: VaultReceiverKind,
  settlement_destination: id("sd")
    .nullable()
    .describe("Settlement destination that matches `merchant_receiver` (linked mandates); null otherwise."),
  amount_per_period: BaseUnits.describe("Tokens collected per period."),
  period_secs: z.int().min(86_400).describe("Vault period length (seconds)."),
  start_at: UnixTime.describe("When vault period 1 became (or becomes) due."),
  max_periods: z.int().min(1).nullable().describe("Maximum periods; null = until canceled."),
  fee_bps: z.int().min(0).max(10_000).describe("NearPay fee in basis points, fixed on chain at creation."),
  collected_periods: z.int().min(0).describe("Periods the vault has counted."),
  balance: BaseUnits.describe("Tokens on the mandate available for the next periods (mirror of the vault events)."),
  funded_periods: z.int().min(0).describe("`floor(balance / amount_per_period)`: periods the balance still covers."),
  next_collect_at: UnixTime.nullable().describe(
    "When the next vault period becomes due; null unless on-chain active below `max_periods`.",
  ),
  last_collection: MandateCollection.nullable().describe("Most recent collected period."),
  collect_failures: z
    .int()
    .min(0)
    .describe("Consecutive `collect_failed` outcomes (merchant leg delivered nothing); reset by a collection."),
  canceled: out({
    by: NearAccountId.describe("Who canceled (the payer or the merchant receiver)."),
    by_role: openEnum(["payer", "merchant_receiver"], "Role of `by`."),
    refunded: BaseUnits.describe(
      'Returned to the payer by the cancel; `"0"` if that refund failed (then withdrawable).',
    ),
    canceled_at: UnixTime.describe("Block time of the `canceled` event."),
  })
    .nullable()
    .describe("Set once canceled."),
  withdrawn: BaseUnits.describe("Total the payer withdrew after cancel/exhaustion (`withdrawn` events)."),
  ext_ref: z.string().max(64).describe("The mandate's on-chain reference (the subscription id for NearPay mandates)."),
  sequence: z.int().min(0).describe("Increases with every change; discard webhook objects with a lower sequence."),
}).meta({
  id: "Mandate",
  description:
    "An auto-debit mandate: NearPay's mirror of a subscription-vault mandate the payer funded (FR-BIL-02/04).",
});
export type Mandate = z.infer<typeof Mandate>;

// =============================================================================================
// Funding instructions
// =============================================================================================

/** Default `payer_notice` billing returns (English; UIs may localise it without weakening it). */
export const MANDATE_FUNDING_PAYER_NOTICE =
  "Sign both transactions from your own NEAR account and pay the gas yourself. Relayer or gasless wallets, NEAR Intents balances, bridges and smart wallets cannot fund a mandate: the vault refunds such deposits. You can cancel at any time from any NEAR wallet and get the remaining balance back.";

export const MandateFundingInstructions = out({
  object: z.literal("mandate_funding_instructions").describe("Always `mandate_funding_instructions`."),
  livemode: Livemode,
  subscription: id("sub"),
  vault_contract: NearAccountId.describe("Vault the mandate is created in."),
  token: NearAccountId.describe("NEP-141 token the payer funds with."),
  asset_id: AssetId.describe("The token as a NEAR Intents asset id."),
  amount: BaseUnits.describe("Initial funding: `periods × amount_per_period`."),
  periods: z.int().min(1).describe("Periods the initial funding covers."),
  amount_per_period: BaseUnits.describe(
    "Tokens per period: the subscription's per-period total (items and tax) in the token (USD at par for USDC/USDT, or the pricing asset itself).",
  ),
  period_secs: z.int().min(86_400).describe("Vault period for the subscription's interval (billing §14 d3)."),
  start_at: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,19})$/)
    .nullable()
    .describe(
      "Period 1 due time in ns as written in `msg`; null = the block time (the mandate pays the subscription's open invoice right away).",
    ),
  fee_bps: z.int().min(0).max(10_000).describe("The account's agreed NearPay fee (ADR-0006)."),
  merchant_receiver: NearAccountId.describe("The merchant's NEAR Intents account (an active destination)."),
  receiver_kind: VaultReceiverKind,
  settlement_destination: id("sd").describe("Destination `merchant_receiver` belongs to."),
  ext_ref: z.string().max(64).describe("The subscription id, written as the mandate's `ext_ref`."),
  msg: z
    .string()
    .max(2048)
    .describe(
      'Exact `ft_transfer_call` msg (`{"create_mandate":{…}}`, compact JSON, the contract\'s key order). A mandate whose on-chain terms differ is not linked.',
    ),
  payer: NearAccountId.nullable().describe("Payer the storage check was made for; null when none was given."),
  storage: out({
    payer_registered: z
      .boolean()
      .nullable()
      .describe("Whether the payer has a vault storage balance; null when no payer was given."),
    deposit: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,38})$/)
      .describe(
        'yoctoNEAR the payer must add with `storage_deposit` before funding (0.002 NEAR registration + 0.01 NEAR per open mandate, minus what is available); `"0"` = none.',
      ),
  }).describe("Vault storage (NEP-145) the payer pays for."),
  payer_notice: z
    .string()
    .describe(
      "Text the funding UI must show before signing (billing v1.6 §5): sign from your own NEAR account and pay your own gas; relayer/gasless wallets (NEP-366 meta-transactions), NEAR Intents balances, bridges and smart wallets cannot fund (the vault refunds such deposits). Cancel and withdraw work from any wallet, including meta-transactions.",
    ),
  transactions: z
    .array(NearTransactionRequest)
    .min(1)
    .max(2)
    .describe(
      "Transactions to sign from the payer's own NEAR account, in order: `storage_deposit` on the vault (only when `storage.deposit` > 0 or the payer is unknown), then `ft_transfer_call` on the token (`receiver_id` = the vault, `amount`, `msg`; 100 Tgas, 1 yoctoNEAR). Deposits relayed by contracts, smart wallets or NEP-366 meta-transactions are refunded (`ERR_UNSUPPORTED_SENDER`).",
    ),
}).meta({
  id: "MandateFundingInstructions",
  description:
    "What the payer signs to authorise auto-debit for a subscription (lld/billing.md §5, §14). Computing it has no side effects.",
});

const FundingBody = {
  payer: NearAccountId.optional().describe(
    "Payer's NEAR account, if known: billing reads its vault storage balance and leaves out `storage_deposit` when it is enough.",
  ),
  token: NearAccountId.optional().describe(
    "Token to fund with (an allowed vault token). USD subscriptions: USDC or USDT at par (default USDC); asset subscriptions: the pricing asset's token only.",
  ),
  periods: z.int().min(1).max(36).optional().describe("Periods to fund up front (default 3)."),
};

const FUNDING_ERRORS = [
  "state_conflict",
  "auto_debit_unavailable",
  "destination_not_intents_account",
  "vault_cap_exceeded",
  "account_not_live",
  "rail_unavailable",
] as const;

const MandateParams = inp({ id: id("md") });
const WRITE = ["secret_key", "restricted_key:subscriptions.write", "session"] as const;
const READ = ["secret_key", "restricted_key:subscriptions.read", "session"] as const;

export const prepareMandate = route({
  id: "prepareMandate",
  method: "POST",
  path: "/v1/mandates/prepare",
  service: "billing",
  visibility: "public",
  summary: "Compute what a payer signs to fund an auto-debit mandate for a subscription.",
  description:
    "The subscription must be `auto_debit`, not canceled, and without a linked active mandate (`state_conflict`). Its pricing must be vault-compatible: USD (paid at par in USDC/USDT) or an asset whose token the vault allows, with a per-period total within the vault's per-mandate cap (`auto_debit_unavailable`). The merchant receiver is the subscription's settlement destination if it is an active NEAR Intents account for the token, else the account's default one (`destination_not_intents_account`). `start_at` is null (block time) while the subscription's latest invoice is open — the first collection pays it — else the current period end (or `trial_end`). Funding above the vault's per-mandate or TVL cap is `vault_cap_exceeded`; the NEAR RPC being unreachable is `rail_unavailable`. No mandate exists until the payer's transaction lands and rails forwards `mandate_created`.",
  auth: WRITE,
  roles: SUBSCRIPTION_ROLES,
  idempotent: true,
  body: inp({ subscription: id("sub").describe("The `auto_debit` subscription."), ...FundingBody }).meta({
    id: "MandatePrepare",
    description: "Parameters to prepare a mandate's funding.",
  }),
  response: MandateFundingInstructions,
  status: 200,
  errors: [...FUNDING_ERRORS] as never,
  stage: 4,
});

export const getMandate = route({
  id: "getMandate",
  method: "GET",
  path: "/v1/mandates/{id}",
  service: "billing",
  visibility: "public",
  summary: "Retrieve a mandate.",
  auth: READ,
  idempotent: false,
  params: MandateParams,
  response: Mandate,
  status: 200,
  errors: [],
  stage: 4,
});

export const listMandates = route({
  id: "listMandates",
  method: "GET",
  path: "/v1/mandates",
  service: "billing",
  visibility: "public",
  summary: "List mandates.",
  auth: READ,
  idempotent: false,
  query: inp({
    ...listQueryShape,
    ...createdFilterShape,
    subscription: id("sub").optional().describe("Only mandates of this subscription."),
    customer: id("cus").optional().describe("Only mandates of this customer."),
    status: MandateStatus.optional().describe("Only mandates in this status."),
    link_status: MandateLinkStatus.optional().describe("Only linked or only unlinked mandates."),
    payer: NearAccountId.optional().describe("Only mandates funded by this NEAR account."),
  }),
  response: listOf(Mandate, "MandateList", "A page of mandates."),
  status: 200,
  errors: [],
  stage: 4,
});

export const MandateCancelInstructions = out({
  object: z.literal("mandate_cancel_instructions").describe("Always `mandate_cancel_instructions`."),
  mandate: id("md"),
  transaction: NearTransactionRequest.describe(
    "`cancel({mandate_id})` on the vault, signed by `merchant_receiver` (100 Tgas, 1 yoctoNEAR): the whole balance returns to the payer.",
  ),
}).meta({
  id: "MandateCancelInstructions",
  description:
    "The transaction the merchant receiver signs to cancel a mandate. NearPay cannot cancel (it holds no key the vault accepts, INV-1).",
});

export const prepareMandateCancel = route({
  id: "prepareMandateCancel",
  method: "POST",
  path: "/v1/mandates/{id}/prepare_cancel",
  service: "billing",
  visibility: "public",
  summary: "Get the transaction the merchant receiver signs to cancel a mandate.",
  description:
    "The vault accepts `cancel` from the payer or the merchant receiver only, so the merchant signs it with the wallet of its NEAR Intents account (accounts that cannot sign NEAR transactions, e.g. EVM-keyed implicit accounts without a wallet contract, cannot cancel; the payer always can). Canceled or exhausted mandates answer `state_conflict`. Ending the subscription instead stops collection (`mandate.released`) and asks the payer to cancel.",
  auth: WRITE,
  roles: SUBSCRIPTION_ROLES,
  idempotent: true,
  params: MandateParams,
  response: MandateCancelInstructions,
  status: 200,
  errors: ["state_conflict"],
  stage: 4,
});

// =============================================================================================
// Hosted invoice page (`/i/:id`): payer-side funding and management
// =============================================================================================

const PublicInvoiceParams = inp({ id: id("in") });

export const PublicMandate = out({
  id: id("md"),
  object: z.literal("mandate").describe("Always `mandate`."),
  livemode: Livemode,
  status: MandateStatus,
  link_status: MandateLinkStatus,
  payer: NearAccountId.describe("Payer account."),
  vault_contract: NearAccountId.describe("Vault account."),
  onchain_id: z.int().min(0).describe("The vault's `mandate_id`."),
  token: NearAccountId.describe("Token contract."),
  asset_id: AssetId.describe("Token as a NEAR Intents asset id."),
  amount_per_period: BaseUnits.describe("Tokens per period."),
  period_secs: z.int().min(86_400).describe("Period length (seconds)."),
  balance: BaseUnits.describe("Remaining balance."),
  funded_periods: z.int().min(0).describe("Periods the balance still covers."),
  collected_periods: z.int().min(0).describe("Periods collected."),
  next_collect_at: UnixTime.nullable().describe("Next due time; null when none."),
  collecting: z.boolean().describe("The merchant still collects from it."),
  top_up_msg: z
    .string()
    .nullable()
    .describe(
      '`ft_transfer_call` msg to top up (`{"top_up":{"mandate_id":n}}`) while on-chain active; send it to the vault from the payer\'s account with any amount.',
    ),
  transactions: out({
    cancel: NearTransactionRequest.nullable().describe(
      "`cancel` signed by the payer (100 Tgas, 1 yoctoNEAR); null unless on-chain active.",
    ),
    withdraw: NearTransactionRequest.nullable().describe(
      "`withdraw` signed by the payer after cancel/exhaustion while a balance remains; null otherwise.",
    ),
  }).describe("Payer transactions the page offers."),
}).meta({
  id: "PublicMandate",
  description: "A mandate as the hosted invoice page shows it to the payer (holder of the invoice secret).",
});

export const createPublicInvoiceMandateFunding = route({
  id: "createPublicInvoiceMandateFunding",
  method: "POST",
  path: "/v1/invoices/{id}/public/mandate_funding",
  service: "billing",
  visibility: "public",
  summary: "Hosted invoice page: compute the payer's auto-debit funding transactions.",
  description:
    "Anonymous; billing checks the invoice secret. Offered when `PublicInvoice.auto_debit.available`: the invoice belongs to an `auto_debit` subscription without a linked active mandate. Same computation as `prepareMandate` (no side effects); paid or void invoices answer `invoice_not_payable`.",
  auth: ["anonymous"],
  idempotent: false,
  params: PublicInvoiceParams,
  headers: InvoiceSecretHeaders,
  body: inp(FundingBody),
  response: MandateFundingInstructions,
  status: 200,
  errors: ["invoice_secret_invalid", "invoice_not_payable", ...FUNDING_ERRORS] as never,
  stage: 4,
});

export const getPublicInvoiceMandate = route({
  id: "getPublicInvoiceMandate",
  method: "GET",
  path: "/v1/invoices/{id}/public/mandate",
  service: "billing",
  visibility: "public",
  summary: "Hosted invoice page: the subscription's mandate with the payer's cancel/withdraw transactions.",
  description:
    "Anonymous; billing checks the invoice secret. Returns the newest mandate linked to the invoice's subscription (or unlinked for it), else `404 resource_missing`. The payer may also cancel straight from any NEAR wallet: the vault needs no NearPay involvement.",
  auth: ["anonymous"],
  idempotent: false,
  params: PublicInvoiceParams,
  headers: InvoiceSecretHeaders,
  response: PublicMandate,
  status: 200,
  errors: ["invoice_secret_invalid"],
  stage: 4,
});

// =============================================================================================
// Test helpers (test mode: the sandbox vault stand-in, lld/sandbox.md §3.1)
// =============================================================================================

export const MandateSimulation = out({
  object: z.literal("mandate_simulation").describe("Always `mandate_simulation`."),
  action: openEnum(["fund", "top_up", "cancel", "withdraw"], "What the simulated payer did."),
  tx_hash: TxHash.describe("Sandbox NEAR transaction."),
  accepted: z
    .boolean()
    .describe(
      "The vault accepted it (`fund`/`top_up`: not refunded; `cancel`/`withdraw`: no failure). The mirror follows asynchronously from the forwarded events.",
    ),
  rejection: z
    .string()
    .nullable()
    .describe("The vault's error or rejection log line (`ERR_…[: detail]`) when not accepted."),
  onchain_id: z.int().min(0).nullable().describe("Vault `mandate_id` (from `mandate_created` / the mandate)."),
  logs: z.array(z.string()).describe("Every log line of the vault's receipts, in order."),
}).meta({ id: "MandateSimulation", description: "Result of a simulated payer action on the sandbox vault." });

const TEST_HELPER_AUTH = WRITE;
const TEST_HELPER_ROLES = ["owner", "admin", "developer"] as const;

export const simulateMandateFunding = route({
  id: "simulateMandateFunding",
  method: "POST",
  path: "/v1/test_helpers/mandates/fund",
  service: "billing",
  visibility: "public",
  summary: "Test mode: fund a mandate for a subscription as the simulated payer.",
  description:
    "Prepares the funding like `prepareMandate` and submits it to the sandbox vault stand-in as `payer` (default the simulated NEAR payer `sandbox-payer.near`, sandbox §4.1): storage is registered and the payer's test tokens are minted as needed, then `ft_transfer_call` runs with the prepared `msg`. Outcome scenarios follow the last two digits of `amount_per_period` (sandbox §4.2: `91` merchant leg fails, `92` fee leg fails, `93` first refund fails, `94` partial delivery).",
  auth: TEST_HELPER_AUTH,
  roles: TEST_HELPER_ROLES,
  idempotent: true,
  testModeOnly: true,
  body: inp({ subscription: id("sub").describe("The `auto_debit` subscription."), ...FundingBody }).meta({
    id: "MandateFundingSimulation",
    description: "Parameters of a simulated mandate funding.",
  }),
  response: MandateSimulation,
  status: 200,
  errors: ["livemode_forbidden", ...FUNDING_ERRORS.filter((c) => c !== "account_not_live")] as never,
  stage: 4,
});

export const simulateMandatePayerAction = route({
  id: "simulateMandatePayerAction",
  method: "POST",
  path: "/v1/test_helpers/mandates/{id}/payer_action",
  service: "billing",
  visibility: "public",
  summary: "Test mode: top up, cancel or withdraw a mandate as its payer.",
  description:
    "Submits the payer's transaction to the sandbox vault stand-in (`top_up`: `periods × amount_per_period`, default 1; `cancel` and `withdraw` with 100 Tgas and 1 yoctoNEAR). The vault's own errors come back in `rejection` with `accepted: false` (e.g. `ERR_STILL_ACTIVE` for a withdraw before cancel), not as API errors.",
  auth: TEST_HELPER_AUTH,
  roles: TEST_HELPER_ROLES,
  idempotent: true,
  testModeOnly: true,
  params: MandateParams,
  body: inp({
    action: closedEnum(["top_up", "cancel", "withdraw"], "Payer action."),
    periods: z.int().min(1).max(36).optional().describe("`top_up` only: periods to add (default 1)."),
  }),
  response: MandateSimulation,
  status: 200,
  errors: ["livemode_forbidden"],
  stage: 4,
});

// ===== src/internal/vault.ts =====
// =============================================================================================
// evt.rails.vault.event (rails §8.6)
// =============================================================================================

export const VaultEventRecord = out({
  vault_contract: NearAccountId.describe(
    "Executor of the receipt: the configured vault (`NP_VAULT_CONTRACT`; the sandbox stand-in in test mode).",
  ),
  tx_hash: TxHash.describe("Transaction the receipt belongs to (explorer link)."),
  receipt_id: z.string().min(1).max(64).describe("Receipt that logged the event (base58)."),
  log_index: z.int().min(0).describe("0-based index of the log line in the receipt's outcome logs."),
  block_height: z.int().min(0).describe("Final block that includes the receipt outcome."),
  block_hash: z.string().min(1).max(64).describe("Hash of that block."),
  block_timestamp: z
    .string()
    .regex(/^(0|[1-9][0-9]{0,19})$/)
    .describe("Block time in nanoseconds (decimal string); billing's `created`/`collected_at`."),
  event: VaultEvent,
}).meta({
  id: "VaultEventRecord",
  description:
    "A valid vault event (contracts-vault §4.1): executor = the vault, outcome `SuccessValue`/`SuccessReceiptId`, block final, schema-valid. Dedupe key `receipt_id:log_index` (at-least-once, INV-4). Envelope: `account_id` null, `livemode` true for the mainnet vault and false for the stand-in, aggregate `vault_mandate` `<vault_contract>#<mandate_id>`.",
});
export type VaultEventRecord = z.infer<typeof VaultEventRecord>;

/** Dedupe key of a forwarded vault event. */
export function vaultEventDedupeKey(r: Pick<VaultEventRecord, "receipt_id" | "log_index">): string {
  return `${r.receipt_id}:${r.log_index}`;
}

/** Reasons rails drops a `nearpay_vault` log instead of forwarding it (`vault_event_rejected_total{reason}`). */
export const VAULT_EVENT_REJECT_REASONS = [
  "wrong_executor",
  "failed_receipt",
  "not_final",
  "bad_version",
  "bad_schema",
] as const;

// =============================================================================================
// NEAR JSON-RPC subset (keeper ↔ NEAR RPC | sandbox stand-in)
// =============================================================================================

const JsonRpcId = z.union([z.string().max(128), z.int()]).describe("JSON-RPC request id (echoed).");
const Finality = closedEnum(["final", "optimistic"], "Block finality.");
const Base58Hash = z.string().min(32).max(64).describe("Base58 hash.");

export const NearRpcBlockParams = inp({ finality: Finality }).describe("`block` params (latest block).");

export const NearRpcCallFunctionParams = inp({
  request_type: z.literal("call_function").describe("View call."),
  finality: Finality,
  account_id: NearAccountId.describe("Contract (the vault, or a token for `ft_balance_of`)."),
  method_name: z.string().min(1).max(256).describe("View method."),
  args_base64: z.string().max(8192).describe("Base64 of the JSON arguments."),
}).describe("`query` call_function params.");

export const NearRpcViewAccessKeyParams = inp({
  request_type: z.literal("view_access_key").describe("Access key lookup (nonce before signing)."),
  finality: Finality,
  account_id: NearAccountId.describe("Signer account."),
  public_key: z
    .string()
    .regex(/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/)
    .describe("`ed25519:<base58>` key."),
}).describe("`query` view_access_key params.");

export const NearTxWaitUntil = closedEnum(
  ["NONE", "INCLUDED", "EXECUTED_OPTIMISTIC", "INCLUDED_FINAL", "EXECUTED", "FINAL"],
  "`send_tx` wait level; the keeper waits for `FINAL` (the stand-in executes synchronously and answers every level with the final outcome).",
);

export const NearRpcSendTxParams = inp({
  signed_tx_base64: z.string().min(1).max(65_536).describe("Base64 of the borsh `SignedTransaction`."),
  wait_until: NearTxWaitUntil.optional(),
}).describe("`send_tx` params.");

export const NearRpcTxParams = inp({
  tx_hash: Base58Hash.describe("Transaction hash."),
  sender_account_id: NearAccountId.describe("Signer."),
  wait_until: NearTxWaitUntil.optional(),
}).describe("`tx` params (status of a sent transaction, e.g. after a transport error).");

export const NearRpcRequest = z
  .discriminatedUnion("method", [
    inp({
      jsonrpc: z.literal("2.0").describe("JSON-RPC version."),
      id: JsonRpcId,
      method: z.literal("block").describe("Latest block (hash for signing)."),
      params: NearRpcBlockParams,
    }),
    inp({
      jsonrpc: z.literal("2.0").describe("JSON-RPC version."),
      id: JsonRpcId,
      method: z.literal("query").describe("View call or access key."),
      params: z.union([NearRpcCallFunctionParams, NearRpcViewAccessKeyParams]).describe("Query params."),
    }),
    inp({
      jsonrpc: z.literal("2.0").describe("JSON-RPC version."),
      id: JsonRpcId,
      method: z.literal("send_tx").describe("Submit a signed transaction."),
      params: NearRpcSendTxParams,
    }),
    inp({
      jsonrpc: z.literal("2.0").describe("JSON-RPC version."),
      id: JsonRpcId,
      method: z.literal("broadcast_tx_commit").describe("Submit and wait (legacy form of `send_tx`)."),
      params: z.tuple([z.string().min(1).max(65_536)]).describe("`[signed_tx_base64]`."),
    }),
    inp({
      jsonrpc: z.literal("2.0").describe("JSON-RPC version."),
      id: JsonRpcId,
      method: z.literal("tx").describe("Transaction status."),
      params: NearRpcTxParams,
    }),
  ])
  .meta({
    id: "NearRpcRequest",
    description:
      "The NEAR JSON-RPC subset the keeper uses (`block`, `query` call_function / view_access_key, `send_tx`, `broadcast_tx_commit`, `tx`). The sandbox stand-in serves exactly this subset; other methods answer `METHOD_NOT_FOUND`.",
  });
export type NearRpcRequest = z.infer<typeof NearRpcRequest>;

/** Failure of a function call (the shape a vault panic takes in a transaction outcome). */
export const NearTxExecutionError = out({
  ActionError: out({
    index: z.int().min(0).nullable().describe("Index of the failed action."),
    kind: out({
      FunctionCallError: out({
        ExecutionError: z.string().describe("`Smart contract panicked: <message>` (vault: `ERR_…`)."),
      })
        .optional()
        .describe("Contract panic."),
    }).describe("Failure kind (other kinds pass through untyped)."),
  })
    .optional()
    .describe("An action failed."),
  InvalidTxError: z.unknown().optional().describe("The transaction itself was invalid."),
}).meta({ id: "NearTxExecutionError", description: "`TxExecutionError` (loose)." });

export const NearExecutionStatus = z
  .union([
    out({ SuccessValue: z.string().describe("Base64 of the return value (vault `collect`: `true`/`false`).") }),
    out({ SuccessReceiptId: z.string().describe("Receipt the outcome continues in.") }),
    out({ Failure: NearTxExecutionError }),
    z.literal("Unknown").describe("Not executed yet."),
  ])
  .describe("Execution status of a transaction or receipt.");

export const NearExecutionOutcomeWithId = out({
  id: z.string().describe("Receipt (or transaction) id."),
  block_hash: z.string().describe("Block that included the outcome."),
  outcome: out({
    logs: z.array(z.string()).describe("Log lines (`EVENT_JSON:…`, rejection codes)."),
    receipt_ids: z.array(z.string()).describe("Receipts it created."),
    gas_burnt: z.int().min(0).describe("Gas burnt."),
    tokens_burnt: z.string().describe("yoctoNEAR burnt."),
    executor_id: NearAccountId.describe("Account that executed it (rails checks = the vault)."),
    status: NearExecutionStatus,
  }).describe("Outcome."),
}).meta({ id: "NearExecutionOutcomeWithId", description: "A transaction or receipt outcome." });

export const NearFinalExecutionOutcome = out({
  final_execution_status: NearTxWaitUntil.optional(),
  status: NearExecutionStatus.describe("Overall status: `Failure` when any receipt of the call chain panicked first."),
  transaction: out({
    signer_id: NearAccountId.describe("Signer."),
    public_key: z.string().describe("Signer key."),
    nonce: z.int().min(0).describe("Nonce."),
    receiver_id: NearAccountId.describe("Receiver."),
    hash: z.string().describe("Transaction hash."),
  }).describe("The transaction (actions omitted from the contract; the stand-in echoes them)."),
  transaction_outcome: NearExecutionOutcomeWithId,
  receipts_outcome: z.array(NearExecutionOutcomeWithId).describe("Every receipt outcome, in execution order."),
}).meta({ id: "NearFinalExecutionOutcome", description: "`send_tx` / `broadcast_tx_commit` / `tx` result (loose)." });
export type NearFinalExecutionOutcome = z.infer<typeof NearFinalExecutionOutcome>;

export const NearCallFunctionResult = out({
  result: z.array(z.int().min(0).max(255)).describe("UTF-8 bytes of the JSON return value."),
  logs: z.array(z.string()).describe("Logs (views log nothing)."),
  block_height: z.int().min(0).describe("Block."),
  block_hash: z.string().describe("Block hash."),
}).meta({ id: "NearCallFunctionResult", description: "`query` call_function result." });

export const NearAccessKeyResult = out({
  nonce: z.int().min(0).describe("Last used nonce."),
  permission: z
    .union([
      z.literal("FullAccess").describe("Full access."),
      out({
        FunctionCall: out({
          allowance: z.string().nullable().describe("Remaining allowance (yoctoNEAR); null = unlimited."),
          receiver_id: NearAccountId.describe("Only this contract."),
          method_names: z.array(z.string()).describe("Only these methods (empty = any)."),
        }).describe("Function-call permission."),
      }),
    ])
    .describe("Key permission."),
  block_height: z.int().min(0).describe("Block."),
  block_hash: z.string().describe("Block hash (signers use it as the transaction's recent block hash)."),
}).meta({ id: "NearAccessKeyResult", description: "`query` view_access_key result." });

export const NearBlockResult = out({
  header: out({
    height: z.int().min(0).describe("Height."),
    hash: z.string().describe("Block hash."),
    timestamp_nanosec: z.string().describe("Block time (ns, decimal string)."),
  }).describe("Block header (loose)."),
}).meta({ id: "NearBlockResult", description: "`block` result (loose)." });

export const NearRpcError = out({
  name: z.string().describe("`HANDLER_ERROR`, `REQUEST_VALIDATION_ERROR` or `INTERNAL_ERROR`."),
  cause: out({
    name: z
      .string()
      .describe(
        "E.g. `INVALID_TRANSACTION`, `UNKNOWN_ACCESS_KEY`, `UNKNOWN_ACCOUNT`, `NO_CONTRACT_CODE`, `CONTRACT_EXECUTION_ERROR`, `METHOD_NOT_FOUND`, `TIMEOUT_ERROR`.",
      ),
    info: z.record(z.string(), z.unknown()).optional().describe("Details."),
  }).describe("Cause."),
  code: z.int().describe("JSON-RPC code (-32000 handler errors, -32601 unknown method, -32700 parse error)."),
  message: z.string().describe("Message."),
  data: z.unknown().optional().describe("Legacy detail."),
}).meta({ id: "NearRpcError", description: "NEAR JSON-RPC structured error." });

export const NearRpcResponse = z
  .union([
    out({
      jsonrpc: z.literal("2.0").describe("JSON-RPC version."),
      id: JsonRpcId,
      result: z
        .union([NearFinalExecutionOutcome, NearCallFunctionResult, NearAccessKeyResult, NearBlockResult])
        .describe("Method result."),
    }),
    out({ jsonrpc: z.literal("2.0").describe("JSON-RPC version."), id: JsonRpcId, error: NearRpcError }),
  ])
  .meta({ id: "NearRpcResponse", description: "JSON-RPC response of the subset (always HTTP 200, like NEAR RPC)." });

/** Builds the `Failure` status of a vault panic, as NEAR RPC renders it. */
export function nearPanicStatus(message: string, actionIndex = 0) {
  return {
    Failure: {
      ActionError: {
        index: actionIndex,
        kind: { FunctionCallError: { ExecutionError: `${SMART_CONTRACT_PANICKED_PREFIX}${message}` } },
      },
    },
  };
}

// =============================================================================================
// Keeper outcome rules (billing §7.1) as data
// =============================================================================================

/** What the keeper does when a `collect` transaction fails with a vault error. */
export const VAULT_KEEPER_ON_TX_FAILURE = {
  ERR_INSUFFICIENT_BALANCE: "fallback_send_invoice",
  ERR_NOT_DUE: "retry_at_next_collect_at",
  ERR_IN_FLIGHT: "await_forwarded_outcome",
  ERR_GAS: "alert_and_fix_gas",
  ERR_NOT_ACTIVE: "reconcile_no_retry",
  ERR_MAX_PERIODS: "reconcile_no_retry",
  ERR_NOT_FOUND: "reconcile_no_retry",
} as const satisfies Partial<Record<VaultErrorCode, string>>;

/** Keeper tuning fixed by billing §7.1. */
export const VAULT_KEEPER_RULES = {
  /** Consecutive `collect_failed` outcomes before the invoice falls back to `send_invoice`. */
  max_collect_failures: 5,
  /** …or this long since the first failure of the streak (seconds). */
  collect_failure_window_secs: 86_400,
  /** Re-check after `ERR_IN_FLIGHT` (seconds). */
  in_flight_recheck_secs: 30,
  /** Other errors: retries before a case is opened. */
  other_error_retries: 5,
  /** Minimum spacing of collect attempts per mandate (seconds). */
  min_attempt_spacing_secs: 60,
} as const;

/** The keeper's outcome kind once a `collect` transaction is final (billing §7.1). */
export const VaultCollectOutcome = openEnum(
  ["collected", "collected_short", "collected_no_fee", "collect_failed", "tx_failure"],
  "Keeper outcome of one collect: full collection, short merchant share, fee leg failed, merchant leg failed, or the transaction failed with a vault error.",
);

// =============================================================================================
// Sandbox vault stand-in (OQ-T-03, sandbox §3.1, §4.2)
// =============================================================================================

/** Defaults of the stand-in's configuration (sandbox §6). */
export const SANDBOX_VAULT_DEFAULTS = {
  vault_contract: "vault.sandbox.near",
  fee_receiver: "treasury.sandbox.near",
  intents_account: "intents.near",
  max_fee_bps: 500,
} as const;

/** Outcome scenarios of the stand-in, by the last two digits of `amount_per_period`. */
export const VAULT_SANDBOX_SCENARIOS = {
  "91": "merchant_leg_fails",
  "92": "fee_leg_fails",
  "93": "first_refund_fails",
  "94": "partial_delivery",
} as const;
export type VaultSandboxScenario = (typeof VAULT_SANDBOX_SCENARIOS)[keyof typeof VAULT_SANDBOX_SCENARIOS] | "success";

/** Scenario of a mandate in the stand-in (`success` for `00` and every unlisted suffix). */
export function vaultSandboxScenarioOf(amountPerPeriod: string): VaultSandboxScenario {
  const suffix = amountPerPeriod.padStart(2, "0").slice(-2) as keyof typeof VAULT_SANDBOX_SCENARIOS;
  return VAULT_SANDBOX_SCENARIOS[suffix] ?? "success";
}

/** Merchant share the stand-in delivers in scenario `94` (0 → nothing delivered, i.e. `collect_failed`). */
export function vaultSandboxPartialShare(merchantShare: bigint): bigint {
  return merchantShare / 2n;
}

// ===== src/internal/billing.ts (stage 4) =====
// stage 4 — autodebit: mandate emails (lld/notify.md §4, lld/billing.md §14)
export const MandateNotificationContext = out({
  ...MerchantFields,
  mandate: id("md"),
  subscription: id("sub"),
  status: MandateStatus,
  link_status: MandateLinkStatus,
  unlinked_reason: MandateUnlinkedReason.nullable().describe("Why it is unlinked (the mail asks the payer to cancel)."),
  payer: NearAccountId.describe("Payer's NEAR account (the mail shows it shortened)."),
  vault_contract: NearAccountId.describe("Vault account."),
  onchain_id: z.int().min(0).describe("Vault mandate id (shown so the payer can cancel from any wallet)."),
  token_asset: PricingAssetDisplay.describe("Display data of the mandate's token (symbol, decimals)."),
  amount_per_period: BaseUnits.describe("Tokens per period."),
  recurring: Recurring.nullable().describe("Billing period of the subscription; null if it no longer exists."),
  balance: BaseUnits.describe("Remaining balance."),
  next_collect_at: Timestamp.nullable().describe("Next due time; null when none."),
  refunded: BaseUnits.nullable().describe("`mandate.canceled`: amount returned to the payer by the cancel."),
  cancel_transaction: NearTransactionRequest.nullable().describe(
    "The payer's `cancel` transaction (contract, method, args, 100 Tgas, 1 yoctoNEAR) while on-chain active; null otherwise.",
  ),
  withdraw_transaction: NearTransactionRequest.nullable().describe(
    "The payer's `withdraw` transaction when a balance remains after cancel/exhaustion; null otherwise.",
  ),
  invoice: id("in")
    .nullable()
    .describe("`mandate.insufficient_funds`: the invoice that fell back to `send_invoice` (it is emailed separately)."),
  manage_url: Url.nullable().describe(
    "Hosted invoice page of the subscription's latest invoice (with its secret) where the payer can top up, cancel or withdraw; null when none. PII-grade: never logged, never in events.",
  ),
}).meta({
  id: "MandateNotificationContext",
  description: "Data for the payer's mandate emails (PII; never in events).",
});

export const getMandateNotificationContext = route({
  id: "getMandateNotificationContext",
  method: "GET",
  path: "/internal/mandates/{id}/notification-context",
  service: "billing",
  visibility: "internal",
  summary: "Data for the mandate emails to the payer (PII and the hosted link; never in events).",
  description:
    "notify calls it for `evt.billing.mandate.activated` (`mandate.activated`), `.insufficient_funds` (`mandate.insufficient_funds`), `.canceled` (`mandate.canceled`), `.unlinked` (`mandate.unlinked`) and `.released` (`mandate.released`). `customer_email: null` → no mail; nothing is sent when the context's `livemode` differs from the event's.",
  auth: ["service:billing.read"],
  idempotent: false,
  params: inp({ id: id("md") }),
  response: MandateNotificationContext,
  status: 200,
  errors: [],
  stage: 4,
});

// ===== src/internal/sandbox.ts (stage 4) =====
// stage 4 — autodebit: sandbox vault stand-in (OQ-T-03, lld/sandbox.md §3.1, §4.2)
const SimVaultTokenAmount = BaseUnits.refine((v) => v !== "0", "must be > 0");

export const sandboxNearRpc = route({
  id: "sandboxNearRpc",
  method: "POST",
  path: "/sim/near-rpc",
  service: "sandbox",
  visibility: "internal",
  summary: "Vault stand-in: NEAR JSON-RPC subset (test-mode `NP_NEAR_RPC_URLS` of billing's keeper).",
  description:
    "Serves `NearRpcRequest` for the stand-in vault account (and NEP-141 `ft_balance_of` / `storage_balance_of` views of the test tokens) with mainnet shapes: `send_tx` / `broadcast_tx_commit` decode the borsh `SignedTransaction`, verify its ed25519 signature over sha256(transaction), require a nonce above the key's last one (keys register on first use, like the simulated Verifier) and execute `collect`, `cancel`, `withdraw`, `storage_deposit`, `storage_withdraw` or `storage_unregister` synchronously by the vault rules (contracts-vault §3.1–§3.8: check orders, `MIN_COLLECT_GAS`/`MIN_EXIT_GAS` from the action's gas, 1 yoctoNEAR, caps, periods, refunds). A vault error is `status.Failure` with `Smart contract panicked: ERR_…`; a success carries the exact `EVENT_JSON` lines (`formatVaultEventLog`) in the vault receipts' logs and `status.SuccessValue` = base64 of the return value. Every receipt with logs is also appended to `GET /sim/intents/events` (with `receipt_id`, `log_index`, `executor_id`). Always HTTP 200 with a JSON-RPC result or error, as NEAR RPC does.",
  auth: SANDBOX_AUTH,
  idempotent: false,
  body: NearRpcRequest,
  response: NearRpcResponse,
  status: 200,
  errors: [],
  stage: 4,
});

export const sandboxVaultFtTransferCall = route({
  id: "sandboxVaultFtTransferCall",
  method: "POST",
  path: "/sim/vault/ft_transfer_call",
  service: "sandbox",
  visibility: "internal",
  summary: "Vault stand-in: the payer's `ft_transfer_call` to the vault (create or top up a mandate).",
  description:
    "Stands in for the payer's wallet (no signature): mints the payer's shortfall of the test token first (like `/sim/intents/transfers`), then runs the token's `ft_transfer_call(receiver_id = vault, amount, msg)` with `payer` as signer and sender: the token receipt (NEP-141 `ft_transfer` log), the vault's `ft_on_transfer` (contracts-vault §3.1 check order; a rejection logs `ERR_…[: detail]` and returns the full amount) and the token's resolve (refund log). `payer` = `intents.near` or the vault is refused with `ERR_UNSUPPORTED_SENDER`, as on chain. Test mode only by construction.",
  auth: SANDBOX_AUTH,
  idempotent: false,
  body: inp({
    payer: NearAccountId.describe(
      "Payer (signer and NEP-141 sender); default for NearPay helpers `sandbox-payer.near`.",
    ),
    token: NearAccountId.describe(
      "Test token contract (one of the stand-in's allowed tokens, or any other to test `ERR_TOKEN_NOT_ALLOWED`).",
    ),
    amount: SimVaultTokenAmount.describe("Amount (base units)."),
    msg: z.string().max(4096).describe("The `msg` exactly as the payer would send it."),
  }),
  response: NearFinalExecutionOutcome,
  status: 200,
  errors: [],
  stage: 4,
});

export const sandboxVaultCall = route({
  id: "sandboxVaultCall",
  method: "POST",
  path: "/sim/vault/call",
  service: "sandbox",
  visibility: "internal",
  summary: "Vault stand-in: an unsigned change call as a named account (payer cancel/withdraw, storage).",
  description:
    "Same execution as a signed `send_tx` for the stand-in vault, without the signature (test helper for simulated payers and merchants). Gas and deposit are taken as given, so `ERR_GAS` and the 1-yocto guard are testable.",
  auth: SANDBOX_AUTH,
  idempotent: false,
  body: inp({
    signer: NearAccountId.describe("Account the call is made as (predecessor and signer)."),
    method: closedEnum(
      ["collect", "cancel", "withdraw", "storage_deposit", "storage_withdraw", "storage_unregister"],
      "Vault method.",
    ),
    args: z.record(z.string(), z.unknown()).describe('JSON arguments (e.g. `{"mandate_id": 7}`).'),
    gas: z
      .string()
      .regex(/^[1-9][0-9]{0,17}$/)
      .optional()
      .describe("Attached gas (default 100 Tgas; `collect` default 250 Tgas)."),
    deposit: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,38})$/)
      .optional()
      .describe("Attached yoctoNEAR (default `1` for cancel/withdraw/storage_withdraw/storage_unregister, else `0`)."),
  }),
  response: NearFinalExecutionOutcome,
  status: 200,
  errors: [],
  stage: 4,
});

export const SimVaultClock = out({
  mandate_id: z.int().min(0).describe("Vault mandate id."),
  clock_offset_secs: z.int().min(0).describe("Total seconds this mandate's clock is ahead of real time."),
  now_ns: z.string().describe("The mandate's clock now (ns)."),
  next_collect_at: z.string().nullable().describe("`next_collect_at` view after the advance (ns)."),
}).meta({ id: "SimVaultClock", description: "A stand-in mandate clock after an advance." });

export const sandboxVaultAdvance = route({
  id: "sandboxVaultAdvance",
  method: "POST",
  path: "/sim/vault/advance",
  service: "sandbox",
  visibility: "internal",
  summary: "Vault stand-in: move one mandate's clock forward (make the next period due).",
  description:
    "Each stand-in mandate has its own forward-only clock offset (like billing's per-subscription test clock), used for its due checks and `next_collect_at`; other mandates and block timestamps are unaffected. `secs` omitted = exactly up to the mandate's `next_collect_at` (no-op when already due). The 86 400 s minimum period is never lowered. billing's `advanceSubscriptionClock` calls it with the same delta for a subscription's linked mandate. Unknown or closed mandate → `404`.",
  auth: SANDBOX_AUTH,
  idempotent: false,
  body: inp({
    mandate_id: z.int().min(0).describe("Vault mandate id."),
    secs: z.int().min(1).max(379_468_800).optional().describe("Seconds to move forward."),
  }),
  response: SimVaultClock,
  status: 200,
  errors: [],
  stage: 4,
});
