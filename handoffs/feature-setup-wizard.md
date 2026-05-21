# feature/setup-wizard — handoff

Chunk 4: the interactive setup wizard plus the `test` and `doctor`
diagnostic CLIs. Branch is `feature/setup-wizard`, off the
`claude/affiliate-mcp-orchestration-qfKw4` head.

## What I did

- Added `src/cli/setup.ts` — the wizard. Detects first-run vs existing
  config; offers `add` / `reset` / `quit` on top of the standard `setup`
  path; multi-selects networks from the registry; walks each adapter's
  `setupSteps()` showing the description verbatim; calls
  `validateOnEntry` (mapping to each adapter's `validateCredential`)
  with retry-or-skip on rejection; runs `verifyAuth()` and merges any
  `derivedValues` from the underlying auth result via duck-typing
  (Option B per the brief); writes the .env at mode 0600; preserves
  unrelated entries; prints the absolute path on completion.
- Added `src/cli/test.ts` — `affiliate-mcp test [slug]`. Runs
  `runDiagnostic` and prints one human-readable line per network
  (`ok` / `partial` / `fail`) with a latency range across probed
  operations and one indented line per failing operation naming the
  network, the operation, and the verbatim error note. Exits 0 only
  when every probed operation succeeded.
- Added `src/cli/doctor.ts` — `affiliate-mcp doctor [slug]`. Dumps a
  JSON document containing the Node version, platform, arch, the
  resolved config path (respecting `AFFILIATE_MCP_CONFIG_DIR`), the
  list of variable NAMES present in the .env (never values), per-
  network claim status + known limitations + resilience config, and
  the full diagnostic envelope.
- Added `src/cli/wizard/prompts.ts` — a small `Prompter` interface
  with a `readline/promises`-backed default. Deps-free (we chose
  not to add `enquirer` / `prompts`). Tests inject a `FakePrompter`
  via `setPrompter()`.
- Added `src/cli/wizard/paths.ts` — resolves the config dir/.env
  path, honouring `AFFILIATE_MCP_CONFIG_DIR` (PRD §15.18). The
  shared loader still hardcodes `~/.affiliate-mcp/.env`; see
  "What surprised me" below.
- Added `src/cli/wizard/envfile.ts` — reads (via the shared
  `parseEnvFile`), merges, and writes the .env with mode 0600.
- Wired `setup` / `test` / `doctor` in `src/index.ts` via dynamic
  imports of the new handlers. The first-run banner still points
  at `affiliate-mcp setup`.

## What's tested

`tests/cli/setup.test.ts`, `tests/cli/test.test.ts`,
`tests/cli/doctor.test.ts`, `tests/cli/fakes.ts`. Test count
147 → 165 (+18). All quality bars covered with named test cases:

- **§15.11 first-run wizard** — `runSetup — first-run path (PRD §15.11)
  › writes a clean .env from a fresh install` drives the wizard with
  a `FakePrompter`, asserts the .env contains the captured token,
  and asserts the absolute path is printed.
- **§15.12 wizard validation** — `runSetup — validateCredential
  failure (PRD §15.12) › re-prompts and surfaces the verbatim reason`
  asserts the wizard calls the validator twice (bad then good token)
  and that the rejection line names the network + field + verbatim
  reason. A second case covers the skip path.
- **§15.13 wizard reset** — `runSetup — reset path (PRD §15.13) ›
  overwrites the existing entries for the chosen network` asserts a
  pre-existing stale entry is replaced and that an unrelated entry
  is preserved.
- **§15.14 wizard add-network** — `runSetup — add-network path (PRD
  §15.14) › appends a new network without overwriting other networks`
  asserts both the existing ALPHA_TOKEN and the new BETA_TOKEN +
  BETA_ACCOUNT_ID end up in the merged file.
- **§15.15 friendly test command** — `formatDiagnostic — human-
  readable summary` covers ok / partial / error rendering, plus
  `runTest — end-to-end` asserts exit-code semantics.
- **§15.18 config location** — `runSetup — AFFILIATE_MCP_CONFIG_DIR
  (PRD §15.18) › writes into the directory named by the env var and
  prints the path`. Also asserted in the doctor tests.

Additional coverage:

- `runSetup — derivedValues from verifyAuth › merges derived values
  without re-prompting the user` — covers the canonical Awin/CJ
  pattern.
- `runSetup — file permissions › writes the .env with 0600
  permissions`.
- `buildReport — environment + config info › lists config variable
  NAMES only — never values` asserts the doctor JSON never includes
  credential values.

`npm run typecheck`, `npm run lint`, `npm test`, and `npm run build`
are all clean (lint has two warnings — `no-non-null-assertion` in
test code; consistent with patterns elsewhere in the test suite).
`node dist/index.js --help` and `node dist/index.js doctor` work as
expected.

## What's unfinished

- I did NOT run the wizard interactively in this sandbox — no TTY.
  The integration tests drive the same `runSetup` entrypoint, and a
  manual run with `AFFILIATE_MCP_CONFIG_DIR=$(mktemp -d) node
  dist/index.js setup` should work but needs a terminal. The
  `ReadlinePrompter` is the only piece not exercised by tests; it's
  thin and exists only to back the manual path.
- `affiliate-mcp test` and `doctor` correctly surface
  `config_error` envelopes when adapters are missing credentials,
  but I did not add a "config errors aren't really 'unsupported'"
  distinction. The human summary calls them "not supported" with
  the verbatim reason ("Missing required credential ..."), which is
  accurate but slightly muddled compared to live failures. A polish
  pass could split the partial/error categories more finely.

## What surprised me

- **`src/shared/config.ts` hardcodes `~/.affiliate-mcp/.env`.** It
  doesn't read `AFFILIATE_MCP_CONFIG_DIR`. I respected the "do NOT
  modify `src/shared/*`" constraint and resolved paths in
  `src/cli/wizard/paths.ts` instead. Consequence: `isFirstRun()`
  from the shared module checks the hardcoded path, so the no-arg
  first-run banner ignores the env override. The wizard itself,
  test, doctor, and the .env writer all honour the override. A
  future polish chunk should push the path resolution down into
  `config.ts` and have `loadConfig`/`isFirstRun` accept the same
  override; once it does, the banner branch in `src/index.ts` will
  honour it automatically.
- **`NetworkAdapter.verifyAuth`'s return type does not include
  `derivedValues`.** As the Awin handoff noted. I used Option B
  (duck-typing the underlying result) per the orchestrator brief:
  `(result as unknown as { derivedValues?: Record<string, string>
  }).derivedValues`. The wizard calls `adapter.verifyAuth()` and
  trusts that adapters returning derived values do so on the same
  object (Awin and CJ both do; Impact and Rakuten return
  `{ derivedValues: {} }` or nothing — neutral either way). Future
  polish chunk: widen the interface in `src/shared/types.ts` to
  include `derivedValues?: Record<string, string>` on the `ok: true`
  branch.
- **`vi.spyOn(process.stdout, 'write')` produces a type vitest
  doesn't like.** I had to type the spy variable as `any` (with an
  eslint-disable) — the overloaded `Writable.write` signature
  conflicts with `MockInstance`'s generic. Wider issue; not worth
  fighting for a test fixture.
