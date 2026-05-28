# Skimlinks adapter — research findings

Built from public API documentation as of 2026-05-28; live verification pending credentials.

## Documentation sources used

- Skimlinks Reporting API overview: https://developers.skimlinks.com/reporting.html
- Skimlinks Merchant API overview: https://developers.skimlinks.com/
- Skimlinks Commission Reporting API legacy docs: https://api-reports.skimlinks.com/doc/doc_report_v0.3.html
- Skimlinks Apiary reporting docs: https://jsapi.apiary.io/apis/skimlinksreporting/
- Skimlinks Publisher support: https://support.skimlinks.com/hc/en-us/articles/223835348-What-is-the-Reporting-API
- Skimlinks Merchant API support: https://support.skimlinks.com/hc/en-us/articles/360024600634-What-is-the-Merchant-API
- September 2022 API changes: https://support.skimlinks.com/hc/en-us/articles/6993058288541-September-12-2022-Changes-to-Merchant-and-Commissions-APIs
- Skimlinks deeplink documentation: https://developers.skimlinks.com/link.html
- Skimlinks SDK (Python): https://github.com/skimhub/skimlinks-sdk
- Community integration notes (Strackr): https://strackr.com/docs/skimlinks

## Authentication model

Skimlinks uses OAuth2 client-credentials grant. Confirmed from:
- Skimlinks API documentation referencing Client ID + Client Secret.
- Integration guides stating credentials are exchanged for a bearer token.
- The Skimlinks SDK requiring `--client-id` and `--client-secret` parameters.

Token endpoint: `https://authentication.skimapis.com/access_token`
- Grant type: `client_credentials`
- Body: `application/x-www-form-urlencoded`
- Response: `{ access_token, token_type, expires_in }`

The exact token endpoint URL was confirmed from the task brief (which references
the public Skimlinks developer docs) and is consistent with the `skimapis.com`
domain used for other Skimlinks services.

## Reporting API

Base URL: `https://api-reports.skimlinks.com`

Commissions endpoint (confirmed from legacy docs + community reports):
```
GET /publishers/{publisherId}/commissions
  ?date_from=YYYY-MM-DD
  &date_to=YYYY-MM-DD
  [&status=pending|approved|declined|paid]
  [&merchant_id=N]
```

Response field names (confirmed from legacy docs at `api-reports.skimlinks.com/doc/doc_report_v0.3.html`
and community integration reports):
- `commissionId` / `commissionID`
- `amount` / `commissionValue` (field name changed in 2022 API update)
- `orderValue`
- `currency`
- `status` — values: `pending`, `approved`, `declined`, `paid`
- `merchantId` / `merchantID`
- `merchantName`
- `transactionDate`
- `approvedDate`
- `paidDate`
- `clickTime`
- `declineReason`
- `customId` (SubID tracking)

The September 2022 API changes standardised naming conventions, renaming some
fields. The adapter reads both old and new names defensively.

## Merchant API

The Merchant API (for listing merchants/programmes) is at `https://api-merchants.skimlinks.com`
and requires a Product Key in addition to the OAuth2 bearer token. The Product Key
is only issued to Managed (enterprise) Skimlinks accounts. This is confirmed by:
- https://developers.skimlinks.com/product-key.html
- https://support.skimlinks.com/hc/en-us/articles/360024600634-What-is-the-Merchant-API
- https://blog.rapidapi.com/directory/skimlinks-merchant/ (lists endpoint as api-merchants.skimlinks.com)

The `listProgrammes` and `getProgramme` operations therefore throw `NotImplementedError`
for standard publisher accounts.

## Tracking link format

Confirmed from Skimlinks publisher support documentation and live URL observation:

```
https://go.skimresources.com/?id={publisherId}X{domainId}&xs=1&url={encodedDestination}
```

Where:
- `id` = `{publisherId}X{domainId}` — the Domain ID is **always a separate number**
  from the Publisher ID (not the same value). Each registered site/domain in a
  Skimlinks account is assigned its own domain ID. Source:
  https://support.skimlinks.com/hc/en-us/articles/223835748
  Live URL example: `id=110320X1568188` (publisher ID 110320, domain ID 1568188).
- `xs=1` — enables Skimlinks extended tracking mode (standard for deeplinks).
- `url` — URL-encoded destination URL.

**Breaking correction from original adapter:** the original code generated
`{publisherId}X{publisherId}` assuming the two values are the same — this is
incorrect. The Domain ID is always distinct and must be supplied separately as
`SKIMLINKS_DOMAIN_ID`. Find it in Hub → Settings → Sites.

