# Tradedoubler API Research Findings

**Date:** 2026-05-28  
**Status:** Built from public API documentation; live verification pending credentials.

## Summary

The Tradedoubler adapter was built from public documentation sources without access to a live
account. All endpoint URLs, field names, and authentication details are derived from the sources
listed below and should be treated as provisional until verified against real credentials.

## Authentication Model

Tradedoubler operates **two distinct API surfaces** with different authentication schemes:

1. **connect.tradedoubler.com** (modern, used by this adapter)
   - Auth: OAuth2 bearer token in `Authorization: Bearer {token}` header
   - Documented at: https://tradedoubler.docs.apiary.io/
   - Endpoints: `/publisher/programs`, `/publisher/report/transactions`, `/usermanagement/users/me`, etc.

2. **api.tradedoubler.com** (legacy/per-product, NOT used by this adapter)
   - Auth: Token as `?token={sha1_hash}` query parameter
   - Separate per-product tokens: PRODUCTS, CONVERSIONS, VOUCHERS
   - Documented at: https://dev.tradedoubler.com/

This adapter targets surface (1). Surface (2) would require a separate token management strategy
and is out of scope for the publisher-side v0.1 adapter.

## Documentation Sources Used

| Source | URL | Reliability |
|--------|-----|-------------|
| Tradedoubler Publisher Management API (Apiary) | https://tradedoubler.docs.apiary.io/ | High (official) |
| Tradedoubler API Blueprint source | https://github.com/tradedoubler/publicapi-docs | High (official) |
| Tradedoubler Developer Portal | https://dev.tradedoubler.com/ | High (official) |
| Tradedoubler Link Converter docs | https://dev.tradedoubler.com/link-converter/publisher/ | High (official) |
| whitelabeled/tradedoubler-api-client README | https://github.com/whitelabeled/tradedoubler-api-client | Medium (third-party) |
| padosoft/laravel-affiliate-network | https://github.com/padosoft/laravel-affiliate-network | Medium (third-party) |

## Key Findings

### Programmes API
- Endpoint: `GET /publisher/programs` with pagination (`offset`, `limit`, max 100).
- Status values from Apiary: JOINED, NOT_JOINED, APPLIED, DECLINED, TERMINATED.
- Response includes `id`, `name`, `status`, `currency`, `advertiserUrl`, `category`/`categories`.
- Single programme: `GET /publisher/programs/detail?programId={id}` returns tariffs and default tracking link.

### Transactions API
- Endpoint: `GET /publisher/report/transactions` with `fromDate`/`toDate` (YYYYMMDD format).
- Status codes: `A` (Accepted), `P` (Pending), `D` (Denied) — confirmed from Apiary docs.
- Response fields confirmed from Apiary + whitelabeled client:
  `transactionId`, `programId`, `status`, `statusReason`, `commission`, `orderValue`,
  `timeOfTransaction`, `timeOfLastModified`, `orderNr`, `clickDate`, `epi1`, `epi2`.
- `reasonId`/`reasonName` added 2022-06-01 (per Apiary changelog).
- `paid` field: presence and type (`boolean`) NOT confirmed from docs — marked `// TODO(verify)`.

### Tracking Links
- Format confirmed from Tradedoubler tracking documentation:
  `https://clk.tradedoubler.com/click?p={programId}&a={siteId}&url={encodedUrl}`
- Both `clk.tradedoubler.com` and `clkuk.tradedoubler.com` are valid domains.
- `p` (program ID) and `a` (site/affiliate ID) are mandatory; `url` must be last.

### Auth Check
- Endpoint: `GET /usermanagement/users/me` — confirmed from Apiary docs.
- Returns user ID, email, first/last name, organisationId.
- `organisationId` field name not confirmed against live account — marked `// TODO(verify)`.

## Fields Marked TODO(verify)

The following fields require live account testing to confirm:

| Field | Location | Issue |
|-------|----------|-------|
| `paid` field (boolean) | TdTransactionRaw | Existence and type not confirmed in docs |
| `organisationId` vs `organizationId` | TdUserMe | Spelling variant not confirmed |
| `currency` vs `currencyCode` vs `currency3Code` | TdProgrammeRaw, TdTransactionRaw | Multiple potential field names |
| `programName` vs `name` | TdProgrammeRaw | Alternate field names in programmes response |
| `commissionMin`/`commissionMax` | TdProgrammeRaw | Commission field names not fully confirmed |
| `categories` shape | TdProgrammeRaw | Whether array of strings or objects |
| `siteId` vs `orgId` for tracking `a=` param | generateTrackingLink | Multi-site publisher disambiguation |
| Date format in responses | TdTransactionRaw | ISO 8601 vs Unix timestamp for timeOfTransaction |

## Limitations Discovered During Research

1. The `dev.tradedoubler.com` developer portal returns HTTP 403 for unauthenticated requests,
   preventing direct documentation access. Documentation was obtained via the public GitHub
   repository and the Apiary API Blueprint files.

2. Click-level data is confirmed NOT available via the publisher API; only aggregated statistics
   are exposed via `GET /publisher/report/statistics`.

3. The `api.tradedoubler.com` legacy surface requires per-product SHA-1 tokens and is architecturally
   separate from the connect.tradedoubler.com bearer-token surface. The two surfaces cannot share
   credentials.

4. Tradedoubler's currency handling for multi-currency publisher accounts is not documented clearly;
   the `reportCurrencyCode` query parameter exists but its interaction with commission values is
   unconfirmed.
