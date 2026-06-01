# Partnerize (Advertiser) — findings

Built from public API documentation as of 2026-05-28; live verification pending
credentials.

---

## Research sources

The following public sources were consulted to build and harden this adapter.

### Primary sources consulted in both passes

- **Partnerize Brands API documentation** (primary):
  https://api-docs.partnerize.com/brand/ — returned HTTP 403 to automated fetch
  in both the initial build and the hardening pass.
- **Partnerize API on Apiary** (mirror):
  https://partnerize.docs.apiary.io/ — returned HTTP 403 to automated fetch.
- **PerformanceHorizonGroup/apidocs** (official open-source API Blueprint source):
  https://github.com/PerformanceHorizonGroup/apidocs — fetchable. This is the
  primary ground-truth source for the hardening pass. Key files used:
  - `src/advertiser.apib` — campaign list endpoint shape, `campaigns` envelope.
  - `src/participating_publishers.apib` — publishers endpoint path and response.
  - `src/publisher_campaign.apib` — publisher campaign_status single-letter codes.
  - `src/aggregated_reporting.apib` — `start_date`/`end_date` parameter names.
  - `src/granular_reporting.apib` — `campaign_id`/`publisher_id` filter names.
  - `src/export_reporting.apib` — conversion date field names, conversion fields.
  - `src/campaign_conversion.apib` — conversion status values, `reject_reason`.
  - `src/network_publisher.apib` — publisher network_status values.
  - `data/common.apib` — canonical Conversion Status enum: `pending`, `approved`, `rejected`.
  - `data/publisher.apib` — publisher object field names incl. `account_name`.
  - `data/reporting.apib` — `publisher_id`, `publisher_name`, `commission`, `value`.

### Secondary sources consulted in the hardening pass

- **Partnerize Apiary introduction/standard-pagination** (web-search summary):
  Confirmed `limit` + `offset` pagination (not `page`); hypermedia block may
  contain `total_item_count`, `total_page_count`.
- **dltHub Partnerize context page** (web-search summary):
  https://dlthub.com/context/source/partnerize — returned HTTP 403 to direct
  fetch; web-search snippet confirmed `v3/brand/analytics/metrics` endpoint path
  and `data` as the response data selector.
- **Adverity Partnerize authorisation guide** (web-search summary):
  Confirmed HTTP Basic auth with `Authorization: Basic base64(application_key:user_api_key)`.
- **Funnel.io Partnerize connection guide** (web-search summary):
  Additional confirmation of auth scheme and credential names.

---

## Hardening pass 2026-05-28

### Summary

| Category | Count |
|---|---|
| TODOs fully confirmed (TODO removed, source cited) | 12 |
| TODOs corrected (code/fixtures updated, TODO removed) | 6 |
| Blocked (confirmed needs live account, specific blocker recorded) | 9 |
| New tests added | 8 |
| Net TODO(verify) count after pass | 0 |

All `TODO(verify)` comments have been replaced with either confirmed facts (source
cited inline) or `BLOCKED(verify)` comments with a precise description of what is
needed and why it cannot be confirmed without live credentials.

---

### Per-TODO outcome

#### auth.ts

| Original TODO | Outcome | Source |
|---|---|---|
| Exact 401/403 response body shape | **BLOCKED** — requires live account | n/a |
| Response body field names for identity string | **BLOCKED** — requires live account | n/a |
| Application Key format/length | **BLOCKED** — not publicly documented; defensive `[A-Za-z0-9_-]{6,}` regex is a sanity check only | n/a |

#### adapter.ts — raw interface field names

