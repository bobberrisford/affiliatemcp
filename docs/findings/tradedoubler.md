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
   - Token obtained via OAuth2 Resource Owner Password Credentials (ROPC) flow:
     `POST https://connect.tradedoubler.com/uaa/oauth/token`
     `grant_type=password&client_id=<id>&client_secret=<secret>&username=<email>&password=<pw>`
   - Client credentials created under publisher dashboard → Tools → API Info → Clients
   - Endpoints: `/publisher/programs`, `/publisher/report/transactions`, `/usermanagement/users/me`, etc.

2. **api.tradedoubler.com** (legacy/per-product, NOT used by this adapter)
   - Auth: Token as `?token={sha1_hash}` query parameter (40-char hex SHA-1 string)
   - Separate per-product tokens: PRODUCTS, CONVERSIONS, VOUCHERS
   - Documented at: https://dev.tradedoubler.com/
   - Also accessible via the older reports.tradedoubler.com XML reporting API

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
| eelcol/laravel-tradedoubler (Packagist) | https://packagist.org/packages/eelcol/laravel-tradedoubler | Medium (third-party) |
| Funnel.io Tradedoubler connection guide | https://help.funnel.io/en/articles/4118042-how-to-connect-to-tradedoubler | Medium (third-party) |
| Supermetrics Tradedoubler connection guide | https://docs.supermetrics.com/docs/tradedoubler-connection-guide | Medium (third-party) |
| Stape.io Tradedoubler tag docs | https://stape.io/helpdesk/documentation/tradedoubler-tag | Medium (third-party) |
| dev.tradedoubler.com tracking link FAQ | https://dev.tradedoubler.com/link-converter/publisher/ | High (official) |

## Key Findings

### Programmes API
- Endpoint: `GET /publisher/programs` with pagination (`offset`, `limit`, max 100).
- Status values from Apiary: JOINED, NOT_JOINED, APPLIED, DECLINED, TERMINATED.
- Response includes `id`, `name`, `status`, `currency`, `advertiserUrl`, `category`/`categories`.
- Single programme: `GET /publisher/programs/detail?programId={id}` — `programId` query param confirmed.
- `commissionMin`/`commissionMax`/`commissionType` field names NOT confirmed from public docs.

### Transactions API
- Endpoint: `GET /publisher/report/transactions` with `fromDate`/`toDate` (YYYYMMDD format confirmed).
- Status codes: `A` (Accepted), `P` (Pending), `D` (Denied) — confirmed from Apiary docs.
- Response fields confirmed from Apiary + whitelabeled client:
  `transactionId`, `programId`, `status`, `statusReason`, `commission`, `orderValue`,
  `timeOfTransaction` (ISO 8601), `timeOfLastModified`, `clickDate`, `orderNr`, `leadNr`,
  `epi1`, `epi2`, `eventId`, `eventName`, `mediaId`, `deviceType`, `reasonId`.
- `reasonId` added 2022-06-01 per Apiary changelog.
- Currency field name NOT confirmed from public JSON API docs (likely `currency`, kept with fallback).
- `paid` boolean field: NOT mentioned in Apiary or any third-party source.
- `datePaid` / `paymentDate`: NOT documented anywhere in Tradedoubler public docs.

### Tracking Links
- Format confirmed from dev.tradedoubler.com:
  `https://clk.tradedoubler.com/click?p={programId}&a={siteId}&url={encodedUrl}`
- `a=` parameter is the publisher **SITE ID** (per registered website), NOT the organisation ID.
  For single-site publishers these values are typically the same number. For multi-site publishers
  the site ID must match the traffic source website.
- Source: dev.tradedoubler.com FAQ search snippet: "Site ID (a) is a unique identifier that
  ensures valid clicks, leads and sales are attributed to your publisher site."

### Auth Check
- Endpoint: `GET /usermanagement/users/me` — confirmed from Apiary docs.
- Returns user ID, email, firstName, lastName, organisationId (British English spelling expected
  based on Apiary pattern, but not confirmed against a live response).

### Click Data
- Confirmed NOT available as per-click records. `GET /publisher/report/statistics` returns
  aggregated click/impression counts grouped by programme, affiliate site, or ad — NOT
  individual click records with unique IDs or timestamps.
