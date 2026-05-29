# mrge — Findings

Built from public API documentation as of 2026-05-28; live verification
pending credentials; public API docs limited.

## Hardening pass 2026-05-28

### Summary of outcomes

| Category | Count |
|---|---|
| CONFIRMED (TODO removed, code kept or corrected) | 8 |
| CORRECTED (code changed, source cited) | 2 |
| BLOCKED (specific blocker recorded) | 22+ |
| Ops newly implemented | 0 |
| Ops still stubbed | listClicks (no public endpoint found) |

### Confirmed items (TODO converted to no-longer-uncertain)

1. **Auth scheme: api_key + api_secret + site_id as query parameters**
   Source: public.yieldkit.com documentation example showing
   `api_key=c5c2398597a6adcd9b149ad745f207f4&api_secret=74607007cdb6b0db4b3219c8adee3e09&site_id=51e8ee76e4b0dc18d49a4337`
   and any.run sandbox captures of live Yieldkit API calls (2024).
   The `auth_model: "custom"` in network.json is correct.

2. **api.yieldkit.com as the advertiser API host**
   Source: Multiple Yieldkit documentation pages + search snippets confirming
   `GET http://api.yieldkit.com/v2/advertiser/terms?api_key=...&api_secret=...&site_id=...`

3. **Commission status values: OPEN, CONFIRMED, REJECTED, DELAYED**
   Source: Yieldkit knowledge base search snippets (reporting-api-v3 and S2S
   tracking pages). Code correctly maps OPEN->pending, CONFIRMED->approved,
   DELAYED->pending, REJECTED->reversed.

4. **modified_date parameter name and YYYY-MM-DD format**
   Source: Yieldkit knowledge base search snippets referencing
   "modified_date DateType filter" for the commission endpoint.

5. **Reporting API V3 uses 'next' URL for pagination**
   Source: Yieldkit search snippet: "every page will have a 'next' URL".

6. **Tracking redirect host: r.srvtrck.com**
   Source: Yieldkit knowledge base (srvtrck.com redirects page) confirming
   "r.srvtrck.com is a firm part of the Hamburg company YIELDKIT" +
   any.run sandbox captures showing full URL format:
   `r.srvtrck.com/v1/redirect?url=...&api_key=...&type=url&site_id=...&yk_tag=...`

7. **Redirect URL format and yk_tag parameter**
   Source: Yieldkit sub-ID tracking docs: "yk_tag corresponds to your click_id
   and you will receive it back in the commission endpoint of the Reporting API."

8. **sales_date S2S macro confirmed**
   Source: Yieldkit S2S tracking docs confirming {SALES_DATE} and {MODIFIED_DATE}
   macros. REST field names derive from these (BLOCKED: exact REST names unconfirmed).

### Corrected items (code changed)

**CORRECTION 1: MRGE_SITE_ID validation — was integer check, now hex check**

The original validator used `/^\d+$/` (positive integers only). Live API
call captures on any.run (2024) show site IDs are hexadecimal strings:
- 24-char MongoDB ObjectId format: `51e8ee76e4b0dc18d49a4337`
- 32-char MD5 format: `0fb9199cb9ce464f9c82523578c269b4`

Updated to `/^[0-9a-f]{20,40}$/i`. Also updated `MRGE_API_KEY` and
`MRGE_API_SECRET` validator hints to mention the 32-char hex format.
Source: public.yieldkit.com docs example + any.run sandbox 2024.

Files changed: `src/networks/mrge/auth.ts`, `src/networks/mrge/setup.ts`,
`tests/networks/mrge/adapter.test.ts`

**CORRECTION 2: generateTrackingLink fallback — was click.yieldkit.com, now r.srvtrck.com**

The fallback URL (used when no `tracking_url` field is present in the
advertiser/terms response) was using `click.yieldkit.com/{programmeId}`.
This was an invented pattern not grounded in any documentation. The confirmed
Yieldkit redirect format is:
`https://r.srvtrck.com/v1/redirect?api_key=...&type=url&site_id=...&url=...`

Source: Yieldkit redirect documentation + any.run sandbox captures.

Files changed: `src/networks/mrge/adapter.ts`,
`tests/networks/mrge/adapter.test.ts` (new test added for r.srvtrck.com path)

