# Handoff — `feature/foundations`

**Chunk**: 1 — Repo & toolchain bootstrap (PRD §13 Day 1)
**Branch**: `feature/foundations`
**Base**: `claude/affiliate-mcp-orchestration-qfKw4`

## What I did

### Repo & toolchain
- `package.json` — name `affiliate-mcp`, ESM (`"type": "module"`), Node >=20, `bin` → `dist/index.js`, all scripts wired (`build`, `dev`, `typecheck`, `lint`, `test`, `test:live`, `validate:network`, `generate:readme`, `generate:report`).
- `tsconfig.json` — strict ES2022 + NodeNext + `rootDir: src` so `dist/index.js` matches the `bin` advertisement.
- `tsconfig.dev.json` — broader noEmit project covering `scripts/` and `tests/` for `npm run typecheck`.
- `.eslintrc.cjs` — `no-console: error`, strict TS rules, sensible overrides for tests.
- `.prettierrc`, `vitest.config.ts`, `.gitignore`, `.env.example` — all wired.

### Shared modules (`src/shared/`)
- **`types.ts`** — the canonical contract: `Programme`, `Transaction`, `Click`, `TrackingLink`, `EarningsSummary`, `NetworkCapabilities`, `NetworkErrorEnvelope`, `NetworkAdapter`, `SetupStep`, `ResilienceConfig` (+ `ResilienceConfigMap`), `ProgrammeQuery`/`TransactionQuery`/`ClickQuery`, `NotImplementedError`. Mirrors PRD §6 / Appendix C. Marked clearly as the single source of truth.
- **`errors.ts`** — `buildErrorEnvelope`, `toErrorEnvelope`, `NetworkError` (wraps a fully-formed envelope), `isErrorEnvelope`, re-exports `NotImplementedError`.
- **`resilience.ts`** — `withResilience` (timeout + exponential backoff with ±25% jitter + circuit breaker), `HttpStatusError`, `DEFAULT_RESILIENCE` (30s timeout, 2 retries, retryOn `[429, 502, 503, 504]`, 5 failures → 60s cooldown). Header comment makes it explicit that this is the only sanctioned network path.
- **`logging.ts`** — Pino bound to fd 2 (stderr), redaction of any key matching `/token|secret|key|password|authorization/i`, level from `AFFILIATE_MCP_LOG_LEVEL` or `LOG_LEVEL`.
- **`config.ts`** — reads `~/.affiliate-mcp/.env` via a small in-house parser (no `dotenv` dep needed — see "What surprised me"). Exposes `getCredential`, `requireCredential` (throws `config_error`), `isFirstRun`.
- **`registry.ts`** — `registerAdapter`, `getAdapter`, `getAdapters`. Empty at v0.1 by design.
- **`diagnostic.ts`** — `runDiagnostic(slug?)` and `validateNetwork(slug)` returning structured, throw-free results suitable for CLI + script consumption.

### Tooling layer
- **`src/tools/generate.ts`** — produces 7 publisher tools per registered adapter (`affiliate_<slug>_<snake_case_op>`) plus 2 meta tools (`affiliate_run_diagnostic`, `affiliate_list_networks`). Tool descriptions follow PRD §5.5 three-sentence pattern (what / when / returns+pairs). Hand-rolled minimal JSON-Schema projection from Zod for the MCP advertise step; Zod still validates arguments at call time.
- **`src/server.ts`** — boots `Server` from `@modelcontextprotocol/sdk` on stdio. Routes `tools/list` and `tools/call`. Adapter failures return `isError: true` with the envelope as JSON text content (PRD principle 4.1 — never invent success, never raise transport errors for adapter failures).
- **`src/index.ts`** — CLI entry. `--help`, first-run banner on missing config, subcommand stubs for `setup`/`test`/`doctor` and a working `validate <slug>`. Stderr-only output.

### Scripts + templates
- **`scripts/validate-network-json.ts`** — Zod `NetworkJsonSchema` matching PRD Appendix C fields (slug, name, base_url, auth_model, env_vars, setup_time_estimate_minutes, setup_requires_approval, setup_approval_days_typical?, known_limitations, claim_status, adapter_version, last_verified, supports_brand_ops, docs_url). CLI entry runs schema check and, when the slug has a registered adapter, the live `validateNetwork` suite.
- **`templates/new-network/`** — `adapter.ts` (full `NetworkAdapter` skeleton, all methods throw `NotImplementedError`), `auth.ts`, `client.ts`, `setup.ts` stubs, `network.json` template, `README.md` skeleton, `tests/fixtures/.gitkeep`. Structurally correct only — Chunk 11 enriches the TODO comments.

