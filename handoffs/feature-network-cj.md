# Handoff — `feature/network-cj`

**Chunk**: 3 — CJ Affiliate adapter
**Branch**: `feature/network-cj`
**Base**: `claude/affiliate-mcp-orchestration-qfKw4`

## What I did

Implemented the CJ Affiliate adapter pattern-matched to Awin (the canonical
reference). Everything lives under `src/networks/cj/`. Tests under
`tests/networks/cj/` and `tests/fixtures/cj/`. Findings at
`docs/findings/cj.md`.

### Files added

- **`src/networks/cj/network.json`** — manifest. `slug: cj`, `name: CJ
  Affiliate`, `base_url: https://api.cj.com`, `auth_model: bearer`,
  `env_vars: ["CJ_API_TOKEN", "CJ_COMPANY_ID"]`,
  `setup_time_estimate_minutes: 8`, `setup_requires_approval: false`,
  `claim_status: partial`, `adapter_version: 0.1.0`,
  `last_verified: 2026-05-21`, `supports_brand_ops: false`,
  `docs_url: https://developers.cj.com/`.
  - `known_limitations`: click-level data not exposed via modern GraphQL,
    plus the standard brand-side stub note.

- **`src/networks/cj/client.ts`** — the only sanctioned HTTP path. Two
  helpers, both wrapped in `withResilience`:
  - `cjGraphQL<T>({ endpoint, query, variables, operation, token, ... })`
    — handles both GraphQL endpoints (`commissions.api.cj.com/query` and
    `ads.api.cj.com/query`). On GraphQL `errors` payloads (even on HTTP
    200) synthesises `HttpStatusError(200, body, ...)` so the verbatim
    body reaches the envelope.
  - `cjRest<T>({ baseUrl, path, method, body, operation, token, ... })` —
    for the link-builder REST endpoint and any future legacy report.
  - Both throw `HttpStatusError(status, rawBody, message)` on non-2xx so
    the resilience layer applies its retry policy uniformly.
  - Re-exports `HttpStatusError`.

- **`src/networks/cj/auth.ts`** — credential validation + auth-check.
  - `verifyAuth()` runs `{ me { id companyId name email company { id name } } }`
    against the commissions GraphQL endpoint, returns
    `{ ok: true, identity, derivedValues: { CJ_COMPANY_ID } }` on success
    or `{ ok: false, reason, envelope }` on failure.
  - `validateCredential(field, value)` — runs token via `verifyAuth`;
    validates company ID as positive integer string.
  - Heavily commented on the `derivedValues` pattern (CJ_COMPANY_ID
    bootstrap) — mirrors the Awin `derivedValues` doc pattern.

- **`src/networks/cj/setup.ts`** — `setupSteps()` returns two `SetupStep`
  records. Walks the user through CJ dashboard → Account → Personal Access
  Tokens with exact button labels.

- **`src/networks/cj/adapter.ts`** — the `NetworkAdapter` implementation.
  - All seven publisher operations + the two admin stubs.
  - `listProgrammes` — `advertisers(companyId, recordsPerPage, advertiserStatus)`
    against ads GraphQL; client-side filters for search/categories/status/limit.
    Tolerates both `advertisers.resultList` (modern) and flat array (legacy).
  - `getProgramme` — single-ID query via the same endpoint; numeric-only
    validation; explicit "no advertiser found" envelope on empty result.
  - `listTransactions` — `publisherCommissions(forPublishers, sincePostingDate, beforePostingDate)`
    against commissions GraphQL. Supports
    `programmeId/status/from/to/minAgeDays/maxAgeDays/limit`. Anchors
    `ageDays` on `lockingDate ?? postingDate ?? eventDate`.
  - `getEarningsSummary` — aggregates from `listTransactions` (auditable
    single source of truth, same pattern as Awin). Surfaces
    `oldestUnpaidAgeDays` from pending+approved.
  - `listClicks` — throws `NotImplementedError("CJ does not expose
    click-level data via the modern GraphQL surface; legacy REST report
    endpoints are inconsistently available across accounts")`.
  - `generateTrackingLink` — deterministic
    `https://www.dpbolvw.net/click-{publisherId}-{advertiserId}?url={encoded}`.
    No network call. Required-field validation throws `config_error`
    envelopes.
  - `capabilitiesCheck` — probes each op with minimal queries; records
    `listClicks` as `supported:false` without probing.
  - `listPublishers` / `listPublisherSectors` — throw
    `NotImplementedError("Brand-side operations are scaffolded for v0.2")`.
  - `derivedValues()` — exposes `CJ_COMPANY_ID` source-tagged.
  - `resilienceConfig` — `{ default, listTransactions: 60s/3 retries,
    getEarningsSummary: same }`.
  - Module top-level: `registerAdapter(cjAdapter)`.

