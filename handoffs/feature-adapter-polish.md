# feature/adapter-polish — Chunk 10 handoff

Branch: `feature/adapter-polish` (off `claude/affiliate-mcp-orchestration-qfKw4`).
Head: `9541dee`.
Test count: **181 → 192** (+11). Typecheck clean, lint clean, build clean.

This is the polish chunk. It catches the four sub-agent chunks' known
follow-ups, hardens error envelopes against PRD §4.1, and adds the §15.1-3
integration acceptance tests. No new features.

## What I did

### 1. Error-envelope audit + fix (commit `31844e9`)

Audited every `adapter.ts`/`client.ts`/`auth.ts`/`setup.ts` under
`src/networks/*` for:

- `console.log` / `console.error` / `console.warn` — none found.
- `catch (...)` blocks that swallow errors — all existing blocks either
  rethrow or build a `NetworkErrorEnvelope`; the only thing each was
  missing was the `networkErrorBody` field on the synthesised envelope.
- `throw new Error(...)` with generic strings — five instances found,
  all on the 2xx-non-JSON-body path (one per network client) plus two in
  `rakuten/auth.ts` (token endpoint returned non-JSON / no access_token).
- Generic message literals — none found.

Each `throw new Error(...)` was converted to `throw new NetworkError(
buildErrorEnvelope({ ... networkErrorBody: rawBody ... }))` so the
verbatim upstream body lands on the envelope. The resilience layer
already round-tripped these via `classifyError` but lost the body field
in the process; this fix preserves it. Tagged `// Polish (Chunk 10):`.

Files: `src/networks/awin/client.ts`, `src/networks/cj/client.ts` (3
spots — GraphQL parse, GraphQL no-data, REST parse), `src/networks/
impact/client.ts`, `src/networks/rakuten/client.ts`,
`src/networks/rakuten/auth.ts` (2 spots — token JSON parse, missing
access_token).

### 2. Fresh-install rehearsal (no code changes needed)

`git clone … && cd … && npm install && npm run build && node dist/index.js --help`
produced clean output. `affiliate-mcp test` against a fresh
`AFFILIATE_MCP_CONFIG_DIR=$(mktemp -d)` printed the expected
`Missing required credential X` envelopes for all four networks with
no stack traces, no generic errors. `affiliate-mcp setup --help`
launched the wizard banner. `affiliate-mcp validate awin` produced a
clean JSON report. `affiliate-mcp doctor` produced JSON with the
config path correctly pointed at the override directory.

No fresh-install bugs surfaced. The rehearsal is therefore not a
regression test in itself, but its successful execution is recorded
here as evidence for PRD §15.1.

### 3. Bad-key rehearsal test (commit `c7ad1f7`)

New file: `tests/integration/bad-key.test.ts`. For each adapter
(awin/cj/impact/rakuten) it mocks `fetch` to return 401 with
`{"error":"invalid_token","detail":"token rejected by upstream"}` and
asserts `validateNetwork(slug)` surfaces:
- `ok === false`
- a `verifyAuth` check whose detail names the network/operation and
  contains either the verbatim body fragment OR a verbatim
  "Missing required credential" hint (rakuten's token-exchange path
  fails at the credential layer if any of the three creds are blank
  before the network round-trip — still a clean envelope)
- never the strings "an error occurred" / "something went wrong"
- every operation probe (listProgrammes, listTransactions, etc.)
  failed — none invented success.

4 tests, all green.

### 4. Diagnostic-meta rehearsal test (commit `c7ad1f7`)

New file: `tests/integration/diagnostic-meta.test.ts`. Mocks `fetch`
universally to return plausible probe responses (token-exchange for
rakuten, GraphQL envelope for CJ, empty array for awin/impact) and
calls `runDiagnostic()` (no slug). Asserts:
- 4 entries returned (one per adapter)
- each entry has a populated `capabilities.operations` map with every
  op carrying a `supported: boolean`
- `knownLimitations` propagates verbatim from each adapter's
  `META.knownLimitations`.

3 tests, all green.

### 5. Wizard config-location follow-up (commit `be13022`)

`src/shared/config.ts` previously hardcoded `~/.affiliate-mcp/.env`
in `isFirstRun()` and `loadConfig()`. The setup-wizard handoff
explicitly flagged this. Added `resolveConfigEnvFile()` (reads
`AFFILIATE_MCP_CONFIG_DIR`, falls back to the default) and re-pointed
both functions' default parameter via that resolver. The behaviour
diff: a user with `AFFILIATE_MCP_CONFIG_DIR=/tmp/foo` and no
`/tmp/foo/.env` now sees the first-run banner; previously they saw
the "config present" path because the system checked the wrong path.

The wizard's `src/cli/wizard/paths.ts` already honoured the override;
this commit makes `shared/config.ts` consistent. Behaviour at call
sites that pass an explicit `filePath` argument is unchanged.

Tests: three new cases in `tests/shared/config.test.ts` cover
`resolveConfigEnvFile`, `isFirstRun` returning true when the override
dir lacks `.env`, and `isFirstRun` returning false when it doesn't.

### 6. Doctor JSON env-value-leak regression test (commit `cfa0f70`)

The doctor handoff committed to "variable VALUES never leak". Existing
tests covered the small (two-key) case; this adds a fully-populated
case with nine distinct sentinel values across all four networks,
populated both in the `.env` file and in `process.env` (so any path
that reads from live env is exercised). Asserts:
- every key NAME appears in `report.config.keys` (we publish names)
- no value substring appears anywhere in `JSON.stringify(report)`.

1 test, green.

### 7. last_verified bumps