- **The doctor's exit-code semantics are deliberately lenient.** It
  exits 1 only when a registry-level error occurs (unknown slug,
  no adapters), not when a network reports `partial`. The user
  generates a doctor report _because_ something's wrong; surfacing
  the partial state in the JSON is what matters, not the exit
  code. `test` is the stricter sibling.

## Recommended next steps

1. **Widen `NetworkAdapter.verifyAuth` to include `derivedValues?`**
   on the success branch (foundation change). Drop the duck-type
   cast in `src/cli/setup.ts` and have the wizard read the field
   directly.
2. **Push `AFFILIATE_MCP_CONFIG_DIR` into `src/shared/config.ts`**
   so `loadConfig`/`isFirstRun` respect it. Today they don't, which
   means the first-run banner in `src/index.ts` ignores the
   override and the loader can't find credentials the wizard wrote
   when the env var is set. (At v0.1 the only consumers are tests,
   which set both, so this is latent rather than broken.)
3. **Polish the partial/error distinction in `affiliate-mcp test`.**
   Currently a network missing credentials shows up as `partial`
   with "Missing required credential ..." notes. A "needs setup"
   category (distinct from "supports the op but it failed") would
   be friendlier.
4. **Wizard ergonomics.** The current readline-based prompter is
   functional but plain. If user testing wants cursor-driven
   multi-select / inline editing, swap the default `Prompter`
   implementation in `src/cli/wizard/prompts.ts` for `enquirer` or
   `prompts` (the interface is stable for that swap).
5. **End-to-end "first-run → test" walkthrough** in `affiliate-mcp
   validate`. Today the wizard prints "test with `affiliate-mcp
   test`"; consider an optional `--then-test` flag that chains the
   two commands so a user gets one continuous experience.

## Blockers

None. Cannot push (remote 403, as expected). Branch is ready for the
orchestrator to merge.

## Commits

See `git log claude/affiliate-mcp-orchestration-qfKw4..feature/setup-wizard --oneline`.

  - 83442d8 Add wizard prompt + paths + envfile helpers
  - 65d5d86 Add interactive setup wizard
  - 986ff0f Add affiliate-mcp test + doctor CLIs
  - a1ec20c Wire setup/test/doctor subcommands to the new cli/* modules
  - 4d6cf74 Add cli tests for setup wizard, test, and doctor