- **`src/networks/index.ts`** — added the one line: `import './cj/adapter.js';`.

- **Tests** (`tests/networks/cj/adapter.test.ts`, `manifest.test.ts`) — 24
  tests. Status normalisation (NEW/LOCKED/CLOSED/EXTENDED), age filter
  (§15.9), reversed visibility (§15.10), deterministic link, listClicks
  NotImplementedError, verifyAuth happy/sad, 401 → auth_error, 500 with
  body → verbatim networkErrorBody, GraphQL 200-with-errors → verbatim
  body, capabilitiesCheck. Uses `globalThis.fetch` mocks — no live HTTP.

- **Fixtures** (`tests/fixtures/cj/`) — `me.json`, `advertisers.json`,
  `commissions.json`. Synthesised CJ GraphQL response shapes; no real
  data, no real tokens. Commission fixture spans Jan 2024 → April 2026
  to exercise the unpaid-age + reversed-sale tests.

- **`docs/findings/cj.md`** — qualitative findings: GraphQL/REST split,
  schema documentation quality, PAT longevity, rate-limit observations,
  status-mapping rationale, deep-link-by-construction, derivedValues
  bootstrap, click-data landscape, future work.

## What's tested

All 80 tests pass (56 baseline + 24 new CJ tests). `npm run typecheck`,
`npm run lint`, `npm test`, `npm run build`, `npm run validate:network cj`
all green. The live diagnostic for CJ correctly reports missing credentials
(expected without real PAT).

Quality bars (PRD §15) status:

- **§15.4 error transparency** — covered. Test names:
  - `surfaces the verbatim CJ response body on a 500` — asserts
    `env.network === 'cj'`, `env.operation === 'listProgrammes'`,
    `env.httpStatus === 500`, `env.networkErrorBody.includes('upstream broke')`.
  - `classifies 401 as auth_error (§15.4)` — asserts `env.type === 'auth_error'`.
  - `surfaces GraphQL "errors" payloads verbatim even on HTTP 200` — CJ
    can return 200-with-errors per the GraphQL spec; the verbatim body
    must still reach the envelope. This is a CJ-specific reinforcement
    of §15.4 that Awin doesn't exercise (Awin is pure REST).
  - `emits an error envelope when the token is missing (§15.4)` —
    `config_error` envelope via `requireCredential`.
  - `surfaces a NetworkErrorEnvelope shape on 401 (§15.4)` — auth_error
    on verifyAuth.

- **§15.9 unpaid-age filter** — covered. Test name:
  - `returns only aged transactions when minAgeDays is set (§15.9)` —
    asserts every returned transaction has `ageDays >= 365`.
  - `getEarningsSummary` separately computes `oldestUnpaidAgeDays` across
    pending+approved (logic exercised via the capabilitiesCheck path).

- **§15.10 reversed-sale visibility** — covered. Test name:
  - `surfaces reversalReason from correctionReason on reversed transactions (§15.10)`
    — asserts the CLOSED commission is mapped to `status: 'reversed'`
    with `reversalReason: 'Customer returned the item within 14 days'`
    populated from CJ's `correctionReason` field.
  - `includes reversed transactions with reason populated (§15.10)` —
    asserts the reversed transaction is returned by default (not
    filtered out) and carries the reason.

## What's unfinished

- **Live API exercise.** The adapter has not been run against a real CJ
  publisher account. `claim_status` is `partial` until Chunk 8.
- **Pagination cursor for `publisherCommissions`.** Wide date windows
  may truncate; for v0.1 we request a single page. Adding cursor support
  is straightforward.
- **Legacy click-data REST report.** Could be implemented as a fallback
  on accounts that have access — but the response shape predates the
  modern schema and would need a bespoke transformer. Documented in
  `docs/findings/cj.md`.
- **Link-builder REST path.** The deterministic redirect works on every
  account; the modern `POST /v1/links` endpoint is documented in
  `client.ts` for tenants that need a tracking ID.
- **Multi-publisher accounts.** The deep-link uses `CJ_COMPANY_ID` as the
  publisher path segment. Multi-site publishers may need a separate
  `CJ_WEBSITE_ID`; documented as future work.