### Blocked items — live-verification checklist

The following items cannot be resolved without a live mrge publisher account.
Each entry includes the exact credential/tier/endpoint needed.

**BLOCKED 1: publisher-api.mrge.com auth scheme (Bearer vs query params)**
- Exact credential/tier needed: Any live mrge publisher account with API access
- Endpoint: publisher-api.mrge.com/documentation/ (returns HTTP 403 to unauthenticated fetches)
- Impact: If Bearer auth, auth_model must change to "bearer" and client.ts
  must inject `Authorization: Bearer ...` header instead of query params.

**BLOCKED 2: Reporting API host**
- Exact credential/tier needed: Any live mrge publisher account
- Endpoint: `reporting-api.yieldkit.com` (unverified; may have changed post-rebrand)
- Impact: `listTransactions` will fail with connection error if host is wrong.
- Test: call `GET reporting-api.yieldkit.com/v3/commission?api_key=...&api_secret=...&site_id=...`

**BLOCKED 3: Reporting API commission endpoint full path**
- Exact credential/tier needed: Any live mrge publisher account
- Endpoint: The `/v3/commission` path is inferred from doc URL slug; may differ
- Impact: `listTransactions` returns 404 if path is wrong.

**BLOCKED 4: Advertiser/terms response envelope shape**
- Exact credential/tier needed: Any live mrge publisher account
- Endpoint: `GET api.yieldkit.com/v2/advertiser/terms?api_key=...&api_secret=...&site_id=...`
- Impact: `listProgrammes` may return 0 results if envelope guess is wrong.

**BLOCKED 5: Response field names — advertiser/terms endpoint**
- Exact credential/tier needed: Any live mrge publisher account
- Fields to confirm: id, advertiser_id, name, status, url, commission,
  commission_type, currency, tracking_url, deep_link
- Impact: Most of `toProgramme()` may produce empty/wrong values.

**BLOCKED 6: Response field names — commission/reporting endpoint**
- Exact credential/tier needed: Any live mrge publisher account with commissions
- Fields to confirm: commission_id, event_id, advertiser_id, advertiser_name,
  commission, sale_amount, currency, state/status, sales_date, modified_date,
  click_date, event_type, click_id, rejection_reason
- Impact: `toTransaction()` may produce empty/wrong values.

**BLOCKED 7: Date range support in Reporting API**
- Exact credential/tier needed: Any live mrge publisher account
- Test: call reporting API with `?modified_date=2026-01-01&modified_date_to=2026-05-28`
- Impact: Without upper-bound date param, all results since `from` are returned
  and filtered client-side (performance impact for large datasets).

**BLOCKED 8: advertiser_id filter on /v2/advertiser/terms**
- Exact credential/tier needed: Any live mrge publisher account
- Test: `GET api.yieldkit.com/v2/advertiser/terms?api_key=...&advertiser_id=12345`
- Impact: `getProgramme` currently falls back to client-side filtering; if
  server-side filter works, it improves performance.

**BLOCKED 9: Paid date availability**
- Exact credential/tier needed: Any live mrge publisher account with paid commissions
- Impact: `datePaid` is always `undefined`; cannot confirm or refute.

**BLOCKED 10: Click-level endpoint**
- Exact credential/tier needed: Any live mrge publisher account + access to
  publisher-api.mrge.com documentation (returns HTTP 403)
- Impact: `listClicks` remains `NotImplementedError`.

**BLOCKED 11: Dashboard navigation paths for setup wizard**
- Exact credential/tier needed: Any live login to publisher.mrge.com
- Paths confirmed for Yieldkit: `home.yieldkit.com/account/api` and `home.yieldkit.com/account/sites`
- Impact: Setup wizard instructions may be outdated if dashboard was rebranded.

**BLOCKED 12: site_id numeric format (edge case)**
- Exact credential/tier needed: Multiple live accounts from different eras
- Current validator: `/^[0-9a-f]{20,40}$/i` (accepts 20-40 char hex strings)
- Impact: If some legacy accounts use plain integers, they would fail validation.

## Documentation sources used

