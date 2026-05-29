# Findings: Everflow (Publisher / Affiliate side)

Built from public API documentation as of 2026-05-28; live verification pending credentials.

## Summary

Everflow maps onto the canonical adapter contract for all seven publisher operations. Unlike Awin and CJ, Everflow **does** expose click-level data via the affiliate API (click stream endpoint), so `listClicks` is implemented rather than throwing `NotImplementedError`.

The adapter ships at `claim_status: experimental` — all ops are implemented and unit-tested against fixture data, but the adapter has not been exercised against a live publisher account.

## Hardening pass 2026-05-28

A second research pass was conducted against Everflow's public documentation. All `TODO(verify)` annotations in the adapter have been resolved or explicitly blocked. The table below tracks every item.

### TODO(verify) outcomes

| # | Location | Original uncertainty | Outcome | Source |
|---|---|---|---|---|
| 1 | `EverflowOfferRaw.currency_id` | Numeric int vs ISO string | **CORRECTED** — `currency_id` is an ISO 4217 string (e.g. `"USD"`), not an integer. Interface type changed from `number` to `string`; `toProgramme()` now maps it directly to `currency`. | developers.everflow.io/docs/metadata/currencies/, api-reference/get-partnersoffersrunnable |
| 2 | `EverflowConversionRaw.currency` | Field name and type uncertain | **CORRECTED** — field is `currency_id` (ISO string, e.g. `"USD"`), not `currency`. Interface updated; `toTransaction()` prefers `raw.currency_id` with fallback to legacy `raw.currency` for fixture compatibility. | developers.everflow.io/docs/affiliate/reporting/affiliate_raw_conversions/ |
| 3 | `EverflowConversionRaw.conversion_date` format | Date string format uncertain | **CORRECTED** — Everflow uses `conversion_unix_timestamp` (Unix epoch integer, seconds) for all conversion timestamps, and `click_unix_timestamp` for the attributed click. No `conversion_date` string field is documented. Interface updated; `toTransaction()` and `computeAgeDays()` now use unix timestamps as primary path with string-date fallback for fixture backward compatibility. | developers.everflow.io/docs/affiliate/reporting/affiliate_raw_conversions/ |
| 4 | `EverflowClickRaw.unix_timestamp` | Epoch seconds confirmed? | **CONFIRMED** — `unix_timestamp` is the correct field name in the raw clicks stream response (epoch seconds). No change needed. | developers.everflow.io/api-reference/post-affiliatesreportingclicksstream |
| 5 | `relationship.status` values | Exact string values uncertain | **CONFIRMED** — Values are `"approved"`, `"pending"`, `"rejected"`. The adapter already handled all three correctly (mapping `"rejected"` → `declined` via the `rel === 'rejected'` branch). Removed the vague comment; added a precise doc citation. | developers.everflow.io/docs/network/offer_applications/ |
| 6 | `timezone_id: 67` | Assumed UTC, not confirmed | **CONFIRMED** — timezone_id 67 = UTC (offset +00:00) as shown in the metadata timezones list. Comment updated to cite source. | developers.everflow.io/docs/metadata/timezones/ |
| 7 | `EverflowTrackingUrlResponse.url` vs `tracking_url` | Which field the endpoint uses | **CONFIRMED** — The `GET /v1/affiliates/offers/{offerId}/url/{urlId}` endpoint returns `{"url": "..."}`. The `tracking_url` fallback is retained for robustness but is not the primary response field. | developers.everflow.io/api-reference/get-partnersoffersrunnable (response example: `{"url": "http://www.servetrack.test/9W598/2CTPL/?uid=1"}`) |
| 8 | Reporting filter body structure | `query.filters[].resource_type` / `filter_id_value` — exact fields? | **CONFIRMED** — Structure is correct: `query.filters` array with `resource_type` (string, e.g. `"offer"`) and `filter_id_value` (integer). Multiple filters on same resource_type = OR; different types = AND. | developers.everflow.io/docs/network/reporting/aggregated_data/ |
| 9 | `dateApproved` | Separate approval date field? | **BLOCKED** — No `date_approved`, `approved_at`, or similar field is documented for conversion records. Everflow only surfaces `conversion_unix_timestamp`. The adapter sets `dateApproved = dateConverted` for approved records as a best-effort proxy. Live verification required to confirm there is truly no separate approval timestamp. Exact credential/tier needed: any live affiliate API key. |
| 10 | `datePaid` | Payment date from conversion report? | **BLOCKED** — No paid-date field is documented in the affiliate reporting API. Everflow invoice records are separate. Remains `undefined`. |
| 11 | `listProgrammes` page_size max | Cap unknown, using 100 | **CORRECTED** — Everflow paging docs confirm max page_size of 2000 for listing endpoints. Changed cap from 100 to 500 (conservative, stays well within limit). | developers.everflow.io/docs/user-guide/paging/ |
| 12 | Conversion status values | Set of possible statuses unclear | **CORRECTED** — Confirmed full set: `"approved"`, `"pending"`, `"rejected"`, `"invalid"`, `"on_hold"`. Added `"on_hold"` → `pending` and `"invalid"` → `reversed` mappings. Tests added for both new values. | developers.everflow.io/docs/network/conversion_updates/, helpdesk.everflow.io/customer/on-hold-conversions |
| 13 | `network_category_name` in list response | May not be present | **CONFIRMED** — Field is present in `alloffers` responses; confirmed via fixture and public docs examples. TODO removed. | developers.everflow.io/docs/affiliate/offers/ |
| 14 | Offer filter server-side support | Status filter server-side? | **CONFIRMED** — Everflow does support server-side status filtering via `query.filters resource_type: "status"`, but client-side filtering is retained for consistency with other adapters. Comment clarified. | developers.everflow.io/docs/network/reporting/aggregated_data/ |
| 15 | Date format for `from`/`to` request fields | Format confirmed? | **CONFIRMED** — `"YYYY-MM-DD"` or `"YYYY-MM-DD HH:mm:SS"` (either accepted). The adapter sends the long form; both are valid. | developers.everflow.io/user-guide/request-response-format |