## What surprised me

- **CJ may return HTTP 200 with `errors` in the body.** Standard GraphQL
  behaviour, but it means the resilience layer's pure status-code retry
  policy doesn't trigger on these. I synthesise `HttpStatusError(200,
  body, ...)` inside `cjGraphQL` so the verbatim body reaches the
  envelope. Tests confirm the path (`surfaces GraphQL "errors" payloads
  verbatim even on HTTP 200`). The synthesised 200 falls through to "no
  retry" in `isRetryable`, which is correct — repeating a malformed
  query gets the same error.

- **No single `commissionStatus` field — both `actionStatus` and
  `commissionStatus` appear depending on tenant.** Same defensive read
  pattern as Awin's `publisherId` / `id` / `accountId` triplet. The
  adapter accepts either.

- **Amount fields can be either JSON strings or numbers.** Newer CJ
  schemas return `"8.00"`; older ones return `8.00`. `toNumber` accepts
  both. Worth flagging to future contributors copying the pattern —
  treat money fields as `string | number | undefined` at the wire.

- **`paidToPublisher` vs `clearedDate`.** Two different "this is paid"
  signals across tenants. Same lesson Awin teaches: trust both
  boolean/date signals AND the string status, not just one.

- **CJ schema documentation is better than Awin's.** Typed GraphQL with
  introspection. Field renames are rare and well-publicised. The cost is
  that the schema is large; we keep queries narrow to minimise drift.

- **CJ_COMPANY_ID is required for most queries, not just nice-to-have.**
  The derivedValues bootstrap is therefore load-bearing for CJ in a way
  it isn't for Awin (where AWIN_PUBLISHER_ID is technically optional on
  some endpoints). The setup wizard needs to handle this — flagged in
  the recommended next steps.

- **The `dpbolvw.net` redirect URL uses the company ID as the publisher
  path segment.** Most CJ accounts have a single web-site PID equal to
  the company ID; multi-site publishers don't. Acceptable for v0.1
  since the modern link-builder API exists as a fallback.

- **CJ adapter is the first in the codebase to need `derivedValues()`
  as a public adapter method** (vs Awin which surfaces it only through
  the underlying `auth.verifyAuth` return type). The `NetworkAdapter`
  contract makes `derivedValues` optional — I implemented it on CJ to
  give the wizard / inspector an audit-friendly handle without widening
  the public `verifyAuth` return type. Future networks should follow
  this pattern when their `derivedValues` are load-bearing.

## Recommended next steps

1. **Chunk 4 (setup wizard)**: consume `adapter.derivedValues()` directly
   for CJ — it returns a `DerivedValueResult[]` with `field`, `value`,
   `source`. For Awin the wizard still needs to reach through
   `auth.verifyAuth().derivedValues` (the adapter contract's `verifyAuth`
   return type is narrow). Consider whether to add a `derivedValues()`
   stub on the Awin adapter for consistency — that's a chunk-2 follow-up,
   not chunk-3.

2. **Chunk 5/6 (Impact, Rakuten)**: CJ is the second pattern source after
   Awin. The CJ-specific learnings worth copying are:
   - Defensive "string or number" handling for money fields.
   - 200-with-errors GraphQL handling (any GraphQL-fronted network).
   - `derivedValues()` as a public method when the derived value is
     load-bearing (vs nice-to-have).

3. **Live validation in Chunk 8**: once a real CJ token is available,
   run `affiliate-mcp validate cj` end-to-end and bump `claim_status`
   from `partial` to `production`. Watch specifically for tenant-
   specific schema variants (`resultList` vs flat array, `commissions`
   vs `records`).

4. **Future enhancement**: pagination cursor for `publisherCommissions`,
   and explicit `CJ_WEBSITE_ID` for multi-site publishers.

## Blockers

None. Cannot push (remote 403, as expected). Branch is ready for the
orchestrator to merge. The `src/networks/index.ts` aggregator change is a
single-line addition (`import './cj/adapter.js';`) likely to conflict
trivially with Chunk 5 (Impact) and Chunk 6 (Rakuten) running in parallel
— resolve by keeping all three import lines in alphabetical order.

## Commits

```
89a226e  Add CJ adapter tests + fixtures
282621a  Add CJ Affiliate adapter (GraphQL + REST hybrid)
fcb0c02  Add CJ Affiliate network.json + HTTP client + auth/setup helpers
```

See `git log claude/affiliate-mcp-orchestration-qfKw4..feature/network-cj --oneline`.
