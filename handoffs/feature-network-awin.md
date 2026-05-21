# Handoff — `feature/network-awin`

**Chunk**: 2 — Awin adapter (the canonical reference implementation)
**Branch**: `feature/network-awin`
**Base**: `claude/affiliate-mcp-orchestration-qfKw4`

## What I did

Implemented the Awin adapter as the pattern source for every future network
adapter (CJ, Impact, Rakuten, …). Everything lives under
`src/networks/awin/`. Tests under `tests/networks/awin/` and
`tests/fixtures/awin/`. Findings doc at `docs/findings/awin.md`.

### Files added

- **`src/networks/awin/network.json`** — manifest, conforms to the canonical
  schema in `scripts/validate-network-json.ts`. Notable values:
  - `slug: awin`, `name: Awin`, `auth_model: bearer`, `claim_status: partial`,
    `adapter_version: 0.1.0`, `last_verified: 2026-05-21`,
    `setup_time_estimate_minutes: 5`.
  - `known_limitations: ["Click-level data is not exposed via the public Awin
    publisher API; listClicks is unsupported."]`.
  - `env_vars: ["AWIN_API_TOKEN", "AWIN_PUBLISHER_ID"]` — note the schema is
    `string[]` (not the object form the chunk-2 brief described). See "What
    surprised me".

- **`src/networks/awin/client.ts`** — the only sanctioned HTTP path.
  - Wraps `fetch` via `withResilience` from `src/shared/resilience.ts`.
  - Single `awinRequest<T>({ operation, path, query, method, body, token,
    resilience })`.
  - Builds `Authorization: Bearer <token>` and JSON Accept/Content-Type.
  - Reads body once; throws `HttpStatusError(status, rawBody, message)` on
    non-2xx so the resilience layer applies its retry policy uniformly and
    the verbatim Awin response body lands on the envelope.
  - Re-exports `HttpStatusError` so adapter code stays decoupled from
    `shared/resilience.ts`.

- **`src/networks/awin/auth.ts`** — credential validation + auth-check.
  - `verifyAuth()` calls `GET /publishers`, returns
    `{ ok: true, identity, derivedValues: { AWIN_PUBLISHER_ID } }` on success
    or `{ ok: false, reason, envelope }` on failure.
  - `validateCredential(field, value)` — runs the token through `verifyAuth`,
    validates the publisher ID as positive integer.
  - **Heavily commented** on the `derivedValues` pattern — why it exists,
    when it applies, where the wizard consumes it (`src/cli/setup.ts`, Chunk 4).

- **`src/networks/awin/setup.ts`** — `setupSteps()` returns two `SetupStep`
  records. Walks the user through Awin dashboard → Account → API credentials
  → "Generate new token". Step 2 is declared but normally auto-derived.

- **`src/networks/awin/adapter.ts`** — the `NetworkAdapter` implementation.
  - All seven publisher operations + the two admin stubs.
  - `listProgrammes` — `GET /publishers/{id}/programmes`, `relationship`
    derived from query status, with client-side substring/category/limit
    filters.
  - `getProgramme` — `GET /publishers/{id}/programmedetails?advertiserId=...`,
    handles both flat-response and `{programmeInfo: ...}` tenants.
  - `listTransactions` — chunks ≤31-day slices automatically, supports
    `programmeId/status/from/to/minAgeDays/maxAgeDays/limit`. Anchors
    `ageDays` on `validationDate ?? transactionDate`.
  - `getEarningsSummary` — aggregates from `listTransactions` (auditable;
    single source of truth). Surfaces `oldestUnpaidAgeDays` from
    pending+approved.
  - `listClicks` — throws `NotImplementedError("Awin does not expose
    click-level data via the public publisher API")`.
  - `generateTrackingLink` — deterministic `https://www.awin1.com/cread.php?
    awinmid={advertiser}&awinaffid={publisher}&ued={URL-encoded}`. No network
    call. Required-field validation throws `config_error` envelopes.
  - `capabilitiesCheck` — probes each op with minimal queries, records
    `supported`, `latencyMs`, `sampleSize`, `note`. `listClicks` is recorded
    as `supported:false` without probing.
  - `listPublishers` / `listPublisherSectors` — throw
    `NotImplementedError("Brand-side operations are scaffolded for v0.2")`.
  - `resilienceConfig` — `{ default: DEFAULT_RESILIENCE, listTransactions: 60s
    timeout + 3 retries, getEarningsSummary: same }`.
  - Module top-level side effect: `registerAdapter(awinAdapter)`.

