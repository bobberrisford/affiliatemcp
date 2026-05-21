# affiliate-mcp — Build Status

**Orchestrator branch**: `claude/affiliate-mcp-orchestration-qfKw4`
**PRD**: v0.4 (Ready for build)
**Status**: Bootstrapping — Day 1 about to start
**Last updated**: 2026-05-21

This document maps the PRD §13 build sequence to discrete sub-agent assignments. The orchestrator delegates one chunk at a time, reviews the handoff document at `handoffs/<branch>.md`, verifies against the relevant PRD §15 quality bars, then merges to `main` (the working integration branch on `claude/affiliate-mcp-orchestration-qfKw4`).

## Conventions

- Each sub-agent works on a feature branch named `feature/<chunk>` and pushes a handoff doc at `handoffs/feature-<chunk>.md`.
- Sub-agents do NOT touch areas outside their chunk. Cross-cutting changes come back to the orchestrator.
- The orchestrator never writes implementation code. If a fix is required mid-review, the orchestrator opens a follow-up chunk.
- Quality bars (PRD §15) are checked at the chunk's natural boundary, not pushed to the end.

## Build sequence and chunk plan

### Day 1 — Foundations + Awin

| # | Chunk | Branch | Depends on | Quality bars |
|---|---|---|---|---|
| 1 | **Repo & toolchain bootstrap** — package.json, tsconfig, ESLint, Vitest config, Pino logger, config loader, error envelope, registry, tool generator skeleton, MCP server stdio entry point, `src/shared/types.ts` (full type system from PRD §6/Appendix C), `network.json` JSON Schema + validator, resilience layer, diagnostic engine skeleton, dev/test/typecheck/lint npm scripts. | `feature/foundations` | — | 23 (lint+types), 24 (no telemetry), 25 (stderr-only logs), 26 (no key leakage) |
| 2 | **Awin adapter** — canonical reference. All 7 publisher ops, `setupSteps()`, `validateCredential()`, `verifyAuth()`, `derivedValues` extraction, fixtures, comments explaining the *why* of every pattern (PRD §9.1, §14.4). | `feature/network-awin` | 1 | 4 (error transparency), 9 (unpaid age filter), 10 (reversed sale visibility), 30 (reference implementation clarity) |

### Day 2 — CJ + setup wizard

| # | Chunk | Branch | Depends on | Quality bars |
|---|---|---|---|---|
| 3 | **CJ Affiliate adapter** — GraphQL + REST hybrid. All 7 ops, fixtures, `docs/findings/cj.md` quirks doc. | `feature/network-cj` | 1, 2 (pattern source) | 4, 9, 10 |
| 4 | **Setup wizard** — `src/cli/setup.ts` interactive first-run, live `validateCredential` calls, `~/.affiliate-mcp/.env` writing, `derivedValues` handling, reset/add-network flows; `src/cli/test.ts` friendly diagnostic; `src/cli/doctor.ts` verbose diagnostic. Wizard end-to-end test against Awin + CJ. | `feature/setup-wizard` | 1, 2, 3 | 11 (first-run wizard), 12 (validation), 13 (reset), 14 (add-network), 15 (friendly test), 18 (config location) |

### Day 3 — Impact

| # | Chunk | Branch | Depends on | Quality bars |
|---|---|---|---|---|
| 5 | **Impact adapter** — defensive workarounds for known flakiness; tuned per-op resilience config; `docs/findings/impact.md`. Marked NOT a pattern source (PRD §9.3). | `feature/network-impact` | 1, 2 | 4, 5 (circuit breaker), 6 (retry), 7 (no retry on 4xx), 8 (rate limit) |

### Day 4 — Rakuten + report generator

| # | Chunk | Branch | Depends on | Quality bars |
|---|---|---|---|---|
| 6 | **Rakuten adapter** — full or partial depending on access; honestly documents access friction in `docs/findings/rakuten.md`. | `feature/network-rakuten` | 1, 2 | 4 |
| 7 | **Report generator + first README pass** — `scripts/generate-report.ts`, `scripts/generate-report-image.ts` (Playwright screenshot of comparison table), `scripts/generate-readme-table.ts`, first complete `REPORT.md`, initial `README.md` skeleton. | `feature/report-generator` | 1, 2, 3, 5, 6 | 22 (generator test) |

### Day 5 — Setup docs + skills

