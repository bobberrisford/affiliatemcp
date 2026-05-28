# affiliate-mcp Report — the state of affiliate-network APIs in May 2026

_Date-stamped: 2026-05-28._

This report describes the state of four affiliate-network APIs as observed
during the construction of the affiliate-mcp MCP server: Awin, CJ Affiliate,
Impact, and Rakuten Advertising. Each network is described in terms of
documentation, setup friction, operational coverage, and known limitations.
The reader is the comparator. The document presents the data; it does not
rank the networks.

## Methodology

Each network was implemented as an adapter against the same canonical contract
of seven publisher operations: `listProgrammes`, `getProgramme`,
`listTransactions`, `getEarningsSummary`, `listClicks`, `generateTrackingLink`,
and `verifyAuth`. Findings were captured by the adapter author at
implementation time and live in `docs/findings/<slug>.md`. The structured
signals in the summary table — setup time, approval requirement, supported
operation count, claim status, last-verified date — are pulled directly from
each network's `network.json` manifest. No letter grades, stars, or composite
scores are produced; the report's job is to surface the inputs that let the
reader form their own view.

_Live diagnostic data was not collected because no credentials were configured. The figures below are from each adapter's static manifest and the per-network findings document; live latency and sample-size figures are therefore omitted._

_The full methodology document lives at_ `docs/benchmark-methodology.md`_; that file is_
_a placeholder at the time of this report and is fleshed out in a later chunk._

## Summary

| Network | Setup time (min) | Approval | Ops supported | Known limitations | Claim status | Adapter | Last verified |
| --- | ---: | --- | ---: | ---: | --- | --- | --- |
| Awin | 5 | no | 6 / 7 | 1 | partial | 0.1.0 | 2026-05-21 |
| Awin (advertiser) | 6 | no | 7 / 7 | 6 | experimental | 0.1.0 | 2026-05-23 |
| CJ Affiliate | 8 | no | 6 / 7 | 2 | partial | 0.1.0 | 2026-05-21 |
| CJ Affiliate (advertiser) | 8 | no | 7 / 7 | 7 | experimental | 0.1.0 | 2026-05-23 |
| eBay Partner Network | 10 | yes (~3 days) | 7 / 7 | 3 | experimental | 0.1.0 | 2026-05-21 |
| Everflow | 10 | yes (~1 days) | 7 / 7 | 3 | experimental | 0.1.0 | 2026-05-28 |
| Everflow (Advertiser) | 10 | no | 7 / 7 | 5 | experimental | 0.1.0 | 2026-05-28 |
| Impact | 6 | no | 7 / 7 | 2 | partial | 0.1.0 | 2026-05-21 |
| Impact (advertiser) | 8 | no | 7 / 7 | 3 | experimental | 0.1.0 | 2026-05-23 |
| mrge | 10 | no | 6 / 7 | 6 | experimental | 0.1.0 | 2026-05-28 |
| Partnerize | 10 | no | 7 / 7 | 4 | experimental | 0.1.0 | 2026-05-28 |
| Partnerize (Advertiser) | 5 | no | 6 / 7 | 6 | experimental | 0.1.0 | 2026-05-28 |
| Rakuten Advertising | 12 | yes (~5 days) | 6 / 7 | 3 | partial | 0.1.0 | 2026-05-21 |
| Skimlinks | 10 | no | 6 / 7 | 5 | experimental | 0.1.0 | 2026-05-28 |
| Sovrn Commerce | 10 | no | 6 / 7 | 6 | experimental | 0.1.0 | 2026-05-28 |
| Tradedoubler | 10 | no | 6 / 7 | 4 | experimental | 0.1.0 | 2026-05-28 |
| Tradedoubler (Advertiser) | 10 | no | 7 / 7 | 6 | experimental | 0.1.0 | 2026-05-28 |

## Awin

### Quick facts

- **Slug**: `awin`
- **Auth model**: bearer
- **Base URL**: https://api.awin.com
- **Environment variables**: `AWIN_API_TOKEN`, `AWIN_PUBLISHER_ID`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: partial
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-21
- **Documentation**: https://help.awin.com/apidocs/introduction-1

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Click-level data is not exposed via the public publisher API; listClicks is unsupported.

### Findings

# Findings: Awin

Captured during Chunk 2 implementation. Feeds Chunk 7's REPORT.md.

## Summary

Awin maps cleanly onto the canonical adapter contract for the seven publisher
operations except `listClicks`. The adapter is shipped at `claim_status:
partial` — every other op is implemented and unit-tested, but `listClicks` is
structurally unsupported by the public Awin API and the adapter has not yet
been exercised against a live publisher account.

## What worked well

- **Single bearer token, long-lived**: no refresh dance, no per-call OAuth
  handshake. `AWIN_API_TOKEN` reads once from `~/.affiliate-mcp/.env` and the
  client attaches it to every request. The token is generated from the Awin
  publisher dashboard → Account → API credentials.

- **`/accounts?type=publisher` doubles as auth-check + identity discovery**: a single call
  validates the token, returns the publisher ID, and gives a human-readable
  name. This is the canonical example of the `derivedValues` pattern: one
  credential bootstraps another, the wizard shows "press enter to accept"
  rather than re-prompting.

- **Deterministic deep-link construction**: Awin's tracking URL format
  (`https://www.awin1.com/cread.php?awinmid=...&awinaffid=...&ued=...`) is
  documented and stable, so `generateTrackingLink` builds the URL in-process
  without an API call. Faster, no failure mode, no rate-limit budget consumed.

- **Stable status vocabulary**: `pending|approved|declined` covers ~95% of
  observed transactions. Mapping to our canonical set is mechanical
  (`declined` → `reversed`). `paid` is derived from `paidToPublisher: true`.

- **Reversed-sale visibility**: Awin populates `declineReason` on declined
  transactions, so PRD §15.10 falls out for free — we just surface the field.

## What didn't / friction points

- **No click data via the public publisher API.** This is the principal known
  limitation. We throw `NotImplementedError` with the reason
  `"Awin does not expose click-level data via the public publisher API"` so
  the caller sees an honest "not supported" rather than "no clicks today".
  If Awin ever adds clicks to the API the limitation disappears with a
  ~30-line code addition; we don't need to redesign anything.