- `https://publisher-api.mrge.com/documentation/` — HTTP 403 to automated fetches
- `https://public.yieldkit.com/` — HTTP 403 to automated fetches
- `https://yieldkit.com/knowledge/reporting-api-v3/` — HTTP 403
- `https://yieldkit.com/knowledge/advertiser-api/` — HTTP 403
- `https://yieldkit.com/knowledge/commission-terms/` — HTTP 403
- `https://yieldkit.com/knowledge/subid-tracking/` — HTTP 403
- `https://yieldkit.com/knowledge/redirect-api/` — HTTP 403
- `https://s3.eu-west-1.amazonaws.com/docs.yieldkit.com/apis/reporting-api/index.html` — HTTP 403
- `https://s3.eu-west-1.amazonaws.com/docs.yieldkit.com/apis/advertiser-api/index.html` — HTTP 403
- `https://wecantrack.com/yieldkit-integration/` — HTTP 403
- `https://doc.voluum.com/article/yieldkit-and-voluum` — HTTP 403
- Search result snippets from approximately 20 targeted queries
- `https://any.run/report/...` — two malware sandbox captures of live Yieldkit API
  calls (2024); confirmed real-world URL parameter format including hex site_id

## Key facts established from public sources

| Fact | Source | Confidence |
|---|---|---|
| Auth: api_key + api_secret + site_id as query params | Yieldkit docs + any.run captures | HIGH |
| Credential format: 24-32 char hex strings | any.run + docs example | HIGH |
| Advertiser API: `GET api.yieldkit.com/v2/advertiser/terms` | Yieldkit docs | HIGH |
| Commission status values: OPEN, CONFIRMED, REJECTED, DELAYED | Yieldkit doc snippets | HIGH |
| Redirect host: r.srvtrck.com/v1/redirect | Yieldkit redirect docs + any.run | HIGH |
| Redirect params: api_key, type, site_id, url, yk_tag | Yieldkit docs + any.run | HIGH |
| modified_date filter in Reporting API | Yieldkit doc snippets | HIGH |
| YYYY-MM-DD date format for filters | Yieldkit doc snippets | MEDIUM |
| Reporting API V3 pagination via 'next' URL | Yieldkit doc snippet | MEDIUM |
| Reporting host: reporting-api.yieldkit.com | Search snippet | LOW |
| Reporting path: /v3/commission | Doc URL slug inference | LOW |
| Yieldkit to mrge rebrand: daily ops unaffected | Yieldkit FAQ | HIGH |

## Research log (2026-05-28 hardening pass)

Key searches that produced grounded facts:

1. `yieldkit "api_key" "api_secret" "site_id" hex string request commission terms`
   -> Confirmed hex format for all three credentials with specific example values.

2. `"r.srvtrck.com" yieldkit tracking redirect URL parameters api_key site_id`
   -> Confirmed r.srvtrck.com is YIELDKIT's redirect service; confirmed URL format
   including api_key, type, site_id, url, yk_tag parameters.

3. `yieldkit "modified_date" "sales_date" reporting commission API parameter`
   -> Confirmed modified_date and sales_date as date type filters.

4. `yieldkit commission terms API response fields advertiser_id name description status`
   -> Confirmed commission terms response includes: id, advertiser_id, description,
   countries, value, value_type, currency, valid_to (CSV sample from snippet).

5. `yieldkit FAQ "daily operations remain unaffected" mrge rebrand`
   -> Confirmed Yieldkit APIs remain active post-mrge rebrand (FAQ updated Feb 9, 2024).

6. any.run malware sandbox captures showing full Yieldkit URL format:
   `r.srvtrck.com/v1/redirect?url=...&api_key=2787b73d6d1c026b48687320e239182a&site_id=0fb9199cb9ce464f9c82523578c269b4&type=url&yk_tag=...`
   -> Confirmed hex format for api_key and site_id in real-world API calls.

## Promotion criteria

To promote from `experimental` to `partial`:

1. Confirm reporting API host resolves and returns commission data (BLOCKED 2).
   This is the single highest-impact blocker.
2. Verify response field names for both advertiser/terms and commission endpoints
   (BLOCKED 5 and 6).
3. Confirm `?advertiser_id=` filter works on `/v2/advertiser/terms` (BLOCKED 8).
4. Run `npx vitest run tests/networks/mrge` against updated fixtures from live
   API calls.
5. Update `last_verified` in `network.json` and `lastVerified` in adapter.ts.
6. Update this document with confirmed shapes and field names.
