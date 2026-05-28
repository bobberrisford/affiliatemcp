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
  - `src/intro.apib` — authentication scheme, base URL
  - `src/publisher.apib` — publisher account endpoints
  - `src/publisher_campaign.apib` — campaign list endpoint, status path segment
  - `src/granular_reporting.apib` — conversion and click reporting endpoints
  - `src/export_reporting.apib` — CSV export field names (used to infer JSON
    reporting field names; not confirmed to match exactly)

- **Partnerize tracking link format**:
  Confirmed from multiple public integration guides:
  `https://prf.hn/click/camref:{camref}/destination:{encodedUrl}`
  The camref format is consistent across TransferWise, Expedia, and Plum Guide
  publisher guides available at docs.partnerize.com and help.phgsupport.com.

- **Web search summaries**: confirmed auth scheme (HTTP Basic,
  `application_key:user_api_key`, base64-encoded), base URL
  (`https://api.partnerize.com`), and general endpoint naming patterns.

---

## Known uncertainties (TODO(verify))

The following fields and behaviours are sourced from documentation but have not
been confirmed against a live Partnerize publisher account:

1. **Conversion response envelope shape**: The JSON reporting endpoint at
   `/reporting/report_publisher/publisher/{id}/conversion` is documented as
   returning a "Publisher Conversion Wrapper" but the blueprint does not
   provide a concrete JSON example. The adapter assumes the envelope matches the
   export_reporting field names (`conversion_id`, `conversion_date_time`,
   `publisher_commission`, `conversion_status`, etc.). These may differ.

2. **Campaign list response body fields**: The publisher campaign endpoint
   returns campaigns but the exact JSON field names for approval status
   (`approval_state` vs `status`) are unconfirmed. The adapter reads both and
   normalises defensively.

3. **Publisher ID derivation**: The `/user/publisher` endpoint response shape
   assumes `{ publishers: { publisher: [...] } }` based on the API blueprint.
   The live response may use a flat array or a different envelope.

4. **Click endpoint response fields**: The publisher click endpoint field names
   (`click_id`, `set_time`, `referer`) are inferred from the CSV export
   documentation. JSON field names may differ.

5. **Pagination mechanism**: The granular reporting docs mention cursor-based
   pagination via a `cursor_id` header attribute but do not confirm whether the
   cursor appears in the response body or headers. The adapter does not yet
   follow pagination cursors.

6. **commission vs publisher_commission**: The adapter uses `publisher_commission`
   as the publisher's earnings amount, preferring it over `commission` (which
   may be the advertiser's network fee). This interpretation is inferred from
   the CSV export field descriptions; live confirmation needed.

---

## Endpoint map

| Operation | Endpoint | Status |
|-----------|----------|--------|
| verifyAuth | `GET /user/publisher` | Documented; unverified |
| listProgrammes | `GET /user/publisher/{id}/campaign/{status}` | Documented; unverified |
| getProgramme | Same as listProgrammes (client-side filter) | Inferred |
| listTransactions | `GET /reporting/report_publisher/publisher/{id}/conversion` | Documented; unverified |
| getEarningsSummary | Derived from listTransactions | N/A |
| listClicks | `GET /reporting/report_publisher/publisher/{id}/click` | Documented; unverified |
| generateTrackingLink | `https://prf.hn/click/camref:{camref}/destination:{url}` | Format confirmed |

---

## Next steps for live verification

1. Obtain Partnerize publisher test credentials.
2. Run `npm run validate:network -- partnerize` against a live account.
3. Compare response shapes against the `// TODO(verify)` annotations in
   `src/networks/partnerize/adapter.ts` and `src/networks/partnerize/auth.ts`.
4. Update fixtures under `tests/fixtures/partnerize/` with real (scrubbed)
   response shapes.
5. Bump `adapter_version` to `0.1.1` and `last_verified` to the test date.
6. Promote `claim_status` from `experimental` to `partial` once the live
   diagnostic passes for all seven operations.
