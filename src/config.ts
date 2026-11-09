/**
 * Configuration (lld/billing.md §8, foundations §13). `*_FILE` variables carry secrets; `secret()` marks the
 * schema object it wraps, so every secret gets a fresh schema (never a shared one). Keys map to
 * `NP_<SNAKE_CASE>` (`payOrigin` ↔ `NP_PAY_ORIGIN`). `NP_ENV` (local|server|test) is required (kit ≥ 0.2.1).
 * Stage 4 adds the vault and the keeper (lld/billing.md v1.7 §8, §15): live mode `NP_VAULT_CONTRACT` (optional,
 * no default: unset = live auto-debit off), `NP_NEAR_RPC_URLS`, `NP_KEEPER_ACCOUNT`, `NP_KEEPER_KEY_FILE` (secret:
 * a funded NEAR account used only for gas, function-call key for the vault); test mode the sandbox stand-in
 * (`NP_TEST_VAULT_CONTRACT`, `NP_SANDBOX_BASE_URL` → `/sim/near-rpc`, `NP_TEST_KEEPER_ACCOUNT`, optional
 * `NP_TEST_KEEPER_KEY_FILE`).
 */

import { baseConfigShape, list, loadConfig, secret, url } from "@nearpay-internal/service";
import { z } from "zod";
import { CLIENT_IP_HEADERS, clientIpRule } from "./domain/client-ip.js";

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
  /** Client IP source behind the gateway (default: cf-connecting-ip on the server stage, x-forwarded-for locally). */
  clientIpHeader: z.enum(CLIENT_IP_HEADERS).optional(),
  /** CIDRs of the proxies in front of billing whose forwarding headers count (default: loopback + private ranges). */
  trustedProxies: list(z.string().min(1)).optional(),
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
  /**
   * Mainnet subscription vault (live mode): the owner-controlled account the vault was deployed to (mainnet
   * checklist A.4). No default — a guessed name could be an account someone else controls, and payers would
   * fund mandates there. Unset (or empty) → live auto-debit is off: live funding and `auto_debit` are refused
   * (`auto_debit_unavailable`), the live keeper does not collect, live vault events are parked.
   */
  vaultContract: nearAccount.optional(),
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

/**
 * Server-stage rules (every NP_ENV but local/test): hosted invoice and PDF links use public https origins (never a
 * `*.localhost` default left in place by a missing variable); the client-IP proxy list parses.
 */
export function checkServerConfig<
  C extends Pick<SharedConfig, "env" | "payOrigin" | "apiOrigin" | "clientIpHeader" | "trustedProxies">,
>(c: C): C {
  clientIpRule(c.env, { header: c.clientIpHeader, trustedProxies: c.trustedProxies });
  if (c.env === "local" || c.env === "test") return c;
  for (const [name, value] of [
    ["NP_PAY_ORIGIN", c.payOrigin],
    ["NP_API_ORIGIN", c.apiOrigin],
  ] as const) {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.hostname === "localhost" || u.hostname.endsWith(".localhost"))
      throw new Error(`${name} must be a public https origin on the server stage (got ${value})`);
  }
  return c;
}

export const readApiConfig = (): ApiConfig => checkServerConfig(loadConfig(apiShape));
export const readWorkerConfig = (): WorkerConfig => checkServerConfig(loadConfig(workerShape));
