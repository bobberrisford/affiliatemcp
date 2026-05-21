# Handoff — `feature/network-rakuten`

**Chunk**: 6 — Rakuten Advertising adapter (partial implementation; not a
pattern source for future networks)
**Branch**: `feature/network-rakuten`
**Base**: `claude/affiliate-mcp-orchestration-qfKw4`

## What I did

Implemented the Rakuten Advertising adapter under `src/networks/rakuten/`,
mirroring the Awin layout. Tests under `tests/networks/rakuten/`, fixtures
under `tests/fixtures/rakuten/`, findings at `docs/findings/rakuten.md`.

### Files added

- **`src/networks/rakuten/network.json`** — manifest. Conforms to the
  canonical Zod schema. Values:
  - `slug: rakuten`, `name: Rakuten Advertising`,
    `base_url: https://api.linksynergy.com`, `auth_model: oauth2`,
    `claim_status: partial`, `adapter_version: 0.1.0`,
    `last_verified: 2026-05-21`, `setup_time_estimate_minutes: 12`,
    `setup_requires_approval: true`, `setup_approval_days_typical: 5`,
    `supports_brand_ops: false`,
    `docs_url: https://developers.rakutenadvertising.com/`.
  - `env_vars: ["RAKUTEN_CLIENT_ID", "RAKUTEN_CLIENT_SECRET", "RAKUTEN_SID"]`
    — three required, none auto-derived.
  - `known_limitations` enumerates: listClicks paid-gated; brand ops scaffold
    only; not yet live-validated; token-host tenant variance.