| # | Chunk | Branch | Depends on | Quality bars |
|---|---|---|---|---|
| 8 | **Per-network setup docs** — `docs/networks/{awin,cj,impact,rakuten}.md` with screenshots, time estimates, prerequisites, top-3 common failures (PRD §8.6). | `feature/setup-docs` | 2, 3, 5, 6 | 16 (setup doc completeness) |
| 9 | **Publisher skills (×4)** — `src/skills/audit-affiliate-links`, `affiliate-earnings-report`, `affiliate-network-status`, `affiliate-network-setup-help`. Each with `SKILL.md` + supporting scripts. Tool description final pass across all adapters. | `feature/publisher-skills` | 2, 3, 5, 6 | 17 (setup-help skill), 19 (tool descriptions), 21 (skill execution) |

### Day 6 — Polish + contribution infrastructure

| # | Chunk | Branch | Depends on | Quality bars |
|---|---|---|---|---|
| 10 | **Adapter polish + clean-room test** — verify principle 4.1 across every failure path on every adapter; fresh-install rehearsal; bad-key rehearsal; diagnostic rehearsal. | `feature/adapter-polish` | 2, 3, 5, 6 | 1 (fresh install), 2 (bad key), 3 (diagnostic) |
| 11 | **Contribution infrastructure** — `AGENTS.md`, `.claude/skills/contribute/SKILL.md`, enriched `templates/new-network/` with Claude-Code-readable TODO comments, comments in `src/networks/awin/` explaining *why* patterns exist (already shipped in chunk 2 but verified here), end-to-end Claude Code contribution test (PRD §14.5). | `feature/contribute-infra` | 2, 10 | 27 (AGENTS.md), 28 (skill executable), 29 (template self-doc), 30 (reference clarity), 31 (end-to-end contribution) |
| 12 | **README + governance docs** — final `README.md`, `CONTRIBUTING.md`, `CORRECTIONS.md`, `WANTED.md`, `CODE_OF_CONDUCT.md`, `LICENCE` (rename from MIT LICENSE, UK spelling), issue templates (7), PR templates (2), pre-filed 15-20 issues via gh, CODEOWNERS. | `feature/governance` | 7, 8, 9, 10 | 20 (README readability) |

### Day 7 — Launch prep

| # | Chunk | Branch | Depends on | Quality bars |
|---|---|---|---|---|
| 13 | **Demo recordings + registry submission** — three demo videos (wizard, setup-help, Claude Code adds a network), final README polish, comparison table image, MCP Registry submission, Smithery + Glama listings. | `feature/launch-prep` | All prior | — |

### Day 8 — Buffer

- Catch up on any failed quality bars
- Draft LinkedIn post
- Hold

### Tuesday following — Launch

## Current state

- ✅ Orchestration scaffolding (this doc + `handoffs/` directory)
- ⏳ **NEXT**: Chunk 1 — `feature/foundations`

## Handoff index

(Each entry links to `handoffs/<branch>.md` once the sub-agent completes.)

| Chunk | Branch | Status | Handoff |
|---|---|---|---|
| 1 | feature/foundations | pending | — |
| 2 | feature/network-awin | blocked on 1 | — |
| 3 | feature/network-cj | blocked on 1,2 | — |
| 4 | feature/setup-wizard | blocked on 1,2,3 | — |
| 5 | feature/network-impact | blocked on 1,2 | — |
| 6 | feature/network-rakuten | blocked on 1,2 | — |
| 7 | feature/report-generator | blocked on 1-6 | — |
| 8 | feature/setup-docs | blocked on 2,3,5,6 | — |
| 9 | feature/publisher-skills | blocked on 2,3,5,6 | — |
| 10 | feature/adapter-polish | blocked on 2,3,5,6 | — |
| 11 | feature/contribute-infra | blocked on 2,10 | — |
| 12 | feature/governance | blocked on 7,8,9,10 | — |
| 13 | feature/launch-prep | blocked on all | — |

## Parallelism opportunities

After chunk 2 (Awin reference) lands, chunks **3, 5, 6** (CJ, Impact, Rakuten) can run in parallel — they don't touch each other's directories. Setup wizard (chunk 4) needs at least Awin + CJ.

After all four adapters land, chunks **7, 8, 9, 10** can run in parallel.

The orchestrator will fan out as soon as dependencies are satisfied.
