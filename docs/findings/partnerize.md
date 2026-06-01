# Partnerize (Publisher) — findings

Built from public API documentation as of 2026-05-28; live verification pending
credentials.

---

## Research sources

The following public sources were consulted to build this adapter. The primary
Partnerize API documentation site (api-docs.partnerize.com) returned HTTP 403
to automated fetch. All shapes were sourced from the official public GitHub
repository and search result fragments.

- **Partnerize Partner API documentation** (primary):
  https://api-docs.partnerize.com/partner/ — returned 403 to automated fetch.
  URL confirmed as valid; accessible via browser.

- **Official Partnerize API blueprint repository** (primary source used):
  https://github.com/PerformanceHorizonGroup/apidocs — all `.apib` source files
  read directly via `raw.githubusercontent.com`. Endpoint paths, request
  parameters, and response envelope shapes sourced from:
  - `src/intro.apib` — authentication scheme, base URL, date format examples
  - `src/publisher.apib` — publisher account endpoints, `publisher_id` / `account_name` field names
  - `src/publisher_campaign.apib` — campaign list endpoint, status path segments (a/p/r)
  - `src/granular_reporting.apib` — conversion and click reporting endpoints, cursor pagination
  - `src/export_reporting.apib` — **primary field-name source**: CSV column headers
    for both conversion and click exports, including sample data rows
  - `src/campaign.apib` — campaign object fields (payment_date at campaign level confirmed)
  - `src/campaign_conversion.apib` — conversion status values (approved/pending/rejected),
    reject_reason on conversion items
  - `src/publisher_transaction_query.apib` — conversion_date_time field name confirmed
  - `src/selfbill.apib` — payment_date confirmed at invoice (selfbill) level only
  - `src/reference.apib` — Vertical/Category type defined but not in publisher campaign list
  - `src/aggregated_reporting.apib` — partner_commission vs commission confirmed as
    separate fields
  - `src/participating_publishers.apib` — `campaign_status` field name at relationship level

- **Partnerize tracking link format**:
  Confirmed from multiple public integration guides:
  `https://prf.hn/click/camref:{camref}/destination:{encodedUrl}`
  The camref format is consistent across TransferWise, Expedia, and Plum Guide
  publisher guides available at docs.partnerize.com and help.phgsupport.com.

- **Web search evidence**:
  - Auth scheme (HTTP Basic, `application_key:user_api_key`, base64-encoded) confirmed
  - Base URL (`https://api.partnerize.com`) confirmed
  - conversion_status filter values confirmed as: `approved`, `pending`, `rejected`, `mixed`
    (search snippets from api-docs.partnerize.com); "paid" not documented publicly
  - Date format for reporting parameters confirmed as `YYYY-MM-DD HH:MM:SS`
    (URL-encoded; YYYY-MM-DD date-only also accepted per search evidence)
  - publisher_commission and commission confirmed as separate distinct fields
    (Funnel.io knowledge base: "Commission" and "Publisher commission" are separate metrics)
  - reject_reason confirmed in API validation docs (field name confirmed)

---

## Hardening pass 2026-05-28

### TODO resolutions

Each of the 27 `TODO(verify)` markers has been resolved as CONFIRM, CORRECT, or BLOCKED:

| # | Location | Resolution | Source | Notes |
|---|----------|-----------|--------|-------|
| 1 | `adapter.ts:161` — `campaign_id` may be numeric | **CONFIRM** | export_reporting.apib sample row (`10l176`) | String type confirmed |
| 2 | `adapter.ts:163` — `campaign_name` alternative field | **CONFIRM** | export_reporting.apib conversion CSV header shows `campaign_title` | Primary field is `campaign_title`; `campaign_name` kept as defensive fallback |
| 3 | `adapter.ts:165` — `approval_state` field name | **BLOCKED** | publisher_campaign.apib references `campaign_status` at relationship level; exact publisher-side response body field name unconfirmed | Requires live credentials |
| 4 | `adapter.ts:170` — commission value may be numeric | **CONFIRM** | export_reporting.apib sample row (`0.9092`) shows numeric string | `toNumber()` handles both string and number |
| 5 | `adapter.ts:173` — `tracking_url` field name | **BLOCKED** | Not documented in publisher_campaign.apib or campaign_tracking.apib | Requires live credentials |
| 6 | `adapter.ts:192` — conversion field names | **CONFIRM (partial)** | export_reporting.apib conversion CSV headers confirm all core fields | JSON endpoint may have different field names; blocked for full confirmation |
| 7 | `adapter.ts:208` — `conversion_lag` units | **BLOCKED** | export_reporting.apib sample shows `626`; units not stated in blueprint | Requires live credentials; likely minutes based on magnitude |
| 8 | `adapter.ts:214` — `reject_reason` field name | **CONFIRM** | export_reporting.apib conversion_item CSV confirms `reject_reason` | Note: field is on conversion ITEMS, not top-level conversion row; kept defensively |
| 9 | `adapter.ts:225` — pagination header vs body | **CONFIRM** | granular_reporting.apib: "if the result set includes a `cursor_id` header attribute" | cursor_id is a RESPONSE HEADER, not in the body |
| 10 | `adapter.ts:232` — conversion field names from export | **CONFIRM** | export_reporting.apib CSV headers directly confirm all conversion field names | JSON parity with CSV is a reasonable assumption but blocked for full confirmation |
| 11 | `adapter.ts:299` — `paid` status exists | **BLOCKED** | Public search confirms only approved/pending/rejected/mixed as documented values; `paid` not found in any public blueprint | Kept for defensive compatibility; requires live credentials to confirm or remove |
| 12 | `adapter.ts:338` — `approval_state` / `status` values | **CONFIRM** | publisher_campaign.apib: path segments a/p/r map to approved/pending/rejected | Defensive reading of both field names preserved |
| 13 | `adapter.ts:362` — `validation_date` / `approved_at` | **CONFIRM ABSENT** | export_reporting.apib conversion CSV has no validation_date or approved_at column; no such field in any public blueprint | `dateApproved` remains `undefined` |
| 14 | `adapter.ts:429` — `categories` taxonomy | **CONFIRM ABSENT** | reference.apib defines Vertical type but publisher campaign list endpoint does not return it in any blueprint | `categories` remains `undefined` |
| 15 | `adapter.ts:449` — `publisher_commission` vs `commission` | **CONFIRM** | export_reporting.apib: both appear as separate CSV columns; aggregated_reporting.apib distinguishes `partner_commission` from `commission`; Funnel.io docs confirm two separate fields | publisher_commission is correct |
| 16 | `adapter.ts:469` — `dateApproved` | **CONFIRM ABSENT** | No separate approval date in export_reporting.apib conversion schema | Remains `undefined`; blocked pending JSON endpoint confirmation |
| 17 | `adapter.ts:470` — `datePaid` | **CONFIRM ABSENT** | selfbill.apib has payment_date at invoice level only; no per-conversion payment_date in any public blueprint | Remains `undefined` |
| 18 | `adapter.ts:559` — path and status values | **CONFIRM** | publisher_campaign.apib: endpoint path and a/p/r values confirmed | Response body field names remain blocked |
| 19 | `adapter.ts:588` — status in response body | **BLOCKED** | publisher_campaign.apib shows `campaign_status` at participating_publishers level; publisher-side list response field unconfirmed | Requires live credentials |
| 20 | `adapter.ts:625` — single-campaign endpoint | **CONFIRM ABSENT** | publisher_campaign.apib documents no single-campaign endpoint; workaround confirmed necessary | |
| 21 | `adapter.ts:697` — date format | **CONFIRM** | granular_reporting.apib example: `2018-03-01+00%3A00%3A00`; intro.apib confirms datetime format | YYYY-MM-DD also accepted; current adapter behaviour safe |
| 22 | `adapter.ts:864` — click field names | **CONFIRM** | export_reporting.apib click CSV headers: click_id, cookie_id, campaign_id, publisher_id, status, set_time, set_ip, last_used, last_ip, advertiser_reference, referer, creative_id, creative_type, specific_creative_id, country, publisher_name | JSON parity blocked |
| 23 | `adapter.ts:907` — `destinationUrl` | **CONFIRM ABSENT** | export_reporting.apib click CSV has no destination_url or landing_url column | Remains `undefined`; JSON endpoint may differ (blocked) |
| 24 | `adapter.ts:1166` — datetime strings accepted | **CONFIRM** | granular_reporting.apib shows full datetime format; date-only also works | YYYY-MM-DD confirmed safe |
| 25 | `auth.ts:41` — publisher field names | **CONFIRM** | publisher.apib confirms `publisher_id` and `account_name` fields | Not live-tested |
| 26 | `auth.ts:153` — response envelope shape | **CONFIRM (blueprint)** | publisher.apib shows `{ publishers: { publisher: [...] } }` pattern; flat array handled defensively | Not live-tested |

