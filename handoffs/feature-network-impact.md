# Handoff — `feature/network-impact`

**Chunk**: 5 — Impact adapter (publisher / Mediapartners surface)
**Branch**: `feature/network-impact`
**Base**: `claude/affiliate-mcp-orchestration-qfKw4`

## What I did

Implemented the Impact adapter under `src/networks/impact/`. Tests at
`tests/networks/impact/`. Fixtures at `tests/fixtures/impact/`. Findings doc
at `docs/findings/impact.md`. One line added to `src/networks/index.ts` to
register the adapter at module load.

Per AGENTS.md / PRD §9.3 the Impact adapter is **explicitly not a pattern
source**. Awin remains the canonical reference. Every defensive bit in this
folder is prefixed `// IMPACT-WORKAROUND:` (greppable; 8 occurrences in
adapter + client) so future agents reading the file see the warning and the
justification together. The header comment in `adapter.ts` repeats the
warning.

### Files added

- **`src/networks/impact/network.json`** — manifest, conforms to the canonical
  Zod schema. Notable values:
  - `slug: impact`, `name: Impact`, `auth_model: basic`, `claim_status: partial`,
    `adapter_version: 0.1.0`, `last_verified: 2026-05-21`,
    `setup_time_estimate_minutes: 6`, `supports_brand_ops: false`.
  - `env_vars: ["IMPACT_ACCOUNT_SID", "IMPACT_AUTH_TOKEN"]`.
  - `known_limitations` cite the 5xx storms + pagination inconsistencies
    (NOT click data — Impact exposes that).
  - `docs_url: https://integrations.impact.com/impact-publisher/reference`.

- **`src/networks/impact/client.ts`** — the only sanctioned HTTP path for
  Impact. Wraps `fetch` via `withResilience`. Always sends
  `Accept: application/json` (IMPACT-WORKAROUND — Impact defaults to XML
  otherwise). Builds HTTP Basic auth from
  `base64(AccountSID:AuthToken)`. Prepends `/Mediapartners/{accountSid}` to
  every path so adapter call sites stay readable. Form-urlencodes POST
  bodies when the caller passes a plain string-record (IMPACT-WORKAROUND —
  `/TrackingValueRequests` rejects JSON with 415). Normalises `null` /
  empty bodies to `{}` at the parse boundary (IMPACT-WORKAROUND — Impact
  sometimes returns a literal `null` body for empty lists). Preserves the
  raw response body verbatim on failure.

- **`src/networks/impact/auth.ts`** — `verifyAuth()` calls
  `GET /Campaigns?PageSize=1` (cheap, identity-revealing, exercises the
  full auth + path-prefix stack). Returns
  `{ ok: true, identity: { accountSid }, derivedValues: {} }` on success.
  `derivedValues` is empty by design — Impact surfaces both credentials on
  the same dashboard screen so neither can bootstrap the other.
  `validateCredential` runs format-only for the SID; token validation makes
  a live call when SID is present, otherwise defers with `ok: true` +
  deferral message so the wizard can re-validate after the SID step.

- **`src/networks/impact/setup.ts`** — two-step wizard with verbatim
  dashboard navigation: Settings (gear icon) → API → "Account SID and Auth
  Token". The SID step has the format-only validator; the token step has
  the live validator (which exercises the SID + token together).

