# Sovrn Commerce — Findings

**Built from public docs as of 2026-05-28; live verification pending credentials.**

---

## Summary

This adapter was built using the publicly accessible Sovrn Commerce developer documentation and knowledge base. No live credentials were available at time of authoring. All field names, endpoint paths, and response shapes are marked `// TODO(verify)` in the adapter source and should be confirmed against a live account before promoting the `claim_status` from `experimental`.

---

## Documentation sources used

| Source | URL | Notes |
|--------|-----|-------|
| Sovrn Developer Centre | https://developer.sovrn.com/ | Reference for endpoint paths; 403 on direct fetch |
| Sovrn Knowledge Base (API implementation) | https://knowledge.sovrn.com/how-to-implement-sovrn-commerce-apis | Authentication format confirmed |
| VigLink support (secret key location) | https://support.viglink.com/hc/en-us/articles/360007678554 | Key location in dashboard |
| VigLink Developer Guide | https://support.viglink.com/hc/en-us/articles/216688298-VigLink-Developer-Guide | Header format |
| Strackr Sovrn Commerce API docs | https://strackr.com/docs/sovrn-commerce | Cross-reference (403 on fetch) |
| Sovrn Blog (transactions API launch) | http://www.viglink.com/blog/2018/05/02/understand-the-click-to-purchase-funnel-with-viglinks-transaction-reporting-api/ | Date param pattern |
| clean-links GitHub issue | https://github.com/Sh1d0w/clean-links/issues/20 | redirect.viglink.com URL format |

---

## Confirmed facts (from public documentation)

1. **Authentication header format**: `Authorization: secret {SECRET_KEY}` — the word "secret" is a literal prefix, not a scheme name. Confirmed across multiple independent sources.

2. **Base URL**: `https://viglink.io/v1/` — used in official curl examples (e.g. `curl ... viglink.io/v1/reports/transactions?clickDate=2023-01-01`).

3. **Transactions endpoint**: `GET /v1/reports/transactions` accepts `clickDate` (YYYY-MM-DD) and returns one day of data per call.

4. **Merchants endpoint**: `GET /v1/reports/merchants` — aggregated merchant performance data. Rate limit of 1 request per 10 seconds (documented for Commerce Merchant APIs).

5. **Tracking link URL pattern**: `https://redirect.viglink.com/?key={SOVRN_API_KEY}&u={encodedUrl}` — observed in the wild and referenced in delink tools.

6. **Two credential types**: SOVRN_SECRET_KEY (server-side, for reporting) and SOVRN_API_KEY (per-site, for links). Both found in Settings → Key icon in the dashboard.

---

## Uncertainties (TODO(verify))

| Field / behaviour | Uncertainty | Where noted |
|-------------------|-------------|-------------|
| Exact JSON field names in `/reports/transactions` | Field names inferred: `revenueId`, `commissionId`, `clickId`, `clickDate`, `commissionDate`, `orderValue`, `publisherNetRevenue`. Confirmed from partial doc snippets but not from a live response. | adapter.ts `SovrnTransactionRaw` |
| Exact JSON field names in `/reports/merchants` | Field names inferred: `merchant`, `merchantId`, `clicks`, `revenue`, `commission`, `epc`. Not confirmed from a live response. | adapter.ts `SovrnMerchantRaw` |
| `merchantId` presence | It is not clear whether the merchants endpoint always returns a numeric `merchantId`. The adapter falls back to a slugified name if absent. | adapter.ts `toProgramme` |
| Currency field name | The `currency` field name in responses is inferred; Sovrn may use a different casing or field name. | adapter.ts `SovrnTransactionRaw` |
| Status field existence | There is no documented status field in Sovrn Commerce transactions. The adapter maps any present `status` string but defaults to `'other'`. | adapter.ts `mapTransactionStatus` |
| `/reports/merchants` date range support | It is not confirmed whether `clickDate` accepts a range or only a single date for this endpoint. | adapter.ts `listProgrammes` |
| `/reports/transactions` rate limit | The 1-request-per-10s rate limit is documented for Commerce Merchant APIs; unclear if it also applies to transactions. | adapter.ts `generateDateRange` comment |
| Auth-check endpoint | Using `/reports/merchants?clickDate=today` as the auth-check. A dedicated whoami endpoint would be more reliable but is not documented. | auth.ts `verifyAuth` |
| `redirect.viglink.com` required params | `opt=true` and `prodOvrd=WRA` appear in some observed URLs but are not required for basic tracking. Adapter omits them. | adapter.ts `generateTrackingLink` |

---

## Recommended verification steps (for first live-account test)

1. Call `verifyAuth()` with a valid Secret key; confirm the response is 200 and inspect the body structure.
2. Call `GET /v1/reports/merchants?clickDate=YYYY-MM-DD` and compare the JSON field names to `SovrnMerchantRaw` in adapter.ts.
3. Call `GET /v1/reports/transactions?clickDate=YYYY-MM-DD` (a date known to have traffic) and compare the JSON field names to `SovrnTransactionRaw`.
4. Confirm whether a `status` field appears on transactions, and what values it takes.
5. Confirm whether `currency` appears in the response.
6. Generate a tracking link and click it manually; confirm it resolves to the correct destination with Sovrn tracking applied.
7. Update all `// TODO(verify)` comments in the adapter and bump `last_verified` in `network.json`.
8. Promote `claim_status` from `experimental` to `partial` once the above steps pass.
