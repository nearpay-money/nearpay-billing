# nearpay-billing

> Products, prices, manual tax rates, invoices, subscriptions, dunning, and the vault keeper for auto-debit mandates. A client of payments.

| | |
|---|---|
| Group | Services |
| Kind | service |
| Ships as | image: ghcr.io/nearpay-money/billing · routes /v1/products, /v1/prices, /v1/invoices, /v1/subscriptions, /v1/mandates |
| Owns | Product, Price, TaxRate, Invoice, Subscription, Mandate (mirror) |
| Depends on (published artifacts only) | spec, kit, payments, notify, NEAR RPC |
| Roadmap phase | P2 Refunds, billing, agents |

## Documentation

This repo stays surgical: design docs live in [`nearpay-brain`](../nearpay-brain/README.md), not here.

- `nearpay-brain/architecture/hld.md` — system design
- `nearpay-brain/architecture/repositories.md` — repo topology and dependency rules
- `nearpay-brain/decisions/ADR-0008-subscriptions.md`
- `nearpay-brain/architecture/flows.md#5-invoice-and-send_invoice-subscription-renewal`

## Layout

```
nearpay-billing/
├── migrations/
├── src/
│   ├── api/
│   ├── app/
│   ├── consumers/
│   ├── domain/
│   │   ├── dunning/
│   │   ├── invoice/
│   │   ├── mandate/
│   │   ├── price/
│   │   ├── product/
│   │   ├── subscription/
│   │   └── tax-rate/
│   ├── infra/
│   │   ├── bus/
│   │   ├── clients/
│   │   └── db/
│   ├── keeper/
│   ├── scheduler/
│   └── workers/
├── templates/
│   └── invoice-pdf/
├── test/
│   ├── contract/
│   ├── integration/
│   ├── property/
│   └── unit/
└── .github/
    └── workflows/
```

## Status

Scaffold only. Implementation starts in phase **P2 Refunds, billing, agents** (`nearpay-brain/roadmap/roadmap.md`).