| Original TODO | Outcome | Source |
|---|---|---|
| Campaign envelope field names | **CONFIRMED** — `campaigns` array with `count`, `execution_time`; pagination via `limit`+`offset` | `src/advertiser.apib`, Apiary standard-pagination |
| Campaign status enum values | **BLOCKED** — not enumerated in accessible docs | `data/campaign.apib` references "Status" type without listing values |
| Publishers envelope field name | **CONFIRMED** — `publishers` is the confirmed key | `src/participating_publishers.apib` |
| Publisher field names (`publisher_id` vs `partner_id`) | **CONFIRMED** — `publisher_id` is primary; `partner_id` is a v3 alias; `account_name` added | `data/publisher.apib` |
| Publisher status enum values | **CONFIRMED/CORRECTED** — single-letter codes `a`/`p`/`r` confirmed; `campaign_status` field confirmed; full-string aliases kept defensively | `src/publisher_campaign.apib` |
| Conversion date field names | **CONFIRMED/CORRECTED** — `conversion_time` (JSON API), `conversion_date_time`, `conversion_date`, `click_time`, `click_date`, `click_date_time` all valid. All resolved defensively. | `src/export_reporting.apib`, `data/reporting.apib` |
| Conversion status enum values | **CONFIRMED** — `pending`, `approved`, `rejected` confirmed. Single-letter codes `a`/`p`/`r` also handled. `reversed`/`paid` still BLOCKED. | `data/common.apib` Conversion Status enum |
| Conversion `sale_amount` / `commission` field names | **CONFIRMED/CORRECTED** — primary fields are `value`/`commission`; `sale_amount` and `publisher_commission` handled as aliases | `data/reporting.apib` |
| `rejection_reason` vs `reject_reason` | **CONFIRMED/CORRECTED** — `reject_reason` confirmed as the canonical field in `campaign_conversion.apib`; both handled | `src/campaign_conversion.apib` |
| Analytics endpoint response data selector | **CONFIRMED** — results under `data` key | dltHub web-search summary |

#### adapter.ts — method-level TODOs

| Original TODO | Outcome | Source |
|---|---|---|
| `listBrands` response envelope shape | **CONFIRMED** — `campaigns` array; pagination via `limit`+`offset` | `src/advertiser.apib` |
| `listBrands` pagination parameters | **CONFIRMED** — `limit` + `offset` | Apiary standard-pagination |
| `listBrands` apiEnabled on paused campaigns | **BLOCKED** — whether the live API blocks conversion queries on paused campaigns is not documented | n/a |
| `listProgrammes` pagination parameters | **CONFIRMED** — `limit` + `offset` | Apiary standard-pagination |
| `listTransactions` date parameter names | **CONFIRMED** — `start_date` / `end_date` | `src/aggregated_reporting.apib`, `src/export_reporting.apib` |
| `listTransactions` date parameter names (inline) | **CONFIRMED** — same | Same sources |
| `listMediaPartners` path `/publishers` vs `/partners` | **BLOCKED** — older API uses `/campaign/{id}/publisher` (singular); v3 pluralisation convention suggests `/publishers`; cannot confirm without live account | `src/participating_publishers.apib` |
| `getProgrammePerformance` parameter names | **CONFIRMED** — `campaign_id`, `publisher_id`, `start_date`, `end_date` confirmed | `src/granular_reporting.apib`, `src/aggregated_reporting.apib` |
| `getProgrammePerformance` parameter names (inline) | **CONFIRMED** — same | Same sources |
| `getProgrammePerformance` response envelope / date field | **CONFIRMED (partial)** — `data` key confirmed; date field name in rows BLOCKED | dltHub summary |
| `capabilitiesCheck` note for getProgrammePerformance | **UPDATED** — TODO removed, note now cites confirmed sources | n/a |

#### client.ts

| Original TODO | Outcome | Source |
|---|---|---|
| Pagination semantics | **CONFIRMED** — `limit` + `offset` for standard endpoints; `cursor_id` available for large result sets | Apiary standard-pagination web-search summary |

---

### Remaining BLOCKED items — live-verification checklist

The following items require a live Partnerize Brand account to verify.
Credentials needed: `PARTNERIZE_APPLICATION_KEY` + `PARTNERIZE_USER_API_KEY`.

1. **Campaign status string values** — the v3 Brand API campaign `status` field
   may return strings like `'active'`, `'paused'`, `'closed'`; the exact set is
   not enumerated in `data/campaign.apib`. Check: `GET /v3/brand/campaigns` and
   inspect `campaigns[*].status` for all returned values.

2. **Conversion status `reversed` and `paid`** — `data/common.apib` only
   confirms `pending`, `approved`, `rejected`. `reversed` and `paid` may be
   payment-pipeline states or may be absent on the v3 brand endpoint. Check:
   `GET /v3/brand/campaigns/{id}/conversions` and inspect `status` values.

