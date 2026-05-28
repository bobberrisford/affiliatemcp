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
3. Verification of all `// TODO(verify)` annotations in the source against
   real API responses.

---

## Documentation sources used

- Everflow API overview: https://developers.everflow.io/docs/network/
- Advertisers endpoint: https://developers.everflow.io/docs/network/advertisers/
- Affiliates (affiliatestable): https://developers.everflow.io/docs/network/affiliates/
- Advertiser reporting: https://developers.everflow.io/docs/advertiser/reporting/
- Authentication: https://developers.everflow.io/docs/user-guide/authentication/

**Note:** The Everflow developer documentation site (developers.everflow.io)
returned HTTP 403 to automated WebFetch during research for this adapter.
Information was gathered via web search and quoted documentation snippets
from third-party sources. The endpoint shapes, request bodies, and response
fields described in the adapter source should be treated as best-effort and
confirmed against real API responses before production use.

---

## Key findings from documentation review

### Authentication

- The API uses a custom header: `X-Eflow-API-Key: <api_key>`.
- Network API keys are created by the network admin at Control Center → Security → API Keys.
- Affiliate and advertiser users cannot create API keys themselves.
- Keys are shown only once at creation.
- Each key carries its own permission scopes; narrowly scoped keys per integration are recommended.

**Source:** https://developers.everflow.io/docs/user-guide/authentication/,
https://developers.everflow.io/user-guide/authentication

### Advertisers endpoint

- `GET /v1/networks/advertisers` returns a paginated list of advertisers.
- Response includes `network_advertiser_id`, `name`, `account_status`.
- `account_status` values: `active`, `inactive`, `suspended`.
- Pagination follows the standard Everflow pattern: `page` + `page_size` query params,
  `paging.total_count` in the response.

**TODO(verify):** Exact response envelope field names (e.g. `advertisers` array key).

**Source:** https://developers.everflow.io/docs/network/advertisers/

### Affiliates table endpoint

- `POST /v1/networks/affiliatestable` returns a paginated list of affiliates.
- Request body contains `filters` for `account_status`.
- Status values: `active`, `inactive`, `pending`, `suspended`.
- Response includes `network_affiliate_id`, `name`, `account_status`.
- No server-side filter by advertiser is documented at this endpoint.

**TODO(verify):** Exact filter request body shape; whether a `relationship` param
or other per-advertiser filter exists.

**Source:** https://developers.everflow.io/docs/network/affiliates/

### Advertiser reporting endpoint

- `POST /v1/advertisers/reporting/entity` for aggregate performance data.
- Request body includes `from` (YYYY-MM-DD), `to` (YYYY-MM-DD), `columns`, and `query`.
- Columns select the breakdown dimension; `"affiliate"` gives per-affiliate rows.
- Date range is limited to one year per request.
- Response is a `table` array with per-row `columns` (dimension values) and `reporting`
  (aggregate metrics: `imp`, `total_click`, `unique_click`, `cv`, `revenue`, `payout`).
- If results exceed 10,000 rows, `incomplete_results: true` is set in the response.

**TODO(verify):**
- Whether `resource_type: "advertiser"` is a valid filter_id filter key, or whether
  the advertiser is implicit from the API key.
- Exact `column_type` value for affiliates in the response columns array.
- `currency` field name and location in the response.
- `timezone_id` and `currency_id` parameter handling when omitted.

**Source:** https://developers.everflow.io/docs/advertiser/reporting/

---

## Open questions for live verification

1. Is `filters[].resource_type = "advertiser"` the correct way to scope a report
   to a specific advertiser, or is the advertiser inferred from the API key?
2. What is the exact `column_type` string used for affiliate rows in the
   report response?
3. Does the affiliatestable endpoint support any per-advertiser filtering, or
   is it always network-wide?
4. Are there any rate limits on the reporting endpoint beyond the 10k-row cap?
5. What happens when `EVERFLOW_ADVERTISER_ID` matches an advertiser that the
   API key does not have permission to access?

---

## Date of review

2026-05-28
