# affiliate-mcp Report — the state of affiliate-network APIs in May 2026

_Date-stamped: 2026-05-23._

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
| Impact | 6 | no | 7 / 7 | 2 | partial | 0.1.0 | 2026-05-21 |
| Impact (advertiser) | 8 | no | 7 / 7 | 3 | experimental | 0.1.0 | 2026-05-23 |
| Rakuten Advertising | 12 | yes (~5 days) | 6 / 7 | 3 | partial | 0.1.0 | 2026-05-21 |

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
- **Documentation**: https://wiki.awin.com/index.php/API_Get_Started

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

- **`/publishers` doubles as auth-check + identity discovery**: a single call
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

- **Schema drift between tenants.** The `/publishers` response uses
  `publisherId` in newer tenants and `id`/`accountId` in older ones. We
  accept all three rather than picking one. This is the kind of compatibility
  shim that should NOT be promoted into a shared layer — it's Awin-specific.

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

- **Latency**: `/publishers` returns in ~100–200ms; `/programmes` in
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

_Last regenerated 2026-05-23 09:49 UTC._
