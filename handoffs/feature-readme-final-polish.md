# Handoff — `feature/readme-final-polish`

**Branch**: `feature/readme-final-polish`
**Base**: tip of `claude/affiliate-mcp-orchestration-qfKw4`.

Final editorial pass on `README.md` for the LinkedIn-arriving publisher
audience. Tightening only; structure unchanged. Test baseline 357 → 359
(two new governance assertions).

## What I did

- **README.md** — tightened the opening "What this is" block (removed
  "roughly 35 tools" math, cut "or any other", dropped "on your machine",
  reframed the REPORT.md link as forward reference rather than companion
  document). Quick-start now states Node 20 prerequisite and includes
  `npx affiliate-mcp test` as a verification step before the Claude
  Desktop hand-off. Tool surface meta-tool paragraph shortened. Skills
  intro reworded to drop the "nudge" framing. Status report paragraph
  trimmed by one sentence.
- **README.md per-network setup list** — added the eBay entry
  (`OAuth client + secret + campaign ID; approval required`); previously
  only four of the five networks had links despite the README claiming
  five ship.
- **README.md acknowledgements** — added eBay Partner Network to the list
  of network teams credited (was four-network text after the eBay merge).
- **tests/governance/readme.test.ts** — added two assertions:
  - every `docs/networks/*.md` file on disk must be linked from the README
    (catches the eBay-style omission for any future addition);
  - every `npx affiliate-mcp <subcommand>` in the quick-start must
    reference a real CLI subcommand (`setup | test | doctor | validate`).

## What's tested

- `npm test` — **359 passed** (357 baseline + 2 new readme governance
  assertions). All 35 test files green.
- `npm run typecheck` — clean.
- `npm run lint` — 7 warnings (6 pre-existing + 1 non-null assertion in
  the new quick-start test, matching the established pattern at
  `readme.test.ts:87,94`); 0 errors.
- `npm run build` — clean.
- `npm run generate:readme` — re-ran; the table region between the
  `AFFILIATE_MCP_NETWORK_TABLE_*` markers is unchanged by my edits and
  the generator's idempotency is preserved.
- Quick-start verified by hand against the built `dist/`:
  `AFFILIATE_MCP_CONFIG_DIR=$(mktemp -d) node dist/index.js --help`
  matches the subcommand vocabulary used in the README; `... test`
  exits cleanly against an empty config dir.

## What's unfinished

- Nothing on the README. PR #1 is still open as draft; promotion to
  ready-for-review is for the orchestrator.
- The README's quick-start assumes `affiliate-mcp` is publishable to
  npm (so `npx affiliate-mcp setup` resolves). Pre-launch this only
  works for users with the repo cloned; that constraint is implicit in
  the "Status: pre-launch" banner and consistent with the previous
  README copy, so I left it.

## What surprised me

The eBay entry was missing from the "Per-network setup" list and the
"Acknowledgements" block despite the eBay adapter being merged and the
opening paragraph correctly saying "five networks". The opening prose
was fixed in Chunk 13 (per `handoffs/feature-launch-prep.md`) but the
two list locations were missed. The new governance test will catch
that class of drift on the next adapter.

## Recommended next steps

- Orchestrator can mark PR #1 ready for review when content of all
  merged chunks is signed off; this branch does not need a separate PR.
- If the project is published to npm under a different name than
  `affiliate-mcp`, update the README's `npx` invocations and the
  Claude Desktop config example accordingly.
