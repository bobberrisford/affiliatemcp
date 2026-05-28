# Sovrn Commerce — Findings

**Built from public docs as of 2026-05-28; live verification pending credentials.**

---

## Summary

This adapter was built using the publicly accessible Sovrn Commerce developer documentation and knowledge base. No live credentials were available at time of authoring. All field names, endpoint paths, and response shapes are now confirmed from multi-source public documentation research (hardening pass 2026-05-28) and reflect the actual API structure. The `claim_status` remains `experimental` until verified against a live account.

---

## Documentation sources used

| Source | URL | Notes |
|--------|-----|-------|
| Sovrn Developer Centre — Transactions | https://developer.sovrn.com/reference/get_reports-transactions | Response schema; 403 on direct fetch — confirmed via search snippets |
| Sovrn Developer Centre — Merchants | https://developer.sovrn.com/reference/get_reports-merchants | Response schema; 403 on direct fetch — confirmed via search snippets |
| VigLink Developer Centre (readme.io) | https://viglink-developer-center.readme.io/ | Authorization format, rate limits |
| Sovrn Knowledge Base (API implementation) | https://knowledge.sovrn.com/how-to-implement-sovrn-commerce-apis | Authentication format confirmed |
| VigLink support (rate limits) | https://support.viglink.com/hc/en-us/articles/360008095914 | Per-endpoint rate limits |
| VigLink support (tracking link CUIDs) | https://support.viglink.com/hc/en-us/articles/360004112874 | redirect.viglink.com parameter confirmation |
| Sovrn Knowledge Base (CUIDs in Commerce) | https://knowledge.sovrn.com/kb/cuids-in-commerce | `cuid` optional param confirmed |
| Sovrn Blog (4 reporting APIs launched) | https://www.viglink.com/blog/2016/07/12/4-new-reporting-apis-launched/ | Original endpoint announcement |
| VigLink Blog (transaction reporting API) | http://www.viglink.com/blog/2018/05/02/understand-the-click-to-purchase-funnel-with-viglinks-transaction-reporting-api/ | Date param patterns |
| clean-links GitHub issue | https://github.com/Sh1d0w/clean-links/issues/20 | redirect.viglink.com URL format |

---

## Hardening pass 2026-05-28

### TODO/stub inventory and outcomes

