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

The Merchant API (for listing merchants/programmes) is at `https://merchants.skimapis.com`
and requires a Product Key in addition to the OAuth2 bearer token. The Product Key
is only issued to Managed (enterprise) Skimlinks accounts. This is confirmed by:
- https://developers.skimlinks.com/product-key.html
- https://support.skimlinks.com/hc/en-us/articles/360024600634-What-is-the-Merchant-API

The `listProgrammes` and `getProgramme` operations therefore throw `NotImplementedError`
for standard publisher accounts.

## Tracking link format

Confirmed from Skimlinks documentation and live link inspection by the community:

```
https://go.skimresources.com/?id={publisherId}X{siteId}&xs=1&url={encodedDestination}
```

Where:
- `id` = `{publisherId}X{siteId}` — for single-site publishers, siteId = publisherId.
- `xs=1` — enables Skimlinks extended tracking mode (standard for deeplinks).
- `url` — URL-encoded destination URL.

The `X` separator and `xs=1` flag are confirmed from community observations of
live Skimlinks links (format is consistent across multiple publisher reports).

## Click data

Not available via the public publisher Reporting API. Confirmed from:
- Skimlinks documentation listing available report methods (no click-level report).
- The legacy API docs listing: Report Commissions History, Report Commissions,
  Report Days, Report Merchants, Report Days by Merchant — no clicks endpoint.

## TODO(verify) annotations

The adapter marks the following with `// TODO(verify)` — these should be confirmed
against a live account before bumping `claim_status` to `partial`:

1. The exact Merchant API base URL (`https://merchants.skimapis.com`).
2. The exact response field names for commissions (the 2022 rename may have left
   old names as aliases, or may have removed them entirely).
3. Whether the commissions endpoint supports cursor-based pagination or only
   page-number pagination.
4. The maximum date window per commissions API call (adapter assumes no cap).
5. Whether `go.skimresources.com/?id={publisherId}X{publisherId}` works for
   single-site publishers or if the siteId is always distinct from the publisherId.

## Claim status rationale

`experimental` — the adapter implements 4 of 7 canonical operations (verifyAuth,
listTransactions, getEarningsSummary, generateTrackingLink) and throws
`NotImplementedError` for the remaining 3 (listProgrammes, getProgramme, listClicks)
for documented reasons. No live account validation has been performed.
