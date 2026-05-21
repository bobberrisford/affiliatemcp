# feature/contribute-infra — Chunk 11 handoff

Branch: `feature/contribute-infra` (off `claude/affiliate-mcp-orchestration-qfKw4`).
Test count: **240 → 293** (+53). Typecheck clean. Lint clean (only the same
pre-existing non-null-assertion warnings; no new errors). Build clean.

This is the meta layer — the contribution infrastructure that lets a future
Claude Code session add a fifth (or sixth, or nth) network without other
context. No runtime behaviour changes. No new dependencies.

## 1. What I did

### `AGENTS.md` at repo root

A ~160-line primer for AI coding agents. Covers:

- One-paragraph project summary (matter-of-fact).
- Editorial tone constraint.
- File layout — verified against the actual repo (every path cited exists on
  disk; the test enforces this).
- Read-in-this-order recommendation (`AGENTS.md` → contribute SKILL.md →
  `src/shared/types.ts` → `src/networks/awin/adapter.ts` → task-specific).
- Conventions: TypeScript strict, UK spelling, principle 4.1, resilience as
  the only path, stderr-only logging, tool description pattern (PRD §5.5),
  test placement.
- Commands table — every script declared in `package.json` is listed.
- "What not to do" list — covers the eleven cardinal don'ts.
- "When in doubt" guidance.
- External contract notes (30 tools at v0.1, envelope shape stable, adding
  networks adds 7 tools automatically).
- Forward shape (tier-ready, brand-side scaffolded, network claim process).

### `.claude/skills/contribute/SKILL.md`

The project-local Claude Code skill (~400 lines). YAML frontmatter matches
the brief verbatim. Body covers the five contribution tasks:

1. **Add a new network adapter** — 16-step flow from prerequisites through
   draft PR. ~70% of the document. Step 6 enumerates the implementation
   order for the seven operations and gives the reason for that order.
2. **Fix an existing network adapter** — reproduce → minimum change → version
   bump → finding → regenerate → PR.
3. **Add a Claude Code skill** — check existing → directory → SKILL.md →
   example → manual test → PR.
4. **Improve setup documentation** — identify confusing step → re-screenshot
   → update step → add to common-failures → bump last_verified → PR.
5. **File a finding for the public REPORT** — specific + verifiable; no
   speculation about motive.

Followed by:

- "What you should NOT do" — mirrors AGENTS.md.
- "Common failures and how to recover" — six entries.
- "When to ask the user vs proceed autonomously".
- Closing PR checklist — fourteen items with markdown checkboxes.

### `templates/new-network/` enriched

Per PRD §14.3, every method in `adapter.ts` now carries a Claude-Code-readable
TODO block with:

1. **What to do** in human language.
2. **Reference:** pointing at `src/networks/awin/adapter.ts::<method>`.
3. **API behaviour to verify** — concrete questions to ask of the upstream API.
4. **Error handling** — which envelope to construct, when to defer.
5. **Return type:** with a pointer to `src/shared/types.ts`.

The ten template methods covered: `listProgrammes`, `getProgramme`,
`listTransactions`, `getEarningsSummary`, `listClicks`, `generateTrackingLink`,
`verifyAuth`, `validateCredential`, `setupSteps`, `capabilitiesCheck`.
`derivedValues` carries an optional/remove-if-not-used TODO. The two admin
ops (`listPublishers`, `listPublisherSectors`) are deliberately left with the
existing v0.1 stub — the template shouldn't encourage contributors to
implement them.

`auth.ts`, `client.ts`, `setup.ts`, `network.json`, and `README.md` are
similarly enriched: each names the Awin equivalent, explains what the file
must export, and lists the API behaviours to verify. `network.json` has
inline `_comment_*` keys so each field carries its schema constraint at the
point of edit; the template is documentation, not a runnable manifest, so
the strict schema check is deliberately not run against it (per the brief).

### Awin reference comments audit (§15.30)

Read `src/networks/awin/adapter.ts` end to end. The file already carries:

- A 65-line file-level header naming the six cardinal rules, the seven
  operations, the Awin API map, and the §15.30 expectation that future
  adapters use this file as their pattern source.
- "Why" comments at every non-obvious decision: per-operation resilience
  override, raw-response defensive parsing rationale, `mapTransactionStatus`
  paid-derivation, `mapProgrammeStatus` exhaustiveness, `computeAgeDays`
  `validationDate`-anchored choice, `listProgrammes` default-`joined`
  rationale, `chunkDateRange` 31-day cap explanation, `getEarningsSummary`
  derive-from-transactions rationale, `listClicks` unsupported-not-empty
  decision, `generateTrackingLink` deterministic construction, the
  `capabilitiesCheck` probe strategy, the aggregator import pattern, and
  `_internals` test-helper export.

