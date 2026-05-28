# Partnerize (Advertiser) — findings

Built from public API documentation as of 2026-05-28; live verification pending
credentials.

---

## Research sources

The following public sources were consulted to build this adapter. All
documentation sites returned HTTP 403 to automated fetch during the initial PR.
Field names and endpoint shapes are sourced from web-search result fragments
and third-party integration guides.

- **Partnerize Brands API documentation** (primary):
  https://api-docs.partnerize.com/brand/ — returned 403 to automated fetch.
- **Partnerize API on Apiary** (mirror):
  https://partnerize.docs.apiary.io/ — returned 403 to automated fetch.
- **Web search summaries**: confirmed auth scheme (HTTP Basic,
  `application_key:user_api_key`), base URL (`https://api.partnerize.com/v3`),
  campaign listing path (`/v3/brand/campaigns`), analytics path
  (`/v3/brand/analytics/metrics`), and conversions bulk path
  (`/v3/brand/campaigns/{campaignID}/conversions/bulk`).
- **dltHub Partnerize context page** (integration guide):
  https://dlthub.com/context/source/partnerize — returned 403 to automated fetch.

---

## Known uncertainties (TODO(verify))

The following fields and behaviours are marked `// TODO(verify)` in the adapter
source and must be confirmed against a live Partnerize brand account before
promoting to `partial` or `production`.

| Location | Uncertainty |
|---|---|
| `auth.ts` | Exact Application Key format / length. |
| `adapter.ts::mapCampaignStatus` | Enumerated campaign status values (e.g. `active`, `paused`, `closed` — exact strings). |
| `adapter.ts::mapConversionStatus` | Enumerated conversion status values (e.g. `approved`, `pending`, `rejected` — exact strings). |
| `adapter.ts::mapPublisherStatus` | Enumerated publisher status values. |
| `adapter.ts::listBrands` | Response envelope field names for campaign list pagination and `apiEnabled` semantics. |
| `adapter.ts::listTransactions` | Query parameter names for date filtering (`start_date` vs `from`, etc.) and status filtering. |
| `adapter.ts::listMediaPartners` | Whether the path ends in `/publishers` or `/partners` against a live account. |
| `adapter.ts::getProgrammePerformance` | Query parameter names for `campaign_id`, `publisher_id`, `start_date`, `end_date`. Response envelope shape. |
| `adapter.ts::toTransaction` | Date field names (`click_time`, `conversion_time`, `approved_at`, `paid_at`). |

---

## Observed API behaviour (unverified)

The following is sourced from public documentation fragments and may not
accurately reflect the current Partnerize Brand API behaviour:

- **Auth scheme**: HTTP Basic, `Authorization: Basic base64(application_key:user_api_key)`.
  Both keys come from the same dashboard page (Settings → API Credentials).
- **Base URL**: `https://api.partnerize.com` (v3 path prefix: `/v3/brand/`).
- **Campaigns endpoint**: `GET /v3/brand/campaigns` — returns campaigns visible
  to the authenticated user.
- **Conversions endpoint**: `GET /v3/brand/campaigns/{campaignID}/conversions/bulk`
  (bulk variant documented publicly; singular variant assumed to exist).
- **Analytics endpoint**: `GET /v3/brand/analytics/metrics`.
- **Publishers endpoint**: assumed `GET /v3/brand/campaigns/{campaignID}/publishers`;
  Partnerize documentation uses "publishers" and "partners" interchangeably.

---

## Next steps

1. Obtain a live Partnerize brand account and run:
   ```
   affiliate-networks-mcp test partnerize-advertiser
   ```
2. Fix any `// TODO(verify)` fields and bump `adapter_version` to `0.1.1`.
3. Promote `claim_status` from `experimental` to `partial` once the seven
   canonical operations are confirmed against a live account.