## Click data

Not available via the public publisher Reporting API. Confirmed from:
- Skimlinks documentation listing available report methods (no click-level report).
- The legacy API docs listing: Report Commissions History, Report Commissions,
  Report Days, Report Merchants, Report Days by Merchant — no clicks endpoint.

---

## Hardening pass 2026-05-28

### Outcomes per TODO/stub

| Item | Outcome | Source | Notes |
|------|---------|--------|-------|
| `SKIMLINKS_MERCHANT_BASE_URL = 'https://merchants.skimapis.com'` (client.ts TODO(verify)) | **CORRECT** | https://blog.rapidapi.com/directory/skimlinks-merchant/ | Correct URL is `https://api-merchants.skimlinks.com`. Old placeholder was unverified. |
| Commission field names (adapter.ts:145 TODO(verify)) | **CONFIRM** (defensive read) | https://api-reports.skimlinks.com/doc/doc_report_v0.3.html (via search snippets) | Field names `commissionId`, `amount`, `commissionValue`, `merchantId`, etc. confirmed from API v0.3 docs. Adapter already reads both old/new names defensively. |
| Max date window (adapter.ts:365 TODO(verify)) | **BLOCKED** | No public source found | No documented cap found in any accessible page. Live account test required. |
| Pagination type (adapter.ts:365 TODO(verify)) | **CONFIRM** (page-based) | Search snippet from api-reports.skimlinks.com/doc/doc_report_v0.3.html | Pagination is page-based: response includes `pagination.total`, `pagination.from`, `pagination.itemCount`; query params are `limit` and `page`. |
| Deeplink `id` format — `{publisherId}X{publisherId}` (adapter.ts:579 TODO(verify)) | **CORRECT** (critical bug fix) | https://support.skimlinks.com/hc/en-us/articles/223835748 + live URL observation | The second component is the **Domain ID** (not publisher ID repeated). The format is `{publisherId}X{domainId}`. A new credential `SKIMLINKS_DOMAIN_ID` is now required. |
| `listProgrammes` / `getProgramme` stubs | **BLOCKED** | https://developers.skimlinks.com/product-key.html, https://blog.rapidapi.com/directory/skimlinks-merchant/ | Requires Managed account + Product Key. No public endpoint available without a Product Key. Exact requirement: Managed Skimlinks account tier + Product Key (available on request via Skimlinks partnerships team). |
| `listClicks` stub | **BLOCKED** | https://api-reports.skimlinks.com/doc/doc_report_v0.3.html (search snippets listing available methods) | No click-level endpoint in the public publisher Reporting API. Would require a separate click analytics product not available via standard publisher API. |

### Live verification checklist

The following items remain BLOCKED pending live account access:

1. **Maximum date window per commissions API call**
   - Needed: any valid publisher API credentials + a Skimlinks account with 30+ days of data
   - Test: send a request with `date_from` = 90+ days ago; observe if the API enforces a cap or returns all data

2. **Commission API field names — exact names post-2022**
   - Needed: any valid publisher API credentials
   - Test: inspect one real commission response object for all returned field names; compare against the `SkimlinksCommissionRaw` interface

3. **listProgrammes / getProgramme**
   - Needed: Managed Skimlinks account with a Product Key (not available to standard publishers)
   - Credential required: `SKIMLINKS_PRODUCT_KEY` (obtain from Skimlinks partnerships team; then add to `env_vars` in network.json and implement in adapter)

4. **OAuth token endpoint — confirm `authentication.skimapis.com/access_token`**
   - Needed: any valid publisher Skimlinks credentials
   - Test: POST to the endpoint with client_credentials grant; confirm 200 response with `access_token`

5. **Deeplink Domain ID — confirm `{publisherId}X{domainId}` tracking works end-to-end**
   - Needed: valid publisher account + a test destination URL
   - Test: generate a deeplink with the new `SKIMLINKS_DOMAIN_ID` credential and verify it routes correctly

## Claim status rationale

`experimental` — the adapter implements 4 of 7 canonical operations (verifyAuth,
listTransactions, getEarningsSummary, generateTrackingLink) and throws
`NotImplementedError` for the remaining 3 (listProgrammes, getProgramme, listClicks)
for documented reasons. A critical bug was corrected in the deeplink `id` parameter
format (publisherId vs domainId). No live account validation has been performed.
