/**
 * Configuration (lld/billing.md §8, foundations §13). `*_FILE` variables carry secrets; `secret()` marks the
 * schema object it wraps, so every secret gets a fresh schema (never a shared one). Keys map to
 * `NP_<SNAKE_CASE>` (`payOrigin` ↔ `NP_PAY_ORIGIN`). `NP_ENV` (local|server|test) is required (kit ≥ 0.2.1).
 * Stage 4 adds the keeper (`NP_VAULT_CONTRACT`, `NP_KEEPER_ACCOUNT`, `NP_KEEPER_KEY_FILE`, `NP_NEAR_RPC_URLS`).
 */
import { baseConfigShape, list, loadConfig, secret, url } from "@nearpay-internal/service";
import { z } from "zod";

const http = () => url(["http:", "https:"]);
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
  /** 32-byte KEK (base64 or hex) for envelope encryption (invoice secret, bill-to, session client secret). */
  piiKek: secret(),
  /** Invoice PDFs: `fs:/data/invoices` (local) or `s3://bucket/prefix` (server). */
  objectStore: z
    .string()
    .regex(/^(fs:\/.+|s3:\/\/.+)$/, "fs:/<dir> or s3://<bucket>/<prefix>")
    .default("fs:/data/invoices"),
  /** Fiat pricing currencies payments accepts (same list as payments' `NP_PRICING_CURRENCIES`). */
  pricingCurrencies: list(z.string().regex(/^[a-z]{3}$/)).default(["usd", "eur", "gbp", "chf", "jpy", "cad", "aud"]),
  /** Anonymous hosted-invoice session creations per minute: per client network and per invoice. */
  publicSessionsPerClient: bounded(1, 1_000, 10),
  publicSessionsPerInvoice: bounded(1, 10_000, 30),
};

export const apiShape = { ...shared };
export const workerShape = { ...shared, natsUrl: url(["nats:", "tls:"]) };
export const migrateShape = { ...baseConfigShape, dbUrl: secret(url(["postgres:", "postgresql:"])) };

export type SharedConfig = z.output<z.ZodObject<typeof shared>>;
export type ApiConfig = z.output<z.ZodObject<typeof apiShape>>;
export type WorkerConfig = z.output<z.ZodObject<typeof workerShape>>;

export const readApiConfig = (): ApiConfig => loadConfig(apiShape);
export const readWorkerConfig = (): WorkerConfig => loadConfig(workerShape);