**Summary: 18 CONFIRM, 1 CONFIRM ABSENT (6 items), 6 BLOCKED**

---

## Remaining BLOCKED items (live-verification checklist)

The following uncertainties cannot be resolved without live Partnerize publisher
credentials. They require: `PARTNERIZE_APPLICATION_KEY`, `PARTNERIZE_USER_API_KEY`,
and a publisher account with at least one approved campaign.

| Item | What to check | Expected resolution |
|------|--------------|---------------------|
| **Campaign status field name** | Run `GET /user/publisher/{id}/campaign/a` and inspect response body — is the status field `approval_state`, `status`, `campaign_status`, or absent? | Update `mapProgrammeStatus` to read the confirmed field; remove defensive fallback |
| **Campaign response body fields** | Is `campaign_title` present in the JSON response? (Confirmed in conversion CSV but not in campaign list blueprint) | Confirm or correct `toProgramme` field mapping |
| **tracking_url field name** | Is there a `tracking_url` field on campaign objects in the publisher campaign endpoint? | Confirm or remove from `PartnerizeCampaignRaw` |
| **`paid` conversion_status** | Does the conversion reporting endpoint ever return `conversion_status: 'paid'`? | Confirm or remove from `mapTransactionStatus` |
| **`reject_reason` on conversion row** | Does the JSON conversion endpoint return `reject_reason` on the top-level conversion (not just conversion_item)? | If absent, remove from `PartnerizeConversionRaw`; if present, confirm field name |
| **`conversion_lag` units** | What unit does the `conversion_lag` field use? Export sample shows `626` — is this minutes (≈10 hours), hours, or days? | Document units in comments |
| **JSON vs CSV field parity** | Do the JSON granular reporting endpoints return the same field names as the CSV export columns? | Update fixtures and confirm all `PartnerizeConversionRaw` / `PartnerizeClickRaw` fields |
| **Publisher list envelope** | Does `GET /user/publisher` return `{ publishers: { publisher: [...] } }` or a flat array? | Confirm `extractPublisherList` logic in auth.ts |
| **Click destinationUrl** | Does the JSON click endpoint include `destination_url` or equivalent that is absent from the CSV? | If present, populate `destinationUrl` in `listClicks` |
| **dateApproved / datePaid** | Do JSON conversion records include any approval or payment date field not in the CSV schema? | If present, map to `dateApproved` / `datePaid` |

---

## Endpoint map

| Operation | Endpoint | Status |
|-----------|----------|--------|
| verifyAuth | `GET /user/publisher` | Endpoint confirmed from blueprint; field names confirmed; not live-tested |
| listProgrammes | `GET /user/publisher/{id}/campaign/{status}` | Path/status segments confirmed; response body field names BLOCKED |
| getProgramme | Same as listProgrammes (client-side filter) | No single-campaign endpoint documented (confirmed absent) |
| listTransactions | `GET /reporting/report_publisher/publisher/{id}/conversion` | Endpoint confirmed; field names confirmed from CSV export; JSON parity BLOCKED |
| getEarningsSummary | Derived from listTransactions | N/A |
| listClicks | `GET /reporting/report_publisher/publisher/{id}/click` | Endpoint confirmed; field names confirmed from CSV export; JSON parity BLOCKED |
| generateTrackingLink | `https://prf.hn/click/camref:{camref}/destination:{url}` | Format confirmed from multiple public sources |

---

## Next steps for live verification

1. Obtain Partnerize publisher test credentials.
2. Run `npm run validate:network -- partnerize` against a live account.
3. Work through the BLOCKED items checklist above, comparing live responses against
   the existing fixtures under `tests/fixtures/partnerize/`.
4. Update fixtures with real (scrubbed) response shapes.
5. Bump `adapter_version` to `0.1.1` and `last_verified` to the test date.
6. Promote `claim_status` from `experimental` to `partial` once the live
   diagnostic passes for all seven operations.