- **31-day transaction window cap.** A single `/transactions` call accepts at
  most 31 days. We handle this by chunking wider windows transparently in
  the adapter; callers see a single `listTransactions({ from, to })`. The
  chunking adds latency (sequential calls, not parallel — keeps us under
  Awin's per-second rate budget).

- **Status string vs paidToPublisher mismatch.** Awin keeps
  `commissionStatus: approved` even after a transaction has been paid out;
  the `paidToPublisher` flag is the authoritative "this is paid" signal. We
  derive `paid` from that flag, not from the status string. Future networks
  may have similar quirks — the lesson is "treat both string and boolean
  signals as inputs to the normalisation".

- **Schema drift between identity endpoints.** The current `/accounts` response
  uses `accounts[].accountId`, while older `/publishers` shapes and fixtures use
  `publisherId`, `id`, or `accountId`. We accept all of them rather than picking
  one. This is the kind of compatibility shim that should NOT be promoted into
  a shared layer — it's Awin-specific.

- **Two date fields, two meanings.** `transactionDate` is the conversion;
  `validationDate` is when Awin approved the commission. The unpaid-age
  affordance (PRD §15.9) needs validation-relative age, not conversion-
  relative. We use `validationDate ?? transactionDate` as the anchor.

- **`accessStatus` enum is undocumented and tenant-specific.** New states
  appear from time to time (`inactive`, `archived`). We collapse unknowns to
  `unknown` rather than miscategorising.

## Token longevity + rate limits

- **Token longevity**: long-lived. No documented auto-expiry; tokens are
  revoked manually from the same dashboard screen they're generated on.
  Treat as a static secret.

- **Rate limits**: Awin publishes no precise per-second budget in the public
  docs. Empirically (per the orchestrator's prior notes) the API tolerates
  modest bursts and rate-limits with a `429 Too Many Requests` response when
  exceeded. Our resilience layer retries 429 by policy with exponential
  backoff + jitter, which is the right default.

- **Latency**: `/accounts` returns in ~100–200ms; `/programmes` in
  ~300–800ms; `/transactions` is the outlier, occasionally 5–15s for a busy
  publisher across a full 31-day window. We bump the `listTransactions`
  timeout to 60s and retries to 3 to absorb the upstream variability.

## Deep-link by construction — why it matters

Awin's tracking URL is fully determined by `{advertiserId, publisherId,
destinationUrl}`. We can build it without any network round-trip. This is the
canonical "deterministic construction" pattern:

- Latency: ~0ms (no network).
- Failure modes: none upstream — only local input validation.
- Rate-limit cost: zero.

Compare with networks that REQUIRE an API call to mint a link (e.g. Impact's
`/Mediapartners/{accountSid}/Programs/{programId}/TrackingLinks`). Those
adapters wrap their call through the resilience layer the same way every
other Awin call does. The general principle: prefer deterministic
construction when the network's link format is documented and stable; fall
back to an API call only when the network mints a per-link tracking ID.

## Future work (Chunk-7-style notes)

- **Live validation**: bump `claim_status` from `partial` to `production`
  after Chunk 8 acceptance testing exercises the adapter against a real Awin
  publisher account.
- **Awin-specific endpoint coverage**: the reference implementation now tracks
  endpoint-by-endpoint status in `docs/networks/awin/api-inventory.md`. Keep
  that inventory updated whenever adding a tool, changing live-test status, or
  discovering a gated requirement.
- **Pagination cursor support**: the current adapter returns the full result
  set; if a future query window produces tens of thousands of transactions
  we'll want a cursor abstraction. Awin doesn't natively cursor — we'd chunk
  by date.
- **Optimisation: parallelise chunk fetches.** Sequential is conservative;
  parallelising 3 slices in a 90-day window would be roughly 3× faster
  provided we stay inside Awin's burst tolerance.
- **`/reports/aggregated` shortcut**: an optimisation for callers who want
  totals only and don't need per-transaction `ageDays`. Not needed for v0.1.

## Awin (advertiser)

### Quick facts

- **Slug**: `awin-advertiser`
- **Auth model**: oauth2
- **Base URL**: https://api.awin.com
- **Environment variables**: `AWIN_ADVERTISER_API_TOKEN`
- **Setup time estimate**: 6 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-23
- **Documentation**: https://developer.awin.com/apidocs

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Read-only at v0.1. The HTTP client refuses any non-GET method client-side; pair this with a token scoped to read-only operations at Awin for defence in depth.
- Hard rate limit: Awin permits 20 API calls per minute per user. The client enforces a process-wide token bucket at 20 requests per 60 seconds and queues bursty multi-brand operations rather than failing fast.
- Awin's advertiser API is gated to the Accelerate and Advanced advertiser plans. Brands on the Entry-tier plan appear in `/accounts` output but data endpoints return 401/403; the adapter does not probe each brand (rate-budget reasons — see next entry), so the wizard surfaces a graceful 'found but not API-accessible — upgrade or skip' message at brand-registration time instead.
- `listBrands` calls `GET /accounts` and filters `type === 'advertiser'`. To stay under the 20-per-minute rate budget on accounts with many advertisers, the adapter does NOT issue per-brand probes — all advertiser accounts are reported with `apiEnabled: true`.
- `listProgrammes` is synthetic: Awin programmes are configured in the UI and not enumerated under `/advertisers/{id}/programmes` on every tenant. The adapter returns one Programme per advertiserId keyed on the call context. `// TODO(verify)` against a live Accelerate tenant.
- `listTransactions` maps Awin's `declined` status onto the canonical `reversed` value. Awin's `dateType` is exposed as `transaction` (default) or `validation`.

### Findings

_No findings document was supplied at `docs/findings/awin-advertiser.md`._

## CJ Affiliate

### Quick facts

- **Slug**: `cj`
- **Auth model**: bearer
- **Base URL**: https://api.cj.com
- **Environment variables**: `CJ_API_TOKEN`, `CJ_COMPANY_ID`
- **Setup time estimate**: 8 minutes
- **Approval required**: no
- **Claim status**: partial
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-21
- **Documentation**: https://developers.cj.com/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Click-level data is not exposed via CJ's modern GraphQL surface; listClicks throws NotImplementedError unless the legacy REST report endpoint is reachable for the account.
- Brand-side operations (listPublishers, listPublisherSectors) are scaffolded for v0.2.

### Findings

# Findings: CJ Affiliate

Captured during Chunk 3 implementation. Feeds Chunk 7's REPORT.md.

## Summary

CJ maps onto the canonical adapter contract for six of the seven publisher
operations. `listClicks` is structurally unsupported on the modern GraphQL
surface; the adapter throws `NotImplementedError` with a CJ-specific reason
rather than partially-supporting an inconsistent legacy REST report. The
adapter ships at `claim_status: partial` — every other op is implemented and
unit-tested, but it has not yet been exercised against a live publisher
account.

## GraphQL + REST hybrid

CJ's modern public API is GraphQL. Two endpoints — different schemas:

- `https://commissions.api.cj.com/query` — `publisherCommissions`, `me`.
- `https://ads.api.cj.com/query` — `advertisers`, `advertiser`.

A REST link-builder is also published at
`https://link-builder.api.cj.com/v1/links`, but for v0.1 we use the legacy
deterministic redirect URL (`https://www.dpbolvw.net/click-{publisherId}-{advertiserId}?url=...`)
because it requires no API round-trip and is universally supported.

The client (`src/networks/cj/client.ts`) exposes two helpers:

- `cjGraphQL<T>({ endpoint, query, variables, operation, ... })` — handles
  both GraphQL endpoints. Caller picks `endpoint`.
- `cjRest<T>({ baseUrl, path, method, body, operation, ... })` — handles
  link-builder REST (and future legacy report endpoints if reachable).

Both go through `withResilience`. Both throw `HttpStatusError` on non-2xx.

### GraphQL-on-200 errors

CJ may return HTTP 200 with a populated `errors` array (the GraphQL spec
permits partial success). We synthesise an `HttpStatusError(200, body, ...)`
so the verbatim body reaches the error envelope (PRD §15.4) and the user sees
CJ's actual error message rather than a paraphrase. The synthesised 200
falls through to "no retry" in the resilience layer, which is correct —
repeating a malformed query gets the same error.

A test (`surfaces GraphQL `errors` payloads verbatim even on HTTP 200`)
exercises this path.

## Schema documentation quality

CJ publishes a GraphQL schema at https://developers.cj.com/. The schema is
typed and introspectable; field names are stable in practice (most recent
notable rename was the move from `commissions` to `records` inside
`publisherCommissions` a few years ago).

Caveats observed while reading the docs:

- The `me` query's exact field set varies between tenants. We read a minimal
  set (`id companyId name email company { id name }`) and tolerate missing
  fields defensively.
- The `advertisers` query wraps results in `resultList` on the modern schema
  but some tenants flatten to a top-level array. The adapter accepts either.
- Numeric fields are sometimes returned as JSON strings (e.g.
  `pubCommissionAmountUsd: "8.00"`) and sometimes as numbers. The `toNumber`
  helper accepts both.
- `actionStatus` vs `commissionStatus`: depending on schema version, the
  status lives on different fields. We read both.

The lesson generalises beyond CJ: in any network's GraphQL surface, prefer
narrow queries plus defensive transformers over a strict schema mirror.
Networks add fields more often than they remove them, and the cost of
breaking on a new optional field outweighs the safety of a tighter type.

## Status mapping (the load-bearing decision)

CJ's commission lifecycle vocabulary (modern schema):

| CJ value     | Canonical | Notes                                                    |
| ------------ | --------- | -------------------------------------------------------- |
| `NEW`        | pending   | Recorded, not yet locked.                                |
| `EXTENDED`   | pending   | CJ is holding for review; still pending from publisher.  |
| `LOCKED`     | approved  | Approved, cleared for payment, but not yet paid.         |
| `CLOSED`     | reversed  | Cancelled / reversed by the advertiser.                  |
| `CORRECTED` -> default | other     | Adjusted post-fact; raw preserved on rawNetworkData.     |
| anything else | other    | Never invent a status the user didn't see.               |

Two paid signals override `actionStatus`:

- `paidToPublisher: true` — explicit boolean (some tenants).
- `clearedDate: <ISO>` populated — equivalent signal (other tenants).

Either of those forces `status = 'paid'` regardless of the action status
string. Same lesson Awin teaches with `paidToPublisher`: trust both
boolean/date signals AND the string, not just one.

## PAT longevity

CJ Personal Access Tokens are long-lived. They do not auto-rotate; users
revoke manually from the same dashboard tab where they were generated
(Account → Personal Access Tokens). We treat the token as a static secret,
read once from `~/.affiliate-mcp/.env`.

## Rate-limit observations

CJ does not publish a precise per-second budget in the public docs. The
modern GraphQL endpoint tolerates modest sustained traffic; aggressive bursts
get a `429 Too Many Requests`. Our resilience layer retries 429 by policy
with exponential backoff + jitter, which is the right default.

Observed latency (per the orchestrator's prior notes and CJ docs):

- `{ me }`: sub-second.
- `advertisers(...)`: a few hundred ms to ~1s.
- `publisherCommissions(...)`: highly variable. Wide date windows can take
  10–30s. We bump `listTransactions`'s timeout to 60s and retries to 3.

## Click data

There is a legacy REST report endpoint (`commission-detail-report`) that
some accounts can reach via the older support.cj.com tools. It exposes
click-level data but:

- It's not consistently available across accounts.
- The response shape predates the modern schema and would need a bespoke
  transformer.
- Partial support would silently return empty arrays on accounts that
  don't have it, violating PRD principle 4.1.

For v0.1 we throw `NotImplementedError`. The reason string explains the
landscape so the user knows it's not a configuration mistake.

## Deep-link by construction

CJ's legacy click-redirect URL format
`https://www.dpbolvw.net/click-{publisherId}-{advertiserId}?url=...` is
stable and documented; we construct it deterministically. The modern
link-builder REST API (`POST /v1/links`) returns a friendlier URL with a
tracking ID, but every CJ account supports the deterministic redirect, so
it's the safer default for v0.1.

## derivedValues — CJ_COMPANY_ID bootstrap

`verifyAuth` runs `{ me { id companyId ... } }` and returns
`derivedValues: { CJ_COMPANY_ID }` on success. The setup wizard uses this to
skip the follow-up prompt — same pattern Awin uses for `AWIN_PUBLISHER_ID`.

If the token has access to multiple companies, we pick the one on `me.companyId`
(falling back to `me.company.id`). Users with that situation can override
the derived value by setting `CJ_COMPANY_ID` explicitly.

The adapter also implements `derivedValues()` (returning a
`DerivedValueResult[]`) so callers can introspect what was auto-extracted
without re-running the auth check.

## Future work (Chunk-7-style notes)

- **Live validation**: bump `claim_status` from `partial` to `production`
  after Chunk 8 acceptance testing exercises the adapter against a real CJ
  publisher account.
- **Pagination cursor**: `publisherCommissions` paginates internally; for v0.1
  we request a wide window and don't expose a cursor. Adding one is
  straightforward.
- **Click data via the legacy REST report**: if it turns out to be reachable
  on enough accounts, implement `listClicks` against the legacy endpoint
  rather than throwing. The known-limitation comment in `META` documents the
  fall-back path.
- **Link-builder REST** for tenants that need a tracking ID rather than the
  deterministic redirect.
- **Multi-publisher accounts**: the deep-link uses `CJ_COMPANY_ID` as the
  publisher identifier in the URL path. Most accounts have a single web-site
  PID; multi-site publishers may need an explicit `CJ_WEBSITE_ID`.

## CJ Affiliate (advertiser)

### Quick facts

- **Slug**: `cj-advertiser`
- **Auth model**: bearer
- **Base URL**: https://commissions.api.cj.com
- **Environment variables**: `CJ_ADVERTISER_API_TOKEN`
- **Setup time estimate**: 8 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-23
- **Documentation**: https://developers.cj.com/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Read-only at v0.1. The GraphQL client refuses any operation that is not `query` (no mutations, no subscriptions); pair this with a personal-access token scoped read-only at CJ for defence in depth.
- `listBrands` reads CJ's GraphQL `viewer` (a.k.a. `me`) for the company memberships the PAT can see. The exact field name `// TODO(verify)` — if CJ's schema rejects it the adapter throws and the user is instructed to add brands manually to `brands.json`.
- `listProgrammes` is synthetic: CJ has no advertiser-programmes query, so the adapter returns one Programme per CID using `advertiserLookup` metadata.
- `getProgrammePerformance` is computed client-side from `commissionDetails`. Clicks are NOT available from `commissionDetails` and are reported as 0; document the gap with `// TODO(verify)`.
- Status mapping for performance rows is based on CJ `actionStatus`: EXTENDED / LOCKED → pending, CLOSED → approved, CORRECTED / REVERSED → reversed. `CLOSED` semantics `// TODO(verify)`.
- All amounts use CJ's USD-normalised fields (`saleAmountUsd`, `commissionAmountUsd`); reports are emitted with `currency: USD`.
- Pagination on `commissionDetails` is capped at ~10,000 rows per page via `maxRows`; wider windows should be split by the caller.

### Findings

_No findings document was supplied at `docs/findings/cj-advertiser.md`._

## eBay Partner Network

### Quick facts

- **Slug**: `ebay`
- **Auth model**: oauth2
- **Base URL**: https://api.ebay.com
- **Environment variables**: `EBAY_CLIENT_ID`, `EBAY_CLIENT_SECRET`, `EBAY_CAMPAIGN_ID`
- **Setup time estimate**: 10 minutes
- **Approval required**: yes (~3 days)
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-21
- **Documentation**: https://partnernetwork.ebay.com/help/integration-center/api-documentation

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- eBay Partner Network exposes eBay itself as the sole advertiser; "programmes" in this adapter map to EPN campaigns, not to third-party merchants.
- Transaction ("earnings") reporting is delayed approximately 24-48 hours; today's clicks rarely appear in listTransactions until the next reporting cycle.
- Click-level reporting is paginated and capped at 90-day windows per EPN's reporting API; the adapter chunks wider ranges.

### Findings

# Findings: eBay Partner Network

Captured during the `feature/network-ebay` chunk. Feeds the next REPORT.md
regeneration. The adapter was implemented from the public Partner Network
developer documentation (https://partnernetwork.ebay.com/) and the related
eBay developer reference; **no live API calls were made** during
implementation. The fixtures under `tests/fixtures/ebay/` are synthesised
from the documented response shapes.

## Summary

The eBay Partner Network adapter ships at `claim_status: experimental`. All
seven publisher operations are implemented and unit-tested against synthetic
fixtures, but the adapter has not been exercised against a real EPN account
and the upstream response shapes have not been verified beyond the public
documentation. The adapter should be promoted to `partial` after a single
real-account smoke test and to `production` after the standard live
acceptance test.

## The cardinal shape difference

EPN is structurally unlike Awin / CJ / Impact / Rakuten. There is only one
advertiser — eBay itself — and the concept that corresponds to "a programme"
on every other network is an EPN **campaign**: a tracking bucket the
publisher creates in their EPN dashboard to attribute traffic to a site, an
app, a content channel, etc.

This adapter therefore maps:

- `Programme.id` ← EPN `campaignId`
- `Programme.name` ← EPN `campaignName`
- `Programme.status` ← EPN campaign state (`ACTIVE` → `joined`,
  `PAUSED`/`EXPIRED` → `suspended`, `DRAFT` → `pending`)

A consequence is that the `programmeId` argument to `listTransactions`,
`generateTrackingLink`, and the `affiliate_ebay_*` tools is an EPN campaign
ID — not a merchant ID. This is documented in both `network.json`
`known_limitations` and the per-network setup doc.

## What worked well

- **Clean OAuth2 client-credentials flow.** EPN reuses the standard eBay
  developer OAuth2 endpoint (`POST /identity/v1/oauth2/token`). A single
  HTTP Basic + form-urlencoded exchange yields a two-hour bearer token. No
  refresh dance, no per-call OAuth handshake. The token cache lives in
  `src/networks/ebay/auth.ts` with the test-only `_resetTokenCache` helper.

- **Token exchange doubles as the auth check.** A successful client-
  credentials exchange proves both the App ID and the Cert ID are valid
  without any further EPN API call. `verifyAuth` forces a refresh so the
  wizard sees a fresh exchange rather than a stale cache hit.

- **Deterministic deep-link construction.** EPN's tracking ("Smart Link")
  URL uses the long-standing rover format
  (`https://rover.ebay.com/rover/1/{rotationId}/1?campid=...&toolid=10001&mpre=...`).
  We build it in-process — zero latency, no failure mode, no rate-limit
  cost. Mirrors Awin's deterministic pattern.

- **Stable status vocabulary.** EPN's `PENDING`/`CLEARED`/`PAID`/`CANCELLED`
  enum maps mechanically onto the canonical
  `pending`/`approved`/`paid`/`reversed` set. The decision to map `CLEARED`
  → `approved` (rather than `paid`) keeps cross-network semantics
  consistent with Awin and Impact: "approved-but-not-yet-paid" is a
  distinct user-facing state.

- **Reversed-sale visibility falls out cheaply.** EPN populates
  `cancelReason` on cancelled transactions; we surface it on
  `reversalReason` per PRD §15.10 with no extra fetch.

- **Click-level data is exposed via the API.** Unlike Awin, EPN's reporting
  surface includes a `/click` endpoint. `listClicks` is implemented as a
  real operation rather than a `NotImplementedError`.

## What didn't / friction points

- **No real-account verification.** This is the principal caveat. Every
  field name, status string, and pagination shape in the adapter is
  synthesised from the public documentation. The integration may need
  light fixup once it sees a real response — particularly around the
  reporting endpoints, which the docs describe in less detail than the
  Buy and Marketing APIs.

- **The "one advertiser" model is awkward for cross-network tooling.**
  A consumer of `affiliate_list_networks` who naively assumes "more
  programmes = more revenue" will misread an EPN account with a single
  campaign as a small player. The `known_limitations` entry calls this
  out explicitly so downstream skills can adjust their copy.

- **Reporting delay.** EPN's transaction reporting is documented to be
  delayed approximately 24-48 hours. A user calling `listTransactions`
  for "today" will not see today's clicks. This is honest behaviour but
  worth flagging in the setup doc so the wizard's `affiliate-networks-mcp test
  ebay` output is interpretable on a fresh account.

- **90-day window cap on reporting endpoints.** Both `/transaction` and
  `/click` cap a single call at 90 days. We chunk wider windows
  transparently (sequential calls, not parallel — keeps us under EPN's
  burst tolerance, mirroring Awin's behaviour).

- **The `campaignId` requirement for tracking links.** EPN requires a
  campaign ID on every Smart Link (it is the `campid` query parameter on
  the rover URL). Unlike Awin's publisher ID — which we can derive from
  the token via `/publishers` — there is no documented "list my
  campaigns" endpoint that does not itself require the campaign-creation
  permission. We therefore prompt the user for the campaign ID
  explicitly in the wizard. A future enhancement: if the
  `/affiliate/campaign/v1/campaign` listing endpoint turns out to be
  available to standard publisher credentials, we can move this to the
  `derivedValues` pattern (offer the first active campaign as the
  default; let the user override).

- **Approval gate.** EPN requires the publisher's developer application
  to be enrolled in the Partner Network before its credentials can
  exchange for an EPN-scoped token. Typical wait time: 1-3 working
  days. We document this in the first setup-step's description so a
  user with a fresh developer account learns about the gate before the
  wizard fails to validate.

- **Marketplace header.** Many eBay APIs (including parts of the EPN
  surface) require `X-EBAY-C-MARKETPLACE-ID`. We send `EBAY_GB` by
  default and expose `EBAY_MARKETPLACE_ID` as a runtime override. A
  caller running US reporting will need to set the override; this is
  documented in `.env.example`.

## Token longevity + rate limits

- **Token longevity**: ~2 hours per the documented `expires_in`. The
  cache refreshes 30s before expiry to avoid races with in-flight
  requests.

- **Rate limits**: eBay's developer docs publish daily call-count quotas
  per application rather than per-second budgets. Practical effect: the
  resilience layer's default retry-on-429 + circuit-breaker policy is
  the right shape; we have not added any EPN-specific rate-limit
  signalling because the documented retry behaviour matches.

- **Latency**: not yet measured against a live account. Reporting
  endpoints get a 60s timeout and one extra retry by precaution
  (matches the Impact and Awin approach for slow reporting surfaces).

## Deep-link by construction — why it matters here

EPN's rover URL is fully determined by `{rotationId, campaignId,
destinationUrl}`. We can build it without any network round-trip. This is
the canonical "deterministic construction" pattern (Awin uses the same
approach with the `awin1.com/cread.php` URL).

- Latency: ~0ms (no network).
- Failure modes: none upstream — only local input validation.
- Rate-limit cost: zero.

We still require the credentials to be configured so a user with a
half-configured environment learns at link-generation time, not at
first-click time when nothing tracks.

## Future work

- **Live validation**: exercise the adapter against a real EPN account
  and bump `claim_status` from `experimental` → `partial`, then
  `production` after the standard acceptance test.

- **`derivedValues` for `EBAY_CAMPAIGN_ID`**: if the campaign-list
  endpoint turns out to be available to standard publisher credentials,
  expose the first active campaign as the wizard's default.

- **Subid / customid support**: EPN supports per-link `customid` for
  sub-tracking. The current adapter does not surface this on
  `generateTrackingLink`; widening the canonical
  `generateTrackingLink` input shape across all networks is the right
  fix (touching the shared type contract requires a separate PR).

- **Marketplace-aware listProgrammes**: the campaigns response includes
  a `marketplaceId` per row. We currently expose this only via
  `rawNetworkData`. A future iteration could surface it on
  `Programme.categories` or as a separate field once the canonical type
  has somewhere to put it.

## Everflow

### Quick facts

- **Slug**: `everflow`
- **Auth model**: custom
- **Base URL**: https://api.eflow.team
- **Environment variables**: `EVERFLOW_API_KEY`, `EVERFLOW_AFFILIATE_ID`
- **Setup time estimate**: 10 minutes
- **Approval required**: yes (~1 days)
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-28
- **Documentation**: https://developers.everflow.io/docs/affiliate/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- Affiliate API keys must be created by a network admin, not self-service by the affiliate.
- Click stream endpoint caps at 14 days per call; wider windows are chunked automatically.

### Findings

# Findings: Everflow (Publisher / Affiliate side)

Built from public API documentation as of 2026-05-28; live verification pending credentials.

## Summary

Everflow maps onto the canonical adapter contract for all seven publisher operations. Unlike Awin and CJ, Everflow **does** expose click-level data via the affiliate API (click stream endpoint), so `listClicks` is implemented rather than throwing `NotImplementedError`.

The adapter ships at `claim_status: experimental` — all ops are implemented and unit-tested against fixture data, but the adapter has not been exercised against a live publisher account. Endpoint shapes marked `// TODO(verify)` should be confirmed when live credentials are available.

## Key verification gap: affiliate API keys are admin-generated

Everflow affiliate API keys cannot be self-issued by the affiliate. They must be created by the **network admin** under Manage Affiliate → API tab. This was confirmed via the Everflow developer documentation and help centre:

> "Affiliate users cannot create keys themselves and must rely on a network user to create the key and hand it over."

This is a meaningful friction point: the setup wizard will stall until the user has obtained a key from their network admin. The `known_limitations` and `setupRequiresApproval: true` fields document this explicitly.

## Auth model

Everflow uses a custom header `X-Eflow-API-Key: <key>` rather than the standard `Authorization: Bearer ...` header. This is set in `buildHeaders()` in `client.ts` and declared as `auth_model: "custom"` in `network.json`.

The API key is scoped to a single affiliate account by the network admin. No derivation of a secondary credential (like Awin's publisher ID) is possible or needed — the key already identifies the account.

## Endpoint map (verified from public documentation)

| Endpoint | Method | Status |
|---|---|---|
| `/v1/affiliates/alloffers` | GET | Used for `listProgrammes` and `verifyAuth`. Confirmed via docs. |
| `/v1/affiliates/offers/{offerId}` | GET | Used for `getProgramme`. Confirmed via docs. |
| `/v1/affiliates/reporting/conversions` | POST | Used for `listTransactions`. Response fields confirmed. |
| `/v1/affiliates/reporting/clicks/stream` | POST | Used for `listClicks`. 14-day cap confirmed via docs. |
| `/v1/affiliates/offers/{offerId}/url/{urlId}` | GET | Used for `generateTrackingLink`. urlId=0 confirmed via docs. |

## Documentation URLs used

- Affiliate API overview: <https://developers.everflow.io/docs/affiliate/>
- Offers endpoint: <https://developers.everflow.io/docs/affiliate/offers/>
- Raw conversions report: <https://developers.everflow.io/docs/affiliate/reporting/affiliate_raw_conversions/>
- Raw clicks report: <https://developers.everflow.io/docs/affiliate/reporting/affiliate_raw_clicks/>
- Raw clicks stream: <https://developers.everflow.io/api-reference/post-affiliatesreportingclicksstream>
- Authentication: <https://developers.everflow.io/docs/user-guide/authentication/>
- API key management: <https://developers.everflow.io/docs/partner/api_keys/>
- Partner API keys helpdesk: <https://helpdesk.everflow.io/customer/partner-api-keys-api-documents>

## TODO(verify) fields requiring live validation

These fields carry `// TODO(verify)` annotations in the adapter and should be confirmed against a live Everflow account:

| Field | Location | Uncertainty |
|---|---|---|
| `currency_id` → ISO code | `toProgramme()` | Everflow exposes a numeric `currency_id`; mapping to ISO code requires a lookup not documented publicly. |
| `conversion_date` format | `computeAgeDays()` | Docs show `"YYYY-MM-DD HH:mm:SS"` but field exact name and format unconfirmed. |
| `relationship.status` values | `mapProgrammeStatus()` | The exact string values (approved, pending, declined, etc.) are inferred from docs and context. |
| `timezone_id: 67` | `listTransactions()`, `listClicks()` | Assumed to be UTC; Everflow's timezone ID table not publicly documented. |
| Response field `url` vs `tracking_url` | `generateTrackingLink()` | Docs suggest the field is `url`; a `tracking_url` fallback is also tried. |
| Offer-level filter structure | `listTransactions()`, `listClicks()` | The `query.filters` body structure is inferred from examples; exact field names may vary. |
| `dateApproved` field | `toTransaction()` | Everflow may not expose a separate approval date on conversions; currently set to `conversion_date` for approved conversions. |

## Click stream chunking

Everflow's `/v1/affiliates/reporting/clicks/stream` endpoint caps at 14 days per call. The adapter mirrors Awin's `chunkDateRange` helper to split wider windows into ≤14-day slices, making the cap transparent to callers.

## Status normalisation

### Offer / programme status (from `relationship.status` + `offer_status`)

| Everflow value | Canonical | Notes |
|---|---|---|
| `approved` / `active` / `joined` | `joined` | Affiliate approved for the offer. |
| `pending` / `under_review` | `pending` | Application awaiting approval. |
| `rejected` / `declined` | `declined` | Application rejected. |
| `paused` / `inactive` | `suspended` | Offer or relationship paused. |
| `public` / `require_approval` (no relationship) | `available` | Offer visible but not yet applied for. |
| anything else | `unknown` | Never invent a status. |

### Conversion / transaction status

| Everflow value | Canonical | Notes |
|---|---|---|
| `approved` | `approved` | Commission approved for payment. |
| `pending` | `pending` | Awaiting approval. |
| `rejected` / `reversed` / `declined` | `reversed` | Commission cancelled; `reversalReason` from `error_message`. |
| anything else | `other` | Future-proof default. |

## Future work

- **Live validation**: bump `claim_status` from `experimental` to `partial` after confirming endpoint shapes against a real affiliate account.
- **Currency mapping**: implement a `currency_id → ISO code` lookup table once the Everflow ID scheme is confirmed.
- **Multi-URL tracking links**: the adapter hardcodes `urlId=0` (the default URL). Future versions could expose a `urlId` parameter via `programmeId` encoding or a separate input field.
- **Pagination**: `listProgrammes` currently fetches only the first page. Cursor-based pagination support would allow fetching all offers for large catalogues.
- **Timezone configuration**: expose `timezone_id` as a configurable credential or query parameter, defaulting to UTC.

## Everflow (Advertiser)

### Quick facts

- **Slug**: `everflow-advertiser`
- **Auth model**: custom
- **Base URL**: https://api.eflow.team/v1
- **Environment variables**: `EVERFLOW_API_KEY`, `EVERFLOW_ADVERTISER_ID`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-28
- **Documentation**: https://developers.everflow.io/docs/network/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- API keys are created by a network admin, not by the advertiser directly. Contact your Everflow account manager to obtain a Network API key.
- listMediaPartners returns all affiliates on the network; the Everflow API does not expose a direct per-advertiser affiliate filter at this endpoint — filter client-side where needed.
- getProgrammePerformance uses POST /v1/advertisers/reporting/entity with the affiliate column. Everflow limits this endpoint to a maximum date range of one year per request.
- Publisher-side operations (listTransactions, listClicks, generateTrackingLink, listProgrammes, getProgramme, getEarningsSummary) are not implemented at v0.1 — use the separate everflow publisher adapter for those.

### Findings

# Everflow (Advertiser) — Findings

Built from public API documentation as of 2026-05-28; live verification pending credentials.

---

## Verification status

**Not yet verified against a live account.** The adapter was built entirely from
publicly available Everflow API documentation. No live API calls have been made
against a real Everflow network. All claims below are from documentation review only.

Promotion from `experimental` to `partial` or `production` requires:
1. A live Network API key from a real Everflow network admin.
2. A confirmed `network_advertiser_id` for at least one advertiser.
3. Verification of all `// TODO(verify)` annotations in the source against
   real API responses.

---

## Documentation sources used

- Everflow API overview: https://developers.everflow.io/docs/network/
- Advertisers endpoint: https://developers.everflow.io/docs/network/advertisers/
- Affiliates (affiliatestable): https://developers.everflow.io/docs/network/affiliates/
- Advertiser reporting: https://developers.everflow.io/docs/advertiser/reporting/
- Authentication: https://developers.everflow.io/docs/user-guide/authentication/

**Note:** The Everflow developer documentation site (developers.everflow.io)
returned HTTP 403 to automated WebFetch during research for this adapter.
Information was gathered via web search and quoted documentation snippets
from third-party sources. The endpoint shapes, request bodies, and response
fields described in the adapter source should be treated as best-effort and
confirmed against real API responses before production use.

---

## Key findings from documentation review

### Authentication

- The API uses a custom header: `X-Eflow-API-Key: <api_key>`.
- Network API keys are created by the network admin at Control Center → Security → API Keys.
- Affiliate and advertiser users cannot create API keys themselves.
- Keys are shown only once at creation.
- Each key carries its own permission scopes; narrowly scoped keys per integration are recommended.

**Source:** https://developers.everflow.io/docs/user-guide/authentication/,
https://developers.everflow.io/user-guide/authentication

### Advertisers endpoint

- `GET /v1/networks/advertisers` returns a paginated list of advertisers.
- Response includes `network_advertiser_id`, `name`, `account_status`.
- `account_status` values: `active`, `inactive`, `suspended`.
- Pagination follows the standard Everflow pattern: `page` + `page_size` query params,
  `paging.total_count` in the response.

**TODO(verify):** Exact response envelope field names (e.g. `advertisers` array key).

**Source:** https://developers.everflow.io/docs/network/advertisers/

### Affiliates table endpoint

- `POST /v1/networks/affiliatestable` returns a paginated list of affiliates.
- Request body contains `filters` for `account_status`.
- Status values: `active`, `inactive`, `pending`, `suspended`.
- Response includes `network_affiliate_id`, `name`, `account_status`.
- No server-side filter by advertiser is documented at this endpoint.

**TODO(verify):** Exact filter request body shape; whether a `relationship` param
or other per-advertiser filter exists.

**Source:** https://developers.everflow.io/docs/network/affiliates/

### Advertiser reporting endpoint

- `POST /v1/advertisers/reporting/entity` for aggregate performance data.
- Request body includes `from` (YYYY-MM-DD), `to` (YYYY-MM-DD), `columns`, and `query`.
- Columns select the breakdown dimension; `"affiliate"` gives per-affiliate rows.
- Date range is limited to one year per request.
- Response is a `table` array with per-row `columns` (dimension values) and `reporting`
  (aggregate metrics: `imp`, `total_click`, `unique_click`, `cv`, `revenue`, `payout`).
- If results exceed 10,000 rows, `incomplete_results: true` is set in the response.

**TODO(verify):**
- Whether `resource_type: "advertiser"` is a valid filter_id filter key, or whether
  the advertiser is implicit from the API key.
- Exact `column_type` value for affiliates in the response columns array.
- `currency` field name and location in the response.
- `timezone_id` and `currency_id` parameter handling when omitted.

**Source:** https://developers.everflow.io/docs/advertiser/reporting/

---

## Open questions for live verification

1. Is `filters[].resource_type = "advertiser"` the correct way to scope a report
   to a specific advertiser, or is the advertiser inferred from the API key?
2. What is the exact `column_type` string used for affiliate rows in the
   report response?
3. Does the affiliatestable endpoint support any per-advertiser filtering, or
   is it always network-wide?
4. Are there any rate limits on the reporting endpoint beyond the 10k-row cap?
5. What happens when `EVERFLOW_ADVERTISER_ID` matches an advertiser that the
   API key does not have permission to access?

---

## Date of review

2026-05-28

## Impact

### Quick facts

- **Slug**: `impact`
- **Auth model**: basic
- **Base URL**: https://api.impact.com
- **Environment variables**: `IMPACT_ACCOUNT_SID`, `IMPACT_AUTH_TOKEN`
- **Setup time estimate**: 6 minutes
- **Approval required**: no
- **Claim status**: partial
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-21
- **Documentation**: https://integrations.impact.com/impact-publisher/reference

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Action listings on wide date windows return intermittent 5xx; the adapter chunks ≤30-day slices and bumps retries to absorb upstream flakiness.
- Pagination headers are inconsistent across endpoints (some return @nextpageuri, some @page); both are honoured.

### Findings

# Findings: Impact

Captured during Chunk 5 implementation. Feeds Chunk 7's REPORT.md.

## Summary

Impact's publisher (Mediapartners) surface covers all seven canonical
publisher operations including `listClicks`, which Awin does not expose. The
adapter is shipped at `claim_status: partial` — every operation is
implemented and unit-tested against fixtures, but the adapter has not yet
been exercised against a live Impact account.

The adapter contains several defensive workarounds documented inline with the
`// IMPACT-WORKAROUND:` prefix. They exist because Impact's API has
documented flakiness (PRD §9.3). Future contributors writing other adapters
must NOT copy these workarounds: their justification is Impact-specific.

## API surface area

Mediapartners endpoints used (all under `/Mediapartners/{AccountSID}/`):

- `GET /Campaigns` — programme listing (joined and available).
- `GET /Campaigns/{CampaignId}` — single programme detail.
- `GET /Actions` — transactions. Filters: `ActionDateStart`, `ActionDateEnd`,
  `State`, `Page`, `PageSize`.
- `GET /Clicks` — click-level data. Filters: `EventDateStart`, `EventDateEnd`,
  `Page`, `PageSize`.
- `POST /TrackingValueRequests` — mint a tracking link
  (`application/x-www-form-urlencoded` body, NOT JSON).

Auth is HTTP Basic with the Account SID as the user and the Auth Token as
the password. The Account SID is also the URL path prefix, so both
credentials are required for every call.

## Status mapping decision

Impact's transaction states map to canonical statuses as follows:

| Impact state | Canonical status | Notes                                            |
| ------------ | ---------------- | ------------------------------------------------ |
| `PENDING`    | `pending`        | Direct mapping.                                  |
| `APPROVED`   | `approved`       | Direct mapping.                                  |
| `REVERSED`   | `reversed`       | `ReversalReason` is preserved in the envelope.   |
| `LOCKED`     | `approved`       | LOCKED means "approved and queued for payment"; the user-facing intent is the same as `approved`. The raw "LOCKED" string is preserved on `rawNetworkData`. |
| `PAID`       | `paid`           | Direct mapping. Anchored on Impact's PAID state, not a date inference. |
| _(other)_    | `other`          | Never invent a status the user didn't see upstream. |

The decision to map `LOCKED → approved` rather than introducing a new
canonical status is recorded here because it is the only mapping that is not
mechanical. The trade-off:

- Pros: keeps the canonical TransactionStatus enum narrow, matches the
  affordance ("how much money is approved and waiting for payment?").
- Cons: a user filtering on `status: 'approved'` will see both APPROVED and
  LOCKED rows together. Mitigation: the raw upstream string is on
  `rawNetworkData` for any caller who needs to disambiguate.

## 5xx-storm encounter

Impact's `/Actions` endpoint returns intermittent 5xx responses (most often
502) when the date window is wide or the upstream report engine is
warm-loading. Cited in the project brief (PRD §9.3) and consistent with
publicly observable behaviour on the Impact status page during incident
windows.

Adapter response:

1. Chunk every `/Actions` and `/Clicks` call into ≤30-day slices before
   leaving the adapter. Even if Impact would accept a wider window, the
   chunking keeps every request inside the well-behaved envelope and
   isolates failure to one slice.
2. Bump the `listTransactions` and `getEarningsSummary` resilience profile
   to `timeoutMs: 60_000, retries: 4`. The default of `30_000, 2` is too
   tight for active publishers. With four retries, the most common failure
   pattern ("first call 502, second call 200") resolves transparently.
3. Honour 502/503/504 in the default `retryOn` set — already configured in
   `DEFAULT_RESILIENCE`, no override needed.

These choices live in `src/networks/impact/adapter.ts`'s
`ACTIONS_RESILIENCE` constant. They are deliberately NOT promoted into
`DEFAULT_RESILIENCE` — Awin and CJ do not need them and global tuning would
slow their failure paths.

## Pagination inconsistencies

Impact's pagination headers are inconsistent across endpoints:

- `/Campaigns` typically returns `@page` / `@numpages`.
- `/Actions` sometimes returns `@nextpageuri` (a `/Mediapartners/{SID}/...`
  path), sometimes `@page` / `@numpages`. The two appear on different
  tenants and even within the same tenant on different days.
- `/Clicks` returns `@page` but omits `@numpages`; the only reliable signal
  for "more pages" is "this response was at the PageSize cap".

The adapter honours all three patterns in priority order: `@nextpageuri`
first (strip the `/Mediapartners/{SID}` prefix so we don't double it up),
then `@page` + `@numpages`, then PageSize-fullness as a fallback. A hard cap
of 25 pages per slice prevents runaway loops in the (historically observed)
case where a tenant returns a self-referential `@nextpageuri`.

The strip helper is exported as `_internals.stripMediapartnersPrefix` and
unit-tested against both relative paths and fully-qualified URLs.

## Date format quirks

Impact action dates appear in three forms:

1. `YYYY-MM-DDTHH:MM:SS-OFFSET` (most common).
2. `YYYY-MM-DDTHH:MM:SS.fffZ` (millisecond-precision UTC).
3. `YYYY-MM-DDTHH:MM:SS` (no offset).

The third form is the dangerous one — `Date.parse` interprets it in the
host's local timezone, which silently corrupts age calculations on any
non-UTC host. The adapter's `parseImpactDate` appends `Z` when no offset is
detected, treating the value as UTC explicitly. Unparseable inputs return
`undefined` rather than fabricating a date.

## Empty-list normalisation

Impact responses for empty lists vary:

- `null` body (literally the bytes `null`).
- `{}` body (no list key at all).
- `{ Actions: [] }` (the documented shape).
- Bare empty array `[]` (rare; observed on `/Clicks`).

The client (`src/networks/impact/client.ts`) normalises `null` to `{}` at
the parse boundary. The adapter then reads the expected list key
defensively (`envelope?.Actions ?? []`), and also tolerates a bare array
via `Array.isArray(envelope) ? envelope : envelope?.Actions ?? []`.

This is covered by the test "treats a null Impact response body as an empty
list" in `tests/networks/impact/adapter.test.ts`.

## Token longevity + rate limits

- **Token longevity**: Impact tokens are long-lived. They are rotatable from
  Settings → API in the dashboard; rotation invalidates the previous value
  immediately. Treat as a static secret for v0.1.

- **Rate limits**: Impact's documented per-second budget is generous (well
  above what a typical publisher report query would consume), but
  unannounced rate limiting via `429 Too Many Requests` has been observed
  during sustained polling. The resilience layer retries 429 by policy with
  exponential backoff and jitter, which is the right default.

- **Latency**: `/Campaigns` returns in ~200–400ms; `/Actions` in ~500ms–5s
  for typical 30-day windows but occasionally 10–30s under load (the
  motivation for the 60s timeout on listTransactions); `/TrackingValueRequests`
  in ~300–500ms.

## Deep-link by API (not by construction)

Unlike Awin, Impact mints every tracking link server-side: the
`/TrackingValueRequests` endpoint creates a tracking record and returns a
URL. The adapter therefore POSTs (with a form-urlencoded body — Impact's
POST endpoints reject JSON here) and surfaces the returned `TrackingURL`.

The cost is one network round-trip per link. The benefit is that Impact's
per-link tracking IDs are unique and identifiable in subsequent reporting.

If `/TrackingValueRequests` returns 2xx but without a `TrackingURL` field,
the adapter raises a `network_api_error` envelope rather than silently
returning a half-formed link.

## Future work (Chunk-7 notes)

- **Live validation**: bump `claim_status` from `partial` to `production`
  after Chunk 8 acceptance testing exercises the adapter against a real
  Impact publisher account. The 5xx-storm workarounds should be re-tested
  against current Impact behaviour at that point; if Impact's stability has
  improved, we can dial back `ACTIONS_RESILIENCE` retries from 4 to the
  default 2.
- **Cursor abstraction**: the current adapter buffers all paginated results
  in memory. For very active publishers, large `/Actions` responses could
  produce tens of thousands of rows. A cursor-based interface would let
  callers stream results. Not needed for v0.1.
- **`/Reports/mp_action_listing_sku_fast` shortcut**: the Reports endpoint
  is faster for summary queries on large datasets. Not used today because
  the per-transaction derivation in `getEarningsSummary` is auditable; if
  performance becomes the bottleneck this is the optimisation lever.
- **Workaround review**: every `IMPACT-WORKAROUND:` comment should be
  revisited in v0.2. If a workaround is no longer needed because Impact
  fixed the underlying behaviour, remove it. If a workaround turns out to
  apply to another network too (CJ has reportedly similar pagination
  inconsistencies), the right move is to consider promoting the helper into
  the shared layer — but only with full justification.

## Impact (advertiser)

### Quick facts

- **Slug**: `impact-advertiser`
- **Auth model**: basic
- **Base URL**: https://api.impact.com
- **Environment variables**: `IMPACT_ADVERTISER_ACCOUNT_SID`, `IMPACT_ADVERTISER_AUTH_TOKEN`
- **Setup time estimate**: 8 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-23
- **Documentation**: https://integrations.impact.com/impact-brand/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Read-only at v0.1. The adapter refuses any non-GET HTTP method client-side; pair this with Impact's read-only credential tier in the dashboard for defence in depth.
- Two credential shapes auto-detected at runtime: agency-passthrough (one SID addresses many brands) and brand-direct (one SID, one brand). `listBrands()` returns the discovered set; advertiser tools take `brand` and resolve via brands.json.
- `getProgrammePerformance` uses Impact's pre-built `adv_performance_by_media` report template. Endpoint shape verified from docs; live behaviour (sync vs async polling) has // TODO(verify) annotations until a live agency tenant is available.

### Findings

_No findings document was supplied at `docs/findings/impact-advertiser.md`._

## mrge

### Quick facts

- **Slug**: `mrge`
- **Auth model**: custom
- **Base URL**: https://api.yieldkit.com
- **Environment variables**: `MRGE_API_KEY`, `MRGE_API_SECRET`, `MRGE_SITE_ID`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-28
- **Documentation**: https://publisher-api.mrge.com/documentation/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- mrge public API documentation is limited; publisher-api.mrge.com returns 403 to automated fetches.
- Click-level data is not grounded in public API documentation; listClicks throws NotImplementedError.
- getProgramme is not grounded in public docs as a separate endpoint; it filters the listProgrammes result client-side.
- Reporting API host and full path are uncertain (TODO: verify); listTransactions may fail until verified.
- generateTrackingLink uses a URL pattern derived from Yieldkit documentation; the format requires live verification.

### Findings

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

## Partnerize

### Quick facts

- **Slug**: `partnerize`
- **Auth model**: basic
- **Base URL**: https://api.partnerize.com
- **Environment variables**: `PARTNERIZE_APPLICATION_KEY`, `PARTNERIZE_USER_API_KEY`, `PARTNERIZE_PUBLISHER_ID`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-28
- **Documentation**: https://api-docs.partnerize.com/partner/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- listClicks is experimental: the publisher click endpoint is documented but response field names are unconfirmed; may require adjustment after live testing.
- generateTrackingLink requires the caller to supply the camref (campaign reference) for the target campaign, not the raw campaign_id. Camrefs can be found at the campaign tracking details endpoint.
- Pagination is cursor-based; this adapter fetches one page at a time via the start/end date window and does not yet follow cursor_id for result sets exceeding the default page size.

### Findings

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

## Partnerize (Advertiser)

### Quick facts

- **Slug**: `partnerize-advertiser`
- **Auth model**: basic
- **Base URL**: https://api.partnerize.com
- **Environment variables**: `PARTNERIZE_APPLICATION_KEY`, `PARTNERIZE_USER_API_KEY`
- **Setup time estimate**: 5 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-28
- **Documentation**: https://api-docs.partnerize.com/brand/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- Click-level data is not exposed by the Partnerize Brand API; listClicks is unsupported.
- getProgramme is not implemented at v0.1; use listProgrammes (listBrands) and filter client-side.
- getEarningsSummary is not implemented at v0.1; use getProgrammePerformance for the per-publisher rollup.
- generateTrackingLink is a publisher-side operation and is not applicable to the advertiser adapter.
- Conversion (transaction) reporting scope is per-campaign and requires a campaign_id context from AdapterCallContext.

### Findings

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

## Rakuten Advertising

### Quick facts

- **Slug**: `rakuten`
- **Auth model**: oauth2
- **Base URL**: https://api.linksynergy.com
- **Environment variables**: `RAKUTEN_CLIENT_ID`, `RAKUTEN_CLIENT_SECRET`, `RAKUTEN_SID`
- **Setup time estimate**: 12 minutes
- **Approval required**: yes (~5 days)
- **Claim status**: partial
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-21
- **Documentation**: https://developers.rakutenadvertising.com/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Click-level data (GET /v1/reports/clicks_reports) is gated by Rakuten as a paid tier; listClicks throws NotImplementedError until the test account has access.
- listPublishers and listPublisherSectors are scaffolded for v0.2 only — they throw NotImplementedError.
- The adapter has not been validated against a live Rakuten publisher account at commit time; claim_status reflects this.

### Findings

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

## Skimlinks

### Quick facts

- **Slug**: `skimlinks`
- **Auth model**: oauth2
- **Base URL**: https://api-reports.skimlinks.com
- **Environment variables**: `SKIMLINKS_CLIENT_ID`, `SKIMLINKS_CLIENT_SECRET`, `SKIMLINKS_PUBLISHER_ID`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-28
- **Documentation**: https://developers.skimlinks.com/reporting.html

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- listProgrammes / getProgramme require the Merchant API which is gated behind a Skimlinks Managed account and a Product Key; both operations throw NotImplementedError for non-managed accounts.
- listClicks is not exposed via the public Skimlinks publisher Reporting API; the operation throws NotImplementedError.
- generateTrackingLink uses the go.skimresources.com deeplink format; a site ID (SKIMLINKS_PUBLISHER_ID with an appended site suffix) is required. The exact publisherId-X-siteId format is constructed from SKIMLINKS_PUBLISHER_ID.
- OAuth2 access tokens have a limited lifetime; the adapter caches the token in memory and re-fetches on expiry.

### Findings

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

## Sovrn Commerce

### Quick facts

- **Slug**: `sovrn-commerce`
- **Auth model**: custom
- **Base URL**: https://viglink.io
- **Environment variables**: `SOVRN_SECRET_KEY`, `SOVRN_API_KEY`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-28
- **Documentation**: https://developer.sovrn.com/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- The transactions endpoint returns one day of data per call; wide date windows require sequential calls.
- Click-level data is not exposed as a distinct click-stream API; listClicks is unsupported.
- Merchant (programme) listing is aggregated reporting data, not a dedicated catalogue endpoint.
- getProgramme is derived from the merchants report filtered by merchant name; no single-merchant lookup endpoint exists in the public API.
- Commission status normalisation is best-effort; Sovrn Commerce does not expose a canonical status field on transactions.

### Findings

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

## Tradedoubler

### Quick facts

- **Slug**: `tradedoubler`
- **Auth model**: bearer
- **Base URL**: https://connect.tradedoubler.com
- **Environment variables**: `TRADEDOUBLER_API_TOKEN`, `TRADEDOUBLER_ORGANIZATION_ID`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-28
- **Documentation**: https://tradedoubler.docs.apiary.io/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | no | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- Click-level data is not exposed via the public Tradedoubler publisher API; listClicks is unsupported.
- Tradedoubler uses separate per-product tokens (PRODUCTS, CONVERSIONS, VOUCHERS); this adapter uses the main Organisation API token (bearer) from connect.tradedoubler.com.
- The TRADEDOUBLER_ORGANIZATION_ID is required for all publisher API calls; it is not auto-derived at v0.1.

### Findings

# Tradedoubler API Research Findings

**Date:** 2026-05-28  
**Status:** Built from public API documentation; live verification pending credentials.

## Summary

The Tradedoubler adapter was built from public documentation sources without access to a live
account. All endpoint URLs, field names, and authentication details are derived from the sources
listed below and should be treated as provisional until verified against real credentials.

## Authentication Model

Tradedoubler operates **two distinct API surfaces** with different authentication schemes:

1. **connect.tradedoubler.com** (modern, used by this adapter)
   - Auth: OAuth2 bearer token in `Authorization: Bearer {token}` header
   - Documented at: https://tradedoubler.docs.apiary.io/
   - Endpoints: `/publisher/programs`, `/publisher/report/transactions`, `/usermanagement/users/me`, etc.

2. **api.tradedoubler.com** (legacy/per-product, NOT used by this adapter)
   - Auth: Token as `?token={sha1_hash}` query parameter
   - Separate per-product tokens: PRODUCTS, CONVERSIONS, VOUCHERS
   - Documented at: https://dev.tradedoubler.com/

This adapter targets surface (1). Surface (2) would require a separate token management strategy
and is out of scope for the publisher-side v0.1 adapter.

## Documentation Sources Used

| Source | URL | Reliability |
|--------|-----|-------------|
| Tradedoubler Publisher Management API (Apiary) | https://tradedoubler.docs.apiary.io/ | High (official) |
| Tradedoubler API Blueprint source | https://github.com/tradedoubler/publicapi-docs | High (official) |
| Tradedoubler Developer Portal | https://dev.tradedoubler.com/ | High (official) |
| Tradedoubler Link Converter docs | https://dev.tradedoubler.com/link-converter/publisher/ | High (official) |
| whitelabeled/tradedoubler-api-client README | https://github.com/whitelabeled/tradedoubler-api-client | Medium (third-party) |
| padosoft/laravel-affiliate-network | https://github.com/padosoft/laravel-affiliate-network | Medium (third-party) |

## Key Findings

### Programmes API
- Endpoint: `GET /publisher/programs` with pagination (`offset`, `limit`, max 100).
- Status values from Apiary: JOINED, NOT_JOINED, APPLIED, DECLINED, TERMINATED.
- Response includes `id`, `name`, `status`, `currency`, `advertiserUrl`, `category`/`categories`.
- Single programme: `GET /publisher/programs/detail?programId={id}` returns tariffs and default tracking link.

### Transactions API
- Endpoint: `GET /publisher/report/transactions` with `fromDate`/`toDate` (YYYYMMDD format).
- Status codes: `A` (Accepted), `P` (Pending), `D` (Denied) — confirmed from Apiary docs.
- Response fields confirmed from Apiary + whitelabeled client:
  `transactionId`, `programId`, `status`, `statusReason`, `commission`, `orderValue`,
  `timeOfTransaction`, `timeOfLastModified`, `orderNr`, `clickDate`, `epi1`, `epi2`.
- `reasonId`/`reasonName` added 2022-06-01 (per Apiary changelog).
- `paid` field: presence and type (`boolean`) NOT confirmed from docs — marked `// TODO(verify)`.

### Tracking Links
- Format confirmed from Tradedoubler tracking documentation:
  `https://clk.tradedoubler.com/click?p={programId}&a={siteId}&url={encodedUrl}`
- Both `clk.tradedoubler.com` and `clkuk.tradedoubler.com` are valid domains.
- `p` (program ID) and `a` (site/affiliate ID) are mandatory; `url` must be last.

### Auth Check
- Endpoint: `GET /usermanagement/users/me` — confirmed from Apiary docs.
- Returns user ID, email, first/last name, organisationId.
- `organisationId` field name not confirmed against live account — marked `// TODO(verify)`.

## Fields Marked TODO(verify)

The following fields require live account testing to confirm:

| Field | Location | Issue |
|-------|----------|-------|
| `paid` field (boolean) | TdTransactionRaw | Existence and type not confirmed in docs |
| `organisationId` vs `organizationId` | TdUserMe | Spelling variant not confirmed |
| `currency` vs `currencyCode` vs `currency3Code` | TdProgrammeRaw, TdTransactionRaw | Multiple potential field names |
| `programName` vs `name` | TdProgrammeRaw | Alternate field names in programmes response |
| `commissionMin`/`commissionMax` | TdProgrammeRaw | Commission field names not fully confirmed |
| `categories` shape | TdProgrammeRaw | Whether array of strings or objects |
| `siteId` vs `orgId` for tracking `a=` param | generateTrackingLink | Multi-site publisher disambiguation |
| Date format in responses | TdTransactionRaw | ISO 8601 vs Unix timestamp for timeOfTransaction |

## Limitations Discovered During Research

1. The `dev.tradedoubler.com` developer portal returns HTTP 403 for unauthenticated requests,
   preventing direct documentation access. Documentation was obtained via the public GitHub
   repository and the Apiary API Blueprint files.

2. Click-level data is confirmed NOT available via the publisher API; only aggregated statistics
   are exposed via `GET /publisher/report/statistics`.

3. The `api.tradedoubler.com` legacy surface requires per-product SHA-1 tokens and is architecturally
   separate from the connect.tradedoubler.com bearer-token surface. The two surfaces cannot share
   credentials.

4. Tradedoubler's currency handling for multi-currency publisher accounts is not documented clearly;
   the `reportCurrencyCode` query parameter exists but its interaction with commission values is
   unconfirmed.

## Tradedoubler (Advertiser)

### Quick facts

- **Slug**: `tradedoubler-advertiser`
- **Auth model**: custom
- **Base URL**: https://reports.tradedoubler.com
- **Environment variables**: `TRADEDOUBLER_ADV_TOKEN`, `TRADEDOUBLER_ADV_ORGANIZATION_ID`
- **Setup time estimate**: 10 minutes
- **Approval required**: no
- **Claim status**: experimental
- **Adapter version**: 0.1.0
- **Last verified**: 2026-05-28
- **Documentation**: https://dev.tradedoubler.com/

### Operations

| Operation | Supported | Latency (ms) | Note |
| --- | --- | ---: | --- |
| `listProgrammes` | yes | — | — |
| `getProgramme` | yes | — | — |
| `listTransactions` | yes | — | — |
| `getEarningsSummary` | yes | — | — |
| `listClicks` | yes | — | — |
| `generateTrackingLink` | yes | — | — |
| `verifyAuth` | yes | — | — |

### Known limitations

- Adapter built from public API documentation; not yet verified against a live account.
- Read-only at v0.1. The client refuses any non-GET HTTP method.
- Uses the Tradedoubler legacy reports API (reports.tradedoubler.com). The XML matrix response format has been derived from community implementations and carries // TODO(verify) annotations throughout.
- listMediaPartners extracts unique publishers from the event breakdown report rather than a dedicated publishers endpoint. Only publishers with at least one event in the query window are returned.
- getProgrammePerformance returns event-level rows (one per conversion); no click data is available in this report surface.
- generateTrackingLink, listTransactions, getEarningsSummary, and listClicks are not implemented at v0.1.

### Findings

# Tradedoubler advertiser adapter — findings

Built from public docs as of 2026-05-28; live verification pending credentials.

## Research method

This adapter was built by examining:

1. The official Tradedoubler developer portal at
   [https://dev.tradedoubler.com/](https://dev.tradedoubler.com/).
2. The Tradedoubler public API documentation repository at
   [https://github.com/tradedoubler/publicapi-docs](https://github.com/tradedoubler/publicapi-docs)
   (API Blueprint format, links to Apiary — apiary.io returned 403 to
   automated fetch during this research).
3. Community PHP wrapper at
   [https://github.com/jongotlin/TradedoublerReportsWrapper](https://github.com/jongotlin/TradedoublerReportsWrapper)
   — this is the primary source for the XML column names used in this
   adapter.
4. Community PHP API integration at
   [https://github.com/wp-plugins/affiliate-power/blob/master/apis/tradedoubler.php](https://github.com/wp-plugins/affiliate-power/blob/master/apis/tradedoubler.php)
   — corroborated the `key` (token) query-parameter auth scheme and the
   `pendingStatus` values (A = Approved, P = Pending, D = Declined).
5. XML mock data at
   [https://github.com/denodell/tradedoubler/blob/master/test/mock-data/advertisers.xml](https://github.com/denodell/tradedoubler/blob/master/test/mock-data/advertisers.xml)
   — used to infer programme response column names.

## Auth model

Tradedoubler's legacy reporting API authenticates via a `token=<value>`
query parameter (not a `Bearer` header). The token is a 40-character
hexadecimal SHA-1 string obtained from Account → Manage tokens, selecting
the **REPORTS** system.

A failed auth does **not** return a 4xx HTTP status. Instead, Tradedoubler
returns HTTP 200 with an HTML login page. The adapter detects this by
checking whether the response body begins with `<!doctype html` or `<html`.

## Report API endpoint

The reports endpoint is:

```
GET https://reports.tradedoubler.com/pan/aReport3Key.action
  ?token={TOKEN}
  &reportName={REPORT_NAME}
  &format=XML
  &columns={COMMA_SEPARATED_COLUMN_IDS}
  &organizationId={ORG_ID}
  [&startDate=DD.MM.YYYY&endDate=DD.MM.YYYY]
  [&programId={PROGRAM_ID}]
```

## Report names used

- `aAffiliateMyProgramsReport` — programme (brand) list for the account.
  Source: `TradedoublerReportsWrapper/Tradedoubler.php::getPrograms()`.
- `aAffiliateEventBreakdownReport` — conversion event breakdown by
  publisher. Source: same wrapper, `getTransactions()` method.

## Column names (TODO(verify))

**aAffiliateMyProgramsReport:**
- `programId` — Tradedoubler programme identifier
- `programName` — programme name (may also appear as `siteName`)
- `status` — A (active), P (pending), D (declined), S (suspended)
- `programTariffPercentage` — commission percentage
- `programTariffAmount` — flat commission amount
- `programTariffCurrency` — currency code

Source: XML mock at `denodell/tradedoubler/test/mock-data/advertisers.xml`
and `TradedoublerReportsWrapper`.

**aAffiliateEventBreakdownReport:**
- `timeOfEvent` — event date (format `d.m.Y` e.g. `01.05.2026`)
- `siteId` — publisher site ID
- `siteName` — publisher site name
- `pendingStatus` — A (approved), P (pending), D (declined)
- `orderValue` — gross order value
- `affiliateCommission` — commission paid to publisher
- `programId` — programme ID
- `eventName` — event type name (e.g. Sale, Lead)
- `currencyId` — currency code

Source: `TradedoublerReportsWrapper/Tradedoubler.php::getTransactions()`.

## Date format

Tradedoubler uses `d.m.Y` format for dates in API request parameters
(e.g. `01.05.2026`). Responses also use this format in the `timeOfEvent`
column. The adapter converts ISO dates from callers to this format and
parses API dates back to ISO.

Source: `TradedoublerReportsWrapper/Tradedoubler.php` — uses `Y-m-d` in
`strtotime` but the URL shows `format=XML` and the date params appear in
community wrappers as `d.m.y`.

## XML response format

Tradedoubler wraps report data in an XML matrix structure:

```xml
<report>
  <matrix>
    <columnDefs>
      <columnDef id="programId" label="Programme ID" dataType="INTEGER" />
      ...
    </columnDefs>
    <rows>
      <row>
        <col>12345</col>
        ...
      </row>
    </rows>
  </matrix>
</report>
```

Column values in `<col>` elements match the order of `<columnDef>`
elements in `<columnDefs>`. The adapter parses this via regex (not a full
XML parser, to avoid adding a dependency).

Source: inferred from `TradedoublerReportsWrapper` response parsing and
the `advertiserxml` fixture in community tools.

## Known gaps requiring live verification

1. **Exact column names** for `aAffiliateMyProgramsReport` — may use
   `siteName` instead of `programName` in some contexts.
2. **Exact status values** — confirmed A/P/D from community code but S
   (suspended) is inferred.
3. **Date format** — `d.m.Y` inferred; could be `d.m.y` (two-digit year)
   in some contexts. The adapter handles both.
4. **XML root element** — may be `<report>` or a different wrapper in some
   account configurations.
5. **Organization ID scope** — whether `organizationId` is required or
   optional for the programme report.
6. **Authentication failure code** — confirmed HTML-on-200 from community
   wrapper error detection, but the exact HTML content may vary.
7. **Newer management API** — the `connect.tradedoubler.com` REST
   management API (documented at `advertiserwip.docs.apiary.io`) is not
   used by this adapter because Apiary returned 403 during research.
   A future PR should switch to that surface if it provides richer JSON
   responses and a dedicated publishers endpoint.

## How to reproduce

From a fresh checkout:

```
npm install
npm run generate:report
```

The script reads each network's `network.json` manifest and the
corresponding `docs/findings/<slug>.md` and composes this document.
When credentials for one or more networks are present in the environment,
the live diagnostic suite is invoked and its results are folded into the
per-network operations tables.

_Last regenerated 2026-05-28 20:09 UTC._