### Tests (`tests/`)
- `shared/types.test.ts` — `NotImplementedError`, minimal `Programme`/`Transaction`/`NetworkErrorEnvelope` shapes.
- `shared/errors.test.ts` — envelope shape stable, `NotImplementedError` → `not_implemented`, `NetworkError` passes envelope through, message-heuristic classification.
- `shared/resilience.test.ts` — retry on 5xx, no retry on 401, retry on 429 by policy, circuit opens after threshold consecutive failures and reports `circuit_open`.
- `shared/registry.test.ts` — round-trip, double-registration rejection, unknown-slug `undefined`.
- `shared/config.test.ts` — env file parser handles comments, blanks, quoted values.
- `shared/logging.test.ts` — smoke test that the logger constructs and accepts sensitive bindings without throwing.
- `shared/diagnostic.test.ts` — empty registry path, unknown-slug honest error.
- `tools/generate.test.ts` — meta tools present, no adapters → meta-only output, three-sentence pattern heuristic.
- `scripts/validate-network-json.test.ts` — accepts a clean Awin-shaped manifest, rejects bad slug + unknown claim_status.

## What's tested

All 30 tests pass; `npm run typecheck` clean; `npm run lint` clean; `npm run build` produces a working `dist/index.js`.

Quality bars (PRD §15) status:

- **§15.23 lint+types pass** — yes (`npm run typecheck && npm run lint` both green).
- **§15.24 no telemetry / phone-home** — yes; no analytics dep, no outbound calls anywhere.
- **§15.25 stderr-only logging** — yes; Pino is constructed against `pino.destination({ fd: 2 })`; CLI prints everything via `process.stderr.write`; `.eslintrc.cjs` enforces `no-console: error` so future commits can't regress.
- **§15.26 no key leakage** — yes; logger redacts any property whose key matches `/token|secret|key|password|authorization/i`. Adapters are expected to never put raw secrets in log message strings (a documented invariant).

## What's unfinished

- **`src/networks/*`** — no adapters yet. Chunk 2 (Awin) lights up the registry, after which the meta tools have something to enumerate.
- **`validate:network`** — only runs the schema check at v0.1. The live diagnostic short-circuits with "no adapter registered" until a real adapter is added.
- **CLI subcommands** — `setup`, `test`, `doctor` are stubs that print "implemented in chunk 4". The dispatcher shell is in place so the wizard chunk can drop in real handlers without restructuring.
- **Generators** — `generate:readme` / `generate:report` scripts are `echo` placeholders.
- **Template TODO comments** — structural only. Chunk 11 enriches them with Claude-Code-readable instructions.
- **Logging redaction smoke test** — verifies the logger doesn't throw on sensitive bindings, but doesn't capture stderr to assert the redacted output appears. A vitest harness capturing fd 2 would be brittle and felt over-engineered for v0.1; consider adding a child-process integration test in a later polish chunk if desired.

## What surprised me

- **Native `fetch` is enough.** Node 20 ships native `fetch`/`AbortController`/streaming. I did not add `undici` or `dotenv` — the env parser is ~20 lines and the saved surface area is worth it. If a future adapter needs streaming pagination tooling, revisit.
- **The MCP SDK's high-level API is now `McpServer`.** The low-level `Server` class is marked `@deprecated` in the type definitions in favour of `McpServer`. I stuck with `Server` because the PRD says "Server from @modelcontextprotocol/sdk" explicitly and the deprecation is just a styling nudge — both classes will be supported for the foreseeable future. If the orchestrator prefers `McpServer`, the migration is mechanical and isolated to `src/server.ts`.
- **`tsconfig` rootDir interplay with scripts/.** I split into `tsconfig.json` (build, src-only, `rootDir: src` so the build emits `dist/index.js` matching the `bin` entry) and `tsconfig.dev.json` (broader noEmit for typecheck across `scripts/` + `tests/`). Cleaner than alternative outDir gymnastics.
- **Sensible defaults picked without explicit PRD guidance**:
  - Default per-op timeout: **30s** (matches the PRD's named figure).
  - Default retries: **2** (so 3 total attempts).
  - Retry status set: **`[429, 502, 503, 504]`** (429 is also forced retryable regardless of `retryOn`).
  - Circuit breaker: **5 consecutive failures → 60s cooldown** (matches PRD).
  - Backoff: **200ms × 2^(attempt-1) with ±25% jitter, capped at 5s.** These felt right; happy to revisit per-adapter.
- **Tool name shape**: `affiliate_<slug>_<snake_case_op>` (e.g. `affiliate_awin_list_programmes`). Three sentences enforced by description style only — Chunk 9 will polish the wording across the board.

## Recommended next steps

1. Hand off to Chunk 2 (`feature/network-awin`). The Awin adapter slots straight into `src/networks/awin/` and `registerAdapter` from inside its module's top-level side effect (or, cleaner, from a `src/networks/index.ts` aggregator the orchestrator adds — TBD by the next agent).
2. Confirm the tool name shape (`affiliate_awin_list_programmes`) before the Awin agent commits to it. If the orchestrator wants `awin.list_programmes` or another shape, that's a one-line change in `src/tools/generate.ts::toolNameFor`.
3. When Chunk 4 lands, replace the stub branches in `src/index.ts` with real wizard dispatch.
4. Consider adding a `tests/integration/server.test.ts` that boots the MCP server against an in-memory transport once at least one adapter is registered — out of scope for foundations but a nice early-confidence test.

## Blockers

None. Cannot push (remote 403, as expected per orchestrator instructions).

## Commits on this branch (will be appended as I commit)

See `git log claude/affiliate-mcp-orchestration-qfKw4..feature/foundations --oneline`.