- **`src/networks/rakuten/auth.ts`** — OAuth2 client-credentials + in-memory
  token cache. The cache is the **only mutable module-level state** in the
  adapter (called out in the file's header comment per the brief).
  - `getAccessToken({ forceRefresh? })` — returns a usable token, refreshing
    proactively when <5min remain on the lifetime.
  - `refreshToken({ reason })` — explicit refresh; deduplicates concurrent
    callers via an `inFlightRefresh` promise so parallel requests don't both
    round-trip `/token`.
  - `exchangeForToken()` — POSTs `Basic <base64(id:secret)>` + body
    `scope=<SID>` to `/token`, parses JSON, computes `expiresAt`. Wrapped in
    `withResilience` so a transient 5xx on the auth path is retried under
    the same policy as data endpoints.
  - `verifyAuth()` / `validateCredential()` / `_resetTokenCache()` for tests.
  - `RAKUTEN_TOKEN_URL` env override accepted for the tenant-variance case
    documented in the findings doc.

- **`src/networks/rakuten/client.ts`** — the only sanctioned HTTP path.
  - `rakutenRequest<T>()` wraps `fetch` via `withResilience`.
  - Token-from-cache on every call. **401 → refresh → retry once** behaviour
    lives inside the resilience callable (so it counts as one composite
    attempt to the resilience layer, not N×2 refreshes). Refresh is logged
    at debug level — not hidden, per "no silent retries".
  - Two consecutive 401s surface as a `NetworkError` with the verbatim body
    on the envelope.
  - Always sends `Accept: application/json` — needed because Rakuten's older
    endpoints default to XML.

- **`src/networks/rakuten/setup.ts`** — three `SetupStep` records for the
  wizard. Step 1's description explicitly mentions the Publisher Solutions
  approval ("typical turnaround 3–7 business days") so users with un-provisioned
  accounts know what to expect.

- **`src/networks/rakuten/adapter.ts`** — the `NetworkAdapter` implementation.
  Heavily commented header explaining "not a pattern source" / what's
  implemented vs stubbed / the locked→approved mapping choice / cardinal
  rules. Per-method "why" comments around the unusual decisions.

- **Tests** (`tests/networks/rakuten/adapter.test.ts`, `manifest.test.ts`):
  27 + 1 = **28 new tests**. Cover:
  - Transformer correctness (status normalisation, raw preservation,
    reversed-reason, programme-status, ageDays anchor).
  - **Token cache happy path** (request → cached token reused on second call).
  - **Token cache 401 refresh path** (request → 401 → refresh → retry → 200).
  - **Two-consecutive-401s → auth_error** envelope.
  - §15.4 error transparency: verbatim 500 body, 403 classified as auth_error.
  - §15.9 unpaid-age filter: `minAgeDays` excludes recent records;
    `oldestUnpaidAgeDays` aggregates pending+approved.
  - §15.10 reversed-sale visibility: reversed records returned with
    `reversalReason` populated.
  - locked→approved mapping verified.
  - generateTrackingLink deterministic, URL-encoded, no fetch.
  - listClicks throws NotImplementedError with the documented reason.
  - validateCredential edge cases (whitespace in secret, malformed SID).
  - getEarningsSummary aggregation totals.

- **Fixtures** (`tests/fixtures/rakuten/`): `programmes.json`,
  `transactions.json`, `token-response.json`. Synthesised plausible Rakuten
  response shapes. No real data.

- **`docs/findings/rakuten.md`** — qualitative findings. Matter-of-fact about
  access friction: Publisher Solutions approval, docs portal 403 for the API
  reference page, token endpoint Accept-header quirk, tenant-variance for
  the token host, clicks_reports paid-tier gating.

- **`src/networks/index.ts`** — one-line addition:
  `import './rakuten/adapter.js';`. Merge conflicts with parallel chunks
  (CJ, Impact) expected; orchestrator resolves.

### Operations: live vs stubbed

| Operation              | Status              | Notes                                                          |
| ---------------------- | ------------------- | -------------------------------------------------------------- |
| `listProgrammes`       | implemented         | `GET /v1/programs/`                                            |
| `getProgramme`         | implemented         | `GET /v1/programs/?mid=<id>` (avoids XML legacy endpoint)      |
| `listTransactions`     | implemented         | `GET /v1/reports/transaction_reports`                          |
| `getEarningsSummary`   | implemented         | Derived from listTransactions (single source of truth)         |
| `generateTrackingLink` | implemented         | Deterministic `click.linksynergy.com/deeplink` construction    |
| `verifyAuth`           | implemented         | Token-exchange round-trip is the conclusive check              |
| `listClicks`           | **NotImplementedError** | Rakuten `clicks_reports` is paid-tier-gated                |
| `listPublishers`       | **NotImplementedError** | Brand-side scaffold for v0.2                              |
| `listPublisherSectors` | **NotImplementedError** | Brand-side scaffold for v0.2                              |

## What's tested

All 84 tests pass (was 56; +28). `npm run typecheck`, `npm run lint`,
`npm test`, `npm run build`, `npm run validate:network -- rakuten` all green
(the live diagnostic correctly fails with `config_error` envelopes when
credentials are absent — expected behaviour, not a failure of the adapter).

Quality bars (PRD §15) status:

- **§15.4 error transparency** — covered. Tests assert:
  - On Rakuten 500 from `/v1/programs/`, the thrown `NetworkError`'s envelope
    carries `network: rakuten`, `operation: listProgrammes`, `httpStatus: 500`,
    and `networkErrorBody` containing the verbatim body
    ("rakuten upstream failure").
  - On 403, the envelope's `type` is `auth_error` and the body is preserved.
  - Missing `RAKUTEN_SID` throws a `NetworkError` (config_error) before any
    network call.
  - Two-consecutive-401s also surface as a `NetworkError` with the verbatim
    body on the envelope.

- **§15.9 unpaid-age filter** — covered. Test "returns only aged transactions
  when minAgeDays is set" asserts that with `minAgeDays: 365`, every returned
  transaction has `ageDays >= 365`. `getEarningsSummary` separately computes
  `oldestUnpaidAgeDays` across pending+approved (and Rakuten's "locked" is
  mapped to "approved" so locked overdue sales count — explicit test).

- **§15.10 reversed-sale visibility** — covered. Test "includes reversed
  transactions with reason populated" asserts that the adapter returns the
  reversed transaction with `reversalReason: "Customer returned the item
  within 30 days"` populated from Rakuten's `reversal_reason` field.

- **§15.30 reference clarity** is NOT a Rakuten quality bar (per the chunk-6
  brief and AGENTS.md). Future-network agents are explicitly directed to the
  Awin adapter as the pattern source; this adapter's header comment calls
  that out so a future contributor doesn't pattern-match Rakuten by accident.

## What's unfinished

- **Live API exercise**. The adapter has not been run against a real Rakuten
  publisher account. `claim_status` is `partial` until Chunk 8 acceptance
  testing.

- **`listClicks` real implementation**. Currently throws
  `NotImplementedError`. If the test account is upgraded to a paid tier, the
  implementation is ~20 additional lines (same response shape as
  `transaction_reports`).

- **`listPublishers` / `listPublisherSectors`**. Scaffolded for v0.2 only —
  same as Awin / CJ / Impact.

- **XML-endpoint coverage** (e.g. `/coupon/getcouponfeed/`). Out of scope for
  v0.1. Would need a `text/xml` Accept branch in the client.

- **Tenant-variance for the token host**. Defaults to
  `api.linksynergy.com/token`; users on `api.rakutenmarketing.com` need to
  set `RAKUTEN_TOKEN_URL`. Could be auto-detected at first-failure but the
  added complexity isn't justified until a real user hits the case.

## What surprised me

- **The `scope` body parameter is the Site ID**. OAuth2 client-credentials
  flows typically don't use `scope` to identify a tenant. Rakuten does. The
  setup wizard has to prompt for it as a separate field; no auto-derivation
  pathway exists from the token response (which is why `derivedValues()`
  returns `[]`).

- **`Accept: application/json` is load-bearing**. Without it, the token
  endpoint can return XML even on the v1 surface. The client sends it
  unconditionally.

- **Rakuten "locked" semantically matches Awin "approved"**, but the names
  are different. Documenting the mapping (locked → approved) in code, tests,
  AND the findings doc was the only way to make the §15.9 affordance work
  uniformly across networks.

- **`/v1/programs/` server-side status filter is sometimes ignored** on some
  tenants (reported anecdotally). Defence-in-depth: I filter client-side
  after the fetch regardless.

- **The docs portal returned 403 for the API reference page on 2026-05-21**
  when accessed without an authenticated session. Endpoint shapes were
  assembled from the chunk-6 brief + public deeplink documentation +
  observed responses. `last_verified` reflects the date of the synthesis,
  not a live-API session.

- **The 401-refresh-retry-once path counts as ONE composite attempt to the
  resilience layer.** That's intentional — we don't want N retries on the
  outer resilience loop to cascade into N×2 token refreshes. If the design
  ever needs to change, the place to do it is the `doRequestWith401Refresh`
  function in `client.ts`.

## Recommended next steps

1. **Chunk 7 (REPORT.md generator)**: this handoff's "operations live vs
   stubbed" table is the canonical input. The findings doc supplies the
   qualitative description.

2. **Chunk 8 (live validation)**: once a real Rakuten test account is
   provisioned, run `affiliate-mcp validate rakuten` end-to-end. Decide
   whether to bump `claim_status` to `production` (if all live ops succeed
   except the known-gated `listClicks`) or hold at `partial`.

3. **If access to clicks_reports is granted**: lift the `transaction_reports`
   transformer pattern, add a `toClick` function, and replace the
   `NotImplementedError` body in `listClicks` with the real implementation.
   Drop the `Click-level data ...` entry from `META.knownLimitations`.

4. **Cross-cutting concern for parallel chunks**: `src/networks/index.ts` is
   touched by every network chunk. I added one line for Rakuten. CJ and
   Impact will each add one line; conflict resolution is trivial.

## Blockers

None. Cannot push (remote 403, as expected). Branch is ready for the
orchestrator to merge.

## Commits

See `git log claude/affiliate-mcp-orchestration-qfKw4..feature/network-rakuten --oneline`.