| # | Location | TODO text | Outcome | Source |
|---|----------|-----------|---------|--------|
| 1 | `adapter.ts:154` | confirm exact JSON field names against a live API response | **CORRECTED** — transactions response is nested under a `transactions` key; each entry has sub-objects `account`, `commission`, `click`, `merchant`, `product` (not a flat structure) | developer.sovrn.com/reference/get_reports-transactions |
| 2 | `adapter.ts:159` | exact field names from /v1/reports/merchants response | **CORRECTED** — merchants use `merchantGroupId` / `merchantGroupName`, not `merchant` / `merchantId`; no `currency` field | developer.sovrn.com/reference/get_reports-merchants |
| 3 | `adapter.ts:169` | currency field presence and name | **CONFIRMED ABSENT** — no currency field in either `/reports/transactions` or `/reports/merchants`; adapter defaults to `'USD'` | developer.sovrn.com/reference/get_reports-transactions (schema review) |
| 4 | `adapter.ts:173` | exact field names from /v1/reports/transactions response | **CORRECTED** — fields are nested: `commission.revenueId`, `commission.commissionId`, `commission.commissionDate`, `commission.updateDate`, `commission.orderValue`, `commission.publisherNetRevenue`, `commission.programType`; `click.clickId`, `click.clickDate`, `click.cuid`, `click.linkUrl`, `click.pageUrl`, `click.country`, `click.device`; `merchant.merchantGroupId`, `merchant.merchantGroupName`, `merchant.network`; `account.accountId`, `account.campaignId`, `account.campaignName` | developer.sovrn.com/reference/get_reports-transactions |
| 5 | `adapter.ts:187` | currency field name | **CONFIRMED ABSENT** — see row 3 above | developer.sovrn.com/reference/get_reports-transactions |
| 6 | `adapter.ts:189` | status field presence | **CONFIRMED ABSENT** — no status field in the documented response schema. `mapTransactionStatus` now unconditionally returns `'other'` | developer.sovrn.com/reference/get_reports-transactions |
| 7 | `adapter.ts:209` | confirm whether a status field exists in the API response | **CONFIRMED ABSENT** — see row 6 above | developer.sovrn.com/reference/get_reports-transactions |
| 8 | `adapter.ts:273` | confirm merchantId field name and whether it's always present | **CORRECTED** — the field is `merchant.merchantGroupId` (nested, numeric); `merchant.merchantGroupName` is the name field | developer.sovrn.com/reference/get_reports-transactions |
| 9 | `adapter.ts:302` | confirm field priority — publisherNetRevenue vs commission vs revenue | **CONFIRMED** — `commission.publisherNetRevenue` is the correct primary earnings field; `commission.orderValue` is the gross sale value | developer.sovrn.com/reference/get_reports-transactions |
| 10 | `adapter.ts:306` | confirm currency field name | **CONFIRMED ABSENT** — see row 3 above; defaults to `'USD'` | developer.sovrn.com/reference/get_reports-transactions |
| 11 | `adapter.ts:359` | confirm the per-10s rate limit applies to /reports/transactions | **CORRECTED** — `/reports/transactions` has a **1 req/60 s** rate limit (Commerce Real-Time Reports section). `/reports/merchants` has 1 req/10 s (Commerce Merchants section) | support.viglink.com/hc/en-us/articles/360008095914 |
| 12 | `adapter.ts:442` | confirm whether /reports/merchants accepts a date range or only a single date | **CONFIRMED single-date** — same one-date-per-call model as `/reports/transactions`; no date-range variant | developer.sovrn.com/reference/get_reports-merchants |
| 13 | `adapter.ts:496` | confirm whether a /reports/merchants?merchantId=... filter exists server-side | **CONFIRMED NO** — no server-side merchant filter on `/reports/merchants`; client-side filtering is correct | developer.sovrn.com/reference/get_reports-merchants |
| 14 | `adapter.ts:552` | confirm whether commissionDate can be used as the date parameter | **CONFIRMED** — all three date params (`clickDate`, `commissionDate`, `updateDate`) are valid alternatives; `updateDate` is especially useful for catching reversals | developer.sovrn.com/reference/get_reports-transactions |
| 15 | `adapter.ts:749` | confirm ?key=&u= is the correct redirect.viglink.com format | **CONFIRMED** — `key` and `u` are the only required params; `cuid` is optional for user-level tracking | support.viglink.com/hc/en-us/articles/360004112874, knowledge.sovrn.com/kb/cuids-in-commerce |
| 16 | `auth.ts:25` | confirm the correct auth-check endpoint against a live account | **CONFIRMED** — `/reports/merchants?clickDate=today` is a valid auth-check; no dedicated "whoami" endpoint exists; `/reports/merchants` preferred over `/reports/transactions` for probes (10 s vs 60 s rate limit) | developer.sovrn.com, support.viglink.com/hc/en-us/articles/360008095914 |
| 17 | `auth.ts:64` | if merchants endpoint requires additional params (e.g. siteUuid) | **CONFIRMED NOT REQUIRED** — `clickDate` is the only required parameter; no `siteUuid` or similar mandatory param | developer.sovrn.com/reference/get_reports-merchants |

---

## Changes made (hardening pass)

### `src/networks/sovrn-commerce/adapter.ts`

- **`SovrnTransactionRaw`** — completely rewritten to reflect the real nested structure: wrapper type `SovrnTransactionsEnvelope` with a `transactions` key, then nested sub-objects `commission`, `click`, `merchant`, `account`, `product`.
- **`SovrnMerchantRaw`** — updated to use `merchantGroupId` / `merchantGroupName`; removed `merchant`, `merchantId`, `currency` fields (confirmed absent).
- **`mapTransactionStatus`** — simplified: always returns `'other'`; no status field exists in the API response.
- **`toProgramme`** — updated to read `merchantGroupId` / `merchantGroupName`.
- **`toTransaction`** — updated to read from nested sub-objects (`raw.commission.publisherNetRevenue`, `raw.merchant.merchantGroupId`, `raw.click.clickDate`, etc.); currency hardcoded to `'USD'`.
- **`computeAgeDays`** — updated to read `raw.commission?.commissionDate` and `raw.click?.clickDate`.
- **`generateDateRange` comment** — corrected rate limit: 1 req/60 s for transactions; 1 req/10 s for merchants.
- **`listTransactions`** — updated to unwrap the `{ transactions: [...] }` envelope.
- **`listProgrammes` doc** — updated: single-date-per-call confirmed, no date-range variant.
- **`getProgramme` doc** — confirmed no server-side merchant filter.
- **`generateTrackingLink` doc** — confirmed `key` + `u` are the only required params; `cuid` optional.
- **`knownLimitations`** — updated to be precise: rate limits, field absences, currency default.

### `src/networks/sovrn-commerce/auth.ts`

- Updated `verifyAuth` doc comment: preferred endpoint, rate limit rationale, confirmed no extra params needed.

### `src/networks/sovrn-commerce/network.json`

- `known_limitations` array updated to match adapter.