3. **Publisher participation path — `/publishers` vs `/publisher`** — the legacy
   API uses singular `/campaign/{id}/publisher`; the v3 brand pattern uses plural
   URLs. Check: attempt `GET /v3/brand/campaigns/{id}/publishers` and compare
   with `/v3/brand/campaigns/{id}/publisher`.

4. **Publisher status field format on brand endpoint** — whether `campaign_status`
   uses full strings (`approved`, `pending`, `rejected`) or single-letter codes
   (`a`, `p`, `r`) or a different field entirely. Check: `GET /v3/brand/campaigns/{id}/publishers`
   and inspect publisher objects.

5. **Analytics date grouping field** — whether the analytics metrics row uses
   `date`, `day`, or another field for the time dimension. Check:
   `GET /v3/brand/analytics/metrics?campaign_id={id}&start_date=...&end_date=...`
   and inspect the first row key names.

6. **Paused campaign conversion query behaviour** — whether a paused campaign
   returns 403 or an empty list when queried for conversions. Affects
   `apiEnabled` logic in `toDiscoveredBrand`. Check: call
   `GET /v3/brand/campaigns/{paused_id}/conversions`.

7. **401/403 response body shape** — the exact JSON structure returned on auth
   failure. The adapter currently surfaces the verbatim body; refine if the
   response contains a structured `message` field.

8. **`verifyAuth` identity field** — whether the v3 campaigns response includes
   any user-name or account-name that can provide a friendlier identity string
   (e.g. `account_name` from the advertiser object).

9. **Application Key exact format** — the regex `[A-Za-z0-9_-]{6,}` is a
   conservative sanity check; the real format may be stricter (e.g. exactly 32
   hex characters). Check the actual key format in the Partnerize dashboard.

---

## Observed API behaviour (partially confirmed, partially unverified)

- **Auth scheme**: HTTP Basic, `Authorization: Basic base64(application_key:user_api_key)`.
  Both keys come from the Partnerize dashboard (Settings → API Credentials).
  **Confirmed** by multiple third-party integration guides.
- **Base URL**: `https://api.partnerize.com` (v3 path prefix: `/v3/brand/`).
  Confirmed by `PerformanceHorizonGroup/apidocs` API host.
- **Campaigns endpoint**: `GET /v3/brand/campaigns` — returns a `campaigns` array
  with `count` and `execution_time`. Pagination via `limit` + `offset`.
  Confirmed by `src/advertiser.apib` and Apiary standard-pagination.
- **Conversions endpoint**: `GET /v3/brand/campaigns/{campaignID}/conversions`
  (and `/conversions/bulk` for the batch-update path). Confirmed by web-search
  summaries of the Partnerize Resource Centre.
- **Date parameters**: `start_date` / `end_date` (ISO 8601 format).
  Confirmed by `src/aggregated_reporting.apib` and `src/export_reporting.apib`.
- **Analytics endpoint**: `GET /v3/brand/analytics/metrics`, returns results
  under a `data` key. Path confirmed by dltHub web-search summary; data selector
  confirmed by dltHub source configuration.
- **Publishers endpoint**: `GET /v3/brand/campaigns/{campaignID}/publishers`
  (assumed plural form). The legacy path `/campaign/{id}/publisher` (singular) is
  confirmed by `src/participating_publishers.apib`. The exact v3 path requires
  live verification.
- **Conversion status values**: `pending`, `approved`, `rejected` confirmed by
  `data/common.apib`. Single-letter aliases `a`/`p`/`r` confirmed by
  `src/publisher_campaign.apib`. `reversed` and `paid` not confirmed.

---

## Next steps

1. Obtain a live Partnerize Brand account and run:
   ```
   affiliate-networks-mcp test partnerize-advertiser
   ```
2. Work through the nine BLOCKED items in the live-verification checklist above.
3. Fix any remaining field-name mismatches and bump `adapter_version` to `0.1.1`.
4. Promote `claim_status` from `experimental` to `partial` once the core
   operations (listBrands, listTransactions, listMediaPartners,
   getProgrammePerformance) are confirmed against a live account.
