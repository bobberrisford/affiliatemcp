# mrge — Findings

Built from public API documentation as of 2026-05-28; live verification
pending credentials; public API docs limited.

## Documentation sources used

- `https://publisher-api.mrge.com/documentation/` — returns HTTP 403 to
  automated fetches; content inaccessible.
- `https://public.yieldkit.com/` — returns HTTP 403 to automated fetches.
- `https://yieldkit.com/knowledge/reporting-api-v3/` — returns HTTP 403 to
  automated fetches.
- `https://yieldkit.com/knowledge/advertiser-api/` — returns HTTP 403 to
  automated fetches.
- `https://s3.eu-west-1.amazonaws.com/docs.yieldkit.com/apis/reporting-api/index.html`
  — returns HTTP 403 to automated fetches.
- `https://s3.eu-west-1.amazonaws.com/docs.yieldkit.com/apis/advertiser-api/index.html`
  — returns HTTP 403 to automated fetches.
- Search result snippets from multiple queries (see research log below).
- `https://wecantrack.com/yieldkit-integration/` — returns HTTP 403.
- `https://doc.voluum.com/article/yieldkit-and-voluum` — returns HTTP 403.

## What was grounded from public sources

The following facts were established from search result snippets and
partially-accessible sources:

- **Auth model**: Three-credential scheme — `api_key`, `api_secret`, `site_id`
  passed as query parameters. Confirmed by multiple third-party integration
  guides describing "Yieldkit account connection requires API key, API secret,
  and Site IDs."

- **Credential location**: API key and secret found under Account → API access;
  site IDs found under Account → Your Sites.

- **Advertiser API endpoint**: `GET http://api.yieldkit.com/v2/advertiser/terms`
  with `api_key`, `api_secret`, `site_id`, optionally `advertiser_id`
  parameters. Confirmed from search snippet: "basic HTTP API to request
  commission terms via HTTP GET".

- **Reporting API**: `/commission` endpoint; uses `modified_date` DateType
  filter to pull commissions updated within a defined time range. Commission
  status values: `OPEN`, `CONFIRMED`, `REJECTED`, `DELAYED`. Source: search
  result snippet from Yieldkit docs.

- **Reporting API V3 pagination**: uses a `next` URL in the response for
  pagination. Source: search snippet.

- **Click tracking**: publishers receive a `yk_tag` value as a click ID;
  it appears in the commission endpoint alongside the commission record.
  No full click log endpoint was found.

## What is uncertain (// TODO(verify))

All of the following need confirmation against a live account:

- Full URL path of the Reporting API (host is assumed to be
  `reporting-api.yieldkit.com`; may have changed in the mrge rebrand).
- Exact JSON field names in the advertiser/terms response (assumed based on
  S2S tracking parameter names in Yieldkit docs).
- Exact JSON field names in the commission/reporting response.
- Whether the Reporting API supports a date range (`from`/`to`) or only a
  single `modified_date` lower bound.
- Whether `publisher-api.mrge.com` uses a Bearer token header rather than
  query-parameter credentials.
- Tracking URL format for deep-link generation.
- Whether `api.yieldkit.com` is still active or has been migrated to
  `api.mrge.com` or another host.

## Research log (2026-05-28)

Searches conducted:

1. `mrge.com publisher API documentation affiliate network yieldkit`
   → Confirmed existence of `publisher-api.mrge.com/documentation/` but
   content blocked.
2. `publisher-api.mrge.com documentation API token authentication`
   → No technical content accessible.
3. `yieldkit reporting-api-v3 commission endpoint api_key api_secret modified_date`
   → Obtained status values (OPEN/CONFIRMED/REJECTED/DELAYED) and
   `modified_date` filter fact from snippets.
4. `yieldkit "api.yieldkit.com" advertiser terms endpoint parameters response`
   → Confirmed endpoint path `/v2/advertiser/terms` and parameter names.
5. Multiple further queries — all documentation endpoints returned 403.

## Promotion criteria

To promote this adapter from `experimental` to `partial`:

1. Verify all `// TODO(verify)` annotations against a live mrge publisher
   account with real credentials.
2. Confirm the reporting API host and commission endpoint path.
3. Confirm the advertiser/terms response JSON field names.
4. Run `npm run validate:network -- mrge` against the live account.
5. Update `last_verified` in `network.json`.
6. Update this findings document with the confirmed shapes.