- **`src/networks/index.ts`** — aggregator. Single import point that pulls in
  every adapter's `registerAdapter` side effect. Currently imports just
  `./awin/adapter.js`. Adding a network is one line here.

- **Tests** (`tests/networks/awin/adapter.test.ts`, `manifest.test.ts`) — 24
  tests covering transformation, status normalisation, raw preservation,
  unpaid-age filter, reversed-sale visibility, deterministic link
  construction, listClicks NotImplementedError, verifyAuth happy path,
  401 error envelope shape, validateCredential, capabilitiesCheck,
  error-envelope transparency on 500. Uses `globalThis.fetch` mocks — no
  live network calls.

- **Fixtures** (`tests/fixtures/awin/`) — `publishers.json`, `programmes.json`,
  `transactions.json`. Synthesised plausible Awin response shapes. No real
  data.

- **`docs/findings/awin.md`** — qualitative findings. What worked, what
  didn't, token longevity, rate-limit observations, deep-link-by-construction
  pattern, future work for Chunks 7/8.

### Choices that propagate to future adapters

- **Aggregator pattern.** I chose `src/networks/index.ts` as the single
  registration entry point instead of having the server import each network
  individually. Adding a new network is one line: import its adapter file.
- **Deep-link by deterministic construction.** Documented in the adapter
  header and `findings/awin.md`. Future networks (Impact) that require an
  API call for tracking links wrap that call through `withResilience`.
- **Aggregate from per-record source of truth.** `getEarningsSummary` derives
  from `listTransactions` rather than calling `/reports/aggregated`, so the
  user can recompute totals from the per-record output. Future adapters
  should default to this pattern unless there is a compelling reason not to.
- **Defensive transformer style.** Every adapter field is read with `??`
  fallback; raw response preserved under `rawNetworkData`. We never trust
  the network schema.

## What's tested

All 54 tests pass (the 30 from foundations + 24 new). `npm run typecheck`,
`npm run lint`, `npm test`, `npm run build`, `npm run validate:network awin`
all green.

Quality bars (PRD §15) status:

- **§15.4 error transparency** — covered. Tests assert:
  - On Awin 500, the thrown `NetworkError`'s envelope carries
    `network: awin`, `operation: listProgrammes`, `httpStatus: 500`, and
    `networkErrorBody` containing the verbatim Awin body
    ("upstream broke at 03:14:15").
  - On 401, the envelope's `type` is `auth_error` (not collapsed to a generic
    error).
  - Missing `AWIN_API_TOKEN` throws a `NetworkError` (config_error).
  - File: `tests/networks/awin/adapter.test.ts` — `§15.4` block.

- **§15.9 unpaid-age filter** — covered. Test "returns only aged transactions
  when minAgeDays is set (§15.9)" asserts that with `minAgeDays: 365`, every
  returned transaction has `ageDays >= 365`. `getEarningsSummary` separately
  computes `oldestUnpaidAgeDays` across pending+approved.

- **§15.10 reversed-sale visibility** — covered. Test "includes reversed
  transactions with reason populated (§15.10)" asserts that the adapter
  returns the declined transaction (mapped to `status: 'reversed'`) with
  `reversalReason: "Customer returned the item within 14 days"` populated
  from Awin's `declineReason` field.

- **§15.30 reference implementation clarity** — covered structurally. The
  adapter file is heavily commented with the *why* of each non-obvious
  decision: ~35 multi-line "why" comment blocks covering status
  normalisation, deterministic link construction, the `derivedValues`
  pattern, the 31-day chunking, the validationDate-anchored age, the
  aggregator import pattern, etc. A future contributor reading the file
  alone should be able to write a CJ/Impact/Rakuten adapter by analogy.

## What's unfinished

- **Server registration of the adapter at boot.** The aggregator
  `src/networks/index.ts` exists but is not imported by `src/server.ts` or
  `src/index.ts`. Per the chunk-2 brief I must not modify those files;
  the orchestrator's integration step needs to add a single
  `import './networks/index.js';` to `src/server.ts` (or `src/index.ts`)
  so `affiliate_list_networks` and `affiliate_run_diagnostic` enumerate
  Awin. See "What surprised me" for the rationale.

- **`npm run validate:network awin` live diagnostic** still prints
  "no adapter registered for this slug; live diagnostic skipped" because
  `scripts/validate-network-json.ts` does not import the aggregator. Same
  remediation as the server — one import line.

- **Live API exercise.** The adapter has not been run against a real Awin
  publisher account. `claim_status` is `partial` until Chunk 8 acceptance
  testing.