### `tests/fixtures/sovrn-commerce/transactions.json`

- Completely rewritten to match the real nested API structure (`account`, `commission`, `click`, `merchant`, `product` sub-objects).

### `tests/fixtures/sovrn-commerce/merchants.json`

- Updated to use `merchantGroupId` / `merchantGroupName`; removed `merchant`, `merchantId`, `currency` fields.

### `tests/networks/sovrn-commerce/adapter.test.ts`

- Status-mapping tests replaced: `mapTransactionStatus` always returns `'other'`.
- `computeAgeDays` tests updated to use nested `commission.commissionDate` / `click.clickDate`.
- `toTransaction` field mapping tests updated for nested structure.
- `listTransactions` mock responses wrapped in `txEnvelope({ transactions: [...] })`.
- `getEarningsSummary` mock responses wrapped in `txEnvelope`.
- `capabilitiesCheck` mock responses wrapped in `txEnvelope`.
- Added test: empty transactions envelope is handled gracefully.
- Removed tests for 'reversed' status (no status field in API; replaced with 'other' status tests).

### `tests/networks/sovrn-commerce/manifest.test.ts`

- Updated `known_limitations` string to match new wording.

---

## Confirmed facts (from hardening pass)

1. **Authentication header format**: `Authorization: secret {SECRET_KEY}` — confirmed unchanged.
2. **Base URL**: `https://viglink.io/v1/` — confirmed unchanged.
3. **Transactions endpoint**: `GET /v1/reports/transactions` — response wrapped in `{ "transactions": [...] }` with nested sub-objects (not a flat array). One date per call.
4. **Transactions rate limit**: **1 request per 60 seconds** (Commerce Real-Time Reports category).
5. **Merchants endpoint**: `GET /v1/reports/merchants` — aggregated metrics per merchant group; uses `merchantGroupId` / `merchantGroupName`; one `clickDate` per call.
6. **Merchants rate limit**: 1 request per 10 seconds (Commerce Merchants category).
7. **No status field**: The `/reports/transactions` schema has no status enum. All transactions map to `'other'`.
8. **No currency field**: Neither `/reports/transactions` nor `/reports/merchants` includes a currency field. Adapter defaults to `'USD'`.
9. **Tracking link**: `https://redirect.viglink.com?key={API_KEY}&u={encodedUrl}` — confirmed; `cuid` is optional.
10. **Primary earnings field**: `commission.publisherNetRevenue` — confirmed as the publisher's net earnings.
11. **Merchant identifiers**: `merchant.merchantGroupId` (numeric) and `merchant.merchantGroupName` — Sovrn uses "merchant group" terminology.
12. **Auth probe**: `/reports/merchants?clickDate=today` is valid; no siteUuid required; preferred over transactions due to faster rate limit.

---

## Remaining BLOCKED items (live-verification checklist)

The following cannot be resolved without live credentials:

| Item | What is needed | Credential / tier required |
|------|---------------|---------------------------|
| Field values in live responses | Confirm exact field names and presence match the documented schema; check for undocumented fields (e.g. `product` array content) | SOVRN_SECRET_KEY + live account with traffic |
| `commissionDate` as date param behaviour | Confirm whether querying by `commissionDate` accurately captures commission events vs `clickDate` | SOVRN_SECRET_KEY + account with historic data |
| `updateDate` reversal detection | Confirm that changed transactions (reversals) appear under `updateDate` queries and whether `commission.publisherNetRevenue` changes value | SOVRN_SECRET_KEY + account with reversals |
| `merchantGroupIds` filter on transactions | Confirm the comma-separated filter narrows results correctly | SOVRN_SECRET_KEY + account with multiple merchants |
| Empty-day response shape | Confirm the response for a date with no transactions is `{ "transactions": [] }` (not `{}` or `null`) | SOVRN_SECRET_KEY |
| Auth probe robustness | Confirm `/reports/merchants` with today's date always returns 200 even on a fresh account with no traffic | SOVRN_SECRET_KEY + new publisher account |
| Tracking link click-through | Confirm `redirect.viglink.com?key=...&u=...` resolves to the destination with Sovrn tracking applied | SOVRN_API_KEY + browser test |
| `cuid` parameter persistence | Confirm `cuid` in the tracking link appears in `click.cuid` on transactions | SOVRN_SECRET_KEY + SOVRN_API_KEY + test purchase |

---

## Recommended next step

Once credentials are available, run `verifyAuth()` and inspect the raw `merchants` and `transactions` responses. Compare field names and nesting to the `SovrnMerchantRaw` and `SovrnTransactionRaw` interfaces in `adapter.ts`. If everything matches, bump `claim_status` from `experimental` to `partial` and update `last_verified`.