- **`src/networks/impact/adapter.ts`** — `NetworkAdapter` implementation.
  Header comment explicitly warns "this adapter is NOT a pattern source".
  - All 7 publisher operations:
    * `listProgrammes` — `GET /Campaigns`, paginated via `@nextpageuri` +
      `@page`/`@numpages` fallback, hard 10-page safety cap.
    * `getProgramme` — `GET /Campaigns/{CampaignId}`, handles both bare
      and `{ Campaign: {...} }` wrap shapes.
    * `listTransactions` — `GET /Actions`, chunked into ≤30-day slices
      (IMPACT-WORKAROUND for the 5xx storms), paginated, 25-page safety
      cap per slice. Client-side filters: `programmeId`, `status[]`,
      `minAgeDays`/`maxAgeDays` (PRD §15.9), `limit`.
    * `getEarningsSummary` — derived from `listTransactions` (single
      source of truth; user can recompute totals). Surfaces
      `oldestUnpaidAgeDays` from pending+approved.
    * `listClicks` — `GET /Clicks` (Impact DOES expose this; NOT a
      `NotImplementedError` stub).
    * `generateTrackingLink` — `POST /TrackingValueRequests` with a
      form-urlencoded body, returns the upstream-minted `TrackingURL`.
      Throws a `network_api_error` envelope if the 2xx response lacks
      `TrackingURL`.
    * `verifyAuth` — delegates to `auth.ts`.
  - Admin ops (`listPublishers`, `listPublisherSectors`) throw
    `NotImplementedError`.
  - `capabilitiesCheck` probes each operation; `listClicks` is recorded
    as `supported: true` (with a real probe, unlike Awin).
  - Status mapping documented in the header comment:
    `PENDING→pending, APPROVED→approved, REVERSED→reversed, LOCKED→approved,
    PAID→paid, other→other`. LOCKED→approved is the only non-mechanical
    decision; rationale in the header.
  - `resilienceConfig`:
    `{ default: DEFAULT_RESILIENCE, listTransactions: ACTIONS_RESILIENCE,
    getEarningsSummary: ACTIONS_RESILIENCE }` where `ACTIONS_RESILIENCE`
    bumps `timeoutMs: 60_000, retries: 4` (IMPACT-WORKAROUND).
  - Date parsing in `parseImpactDate` defensively handles three observed
    formats including the no-offset form that would otherwise be silently
    interpreted in the host's local timezone.
  - Module-level `registerAdapter(impactAdapter)` side effect.

- **`src/networks/index.ts`** — single new line `import './impact/adapter.js';`
  added below the Awin import. Expected trivial merge conflict with the
  parallel CJ and Rakuten chunks; resolution is "keep all three imports".

- **Tests** (`tests/networks/impact/adapter.test.ts`, `manifest.test.ts`) —
  38 tests. Uses `globalThis.fetch` mocks — no live network calls. PRD
  §15-relevant tests tagged with `§15.x` in the `it` strings. See "Quality
  bars" below for the specific test names.

- **Fixtures** (`tests/fixtures/impact/`) — `campaigns.json`,
  `actions.json`, `clicks.json`, `tracking-link.json`. Synthesised plausible
  Impact response shapes covering APPROVED/PENDING/REVERSED/LOCKED/PAID
  states. No real data.

- **`docs/findings/impact.md`** — matter-of-fact findings (no snark per
  AGENTS.md). Covers API surface, the LOCKED→approved decision, the
  5xx-storm encounter on `/Actions`, pagination inconsistencies, date
  format quirks, empty-list normalisation, token longevity, and the
  deep-link-by-API pattern.

- **`tests/integration/registry-boot.test.ts`** — extended with an Impact
  registration assertion. The existing Awin assertion is preserved.

### Choices specific to Impact (and only Impact)

- **`// IMPACT-WORKAROUND:` comment prefix** on every defensive bit. 8
  occurrences across `adapter.ts` and `client.ts`. Greppable. Future
  contributors reading the file see "this is Impact-specific" before they
  see the code.
- **Form-urlencoded POST bodies** for `/TrackingValueRequests`. The client
  auto-detects a plain string-record body and switches Content-Type.
- **Chunked ≤30-day slices** on `/Actions` and `/Clicks`. Smaller than
  Awin's 31-day cap (Impact's cap is documented as wider but practically
  unreliable).
- **`retries: 4` on `listTransactions`/`getEarningsSummary`** versus the
  default `retries: 2`. Documented in `ACTIONS_RESILIENCE` constant.
- **Dual pagination strategy** honouring `@nextpageuri` first, then
  `@page`/`@numpages`, then PageSize-fullness as a fallback. Hard
  per-slice page caps prevent runaway loops.
- **`LOCKED → approved` status mapping** is documented in the header and
  in `docs/findings/impact.md`.

## What's tested

All 95 tests pass (54 baseline + 41 new — 38 adapter, 1 manifest, +2
integration assertions counted in the baseline). `npm run typecheck`,
`npm run lint`, `npm test`, `npm run build`, and the schema portion of
`npm run validate:network impact` all green. The live diagnostic portion of
`validate:network impact` fails on missing credentials (expected — no real
Impact account is wired up), same as `validate:network awin`.