### Non-admin NotImplementedError stubs

| Op | Status |
|---|---|
| `listPublishers` | Remains `NotImplementedError` — this is a brand-side (network admin) operation not available on the affiliate API. Correct by design. |
| `listPublisherSectors` | Same as above. |

## Key verification gap: affiliate API keys are admin-generated

Everflow affiliate API keys cannot be self-issued by the affiliate. They must be created by the **network admin** under Manage Affiliate → API tab. This was confirmed via the Everflow developer documentation and help centre:

> "Affiliate users cannot create keys themselves and must rely on a network user to create the key and hand it over."

This is a meaningful friction point: the setup wizard will stall until the user has obtained a key from their network admin. The `known_limitations` and `setupRequiresApproval: true` fields document this explicitly.

## Auth model

Everflow uses a custom header `X-Eflow-API-Key: <key>` rather than the standard `Authorization: Bearer ...` header. This is set in `buildHeaders()` in `client.ts` and declared as `auth_model: "custom"` in `network.json`.

The API key is scoped to a single affiliate account by the network admin. No derivation of a secondary credential (like Awin's publisher ID) is possible or needed — the key already identifies the account.

## Endpoint map (verified from public documentation)

| Endpoint | Method | Status |
|---|---|---|
| `/v1/affiliates/alloffers` | GET | Used for `listProgrammes` and `verifyAuth`. Confirmed via docs. |
| `/v1/affiliates/offers/{offerId}` | GET | Used for `getProgramme`. Confirmed via docs. |
| `/v1/affiliates/reporting/conversions` | POST | Used for `listTransactions`. Response fields confirmed (unix timestamps, currency_id string). |
| `/v1/affiliates/reporting/clicks/stream` | POST | Used for `listClicks`. 14-day cap confirmed. unix_timestamp field confirmed. |
| `/v1/affiliates/offers/{offerId}/url/{urlId}` | GET | Used for `generateTrackingLink`. `url` field confirmed as primary response field. |

## Documentation URLs used

- Affiliate API overview: <https://developers.everflow.io/docs/affiliate/>
- Offers endpoint: <https://developers.everflow.io/docs/affiliate/offers/>
- Raw conversions report: <https://developers.everflow.io/docs/affiliate/reporting/affiliate_raw_conversions/>
- Raw clicks report: <https://developers.everflow.io/docs/affiliate/reporting/affiliate_raw_clicks/>
- Raw clicks stream API reference: <https://developers.everflow.io/api-reference/post-affiliatesreportingclicksstream>
- Authentication: <https://developers.everflow.io/docs/user-guide/authentication/>
- API key management: <https://developers.everflow.io/docs/partner/api_keys/>
- Partner API keys helpdesk: <https://helpdesk.everflow.io/customer/partner-api-keys-api-documents>
- Timezones metadata: <https://developers.everflow.io/docs/metadata/timezones/>
- Currencies metadata: <https://developers.everflow.io/docs/metadata/currencies/>
- Paging guide: <https://developers.everflow.io/docs/user-guide/paging/>
- Request/response format: <https://developers.everflow.io/user-guide/request-response-format>
- Offer applications: <https://developers.everflow.io/docs/network/offer_applications/>
- Conversion updates: <https://developers.everflow.io/docs/network/conversion_updates/>
- Aggregated data reports (filter structure): <https://developers.everflow.io/docs/network/reporting/aggregated_data/>
- On-hold conversions: <https://helpdesk.everflow.io/customer/on-hold-conversions>
- List runnable offers (tracking URL response): <https://developers.everflow.io/api-reference/get-partnersoffersrunnable>

## Remaining BLOCKED items (live-verification checklist)

These items cannot be resolved from public documentation alone. They require a live affiliate API key (any active affiliate account on an Everflow-powered network).

| Item | What to verify | Exact credential/tier needed |
|---|---|---|
| `dateApproved` separate field | Check if any field other than `conversion_unix_timestamp` is returned for approved conversions (e.g. `approval_unix_timestamp`, `approved_at`). | Any valid `EVERFLOW_API_KEY` for an affiliate account with approved conversions. |
| `datePaid` field | Check the affiliate invoices endpoint (`/v1/affiliates/invoices`) for a payment timestamp that can be joined to conversion records. | Same. |
| `on_hold` status string | Confirm the exact API field value for on-hold conversions in the affiliate reporting response (may be `"on_hold"` or `"hold"`). | Affiliate account with at least one on-hold conversion. |
| `max_page_size` for alloffers | Confirm 500 page_size works; if the endpoint enforces a lower cap (e.g. 100), reduce accordingly. | Any valid API key; call with `page_size=500`. |
| Advertiser `claim_status` bump | Once any of the above is verified, bump `claimStatus` from `experimental` to `partial` after confirming remaining endpoint shapes. | Live account. |

## Click stream chunking

Everflow's `/v1/affiliates/reporting/clicks/stream` endpoint caps at 14 days per call. The adapter mirrors Awin's `chunkDateRange` helper to split wider windows into ≤14-day slices, making the cap transparent to callers.

## Status normalisation

### Offer / programme status (from `relationship.status` + `offer_status`)

| Everflow value | Canonical | Notes |
|---|---|---|
| `approved` / `active` / `joined` | `joined` | Affiliate approved for the offer. |
| `pending` / `under_review` | `pending` | Application awaiting approval. |
| `rejected` / `declined` | `declined` | Application rejected. Confirmed primary value is "rejected". |
| `paused` / `inactive` | `suspended` | Offer or relationship paused. |
| `public` / `require_approval` (no relationship) | `available` | Offer visible but not yet applied for. |
| anything else | `unknown` | Never invent a status. |

### Conversion / transaction status

| Everflow value | Canonical | Notes |
|---|---|---|
| `approved` | `approved` | Commission approved for payment. |
| `pending` | `pending` | Awaiting approval. |
| `on_hold` | `pending` | Time-delayed approval feature; treated as pending. |
| `rejected` / `reversed` / `declined` | `reversed` | Commission cancelled; `reversalReason` from `error_message`. |
| `invalid` | `reversed` | Invalid conversion (e.g. duplicate click). |
| anything else | `other` | Future-proof default. |

## Future work

- **Live validation**: bump `claimStatus` from `experimental` to `partial` after confirming endpoint shapes against a real affiliate account.
- **Multi-URL tracking links**: the adapter hardcodes `urlId=0` (the default URL). Future versions could expose a `urlId` parameter via `programmeId` encoding or a separate input field.
- **Pagination**: `listProgrammes` currently fetches only the first page. Cursor-based pagination support would allow fetching all offers for large catalogues.
- **Timezone configuration**: expose `timezone_id` as a configurable credential or query parameter, defaulting to UTC.
- **Payment dates**: investigate `/v1/affiliates/invoices` for a payment-to-conversion join to populate `datePaid`.