- **Parallelised chunk fetches** in `listTransactions`. Sequential is safer;
  a parallel-with-concurrency-limit refactor is a future optimisation.

- **`/reports/aggregated` shortcut** for callers wanting totals only. Not
  needed for v0.1.

## What surprised me

- **`network.json` schema does NOT support the object form for `env_vars`.**
  The chunk-2 brief described `env_vars: [{ name, required, derived_from }]`,
  but the existing Zod schema in `scripts/validate-network-json.ts` (and the
  passing foundation test in `tests/scripts/validate-network-json.test.ts`)
  defines `env_vars: z.array(z.string())`. Modifying the schema would have
  required touching `src/shared/` / `scripts/`, which the chunk-2 brief
  forbids. I shipped the simpler form (matching the schema) and noted the
  divergence here. If the orchestrator wants the richer form, that's a
  schema migration plus a manifest update — both straightforward.

- **`auth_model` enum doesn't include `oauth2-bearer-static`.** Schema is
  `bearer|oauth2|basic|custom`. Awin is in practice a "long-lived OAuth2
  bearer", which is closest to `bearer`. I used `bearer` and documented the
  longevity story in `docs/findings/awin.md`.

- **`claim_status` enum doesn't include `unclaimed`.** Brief asked for
  `unclaimed`; schema is `production|partial|experimental|unsupported`. I
  used `partial` — honestly reflects "structurally complete; listClicks
  unsupported; not yet live-validated".

- **`registerAdapter` would throw on double-load if the aggregator were
  imported twice in the same process.** ES module caching prevents this in
  practice. Tests that clear the registry would need to re-instantiate the
  adapter (or import `awinAdapter` from the module after `_clearRegistry`).
  The current Awin tests don't touch `_clearRegistry`, so this is latent.

- **Awin's 31-day cap is enforced server-side but not documented in their
  OpenAPI.** Discovered by reading their wiki. Encoded as the chunking
  helper `chunkDateRange(from, to, 31)`. Worth mentioning in the chunk-2
  brief that "wider date windows MUST be chunked client-side" if future
  agents copy the pattern.

- **`paidToPublisher: true` overrides `commissionStatus`.** Awin's status
  string can stay `approved` after payment; the boolean flag is the
  authoritative paid signal. Without this normalisation, `getEarningsSummary`
  would never report any earnings as `paid`.

- **Awin's response is sometimes wrapped in `programmeInfo` and sometimes
  flat.** Tenant-dependent. The `getProgramme` transformer handles both.

- **The chunk-2 brief uses slightly different method names** (`findProgrammes`,
  `earningsSummary`) than the actual interface in `src/shared/types.ts`
  (`listProgrammes`, `getEarningsSummary`). The contract wins; I used the
  contract names.

## Recommended next steps

1. **One-line integration**: add `import './networks/index.js';` to
   `src/server.ts` (or `src/index.ts` before `startServer`), and to
   `scripts/validate-network-json.ts`. After that:
   - `affiliate_list_networks` returns Awin's metadata.
   - `affiliate_run_diagnostic` calls `awinAdapter.capabilitiesCheck()`.
   - `npm run validate:network awin` runs the live diagnostic too.

2. **Chunk 3 (CJ) and Chunk 5/6 (Impact, Rakuten) agents**: read
   `src/networks/awin/adapter.ts` end-to-end before writing your own
   adapter. The "why" comments are the contract — preserve the same shape:
   `client.ts` (resilience-wrapped fetch only), `auth.ts` (with
   `verifyAuth`/`validateCredential`/`derivedValues`), `setup.ts`, `adapter.ts`.

3. **Chunk 4 (setup wizard)**: consume the `derivedValues` flow from the
   `verifyAuth()` underlying result (cast through the adapter's auth module
   if the public adapter contract is too narrow — it currently is). Consider
   widening `NetworkAdapter.verifyAuth`'s return type in `src/shared/types.ts`
   to include `derivedValues?` so the contract carries it. That's a
   foundation tweak, outside chunk-2 scope.

4. **Schema migration**: if the richer `env_vars` object form is desired,
   migrate the Zod schema in `scripts/validate-network-json.ts` and update
   the Awin manifest.

5. **Live validation in Chunk 8**: once a real Awin token is available, run
   `affiliate-mcp validate awin` end-to-end and bump `claim_status` to
   `production`.

## Blockers

None. Cannot push (remote 403, as expected). Branch is ready for the
orchestrator to merge.

## Commits

See `git log claude/affiliate-mcp-orchestration-qfKw4..feature/network-awin --oneline`.