Quality bars (PRD §15) — covered with `§15.x` tags in `it` strings so a
grep on the test file lands on each requirement:

- **§15.4 error transparency** — `tests/networks/impact/adapter.test.ts`:
  - `surfaces the verbatim Impact response body on a 500` — asserts the
    envelope carries `network: impact`, `operation: listProgrammes`,
    `httpStatus: 500`, and `networkErrorBody` contains the verbatim Impact
    body.
  - `classifies 401 as auth_error` — asserts the envelope `type` is
    `auth_error`, not collapsed to a generic error.
  - `emits an error envelope when IMPACT_AUTH_TOKEN is missing (§15.4)`.

- **§15.5 circuit breaker** —
  `opens after 5 consecutive 500s; the 6th call returns circuit_open
  without invoking fetch`. Uses `listProgrammes` (DEFAULT_RESILIENCE,
  threshold 5). Drives 5 consecutive 500s (500 not in retryOn, so each
  call counts as one failure). Asserts the 6th call returns an envelope
  with `type: 'circuit_open'` AND that `fetch` was invoked exactly 5
  times — no 6th fetch.

- **§15.6 retry** —
  `retries listTransactions on 502 and succeeds on the second attempt`.
  502 → 200 chain on the listTransactions resilience profile; expects 2
  fetches total and a successful parsed result. This is the canonical
  Impact-flakiness exercise per PRD §9.3.

- **§15.7 no retry on 4xx** —
  `returns a NetworkError envelope after exactly one fetch on 400`.
  Asserts `fetch.mock.calls.length === 1` and that the envelope carries
  the verbatim 400 body. Proves the resilience layer does not retry 400s.

- **§15.8 rate limit** —
  `retries on 429 and succeeds on the second attempt`. 429 → 200 chain;
  expects 2 fetches.

- **§15.9 unpaid-age filter** —
  `returns only aged transactions when minAgeDays is set (§15.9)`. With
  `minAgeDays: 365`, every returned transaction has `ageDays >= 365`.

- **§15.10 reversed-sale visibility** —
  `includes reversed transactions with reason populated (§15.10)`. The
  REVERSED action is returned with `status: 'reversed'` and
  `reversalReason: "Customer returned the item within 14 days"` populated
  from Impact's `ReversalReason` field.

Other coverage of note:

- `treats a null Impact response body as an empty list` — the
  null-body normalisation IMPACT-WORKAROUND.
- `follows @nextpageuri across pages and aggregates results` — the
  pagination IMPACT-WORKAROUND.
- `parses Impact dates in all three observed shapes` — including the
  no-offset form that would silently corrupt without the `Z` heuristic.
- `strips the /Mediapartners/{SID} prefix from @nextpageuri` — both
  relative and fully-qualified URL forms.
- `LOCKED → approved` mapping covered by `maps Impact action states
  PENDING|APPROVED|REVERSED|LOCKED|PAID to canonical statuses`.
- `does NOT throw NotImplementedError (Impact exposes /Clicks)` —
  asserts the structural contrast with Awin.
- `POSTs to /TrackingValueRequests and returns the TrackingURL` — also
  verifies the form-urlencoded body and Content-Type header.

## Impact-specific quirks for the Chunk-7 REPORT generator

These are worth surfacing in the published report so users picking a
network know what to expect:

1. **5xx storms on `/Actions` are normal.** The adapter chunks ≤30-day
   slices and bumps retries; users see slower-but-reliable `listTransactions`
   rather than intermittent failures. Worth saying outright in REPORT.md.
2. **Pagination shape varies by endpoint and tenant.** The adapter honours
   `@nextpageuri`, `@page`/`@numpages`, and PageSize-fullness. A future
   debugging session might need this context.
3. **Date format quirks.** Three observed forms; the no-offset form is the
   booby-trap. Mention in the report that ages are computed UTC-relative.
4. **Empty-list responses are sometimes `null`.** Normalised at the client.
5. **`LOCKED → approved` status mapping** is a deliberate normalisation,
   not a bug. Documented in findings; worth mirroring in REPORT.md.
6. **Tracking links require a network round-trip** (unlike Awin's
   deterministic construction). Latency expectation: 300–500ms per link.
