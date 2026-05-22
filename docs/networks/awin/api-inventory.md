# Awin API inventory

Date: 2026-05-22. Scope: publisher-side public Awin APIs first. Advertiser
APIs are noted as roadmap only; CJ, Impact, Rakuten, and eBay are unchanged by
this Awin reference implementation.

Primary sources:

- Awin publisher API list:
  https://success.awin.com/articles/en_US/Knowledge/what-types-of-api-calls-does-awin-offer
- Awin API introduction:
  https://help.awin.com/apidocs/introduction-1
- Awin API authentication:
  https://help.awin.com/apidocs/api-authentication

## Publisher API coverage

| Surface | Public endpoint | Auth | MCP coverage | Implementation status | Live-test status | Gaps / notes |
| --- | --- | --- | --- | --- | --- | --- |
| Accounts | `GET /accounts?type=publisher` | Bearer token | `affiliate_awin_list_accounts`, canonical `verify_auth` | Supported | Validated read-only with supplied publisher token on 2026-05-22 | Used to derive `AWIN_PUBLISHER_ID`. |
| Programmes | `GET /publishers/{publisherId}/programmes` | Bearer token | canonical `affiliate_awin_list_programmes` | Supported | Validated read-only on 2026-05-22; sample advertiser ID `3` returned | Relationship filter supports joined, pending, suspended, rejected, not joined. |
| Programme details | `GET /publishers/{publisherId}/programmedetails` | Bearer token | canonical `get_programme`, `affiliate_awin_get_programme_details` | Supported | Validated read-only on 2026-05-22 with sample advertiser ID `3` | Awin requires `advertiserId`; relationship defaults to joined. |
| Commission groups | `GET /publishers/{publisherId}/commissiongroups` | Bearer token | `affiliate_awin_list_commission_groups` | Supported | Validated read-only on 2026-05-22 with 13 sample groups | Requires active relationship with the advertiser. |
| Commission-sharing rules | `GET /publishers/{publisherId}/commissionsharingrules` | Bearer token | `affiliate_awin_list_commission_sharing_rules` | Supported | Fixture-tested; live test pending | Only useful for service partner publisher accounts; non-service accounts may return empty or forbidden. |
| Transactions list | `GET /publishers/{publisherId}/transactions/` | Bearer token | canonical `affiliate_awin_list_transactions` | Supported | Validated empty-but-200 for recent 7-day window on 2026-05-22 | Awin caps date windows at 31 days; adapter chunks wider ranges. |
| Transactions by ID | `GET /publishers/{publisherId}/transactions?ids=...` | Bearer token | `affiliate_awin_get_transactions_by_id` | Supported | Fixture-tested; live skipped on 2026-05-22 because the account returned no recent sample transaction ID | Supports `showBasketProducts` when Awin exposes basket data. |
| Transaction queries | `GET /publisher/{publisherId}/transactionqueries` | Bearer token | `affiliate_awin_list_transaction_queries` | Supported | Fixture-tested; live test pending | Useful for missing, incorrect, declined, or untracked transaction enquiries. |
| Advertiser performance report | `GET /publishers/{publisherId}/reports/advertiser` | Bearer token | `affiliate_awin_get_advertiser_performance` | Supported | Validated read-only on 2026-05-22 with 1 report row | Aggregates clicks, impressions, transactions, and commission by advertiser. |
| Creative performance report | `GET /publishers/{publisherId}/reports/creative` | Bearer token | `affiliate_awin_get_creative_performance` | Supported | Validated empty-but-200 on 2026-05-22 | Aggregates by creative and tag. |
| Campaign performance report | `GET /publishers/{publisherId}/reports/campaign` | Bearer token | `affiliate_awin_get_campaign_performance` | Supported | Validated empty-but-200 on 2026-05-22 | Requires campaign tracking usage for meaningful rows; supports interval aggregation. |
| Link Builder single | `POST /publishers/{publisherId}/linkbuilder/generate` | Bearer token | `affiliate_awin_generate_tracking_links` for one request | Supported | Fixture-tested; live read-only quota pending, one non-shortened live generation pending | Canonical `generate_tracking_link` still builds deterministic long URLs without an API call. |
| Link Builder batch | `POST /publishers/{publisherId}/linkbuilder/generate-batch` | Bearer token | `affiliate_awin_generate_tracking_links` for 2-100 requests | Supported | Fixture-tested; live test pending | Awin batch generation does not support short links. |
| Link Builder quota | `GET /publishers/{publisherId}/linkbuilder/quota` | Bearer token | `affiliate_awin_get_link_builder_quota` | Supported | Validated read-only on 2026-05-22; response omitted limit/usage for this account | Relevant for short-link generation limits. |
| Offers | `POST /publisher/{publisherId}/promotions` | Bearer token | `affiliate_awin_list_offers` | Supported with live caveat | Fixture-tested; live returned Awin HTTP 500 on 2026-05-22 for the supplied account | Filters cover advertiser IDs, membership, type, status, regions, exclusive-only, updated-since, and pagination. Singular endpoint is correct; plural path returned 404. |
| Product feed list | `GET https://productdata.awin.com/datafeed/list/apikey/{key}` | Separate feed API key | `affiliate_awin_list_product_feeds` | Actionable stub | Not live-tested; credential not provided | Public but uses a different product feed key. Needs streaming/download design before live implementation. |
| Product feed download | Legacy ProductServe URL or enhanced `GET /publishers/{publisherId}/awinfeeds/download/{advertiserId}-{vertical}-{locale}.jsonl` | Feed key for legacy list; bearer for enhanced feed | `affiliate_awin_download_product_feed` | Actionable stub | Not live-tested | Feed responses can be large CSV/JSONL; should not be returned as a plain tool payload. |
| Proof of Purchase | `POST /publishers/{publisherId}/advertiser/{advertiserId}/orders` | `x-api-key` plus Awin activation | `affiliate_awin_submit_proof_of_purchase_transaction` | Actionable stub | Not live-tested and no live writes attempted | Public but write-capable and activation-gated; requires Awin Partner Development and advertiser CLO activation. |

## Advertiser API roadmap

Advertiser APIs are out of this PR's implementation scope. The public Awin docs
include advertiser-side surfaces such as publisher performance reports,
campaign reports, creative reports, transaction validation, Conversion API, and
Create Offers. Those should be inventoried in a future advertiser/brand track
with separate credentials, personas, write-safety rules, and live-test plans.

## Journey coverage

| Journey | Tools / prompts | Status |
| --- | --- | --- |
| Connect account and derive publisher ID | `affiliate_awin_list_accounts`, canonical `verify_auth` | Fixture and live auth smoke covered. |
| Daily performance brief | `awin_daily_performance_brief`, advertiser reports, transactions | Prompt and report fixtures covered; live read-only pending. |
| Pending/reversed/unpaid investigation | `awin_transaction_investigation`, transactions by ID, transaction queries | Fixture covered; live sample transaction pending. |
| Offer discovery and link generation | `awin_offer_finder`, `affiliate_awin_list_offers`, `affiliate_awin_generate_tracking_links` | Fixture covered; live non-shortened link pending. |
| Programme opportunity scan | `awin_programme_opportunity_scan`, programme details, commission groups | Fixture covered; live joined advertiser pending. |
| Gated flows fail safely | product feed and Proof of Purchase stubs | Fixture covered; intentionally no live writes. |