Comment line count: 425 lines across the 1078-line file (~40% comment
density). I added no new comments — the bar was met by Chunk 2 and the
"don't double-comment what's already documented" rule applies. The audit is
recorded in the handoff so future maintainers know this audit happened.

### README augmentation (stub only)

Edited the existing "For developers" section to name AGENTS.md and the
contribute skill explicitly, and to link `CONTRIBUTING.md` (which Chunk 12
ships). Two sentences added; no rewrite. The network table block remains
auto-managed.

### Tests added

- `tests/contribute/agents-md.test.ts` (6 tests) — verifies presence,
  canonical references, every cited file path exists, every cited npm
  script is declared, the "what not to do" list is present, and the
  contributor-flow scripts are mentioned by name.
- `tests/contribute/skill-md.test.ts` (9 tests) — frontmatter validity,
  five tasks named, file paths exist, npm scripts declared, AGENTS.md
  cross-reference, Awin reference cross-reference, closing checklist
  present with markdown checkboxes.
- `tests/contribute/template-todos.test.ts` (38 tests) — every method has
  a `// TODO:` block, every TODO references `src/networks/awin/`, every
  TODO names a return type or types.ts, auxiliary template files (auth,
  client, setup) reference the Awin equivalent, file-level header names
  the cardinal rules.

Net delta: +53 tests, all green.

## 2. What I deliberately did NOT do

- Did NOT modify `src/shared/`, `src/cli/`, `src/server.ts`, `src/index.ts`,
  `src/tools/`, `scripts/`, or `src/networks/{cj,impact,rakuten}/`. The
  contribute infrastructure is documentation + templates; no behavioural
  change anywhere.
- Did NOT modify `src/networks/awin/`. The §15.30 audit confirmed no missing
  "why" comments; no edits required.
- Did NOT rewrite the README. Augmented the contribution stub only.
- Did NOT add dependencies.
- Did NOT push.
- Did NOT run `npm run validate:network template-network` — the brief
  explicitly notes the template is not a real network and should not pass
  validation (the `_comment_*` keys violate `.strict()` by design).

## 3. Quality bars

| Bar | State |
| --- | --- |
| §15.27 AGENTS.md completeness | PASS — 6 tests verify (existence, canonical references, paths, scripts, what-not-to-do, contributor scripts). |
| §15.28 contribute skill executable | PASS structurally — 9 tests verify frontmatter, all five tasks, paths, scripts, cross-references, checklist. Live execution is §15.31. |
| §15.29 template self-documentation | PASS — 38 tests across 10 methods + 3 auxiliary files + header. |
| §15.30 reference implementation clarity | PASS — Awin adapter audited; no additions needed. Handoff records the audit. |
| §15.31 end-to-end Claude Code contribution | **DEFERRED** to orchestrator. See below. |

## 4. §15.31 follow-up (queued for orchestrator)

§15.31 requires spawning a fresh Claude Code session with no other context
and instructing it to add a new network adapter (e.g. eBay) using only the
infrastructure shipped by this chunk. That is an orchestrator-level meta-test,
not something a chunk can run against itself.

The infrastructure this chunk delivers should be sufficient for the test to
pass — the test verifies the infrastructure, not the other way around. If
the meta-test fails in a way that points back to a gap in AGENTS.md, the
SKILL.md, the template, or Awin's reference comments, the resulting fixes
go through a new chunk (`feature/contribute-infra-fixes` or similar).

The orchestrator should queue this test with at least:

- A fresh worktree off the merged base (no prior chat history).
- The user message: "Add the eBay Partner Network as a new affiliate
  network. Read AGENTS.md first."
- No other steering. The session succeeds if it produces a draft PR
  meeting the closing checklist in `.claude/skills/contribute/SKILL.md`.

## 5. Files changed

```
new:  AGENTS.md
new:  .claude/skills/contribute/SKILL.md
new:  tests/contribute/agents-md.test.ts
new:  tests/contribute/skill-md.test.ts
new:  tests/contribute/template-todos.test.ts
new:  handoffs/feature-contribute-infra.md
mod:  templates/new-network/adapter.ts        (enriched TODOs)
mod:  templates/new-network/auth.ts           (enriched TODOs)
mod:  templates/new-network/client.ts         (enriched TODOs)
mod:  templates/new-network/setup.ts          (enriched TODOs)
mod:  templates/new-network/network.json      (inline schema comments)
mod:  templates/new-network/README.md         (template setup-doc enrichment)
mod:  README.md                               (2-sentence augment)
```

No files removed.
