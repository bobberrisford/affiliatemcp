# Commission Factory (advertiser)

[![Maintainer: seeking](https://img.shields.io/badge/maintainer-seeking%20a%20network%20owner-orange)](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3A%22network%3Acommission-factory%22)

Brand/merchant-side adapter for Commission Factory. Read-only at v0.1: the
adapter reports on your merchant account's transactions and promotions and never
issues a write. Built from the public API documentation and not yet verified
against a live merchant account.

- API documentation: https://dev.commissionfactory.com/V1/ (Merchant account
  functions and types)
- Base URL: `https://api.commissionfactory.com/V1/`
- Auth model: `custom` (an `apiKey` query parameter on every request)

## Prerequisites

- A Commission Factory **merchant** (advertiser) account.
- Permission to generate an API key under that account's settings.
- No approval step: the key is self-issued and works immediately.

## Credentials needed

### `COMMISSION_FACTORY_ADVERTISER_API_KEY` (required)

Your merchant API key. Generate it yourself in the Commission Factory dashboard:

1. Sign in to the Commission Factory dashboard with your merchant account.
2. Open **Account Settings → API**.
3. Generate (or copy) the API key.

The key is sent as the `apiKey` query parameter on every request. There is no
OAuth flow and no bearer header. This adapter only ever issues GET requests; the
HTTP client refuses any other method.

### `COMMISSION_FACTORY_ADVERTISER_MERCHANT_ID` (optional)

The merchant key already scopes data to a single merchant, so this is not needed
to address the API. Provide it only if you want a stable brand identifier and
display label for `listBrands` and the brand resolver. Leave it blank to let the
adapter derive the merchant identity (`MerchantId` / `MerchantName`) from a
sample transaction.

## Setup steps

1. Run the wizard:

   ```
   affiliate-networks-mcp setup commission-factory-advertiser
   ```

2. Paste the merchant API key when prompted. The wizard probes
   `GET /Merchant/Transactions` over a one-day window to confirm the key is
   accepted.
3. Optionally supply the merchant id, or leave it blank.

## Brands

Commission Factory issues one API key per merchant Account Settings, and the
merchant API surface has no "list my accounts" endpoint. `listBrands()`
therefore returns a **single** brand: the merchant the key addresses. Its
`networkBrandId` and display name come from
`COMMISSION_FACTORY_ADVERTISER_MERCHANT_ID` when set, otherwise from a sample
transaction's `MerchantId` / `MerchantName`.

The adapter still declares `credential_scope: multi-brand` so it behaves
uniformly with the other advertiser adapters: advertiser tools take a `brand`
argument, which the resolver translates to a `networkBrandId` via
`~/.affiliate-mcp/brands.json`. After setup, bind your merchant as a brand in
`brands.json` so the brand-scoped tools can address it.

## Operations

| Operation | Backed by |
| --- | --- |
| `listBrands` | Single merchant entry (hint or sample transaction) |
| `verifyAuth` | `GET /Merchant/Transactions` (1-day probe) |
| `listProgrammes` | `GET /Merchant/Promotions` |
| `listTransactions` | `GET /Merchant/Transactions` |
| `getProgrammePerformance` | `GET /Merchant/Transactions`, rolled up per affiliate |

`getProgramme`, `getEarningsSummary`, `listClicks` and `generateTrackingLink`
throw `NotImplementedError` at v0.1.

## Common failures

- **`config_error: Missing required credential COMMISSION_FACTORY_ADVERTISER_API_KEY`** —
  the key is not in `~/.affiliate-mcp/.env`. Re-run setup or set it manually.
- **`auth_error` (HTTP 401/403)** — the key is wrong, has been revoked, or was
  copied with surrounding whitespace. Regenerate it under Account Settings → API.
- **`config_error: ... requires a brand context (networkBrandId)`** — a
  brand-scoped tool was called without a resolved `brand`. Bind the merchant in
  `brands.json` and pass `brand` to the tool.
- **Empty performance rollup** — there were no merchant transactions in the
  requested window. Widen the date range.

## Known limitations

- Adapter built from public API documentation; not yet verified against a live
  account.
- Read-only at v0.1. The adapter refuses any non-GET HTTP method client-side.
- A merchant API key addresses exactly one merchant; `listBrands()` returns a
  single brand. `credential_scope` is declared multi-brand for uniformity with
  the other advertiser adapters.
- `getProgrammePerformance` is a client-side per-publisher rollup of
  `GET /Merchant/Transactions` grouped by `AffiliateId`. Clicks are not reported
  on the merchant transactions surface, so per-row `clicks` is always 0.
- Pagination parameters for `GET /Merchant/Transactions` are not documented
  publicly; the adapter requests the full date window in a single call. This
  needs confirmation against a live account.

## Verifying

```
affiliate-networks-mcp test commission-factory-advertiser
```

This runs the capability checks. Because the adapter is unverified against a
live account, the operations are reported as `experimental`.
