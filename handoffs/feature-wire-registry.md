# Handoff — `feature/wire-registry`

**Chunk**: Integration tweak — wire the network aggregator into the three entry points
**Branch**: `feature/wire-registry`
**Base**: `claude/affiliate-mcp-orchestration-qfKw4` (post-merge of chunks 1 + 2)

## What I did

Added the side-effect import `import './networks/index.js';` (relative path adjusted per file) to the three entry points that consume the adapter registry:

- `src/server.ts` — placed after the other module imports, before any code that calls `getAdapters()` / `generateAllTools()`. Ensures `tools/list` advertises Awin (and every future adapter) at boot.
- `src/index.ts` — added immediately after the existing `./shared/config.js` import. The `validate <slug>` subcommand already in the CLI now has a populated registry to consult; the `setup`/`test`/`doctor` stubs inherit the same wiring for free when chunk 4 lands.
- `scripts/validate-network-json.ts` — added after the `getAdapter`/`validateNetwork` imports. Each import carries a short comment explaining why it's a side-effect-only import (so a future reader doesn't "tidy it up" by removing it).

Added one smoke test: `tests/integration/registry-boot.test.ts`. It imports the aggregator, asserts `getAdapter('awin')` is truthy with `slug === 'awin'` and `name === 'Awin'`, and asserts `getAdapters().length >= 1`. Intentionally minimal — this is the wiring guarantee, not an Awin re-test.

## What's tested

All quality bars green:

- `npm run typecheck` — clean.
- `npm run lint` — clean.
- `npm test` — 56 tests across 12 files, all pass (was 54; +2 from the new integration spec).
- `npm run build` — clean; `dist/` regenerates without error.
- `npm run validate:network awin` — registry line now reports `OK` instead of "no adapter registered"; downstream operations correctly fail with `Missing required credential AWIN_API_TOKEN` etc., proving the diagnostic path is exercising the real adapter.

## What's unfinished

Nothing within the scope of this chunk. The aggregator currently lists only Awin (`import './awin/adapter.js';`); chunks 3/5/6 (CJ, Impact, Rakuten) will each add one line there and inherit the wiring done here.

## What surprised me

Nothing. The aggregator + registry contract was already cleanly designed in chunk 1 — each adapter file calls `registerAdapter` at top level, so a single side-effect import per entry point is genuinely all that's required. The fact that `validate-network-json.ts` already had the "if `getAdapter(slug)` returns something, run the live diagnostic" branch meant zero script-level changes were needed to light up the live path.

## Recommended next steps

- Proceed to chunk 3 (the next network adapter). It need only append one line to `src/networks/index.ts` — no further wiring required.
- When chunk 4 implements `setup`/`test`/`doctor`, those handlers can rely on the registry being populated by the time the subcommand dispatcher runs (the import sits above the dispatcher in `src/index.ts`).
- Consider whether the orchestrator wants a CI check that fails if any adapter file is added under `src/networks/<slug>/` but not referenced from `src/networks/index.ts`. Out of scope here, but a one-line glob diff in a lint script would catch the easiest possible "I forgot to register my adapter" regression.
