/**
 * Configuration (lld/billing.md §8, foundations §13). `*_FILE` variables carry secrets; `secret()` marks the
 * schema object it wraps, so every secret gets a fresh schema (never a shared one). Keys map to
 * `NP_<SNAKE_CASE>` (`payOrigin` ↔ `NP_PAY_ORIGIN`). `NP_ENV` (local|server|test) is required (kit ≥ 0.2.1).
 * Stage 4 adds the vault and the keeper (lld/billing.md v1.7 §8, §15): live mode `NP_VAULT_CONTRACT`,
 * `NP_NEAR_RPC_URLS`, `NP_KEEPER_ACCOUNT`, `NP_KEEPER_KEY_FILE` (secret: a funded NEAR account used only for
 * gas, function-call key for the vault); test mode the sandbox stand-in (`NP_TEST_VAULT_CONTRACT`,
 * `NP_SANDBOX_BASE_URL` → `/sim/near-rpc`, `NP_TEST_KEEPER_ACCOUNT`, optional `NP_TEST_KEEPER_KEY_FILE`).
 */
import { baseConfigShape, list, loadConfig, secret, url } from "@nearpay-internal/service";
import { z } from "zod";

const http = () => url(["http:", "https:"]);
const nearAccount = z
  .string()
  .regex(/^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/, "NEAR account id");
/** Native USDC and USDT on NEAR (the vault's allowed tokens, contracts-vault §2). */
const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const USDT = "usdt.tether-token.near";
const bounded = (min: number, max: number, fallback: number) =>
  z.coerce.number().int().min(min).max(max).default(fallback);

const shared = {
  ...baseConfigShape,
  dbUrl: secret(url(["postgres:", "postgresql:"])),
  identityUrl: http(),
  serviceClientSecret: secret(),
  paymentsUrl: http(),
  railsUrl: http(),
  /** Hosted invoice origin: `<origin>/i/<in_…>#<invoice secret>`. */
  payOrigin: url(["https:", "http:"]).default("https://pay.nearpay.localhost"),
  /** Public API origin (`Invoice.invoice_pdf` links). */
  apiOrigin: url(["https:", "http:"]).default("https://api.nearpay.localhost"),
  /** 32-byte KEK (base64 or hex) for envelope encryption (invoice secret, bill-to, session client secret). */
  piiKek: secret(),
  /** Invoice PDFs: `fs:/<dir>` (a volume; S3 after v1). */
  objectStore: z
    .string()
    .regex(/^fs:\/.+$/, "fs:/<dir> (s3:// arrives after v1)")
    .default("fs:/data/invoices"),
  /** Fiat pricing currencies payments accepts (same list as payments' `NP_PRICING_CURRENCIES`). */
  pricingCurrencies: list(z.string().regex(/^[a-z]{3}$/)).default(["usd", "eur", "gbp", "chf", "jpy", "cad", "aud"]),
  /** Anonymous hosted-invoice session creations per minute: per client network and per invoice. */
  publicSessionsPerClient: bounded(1, 1_000, 10),
  publicSessionsPerInvoice: bounded(1, 10_000, 30),
  // ---- Stage 4: vault and keeper
  /** Mainnet subscription vault (live mode). */
  vaultContract: nearAccount.default("v1.vault.nearpay.near"),
  /** NEAR JSON-RPC providers for live mode, tried in order. */
  nearRpcUrls: list(z.string().url()).default(["https://rpc.mainnet.near.org"]),
  /** Live keeper account (gas only). Without a key the live keeper does not collect (alerted). */
  keeperAccount: nearAccount.optional(),
  keeperKey: secret(z.string().min(1).optional()),
  /** Sandbox (test mode): vault stand-in and the payer simulations. */
  sandboxBaseUrl: http().optional(),
  testVaultContract: nearAccount.default("vault.sandbox.near"),
  /** Test-mode RPC (default `<sandbox>/sim/near-rpc`). */
  testNearRpcUrls: list(z.string().url()).optional(),
  testKeeperAccount: nearAccount.default("keeper.sandbox.near"),
  /** Optional: without it an ephemeral key is generated at boot (the stand-in registers keys on first use). */
  testKeeperKey: secret(z.string().min(1).optional()),
  /** USD stablecoins paid at par (default first) and the vault's allowed tokens (§14 d2). */
  vaultUsdTokens: list(nearAccount).default([USDC, USDT]),
  vaultTokens: list(nearAccount).default([USDC, USDT]),
  vaultMaxFeeBps: bounded(0, 10_000, 500),
  simulatedPayer: nearAccount.default("sandbox-payer.near"),
};

export const apiShape = { ...shared };
export const workerShape = { ...shared, natsUrl: url(["nats:", "tls:"]) };
export const migrateShape = { ...baseConfigShape, dbUrl: secret(url(["postgres:", "postgresql:"])) };

export type SharedConfig = z.output<z.ZodObject<typeof shared>>;
export type ApiConfig = z.output<z.ZodObject<typeof apiShape>>;
export type WorkerConfig = z.output<z.ZodObject<typeof workerShape>>;

export const readApiConfig = (): ApiConfig => loadConfig(apiShape);
export const readWorkerConfig = (): WorkerConfig => loadConfig(workerShape);