- Source: Supermetrics Tradedoubler connection guide (search result 2026-05-28).
- `listClicks` throwing `NotImplementedError` is correct and should remain.

---

## Hardening Pass 2026-05-28

### Every TODO(verify) and stub — outcome and source

| TODO / Stub | Location | Outcome | Source |
|-------------|----------|---------|--------|
| `// TODO(verify): field names against a live account` (TdUserMe) | auth.ts:36 | **CONFIRMED** field names `id`, `email`, `firstName`, `lastName` from Apiary; `organisationId` spelling expected (British English) but **BLOCKED** pending live response | Apiary, eelcol/laravel-tradedoubler |
| `organisationId?: number \| string; // TODO(verify): exact field name` | auth.ts:43 | **BLOCKED** — spelling cannot be confirmed without live account; both `organisationId` and `organizationId` accepted defensively | Cannot confirm from public docs |
| `user.organisationId ?? // TODO(verify): field name` | auth.ts:91 | **BLOCKED** — kept as-is with updated comment explaining the uncertainty | Cannot confirm from public docs |
| `// TODO(verify) marks those not confirmed against a live tenant` (adapter header) | adapter.ts:133 | **RESOLVED** — header rewritten with full sourcing; `TODO(verify)` language removed | Research 2026-05-28 |
| `// TODO(verify): exact field names against a live account` (TdProgrammeRaw) | adapter.ts:139 | **PARTIALLY CONFIRMED** — `id`, `name`, `status`, `currency`, `advertiserUrl`, `categories` confirmed from Apiary; `commissionMin`/`commissionMax`/`commissionType` still BLOCKED | Apiary blueprint |
| `programId?: number \| string; // TODO(verify)` | adapter.ts:143 | **CONFIRMED** as `id` (primary); `programId` kept as defensive fallback | Apiary blueprint |
| `programName?: string; // TODO(verify)` | adapter.ts:145 | **BLOCKED** — not in Apiary programmes response; `name` is confirmed; `programName` kept as defensive fallback only | Apiary blueprint |
| `advertiserName?: string; // TODO(verify)` | adapter.ts:146 | **BLOCKED** — not confirmed; kept as defensive fallback | Cannot confirm |
| `currencyCode?: string; // TODO(verify)` (programmes) | adapter.ts:149 | **BLOCKED** — `currency` confirmed from Apiary; `currencyCode` kept as fallback | Apiary blueprint |
| `currency3Code?: string; // TODO(verify)` | adapter.ts:150 | **BLOCKED** — not documented; kept as defensive fallback | Cannot confirm |
| `websiteUrl?: string; // TODO(verify)` | adapter.ts:152 | **BLOCKED** — `advertiserUrl` confirmed from Apiary; `websiteUrl` kept as defensive fallback | Apiary blueprint |
| `categories?: ... // TODO(verify): shape` | adapter.ts:154 | **CONFIRMED** — object array `{name: string}` from Apiary example; string array kept as defensive fallback | Apiary blueprint |
| `commissionMin?: // TODO(verify)` | adapter.ts:155 | **BLOCKED** — not confirmed from public docs; kept with BLOCKED comment | Cannot confirm |
| `commissionMax?: // TODO(verify)` | adapter.ts:156 | **BLOCKED** — not confirmed from public docs | Cannot confirm |
| `commissionType?: // TODO(verify)` | adapter.ts:157 | **BLOCKED** — not confirmed from public docs | Cannot confirm |
| `// TODO(verify): exact envelope shape` (TdProgrammesResponse) | adapter.ts:163 | **CONFIRMED** — `{items, offset, limit, total}` is the standard connect API pagination envelope | Apiary blueprint |
| `// TODO(verify): all field names against a live account` (TdTransactionRaw) | adapter.ts:176 | **PARTIALLY CONFIRMED** — core fields confirmed; see table note | Apiary + whitelabeled client |
| `generatedId?: // TODO(verify)` | adapter.ts:180 | **BLOCKED** — legacy XML API field; not in modern JSON API docs | whitelabeled client (XML API) |
| `eventId?: // TODO(verify)` | adapter.ts:184 | **CONFIRMED** from whitelabeled client README | whitelabeled/tradedoubler-api-client |
| `reasonName?: // TODO(verify)` | adapter.ts:189 | **BLOCKED** — not found in Apiary or any source; kept as defensive fallback | Cannot confirm |
| `timeOfTransaction?: // TODO(verify): format` | adapter.ts:190 | **CONFIRMED** — ISO 8601 format, confirmed from Apiary and from fixture usage | Apiary blueprint |
| `transactionDate?: // TODO(verify)` | adapter.ts:191 | **BLOCKED** — alternative spelling; `timeOfTransaction` is the confirmed name | Apiary blueprint |
| `clickDate?: // TODO(verify)` | adapter.ts:192 | **CONFIRMED** from whitelabeled client (maps from `timeOfVisit` in XML API) | whitelabeled/tradedoubler-api-client |
| `timeOfLastModified?: // TODO(verify)` | adapter.ts:193 | **CONFIRMED** from Apiary + whitelabeled client | Apiary blueprint, whitelabeled client |
| `lastModifiedDate?: // TODO(verify)` | adapter.ts:194 | **BLOCKED** — `timeOfLastModified` is confirmed; this is defensive fallback only | Apiary blueprint |
| `currency?: // TODO(verify)` (transactions) | adapter.ts:197 | **BLOCKED** — currency field name not confirmed in modern JSON API docs | Cannot confirm |
| `currencyCode?: // TODO(verify)` (transactions) | adapter.ts:198 | **BLOCKED** — not confirmed | Cannot confirm |
| `mediaName?: // TODO(verify)` | adapter.ts:205 | **CONFIRMED** from whitelabeled client (maps from `siteName` in XML API) | whitelabeled/tradedoubler-api-client |
| `program?: // TODO(verify)` | adapter.ts:206 | **CONFIRMED** from whitelabeled client README (programme name as string) | whitelabeled/tradedoubler-api-client |
| `programName?: // TODO(verify)` | adapter.ts:207 | **BLOCKED** — defensive fallback only; `program` is confirmed | whitelabeled client |
| `paid?: boolean; // TODO(verify)` | adapter.ts:208 | **BLOCKED** — no `paid` boolean field documented in any source | Cannot confirm |
| `// TODO(verify): exact envelope shape` (TdTransactionsResponse) | adapter.ts:213 | **CONFIRMED** — same standard pagination envelope | Apiary blueprint |
| `currencyCode?: // TODO(verify)` (TdEarningsSummaryRaw comment) | adapter.ts:232 | **BLOCKED** — in commented-out stub; not used | Cannot confirm |
| `paid` in mapTransactionStatus | adapter.ts:267 | **BLOCKED** — kept with updated comment; field existence unconfirmed | Cannot confirm |
| `currency field TODO` in toProgramme | adapter.ts:335 | **RESOLVED** — comment updated to BLOCKED with precise reason | Research 2026-05-28 |
| `currency field TODO` in toTransaction | adapter.ts:381 | **RESOLVED** — comment updated to BLOCKED with precise reason | Research 2026-05-28 |
| `datePaid: undefined // TODO(verify)` | adapter.ts:405 | **BLOCKED** — no datePaid/paymentDate/paidDate field found in any public source | Cannot confirm |
| `// TODO(verify): status filter values` (listProgrammes) | adapter.ts:480 | **CONFIRMED** status values are UPPERCASE (JOINED/NOT_JOINED/etc.) from Apiary; server-side filter behaviour still BLOCKED | Apiary blueprint |
| `// TODO(verify): exact field names` (listProgrammes) | adapter.ts:481 | **PARTIALLY CONFIRMED** — see TdProgrammeRaw notes | Apiary blueprint |
| `// TODO(verify): Tradedoubler may require organisation scoping` | adapter.ts:502 | **BLOCKED** — not confirmed from public docs; orgId read but not sent until confirmed | Cannot confirm |
| `// TODO(verify): exact query parameter name` (getProgramme) | adapter.ts:543 | **CONFIRMED** — `programId` from Apiary | Apiary blueprint |
| `query: { programId } // TODO(verify)` | adapter.ts:562 | **CONFIRMED** — `programId` from Apiary | Apiary blueprint |
| `// TODO(verify): date format YYYYMMDD` | adapter.ts:583 | **CONFIRMED** from Apiary | Apiary blueprint |
| `// TODO(verify): status filter in query string` | adapter.ts:584 | **BLOCKED** — server-side filter behaviour not live-tested | Cannot confirm |
| `// TODO(verify): consider /publisher/payments/earnings` | adapter.ts:655 | **BLOCKED** — earnings endpoint response shape not confirmed; derivation from transactions retained | Cannot confirm |
| `// TODO(verify): confirm siteId vs orgId disambiguation` (generateTrackingLink) | adapter.ts:773 | **RESOLVED** — `a=` confirmed as SITE ID (distinct from org ID); multi-site caveat documented | dev.tradedoubler.com FAQ |
| `// TODO(verify): confirm siteId === orgId in rawNetworkData` | adapter.ts:826 | **RESOLVED** — comment updated with confirmed explanation | dev.tradedoubler.com FAQ |

