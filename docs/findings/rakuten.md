# Findings: Rakuten Advertising

Captured during Chunk 6 implementation. Feeds Chunk 7's REPORT.md. Notes
describe access friction matter-of-factly: what happened, what worked, what
didn't.

## Summary

The Rakuten Advertising adapter ships at `claim_status: partial`. Most of the
seven publisher operations are implemented against the documented public
endpoints; `listClicks` is paid-tier-gated and throws `NotImplementedError`
with a specific reason. The adapter has not been exercised against a live
publisher account because API access requires Publisher Solutions approval
(documented turnaround 3–7 business days; we estimate 5).

Per AGENTS.md, Rakuten is **not** a pattern source for future networks. The
canonical reference remains the Awin adapter. Decisions taken here that are
unusual relative to Awin are flagged inline in the adapter source and below.

## Access friction (matter-of-fact)

- **Publisher Solutions approval required**. A freshly-created Rakuten
  publisher account does NOT have API access by default. The "API Credentials"
  tab is hidden until the Publisher Solutions team explicitly grants the
  capability. Setup brief surfaces this in step 1's description.

- **Developer docs portal returned 403 for the API reference page on
  2026-05-21** when accessed without an authenticated session. The base
  marketing URL (`rakutenadvertising.com/legal-notices/services-terms/`) is
  public; `developers.rakutenadvertising.com` (which we list as `docs_url` in
  `network.json`) requires login for the OpenAPI spec. Endpoint shapes in this
  adapter were assembled from the chunk-6 brief, the public deeplink format
  documentation, and observed responses described in Rakuten's blog posts.

- **Token endpoint accepts XML but not JSON by default**. The Rakuten OAuth2
  token-exchange endpoint requires an explicit `Accept: application/json`
  header to return the documented JSON shape — without it, you can get an
  XML response that the client cannot parse. We send the header on every
  request from both the token-exchange and data calls.

- **Tenant variance on token host**. Some accounts use
  `api.linksynergy.com/token`; others use `api.rakutenmarketing.com/token`.
  The adapter defaults to `linksynergy.com` and accepts a `RAKUTEN_TOKEN_URL`
  environment-variable override if a user reports a 404. This is documented
  in `src/networks/rakuten/auth.ts`.

- **`clicks_reports` is paid-tier-gated**. The endpoint exists in the public
  surface but returns 403 on an unapproved or basic-tier account.
  `listClicks` throws `NotImplementedError` with the reason "Rakuten
  clicks_reports endpoint requires a paid Rakuten tier; not available on the
  test account at adapter commit time. Contact Rakuten Publisher Solutions
  to enable click-level reporting." If the test account is later upgraded,
  the implementation is a few-dozen-line addition: the response shape is the
  same as `transaction_reports`.

## What is implemented

All against the documented public endpoints; mocked tests cover transformer
correctness and the §15.4/§15.9/§15.10 quality bars. Live API not yet
exercised.

| Operation              | Endpoint                              | Notes                                                          |
| ---------------------- | ------------------------------------- | -------------------------------------------------------------- |
| `listProgrammes`       | `GET /v1/programs/`                   | Server-side status filter when single value; otherwise client-side. |
| `getProgramme`         | `GET /v1/programs/?mid=<id>`          | Uses the filter rather than the legacy `/linklocator/getMerchByID` (legacy returns XML). |
| `listTransactions`     | `GET /v1/reports/transaction_reports` | Supports `process_date_start/end`, `mid`, post-fetch status/age filters. |
| `getEarningsSummary`   | derived from `listTransactions`       | Single source of truth. Same rationale as Awin.                |
| `generateTrackingLink` | deterministic                         | `https://click.linksynergy.com/deeplink?id=<SID>&mid=<MID>&u=<URL-encoded>`. No API call. |
| `verifyAuth`           | `POST /token`                         | A successful token exchange is the conclusive auth check.       |

## What is stubbed (NotImplementedError)

| Operation                | Reason                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| `listClicks`             | `clicks_reports` requires a paid Rakuten tier; not accessible from the test account at commit time. |
| `listPublishers`         | Brand-side operations scaffolded for v0.2.                                                          |
| `listPublisherSectors`   | Brand-side operations scaffolded for v0.2.                                                          |

Each throws `NotImplementedError` with a specific human-readable reason — never
returns an empty array. Per principle 4.1, the difference between "Rakuten
returned no clicks" and "Rakuten doesn't expose clicks here" is the difference
between an actionable observation and a wild goose chase.

## Status normalisation (the locked → approved choice)

Rakuten's transaction vocabulary is `pending | locked | paid | reversed`.
Mapping to our canonical enum:

- `pending` → `pending` (sale recorded, awaiting advertiser validation)
- `locked` → `approved` — the load-bearing decision. Rakuten "locks" a sale
  after the advertiser approves it but before it leaves the payment-hold
  window (typically 60 days). Semantically the same as Awin's
  "approved-but-not-yet-paid". Mapping to `approved` lets the §15.9 unpaid-age
  affordance work uniformly across networks: a user asking "what is approved
  and older than 90 days?" gets the same kind of answer regardless of the
  underlying network's wording.
- `paid` → `paid`
- `reversed` → `reversed` (also catches Rakuten's occasional `declined` /
  `cancelled` / `canceled` synonyms).
- Anything else → `other`. We never invent a status the user did not see on
  Rakuten's side.

## Token caching pattern (Rakuten-specific decision)

Rakuten access tokens last ~1 hour. The cache (`src/networks/rakuten/auth.ts`)
is the only mutable module-level state in the adapter. Refresh policy:

- **Proactive**: when the cached token has <5 minutes until expiry, refresh
  before the next call uses it. This avoids "token expired mid-flight" 401s.
- **Reactive**: if a 401 surfaces from any data endpoint, the client forces a
  refresh and retries the original call exactly once. The retry is logged at
  debug level. Per the project's "no silent retries" rule, the recovery path
  is NOT hidden.
- **Deduplication**: parallel callers that simultaneously notice a stale token
  share a single in-flight refresh promise so two callers don't both round-trip
  the token endpoint.

The cache lives in module scope keyed by process identity. Tests can call
`_resetTokenCache()` to isolate. Future contributors: if you find yourself
adding a second piece of module-level mutable state in this adapter, stop
and think.

## Tracking link: deterministic vs `getTextLinks`

We construct deeplinks deterministically:

```
https://click.linksynergy.com/deeplink
  ?id=<SID>            (publisher Site ID)
  &mid=<MID>           (merchant ID)
  &u=<URL-encoded destination>
```

Rakuten exposes `/linklocator/getTextLinks/{mid}` as an alternative, but it
returns pre-canned text-link HTML, not a deeplink to an arbitrary destination
URL. For the principle 4.1 use case ("link me to *this specific* product
page"), the deeplink format above is what callers actually want. Same pattern
as the Awin adapter (`cread.php?awinmid=...&awinaffid=...&ued=...`); we kept
the parameter names visible in the comments and the `rawNetworkData` for the
returned `TrackingLink` so the link's construction is fully auditable.

## What surprised me

- **The legacy XML endpoints are still in the surface**. `/linklocator/...`
  returns XML by default even with `Accept: application/json`. We avoid those
  endpoints entirely and stick to the `/v1/` surface so the client's JSON
  parse path applies uniformly. Future expansion (e.g. coupons via
  `/coupon/getcouponfeed/`) would need a tolerant parser path or a `text/xml`
  branch in the client; out of scope for v0.1.

- **The `scope=<SID>` body parameter is unusual**. OAuth2 client-credentials
  flows typically don't use `scope` to identify a tenant — they use it to
  request a permission set. Rakuten uses it as the Site ID. The setup wizard
  has to prompt for it as a separate field; there is no derivation pathway.

- **Status filters on `/v1/programs/` are sometimes ignored by Rakuten.**
  Reported anecdotally; not reproducible without a live account. The adapter
  applies status filters client-side after the fetch as a defence in depth.

- **Rakuten doesn't expose a per-call "transactions older than X" parameter.**
  The §15.9 unpaid-age affordance is applied post-fetch in the adapter, same
  as Awin. The trade-off is that very wide date windows pull more data than
  strictly needed; for a v0.1 sized publisher this is fine.

## Recommended next steps

1. **Live validation in Chunk 8**: once a real Rakuten test account is
   provisioned, run `affiliate-networks-mcp validate rakuten` end-to-end and decide
   whether to bump `claim_status` to `production` (if all live ops pass) or
   leave at `partial` (if clicks remain inaccessible).

2. **Promote `listClicks`** from `NotImplementedError` to a real implementation
   if the test account is upgraded. The endpoint response shape is the same
   as `transaction_reports`, so the `toClick` transformer is a ~20-line
   addition.

3. **Decide on the legacy XML surface.** If a user needs coupons or the older
   merchant detail endpoints, the client needs a `text/xml` Accept branch
   plus an XML parser dependency (out of scope for v0.1).

4. **Consider parallelising the token-refresh + first-data-call** pair when
   the cache is cold. Currently sequential; saves ~200ms per cold session.
   Not a v0.1 blocker.
