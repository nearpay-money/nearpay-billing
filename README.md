# nearpay-billing

> Products, prices, manual tax rates, invoices, subscriptions, dunning, and the vault keeper for auto-debit mandates. A client of payments.

|                                       |                                                                                                                                                |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Group                                 | Services                                                                                                                                       |
| Kind                                  | service                                                                                                                                        |
| Ships as                              | image: ghcr.io/nearpay-money/billing · routes /v1/products, /v1/prices, /v1/tax_rates, /v1/invoices, /v1/subscriptions (Stage 4: /v1/mandates) |
| Owns                                  | Product, Price, TaxRate, Invoice, Subscription, Mandate (mirror, Stage 4)                                                                      |
| Depends on (published artifacts only) | spec, kit, payments, identity, rails, notify (via events)                                                                                      |
| First built in                        | Stage 3 (step 3.2)                                                                                                                             |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

- `nearpay-brain/lld/billing.md` — **low-level design (dev-ready; implement from this)**
- `nearpay-brain/lld/audits/billing.md` — audit findings already folded into the LLD
- `nearpay-brain/roadmap/development-plan.md` — stage and step this repo is built in
- `nearpay-brain/architecture/hld.md` — system design
- `nearpay-brain/architecture/repositories.md` — repo topology and dependency rules
- `nearpay-brain/decisions/ADR-0008-subscriptions.md`
- `nearpay-brain/architecture/flows.md#5-invoice-and-send_invoice-subscription-renewal`

## Run

```sh
pnpm install                     # @nearpay* from the local registry (.npmrc, port 4873)
pnpm typecheck && pnpm lint && pnpm test   # unit + property tests (no Docker)
pnpm test:integration            # Testcontainers: Postgres, NATS, Valkey (needs Docker)
pnpm verify                      # everything CI runs, incl. coverage gate and build
pnpm build && node dist/main.js api|worker|migrate|healthcheck
```

Processes (`lld/billing.md` §2): `api` (merchant, hosted-invoice and internal routes, 2 replicas), `worker`
(payments-event consumers, renewal/dunning/PDF jobs, outbox relay), `migrate` (one-shot, kit + `migrations/`).

Ports: `8080` HTTP (`/healthz`, `/readyz`, routes), `9464` Prometheus metrics (`NP_PORT`, `NP_METRICS_PORT`).

## Configuration

Secrets come only from `NP_<NAME>_FILE` (Docker secrets); everything else from `NP_<NAME>`.

| Variable                                                                                   | Process     | Notes                                                                                 |
| ------------------------------------------------------------------------------------------ | ----------- | ------------------------------------------------------------------------------------- |
| `NP_ENV`                                                                                   | all         | **required**: `local`, `server` or `test` (no default; kit ≥ 0.2.1)                   |
| `NP_LOG_LEVEL`, `NP_HOST`, `NP_PORT`, `NP_METRICS_PORT`, `NP_OTEL_ENDPOINT`, `NP_JWKS_URL` | all         | kit base config (`info`, `0.0.0.0`, `8080`, `9464`)                                   |
| `NP_DB_URL_FILE`                                                                           | all         | Postgres URL (billing's own database)                                                 |
| `NP_IDENTITY_URL`, `NP_SERVICE_CLIENT_SECRET_FILE`                                         | api, worker | service token (`billing`), settlement context (merchant name, destinations)           |
| `NP_PAYMENTS_URL`                                                                          | api, worker | internal invoice sessions and customers                                               |
| `NP_RAILS_URL`                                                                             | api, worker | asset display data (symbol, decimals)                                                 |
| `NP_NATS_URL`                                                                              | worker      | JetStream (events in and out)                                                         |
| `NP_PAY_ORIGIN`                                                                            | api, worker | hosted invoice `<origin>/i/<in_…>#<secret>` (default `https://pay.nearpay.localhost`) |
| `NP_API_ORIGIN`                                                                            | api, worker | public API origin for `Invoice.invoice_pdf` (default `https://api.nearpay.localhost`) |
| `NP_PII_KEK_FILE`                                                                          | api, worker | 32-byte KEK for envelope encryption (invoice secret, bill-to, client secret)          |
| `NP_OBJECT_STORE`                                                                          | api, worker | invoice PDFs: `fs:/data/invoices` (default; a volume — S3 after v1)                   |
| `NP_PRICING_CURRENCIES`                                                                    | api         | fiat pricing currencies (comma list, same as payments)                                |
| `NP_PUBLIC_SESSIONS_PER_CLIENT`, `NP_PUBLIC_SESSIONS_PER_INVOICE`                          | api         | hosted-page session creations per minute (10, 30)                                     |

Stage 4 (auto-debit, `lld/billing.md` v1.11 §8, §15 d14): live vault `NP_VAULT_CONTRACT` (`v1.vault.nearpay.near`),
`NP_NEAR_RPC_URLS`, keeper `NP_KEEPER_ACCOUNT` + `NP_KEEPER_KEY_FILE` (secret file; a funded NEAR account used only for
gas, function-call key for the vault — a full-access key is refused; without it the live keeper does not collect);
test mode `NP_SANDBOX_BASE_URL` (the vault stand-in, `/sim/near-rpc`), `NP_TEST_VAULT_CONTRACT`
(`vault.sandbox.near`), `NP_TEST_KEEPER_ACCOUNT`, optional `NP_TEST_KEEPER_KEY_FILE`; `NP_VAULT_USD_TOKENS`,
`NP_VAULT_TOKENS` (USDC, USDT), `NP_VAULT_MAX_FEE_BPS` (500), `NP_SIMULATED_PAYER` (`sandbox-payer.near`).

## Layout

```
nearpay-billing/
├── migrations/            forward-only SQL (0001_billing, 0002_test_clock, 0003_mandates)
├── src/
│   ├── api/               spec routes → use cases
│   ├── app/               use cases + ports (ports.ts), one transaction per change (commit.ts)
│   ├── consumers/         payments events → app/payment-events.ts
│   ├── domain/            pure rules: dunning, invoice, mandate (mirror, terms, funding, keeper), price, product, subscription, tax-rate
│   ├── infra/             Postgres, peers (payments, identity, rails, sandbox), NEAR RPC + keeper signer, object store, PDF
│   ├── keeper/            the vault keeper (`mandate.collect`)
│   ├── scheduler/         recurring jobs
│   └── workers/           job kinds → use cases
├── templates/invoice-pdf/
└── test/                  unit, property, integration, contract
```

## Status

Stage 3 (step 3.2): products, prices, tax rates, invoices (hosted page, PDF), `send_invoice` subscriptions and
dunning are implemented against `@nearpay/spec` 0.3.0 (kit 0.2.1), test clock on 0.3.1.

Stage 4 (step 4.2, auto-debit) — Phase A: mandates mirrored from vault events (linkage rule, parking), prepare /
cancel / hosted funding / payer view, test helpers on the sandbox stand-in, the keeper, release and amount lock,
built against the spec 0.4.0 source (`src/spec-0.4.0.ts`, a verbatim placeholder removed with the bump). Route and
consumer bindings, the NATS integration suite and the contract test follow with `@nearpay/spec` 0.4.0.

## Built with

Libraries (hackathon rule Q-005): `@nearpay/spec`, `@nearpay-internal/*` (kit), `kysely`, `zod`; tests:
`vitest`, `fast-check`, `testcontainers`; tooling: `typescript`, `@biomejs/biome`. Code and documentation are
written with AI assistance (Claude) under human direction and review.
