# Client-strategy KPI grammar and the read/write tool surface

- **Date:** 2026-06-16
- **Status:** Accepted (2026-06-17)
- **Affects:** `KPI.md` authoring grammar; a new client-strategy meta-tool surface
  in [`src/tools/generate.ts`](../../src/tools/generate.ts); the future
  client-onboarding skill and the reader skills wired in the parent decision's
  follow-ups
- **Depends on:** the accepted
  [client-strategy recording decision](./2026-06-12-client-strategy-recording.md),
  which reserved both of these as implementation follow-ups; the brand registry in
  [`src/shared/brands.ts`](../../src/shared/brands.ts), whose slug remains the
  client key

## Context

The accepted client-strategy decision settled that each client's strategy and KPIs
live as local markdown under `$AFFILIATE_MCP_CONFIG_DIR/clients/<slug>/`, that the
files are advisory and never authority, and that `KPI.md` needs "a light parseable
convention" whose exact grammar was deferred. It also said the relevant contents
are "supplied to the connected AI client under the same data flow as other MCP
results" but did not name the surface that does so.

Two follow-ups cannot be built until those two points are fixed:

1. **Follow-up 1 (KPI grammar).** Reader skills must turn a target into a verdict
   reliably, which means the targets have to parse the same way every time. The
   parent decision required one target per line naming a metric, a comparator or
   direction, a value, and a period, but left the surrounding syntax open
   (frontmatter, a structured block, or another small convention).
2. **Follow-up 2/4 (the read/write surface).** Skills run across Claude Desktop,
   Claude Code, Codex, Cursor, and other MCP clients. Claude Desktop and most
   hosted clients **cannot read arbitrary local files**; they only see MCP tool
   results. A skill that read `clients/<slug>/KPI.md` from disk directly would work
   in Claude Code and fail silently in Desktop. `AGENTS.md` requires
   provider-neutral domain behaviour to live in the shared core and MCP layers,
   with clients kept thin.

This decision fixes both so the dependent PRs can proceed.

## Decision

### 1. `KPI.md` uses a single fenced `kpi` block

`KPI.md` is free prose plus exactly one fenced code block tagged `kpi`. Everything
the reader parses lives in that block; prose outside it is for the human and is
ignored by the parser.

````
```kpi
# targets: metric: comparator value [unit] [per period]
version: 1
revenue: >= 400000 GBP per quarter
conversions: >= 1200 per month
epc: >= 0.45 GBP
aov: >= 65 GBP
reversal_rate: <= 8% per month
approval_rate: >= 90% per month
```
````

- Line shape: `metric: comparator value [unit] [per period]`.
- `version: 1` is required as the first non-comment line; its absence is a parse
  error for the whole block.
- `metric` is drawn from a known, versioned enum: `revenue`, `conversions`,
  `commission`, `epc`, `aov`, `reversal_rate`, `approval_rate`. An unknown metric
  is a parse error for that line, never a guess.
- `comparator` is one of `>=`, `<=`, `>`, `<`, `=`.
- `unit` is optional: an ISO-like currency code (for monetary metrics) or `%` (for
  rate metrics).
- `period` is optional: `per` followed by `day`, `week`, `month`, `quarter`, or
  `year`.
- Lines beginning `#` are comments. Blank lines are ignored.
- Malformed lines and unknown metrics are reported as parse errors and excluded
  from verdicts. The reader must never silently drop a target, never guess a
  meaning, and never zero-fill a metric it could not parse. This is the
  honest-network-truth rule from the parent decision applied to the local file.

The onboarding skill emits this block so operators never type it by hand, and the
auto-written comment header documents the shape for anyone who opens the file
directly.

### 2. A client-strategy meta-tool surface, not direct file reads

Reading and writing these files happens through three new meta-tools alongside the
existing `affiliate_resolve_brand`, defined in `generateMetaTools()` and wired
through `generateAllTools()`:

- `affiliate_get_client_strategy({ brand })` returns
  `{ brand, orphan, strategy: { present, markdown }, kpi: { present, version, targets, parseErrors } }`.
  It returns already-parsed targets so a skill never parses markdown itself, and so
  the same parse-error reporting applies on every client.
- `affiliate_set_client_strategy({ brand, strategyMarkdown?, kpiMarkdown? })`
  validates `kpiMarkdown` with the shared parser. If parsing yields errors it
  returns them and writes nothing; otherwise it writes atomically following the
  `brands.ts` conventions. The tool is a persister with validation; the
  confirm-before-write step lives in the onboarding skill and caller flow, not
  in the storage helper. Its tool description must state plainly that it writes
  local client-strategy files, so MCP hosts can present it as a side-effecting
  local-configuration tool rather than a read.
- `affiliate_list_client_strategies()` returns which registered brands have
  strategy recorded, which drives the gap prompt and the portfolio rollup.

These are local-configuration writes, equivalent to the setup wizard writing
`brands.json`. They are **not** network writes and are out of scope of the accepted
[action-authority decision](./2026-06-12-action-authority-layer.md), which governs
writes to affiliate networks. The strategy and KPI files remain advisory and never
authorise a network write.

This is the smallest surface that keeps the behaviour provider-neutral: every MCP
client gets identical access, and no skill assumes a filesystem it may not have.

## Positions on the open points

1. **Fenced block over frontmatter or a typed schema.** A fenced block is visually
   contained, survives copy-paste into chat, and keeps the rest of `KPI.md` free for
   human notes. Frontmatter competes with any other markdown tooling that reads the
   file head; a typed JSON/YAML schema was already rejected by the parent decision
   for authoring friction.
2. **Versioned grammar.** The `version: 1` marker lets the grammar evolve without
   ambiguity, mirroring `brands.json`'s `version: 1`.
3. **Tool surface owns validation; skill owns consent.** Keeping validation in the
   tool means malformed targets cannot be persisted from any client. Keeping the
   confirm step before tool invocation keeps the human in control of what gets
   written while avoiding a second, prompt-shaped consent protocol inside the
   storage helper.

## Rejected alternatives

- **Direct filesystem reads from the skill.** Works only on clients with file
  access; fails silently on Claude Desktop and breaks the thin-client rule.
- **Overloading `affiliate_resolve_brand`.** That tool answers "which networks is
  this brand bound to"; strategy is a separate concern with its own present/absent
  and parse-error states. Conflating them muddies both contracts.
- **YAML or TOML frontmatter for KPIs.** More capable than needed, and the parent
  decision already ruled out a typed schema for the same authoring-friction reason.
- **A write tool that skips validation.** Would let any client persist unparseable
  targets that later fail to read, hiding the error far from where it was made.

## Consequences

- The dependent PRs can proceed: the storage helper implements this grammar, the
  meta-tools expose this surface, the onboarding skill emits the block, and the
  reader skills consume parsed targets with consistent parse-error reporting.
- The public MCP tool list gains three meta-tools. Downstream clients that
  enumerate tools will see them; their names and result shapes are part of the
  public contract from the moment they ship.
- Nothing changes at runtime until the storage helper and tools land; this record
  is direction only.

## Implementation follow-ups

- Storage helper and parser in `src/shared/client-strategy.ts` with tests
  (parent follow-up 2).
- The three meta-tools in `src/tools/generate.ts` with tests.
- The onboarding skill and the reader-skill wiring (parent follow-ups 3 and 4)
  consume this grammar and surface.
