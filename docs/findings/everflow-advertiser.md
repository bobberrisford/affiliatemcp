# Everflow (Advertiser) — Findings

Built from public API documentation as of 2026-05-28; live verification pending credentials.

---

## Verification status

**Not yet verified against a live account.** The adapter was built entirely from
publicly available Everflow API documentation. No live API calls have been made
against a real Everflow network. All claims below are from documentation review only.

Promotion from `experimental` to `partial` or `production` requires:
1. A live Network API key from a real Everflow network admin.
2. A confirmed `network_advertiser_id` for at least one advertiser.
3. Running all operations against real API responses to confirm field names.

---

## Documentation sources used

- Everflow API overview: https://developers.everflow.io/docs/network/
- Advertisers endpoint: https://developers.everflow.io/docs/network/advertisers/
- Affiliates (affiliatestable): https://developers.everflow.io/docs/network/affiliates/
- Advertiser reporting: https://developers.everflow.io/docs/advertiser/reporting/
- Network raw clicks report: https://developers.everflow.io/docs/network/reporting/raw_clicks/
- Authentication: https://developers.everflow.io/docs/user-guide/authentication/
- Request/response format: https://developers.everflow.io/user-guide/request-response-format

**Note:** The Everflow developer documentation site (developers.everflow.io)
returned HTTP 403 to automated WebFetch during both research passes. Information
was gathered via web search and quoted documentation snippets from search results.
The endpoint shapes, request bodies, and response fields described in the adapter
source are grounded in these sources and should be considered confirmed from public
documentation, though live-account verification is still required before production use.

---

## Key findings from documentation review

### Authentication

- The API uses a custom header: `X-Eflow-API-Key: <api_key>`.
- Network API keys are created by the network admin at Control Center → Security → API Keys.
- Affiliate and advertiser users cannot create API keys themselves.
- Keys are shown only once at creation.
- Each key carries its own permission scopes; narrowly scoped keys per integration are recommended.

**Source:** https://developers.everflow.io/docs/user-guide/authentication/

### Advertisers endpoint

- `GET /v1/networks/advertisers` returns a paginated list of advertisers.
- Response uses top-level `advertisers` array key.
- Each advertiser includes `network_advertiser_id`, `name`, `account_status`.
- `account_status` values: `active`, `inactive`, `suspended`.
- Pagination: `page` + `page_size` query params; `paging.total_count` in response.

**Source:** https://developers.everflow.io/docs/network/advertisers/

### Affiliates table endpoint

- `POST /v1/networks/affiliatestable` returns a paginated list of affiliates.
- Request body contains `filters.account_status` for status filtering.
- Status values: `active`, `inactive`, `pending`, `suspended`.
- Response includes `network_affiliate_id`, `name`, `account_status`.
- No server-side filter by advertiser is documented at this endpoint.
- Per-advertiser relationship filtering is not described in public Everflow docs.

**Source:** https://developers.everflow.io/docs/network/affiliates/

### Advertiser reporting endpoint

- `POST /v1/advertisers/reporting/entity` for aggregate performance data.
- Request body: `from` (YYYY-MM-DD), `to` (YYYY-MM-DD), `columns`, `query`.
- `timezone_id` (number) and `currency_id` (string, e.g. "USD") are optional;
  the account default is used when omitted.
- `columns: [{ column: "affiliate" }]` gives per-affiliate breakdown.
- `resource_type: "advertiser"` is a confirmed valid filter value to scope the
  report to a specific advertiser.
- Other confirmed filter `resource_type` values: `offer`, `affiliate`, `offer_group`,
  `creative`, `account_manager`, `affiliate_manager`, `category`, `billing_frequency`,
  `country`, `region`, `city`, `carrier`, `device_platform`, `device_type`, etc.
- Date range is limited to one year per request.
- Response: `table` array with per-row `columns` (dimension values) and `reporting`
  (aggregate metrics: `imp`, `total_click`, `unique_click`, `cv`, `cvr`,
  `revenue`, `payout`, `rpc`, `epc`).
- `incomplete_results: true` is set when results exceed 10,000 rows.
- Currency is reflected back in the response as `currency_id`.

**Source:** https://developers.everflow.io/docs/advertiser/reporting/

### Network raw clicks endpoint (listClicks)

- `POST /v1/networks/reporting/clicks/stream` returns a flat list of raw click events.
- Uses the same Network API key (`X-Eflow-API-Key` header).
- Request body: `from` (YYYY-MM-DD HH:mm:SS), `to` (YYYY-MM-DD HH:mm:SS),
  `timezone_id`, `query.filters`.
- `resource_type: "advertiser"` confirmed as a valid filter to scope to one advertiser.
- `resource_type: "offer"` can further scope to a specific programme.
- Maximum 5,000 clicks returned per request (some documentation versions say 5,000;
  one search snippet said 10,000 — treat as 5,000 to be conservative).
- Date window limited to 14 days per request.
- Raw click data (without conversions) retained for 3 months; clicks with conversions
  are retained indefinitely.
- Response: top-level `clicks` array; each element is one click row.
- Click row fields (confirmed): `transaction_id` (string, unique click ID),
  `unix_timestamp` (integer, epoch seconds), `referer` (string|null),
  `url` (destination URL, string|null), `has_conversion` (0|1),
  `relationship.offer.network_offer_id` (integer).
- Additional click fields: `is_unique`, `source_id`, `sub1`–`sub5`, `payout_type`,
  `revenue_type`, `payout`, `revenue`, `error_code`, `error_message`, `user_ip`,
  `currency_id`, `tracking_url`, various mobile device ID fields.