All four `src/networks/*/network.json` already carried
`last_verified: 2026-05-21` from their respective chunks. No edits
required; confirmed via grep.

### 8. Generators re-run (commit `9541dee`)

`npm run generate:report` produced a one-line timestamp diff in
`REPORT.md`. `npm run generate:readme` produced no diff (the README
table region was already current). Committed the regenerated REPORT.

## What's tested

Quality bars cleared:

- **§15.1 fresh-install** — manual rehearsal documented above; no
  failures. Not a regression test, but the rehearsal commands are
  in the handoff text for future re-runs.
- **§15.2 bad-key** — `tests/integration/bad-key.test.ts` (4 tests).
- **§15.3 diagnostic meta-tool** — `tests/integration/
  diagnostic-meta.test.ts` (3 tests).
- **§15.4 error transparency** — adapter audit complete; every
  `throw new Error` on a network-failure path now carries the verbatim
  body via `NetworkError`/`NetworkErrorEnvelope`. The existing
  per-adapter unit tests (181 baseline) still pass.
- **§15.18 setup config location** — `tests/shared/config.test.ts`
  three new cases plus the existing wizard/doctor tests that already
  honoured the override.
- **Doctor env-value-leak** — `tests/cli/doctor.test.ts` new
  regression test against a fully-populated config.

Full test suite: **192 passed (192)**. Lint: clean (2 pre-existing
`non-null-assertion` warnings in unrelated tests; not introduced here).
Typecheck: clean. Build: clean. `node dist/index.js --help` produces
the expected banner.

## What's unfinished

- I did NOT propagate `resolveConfigEnvFile()` into
  `src/cli/wizard/paths.ts`. The wizard's resolver still exists as a
  separate function with the same behaviour. They are duplicative but
  consistent. A future refactor could collapse them; I kept the diff
  minimal per the chunk brief ("one function, one test, one commit
  message").
- I did NOT add a "config errors aren't really 'unsupported'"
  distinction in `affiliate-mcp test` output, despite the wizard
  handoff flagging it. The current behaviour (label "not supported"
  with the verbatim reason "Missing required credential ...") is
  correct per PRD §4.1; sharpening the category split is a UX
  enhancement, not a polish item.
- I did NOT widen `NetworkAdapter.verifyAuth`'s return type to include
  `derivedValues`, despite multiple network handoffs flagging the
  duck-typing workaround. The brief explicitly forbids modifying
  `src/shared/types.ts` ("the contract is stable"); the workaround
  remains in `src/cli/setup.ts`.
- Live API exercise still has not happened. All four adapters remain
  `claim_status: partial` in their manifests. Promotion to
  `production` is a downstream-of-this-chunk acceptance gate.

## What surprised me

- **The resilience layer was already saving us on most paths.**
  When I traced the original `throw new Error(...)` calls, I found that
  `classifyError` in `src/shared/resilience.ts` does coerce plain
  `Error` instances into envelopes — just without the
  `networkErrorBody` field populated. The polish fix here adds the body
  preservation; without it, the user's envelope message would still
  include the (truncated) body text via the message string, but the
  dedicated machine-readable field would be empty. That distinction
  matters for tooling on top of the MCP protocol.

- **Rakuten's three-credential model interacts oddly with the bad-key
  test.** When all three creds are present but the token-exchange call
  returns 401, the resilience layer surfaces a clean `auth_error`
  envelope as expected. When even one credential is missing,
  `requireCredential` short-circuits with a `config_error` envelope
  before the network round-trip — also clean, but a different type.
  The bad-key test accepts either path; documented inline so future
  contributors don't think the test is too lenient.

- **`Pino` writes to fd 2 reliably but the test command's diagnostic
  output is interleaved with warning log lines on a fresh terminal.**
  Both go to the expected destination (stdout vs stderr); the
  visual mix is only present when the terminal merges both streams.
  Confirmed by piping stderr to /dev/null — diagnostic output is
  clean. No fix needed; flagging in case a future "make this prettier"
  ticket appears.

- **Re-running `npm run generate:readme` produced no diff.** The
  generator is idempotent over the current network manifests; only
  the report timestamp changes from one run to the next. This is
  good news but worth confirming so future contributors don't think
  they need to "force" a regen.

## Recommended next steps

In rough priority order:

1. **Live acceptance testing per PRD §15.8.** All four adapters are
   `claim_status: partial` and stay that way until someone runs them
   against a real account. This is the gate to promoting any adapter
   to `production`.

2. **Collapse `src/cli/wizard/paths.ts` into `src/shared/config.ts`.**
   `resolveConfigEnvFile()` and `resolveConfigPaths()` now do the same
   thing in two places. Future contributor: delete the wizard-local
   helper, point everything at the shared resolver. Tiny refactor.

3. **Widen `verifyAuth`'s return type** to officially include
   `derivedValues?: Record<string, string>`. This is a shared-types
   edit that the brief forbade me from making. Once done, remove the
   duck-typing in `src/cli/setup.ts`.

4. **Sharpen the `affiliate-mcp test` category split** so
   "missing credential" reports as `error` (config issue), not
   `partial unsupported`. Cosmetic but improves first-run UX.

5. **The setup-docs and publisher-skills chunks** are still in flight
   in parallel worktrees. When they merge, re-run the generators
   (`npm run generate:report`, `npm run generate:readme`) and re-run
   the full test suite — none of this chunk's tests touch those
   surfaces but the integration tests assert four adapters register,
   which any future addition will affect.

6. **A live `npm run test:live` implementation** — currently a
   placeholder script. Once any adapter is live-validated, this
   should drive the diagnostic against real credentials and assert
   the production claim.
