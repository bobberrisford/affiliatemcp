# Sovrn Commerce Adapter

Publisher-side adapter for [Sovrn Commerce](https://www.sovrn.com/commerce/) (formerly VigLink).

See [`docs/networks/sovrn-commerce.md`](../../../docs/networks/sovrn-commerce.md) for setup instructions.

## Status

`claim_status: experimental` — built from public API documentation; not yet verified against a live account.

## Credentials

| Env var              | Purpose                                     |
|----------------------|---------------------------------------------|
| `SOVRN_SECRET_KEY`   | Reporting API authentication (`secret {key}` header) |
| `SOVRN_API_KEY`      | Tracking link construction (`redirect.viglink.com?key=...`) |

## Operations

| Operation              | Status           | Notes                                       |
|------------------------|------------------|---------------------------------------------|
| `listProgrammes`       | Implemented      | Uses `/v1/reports/merchants`                |
| `getProgramme`         | Implemented      | Derived from merchants report               |
| `listTransactions`     | Implemented      | Uses `/v1/reports/transactions` (1 day/call)|
| `getEarningsSummary`   | Implemented      | Derived from `listTransactions`             |
| `listClicks`           | NotImplemented   | No individual click-stream API              |
| `generateTrackingLink` | Implemented      | Deterministic `redirect.viglink.com` URL    |
| `verifyAuth`           | Implemented      | Probes `/v1/reports/merchants`              |