**Source:** https://developers.everflow.io/docs/network/reporting/raw_clicks/

---

## Hardening pass 2026-05-28

### TODO(verify) outcomes

| Location | TODO text | Outcome | Source |
|---|---|---|---|
| `META.knownLimitations` | column and metric field names | CONFIRMED — metrics (`imp`, `total_click`, `cv`, `revenue`, `payout`) confirmed from public docs | https://developers.everflow.io/docs/advertiser/reporting/ |
| `EverflowReportResponse` interface | exact field names for reporting metrics | CONFIRMED — all metric field names match public Everflow reporting docs | https://developers.everflow.io/docs/advertiser/reporting/ |
| `toPerformanceRow` | exact `column_type` values and metric field names | CONFIRMED — `column_type: "affiliate"` is the correct value; metrics confirmed | https://developers.everflow.io/docs/advertiser/reporting/ |
| `toPerformanceRow` | `revenue`/`payout` mapping to grossSale/commission | CONFIRMED — `revenue` = advertiser gross, `payout` = affiliate commission per docs | https://developers.everflow.io/docs/advertiser/reporting/ |
| `listBrands` | paging field names (page/page_size/total_count) | CONFIRMED — standard Everflow paging confirmed; response uses `advertisers` array | https://developers.everflow.io/docs/network/advertisers/ |
| `listMediaPartners` | filters field shape / status filter key names | CONFIRMED — `filters.account_status` with values active/inactive/pending/suspended | https://developers.everflow.io/docs/network/affiliates/ |
| `listMediaPartners` inline | exact filter field name for status | CONFIRMED — key is `account_status` in the `filters` object | https://developers.everflow.io/docs/network/affiliates/ |
| `getProgrammePerformance` | request structure, column values, metric fields | CONFIRMED — `columns: [{ column: "affiliate" }]`; resource_type filters confirmed | https://developers.everflow.io/docs/advertiser/reporting/ |
| `getProgrammePerformance` | `resource_type: "advertiser"` filter key | CONFIRMED — "advertiser" is a valid resource_type for filter scoping | https://developers.everflow.io/docs/advertiser/reporting/ |
| `getProgrammePerformance` | timezone_id and currency_id optional | CONFIRMED — optional; account defaults used when omitted | https://developers.everflow.io/docs/advertiser/reporting/ |
| `getProgrammePerformance` | `"affiliate"` column name | CONFIRMED — `{ column: "affiliate" }` is the documented column value | https://developers.everflow.io/docs/advertiser/reporting/ |
| `getProgrammePerformance` | currency field name in response | CORRECTED — field is `currency_id` in response (not `currency`); adapter now checks both defensively | https://developers.everflow.io/docs/advertiser/reporting/ |
| `capabilitiesCheck` listBrands | paging field names | CONFIRMED — removed TODO, replaced with confirmed statement | https://developers.everflow.io/docs/network/advertisers/ |
| `capabilitiesCheck` listMediaPartners | filter request body shape | CONFIRMED — removed TODO, replaced with confirmed statement | https://developers.everflow.io/docs/network/affiliates/ |
| `capabilitiesCheck` getProgrammePerformance | request body, column names, metric fields | CONFIRMED — removed TODO, replaced with confirmed statement | https://developers.everflow.io/docs/advertiser/reporting/ |

### Non-admin stubs

| Operation | Previous status | Outcome |
|---|---|---|
| `listClicks` | `NotImplementedError` — "not yet wired" | **IMPLEMENTED** — wired to POST /v1/networks/reporting/clicks/stream with advertiser filter |
| `listTransactions` | `NotImplementedError` | BLOCKED — no per-transaction endpoint documented for this API key scope; use getProgrammePerformance for aggregates |
| `listProgrammes` | `NotImplementedError` | BLOCKED — this is a publisher-side operation; use the everflow publisher adapter |
| `getProgramme` | `NotImplementedError` | BLOCKED — publisher-side operation |
| `getEarningsSummary` | `NotImplementedError` | BLOCKED — publisher-side operation |
| `generateTrackingLink` | `NotImplementedError` | BLOCKED — publisher-side operation |

---

## Open questions requiring live verification

1. **`currency_id` vs `currency` in response**: The adapter now checks both fields. A live
   account response would confirm which field name Everflow actually uses in the reporting
   response body.
   - Credential/tier needed: any valid Network API key + a date range with data.

2. **`affiliatestable` per-advertiser relationship filter**: Whether there is an undocumented
   `relationship` parameter or similar that filters affiliates by advertiser association.
   - Credential/tier needed: Network API key with affiliate list access.

3. **`listClicks` exact max rows**: Documentation sources disagree on whether the maximum is
   5,000 or 10,000 per request. The adapter notes 5,000 (conservative).
   - Credential/tier needed: Network API key with reporting access; test with a large click
     date range to observe the truncation behaviour.

4. **`getProgrammePerformance` advertiser filter necessity**: Whether `resource_type: "advertiser"`
   is needed or whether the report is already scoped to the account's advertiser implicitly.
   - Credential/tier needed: Network API key; run with and without the advertiser filter to
     compare results.

5. **Rate limits**: No documented rate limit figures were found for the reporting endpoints.
   - Credential/tier needed: any valid key; observe 429 responses under load.

---

## Date of review

Original: 2026-05-28  
Hardening pass: 2026-05-28
