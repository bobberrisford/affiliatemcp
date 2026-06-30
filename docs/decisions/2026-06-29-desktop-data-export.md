# Desktop data locker: pull, view, and export performance data locally

- **Date:** 2026-06-29
- **Status:** Proposed (decision pending)
- **Affects:** the desktop app scope boundary in
  `docs/decisions/2026-06-12-host-native-distribution.md`, the core facade public
  contract (`src/core/facade.ts`), the Phase 3 entry in
  `docs/product/desktop-app-plan.md`, and a new local-export behaviour.
- **Builds on:** `2026-06-12-host-native-distribution.md`, whose "no new product
  scope" line for the Electron app this record amends narrowly rather than
  restates.

## Context

The question is whether the desktop app should pull affiliate performance data,
let a user view and download it, while Claude continues to do the analytical
work: the synthesis, the narrative, the judgement.

This is a scope and contract decision, not a feasibility one. The data plumbing
already exists:

- Every adapter implements `getEarningsSummary`, `listTransactions`,
  `listClicks`, and advertiser-side `getProgrammePerformance`. They return typed,
  status-normalised shapes (`src/shared/types.ts`) and attach the verbatim
  upstream payload as `rawNetworkData`.
- An opt-in file cache (`src/shared/cache.ts`, `~/.affiliate-mcp/cache/`,
  TTL-driven) is shared with Claude's MCP server, because both read the same
  `~/.affiliate-mcp/.env`. A desktop locker reuses that store; it does not invent
  a second one.

Three things make this a decision the delivery protocol requires to be settled in
a record before any code:

1. It re-scopes a deliberately-downscoped component. The host-native
   distribution record demoted the Electron app to a compatibility fallback that
   "receives fixes but no new product scope", with host-native `.mcpb` and plugin
   bundles as the primary path.
2. It extends a shared contract. The desktop app's only sanctioned API is the
   core facade, which today exposes setup and credential operations only, no
   data-read operations. Adding them is new public surface on a client-neutral
   contract.
3. It introduces local-data-export semantics: writing affiliate data to a
   user-chosen file. No existing decision covers that.

The idea is already half-anticipated. Phase 3 of the desktop plan
(`docs/product/desktop-app-plan.md`) names a "your networks" health view, called
the "anti-dashboard", plus one-click local report export. The manifesto's hard
line is that this product is "not a dashboard". The constraint that Claude does
the analytical work is exactly what keeps an export surface on the right side of
that line.

## Decision

Allow the desktop app, after setup, to stay open and offer a read-only data
locker. Scope for this decision is view plus download and export only. The locker:

- lets the user pick configured network or networks, the side, and a date range,
  then pull `getEarningsSummary`, `listTransactions`, `listClicks`, and the
  advertiser-side `getProgrammePerformance`;
- renders plain rows, the same columns a CSV would carry, with no charts, no
  aggregation beyond what the typed shapes already hold, no scoring, and no
  narrative;
- exports the current view to CSV and JSON, to a user-chosen path, local only;
- offers a "continue in Claude" handoff for anything analytical, so the heavy
  lifting stays with Claude and the existing skills:
  `programme-performance-report`, `agency-portfolio-rollup`,
  `affiliate-earnings-report`, and `programme-anomaly-watch`.

The boundary, stated as a rule: the app surfaces and exports data; it does not
interpret it. Any feature that explains, ranks, forecasts, or advises belongs to
Claude, not the app shell. This is the line that keeps the locker an
anti-dashboard rather than a dashboard.

### Contract change: facade extension

Add read-only data operations to `src/core/facade.ts`, mirroring the existing
thin-wrapper pattern: lazy, no network at module load, structured-clone-safe
DTOs, and errors surfaced through a `NetworkErrorEnvelope` rather than faked into
success (PRD 4.1). The new functions, for example `getEarnings`,
`listTransactions`, `listClicks`, and `getProgrammePerformance` on the facade,
wrap the same adapter calls and the same `withCache` path the MCP tools layer
uses (`src/tools/generate.ts`). No domain logic is duplicated in the client,
which honours the thin-client rule. The change is additive: no existing facade
signature changes, and the public MCP tool contract is untouched.

### Privacy and local-first consequences

Affiliate data already lives on the user's machine. Export writes it to a
user-chosen local file, and nothing leaves the machine. Exported files are the
user's responsibility: they may contain brand or client names and transaction
detail. This introduces no new phone-home path and is orthogonal to the opt-in
issue-reporting record (`2026-06-11-issue-reporting.md`); the local-first promise
holds verbatim.

## Rejected alternatives

- **Do nothing; route everything through Claude.** Honours the current scope
  verbatim. But the setup-then-quit app gives non-technical users no tangible
  proof their data is flowing and no offline export. Recorded as the fallback if
  this scope amendment is not accepted.
- **Build a real dashboard in the app** (charts, filters, insights). Rejected: it
  contradicts the manifesto's "not a dashboard" line and duplicates Claude's
  analytical job inside a fallback client.
- **Add data export as MCP tools rather than a facade surface.** Rejected: it
  would expand the public MCP tool contract for a GUI concern. The facade is the
  correct client-neutral seam and keeps the tool surface stable.
- **Persist a separate desktop data store.** Rejected: reuse the existing shared
  cache. A second store invites drift and opens a new privacy surface.

## Consequences and implementation follow-ups

Keep all of these in draft until this record is accepted.

- PR 1, foundation: the additive read-only facade data operations with unit
  tests, no UI. This is a shared-contract change, so it takes an independent
  agent review plus green CI as the backstop, then Rob's deliberate acceptance.
  Do not request `@offmann`; Rob is the current maintainer decision owner.
- PR 2, vertical slice: the desktop lifecycle change to stay open after setup,
  plus one data screen, pick then pull then table, wired to the facade, for the
  four launch networks.
- PR 3, export and handoff: CSV and JSON export, and the "continue in Claude"
  affordance.
- Doc sync: once this record is accepted, amend the "no new product scope" line
  in `2026-06-12-host-native-distribution.md` to the narrow exception, in PR 1,
  so code and docs never disagree.

## Open questions for the maintainer

- **First networks.** Default to the launch four, Awin, Impact, Partnerize, and
  CJ, or a different set.
- **CLI parity.** Whether the same export is also offered from the CLI.
- **Licence gate.** Whether the locker sits behind the existing licence screen or
  stays free like the core tool.