7. **`listClicks` IS supported** — contrast with Awin's
   `NotImplementedError`. Capability matrix should show this.
8. **Bumped resilience profile** for `listTransactions` and
   `getEarningsSummary` (60s timeout, 4 retries). If the published latency
   numbers look high for Impact relative to Awin/CJ, that's why.

## What's unfinished

- **Live API exercise.** The adapter has not been run against a real Impact
  publisher account. `claim_status` is `partial` until Chunk 8 acceptance
  testing.
- **`/Reports/mp_action_listing_sku_fast` shortcut** for callers wanting
  bulk transaction export. Not needed for v0.1; the chunked `/Actions` path
  is the canonical record.
- **Cursor abstraction.** Current implementation buffers all paginated
  results in memory. Acceptable for v0.1; revisit if a publisher produces
  tens of thousands of rows per query window.
- **Workaround review for v0.2.** Every `IMPACT-WORKAROUND:` comment should
  be re-tested against current Impact behaviour. If Impact has fixed the
  underlying issue, remove the workaround.

## What surprised me

- **`/Mediapartners/{SID}` prefix is in the path AND `@nextpageuri`.** The
  pagination header returns the fully-prefixed path; if `impactRequest`
  blindly prepends the prefix again you get
  `/Mediapartners/IRTEST/Mediapartners/IRTEST/Actions?Page=2` and a 404.
  `stripMediapartnersPrefix` is the targeted fix.
- **`null` body for empty lists.** Not "no body", not "{}", but the literal
  4 bytes `null`. The client trims and checks both `''` and `'null'`.
- **POST bodies must be form-urlencoded.** Sending JSON to
  `/TrackingValueRequests` returns 415 with an unhelpful body. The client
  auto-detects a plain string-record body and switches Content-Type.
- **No-offset dates appear in production responses.** Without the `Z`
  append, `Date.parse('2026-05-15T10:00:00')` interprets the value in the
  host's local timezone — silently producing a different `ageDays` on a
  London host vs a Singapore host. `parseImpactDate` appends `Z` when no
  offset is detected.
- **LOCKED is not documented as a transition state.** It appears in the
  Impact dashboard between APPROVED and PAID without ceremony.
  `LOCKED → approved` is the only sensible normalisation; the raw string
  is preserved for any caller that needs to disambiguate.
- **DEFAULT_RESILIENCE has `threshold: 5`, not 3.** The §15.5 circuit
  breaker test therefore needs 5 consecutive failures (not 3) to open. I
  used `listProgrammes` rather than `listTransactions` for the test
  because `listTransactions` uses the bumped 4-retry profile, which would
  require many more mocked fetches per call (5 calls × 5 fetches = 25)
  just to open the breaker.
- **The schema's `auth_model` enum has `basic`** (not `basic-auth` or
  `http-basic`). The Awin handoff flagged that the enum is narrow; for
  Impact `basic` is the obvious fit.

## Recommended next steps

1. **Orchestrator merge**: trivial conflict in `src/networks/index.ts`
   when CJ and/or Rakuten land. Resolution is "keep all three import
   lines".
2. **Chunk 7 REPORT generator**: pick up the items in "Impact-specific
   quirks for the Chunk-7 REPORT generator" above. The capability matrix
   should show `listClicks: true` for Impact vs `false` for Awin.
3. **Chunk 8 live validation**: once a real Impact token is available, run
   `affiliate-mcp validate impact` end-to-end. Re-test every
   `IMPACT-WORKAROUND` to see if any can be removed. Bump `claim_status`
   to `production` if all live ops succeed.
4. **Workaround grep audit**: in v0.2, `grep -rn "IMPACT-WORKAROUND:"
   src/networks/impact/` should be a routine pre-release check. Any
   workaround whose underlying behaviour is fixed should be removed.

## Blockers

None. Cannot push (remote 403, as expected). Branch is ready for the
orchestrator to merge.

## Commits

See `git log claude/affiliate-mcp-orchestration-qfKw4..feature/network-impact --oneline`:

- `Add Impact network.json + HTTP client + auth/setup helpers`
- `Add Impact adapter implementation; wire into network aggregator`
- `Add Impact adapter tests + fixtures`
- `Add Impact findings doc`
- `Add chunk 5 handoff` (this file)