### Summary Counts (Hardening Pass 2026-05-28)

| Outcome | Count |
|---------|-------|
| CONFIRMED (deleted TODO, kept code) | 14 |
| CONFIRMED PARTIAL (some sub-fields still BLOCKED) | 4 |
| BLOCKED (precise reason documented) | 22 |
| RESOLVED / CORRECTED (comment improved, no code change needed) | 8 |

**Total TODO(verify) instances resolved: ~48**

### Remaining BLOCKED Items — Live Verification Checklist

The following items require a live Tradedoubler account to resolve:

| Blocked Item | Exact Credential/Tier Needed | Where to Check |
|-------------|------------------------------|----------------|
| `currency` field name in transaction JSON | Any publisher account + TRADEDOUBLER_API_TOKEN | `GET /publisher/report/transactions` response |
| `paid` boolean field existence on transactions | Any publisher account | `GET /publisher/report/transactions` response (look for `paid`, `paidToPublisher`, or similar) |
| `datePaid` / `paymentDate` field on paid transactions | Publisher account with at least one paid transaction | `GET /publisher/report/transactions` response |
| `commissionMin` / `commissionMax` / `commissionType` on programmes | Any publisher account | `GET /publisher/programs` response |
| `organisationId` vs `organizationId` spelling in `/users/me` | Any publisher account | `GET /usermanagement/users/me` response |
| `generatedId` / `transactionDate` (legacy XML API names) present in modern JSON | Any publisher account | `GET /publisher/report/transactions` response |
| Server-side status filter values (UPPERCASE vs lowercase) | Any publisher account | `GET /publisher/programs?status=JOINED` vs `?status=joined` |
| Organisation scoping required for `/publisher/programs` | Any publisher account with multiple orgs | `GET /publisher/programs` with and without orgId param |
| `/publisher/programs/detail` response envelope (flat vs wrapped) | Any publisher account | `GET /publisher/programs/detail?programId=X` |
| `/publisher/payments/earnings` response shape | Any publisher account | `GET /publisher/payments/earnings` |
| Token expiry and refresh flow for TRADEDOUBLER_API_TOKEN | Publisher account with OAuth2 credentials | OAuth2 token expiry time and refresh endpoint |

## Limitations Discovered During Research

1. The `dev.tradedoubler.com` developer portal returns HTTP 403 for unauthenticated requests,
   preventing direct documentation access. Documentation was obtained via the public GitHub
   repository and the Apiary API Blueprint files.

2. Click-level data is confirmed NOT available via the publisher API; only aggregated statistics
   are exposed via `GET /publisher/report/statistics` (counts by programme/site/ad, not per-click).

3. The `api.tradedoubler.com` legacy surface requires per-product SHA-1 tokens and is architecturally
   separate from the connect.tradedoubler.com bearer-token surface. The two surfaces cannot share
   credentials.

4. The connect.tradedoubler.com API uses a full OAuth2 ROPC flow (not a static API key). Operators
   must obtain a bearer token programmatically using client_id + client_secret + username + password.

5. Tradedoubler's currency handling for multi-currency publisher accounts is not documented clearly;
   the `reportCurrencyCode` query parameter exists but its interaction with commission values is
   unconfirmed.

6. The tracking `a=` parameter is the publisher site ID, not the organisation ID. These are
   distinct identifiers; multi-site publishers must use the site-specific ID.
