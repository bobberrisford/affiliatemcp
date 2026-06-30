# Brand Data Layer: a canonical, persisted, time-windowed brand dataset

- **Date:** 2026-06-30
- **Status:** Proposed (decision pending)
- **Affects:** a new `src/brand-data/` feature module, three new meta-tools
  registered in `src/tools/generate.ts` and `src/server.ts`, a new local store
  subtree under `~/.affiliate-mcp/`, and the four existing reporting skills, which
  become consumers.
- **Builds on:** `2026-06-30-paid-tier-entitlement-gate.md` (the gate for the
  paid tools below), `2026-06-12-client-strategy-recording.md` and
  `2026-06-16-client-strategy-kpi-grammar-and-tools.md` (advisory strategy/KPI the
  action bundle reuses), `2026-06-18-action-capability-map.md` (the readiness
  slice the action bundle reuses), `2026-06-12-adapter-result-caching.md` (the
  pull layer caches through it), and `2026-06-29-desktop-data-export.md` (the
  facade export surface; this record is the Claude-native sibling, not a
  replacement).

## Context

The feature pulls one brand's affiliate performance from up to five launch
networks, normalises it into one canonical, time-windowed, brand-scoped dataset,
renders it as interactive pivotable tables (free), and powers CSV export plus two
AI deliverables (QBR, weekly report) behind the entitlement gate. The interface
is Claude-native: an artifact plus the MCP. There is no scheduler and no web or
desktop front end.

Most of the analytical work already exists and must not be rebuilt:

- **Status is already canonicalised at the adapter layer.** Every adapter maps
  its native taxonomy to `TransactionStatus = 'pending' | 'approved' | 'reversed'
  | 'paid' | 'other'` in its own `mapTransactionStatus`; adapters also own
  naive-to-UTC timezone conversion via `NetworkMeta.networkTimezone`. The brand
  layer projects and buckets; it never re-maps status or re-converts timezones.
- **Brand is already a multi-network object.** `~/.affiliate-mcp/brands.json`
  maps one logical brand to many `{network, credentialId, networkBrandId}`
  bindings, resolved through `buildAdapterCallContext`.
- **Cross-network aggregation, EPC/AOV, status splits, period windows, the no-FX
  currency rule, and the QBR and weekly-report shapes already ship** in
  `programme-performance-report` (QBR and weekly are cadence profiles of it),
  `agency-portfolio-rollup`, `programme-anomaly-watch`, and
  `affiliate-earnings-report`. These compute live and discard.

What is genuinely new, and what this record covers: a **persisted** snapshot plus
week-over-week history, a **side-agnostic canonical dataset** as a derived shape,
pivot tables, CSV export, the AI-action input bundle, and the partial-failure
health contract. This crosses network semantics and adds new public MCP tools, so
the delivery protocol requires it settled in a record before code.

## Decision

### A new feature module, with the shared contract frozen

The canonical brand-data shapes live in a new `src/brand-data/` directory, not in
`src/shared/types.ts`. `src/shared/types.ts` is the *adapter* contract that 80+
adapters implement; the brand-data row is a *derived* shape produced by a
normaliser that consumes the existing `Transaction[]` and
`ProgrammePerformanceRow[]`. No field is added to `Transaction`,
`ProgrammePerformanceRow`, `EarningsSummary`, or `TransactionStatus`.

Module files: `model.ts` (derived types), `normalise.ts`, `windows.ts`,
`metrics.ts`, `rows-cap.ts` (all pure), `pull.ts` (the only adapter-touching
file, caching through the existing `withCache`), `snapshot.ts` (orchestrator),
`store.ts` (the local store), `entitlement.ts` (the stub from the companion
record), and `csv.ts`.

### Status projection (load-bearing)

The brief's three-way commission split is a **presentation projection of the
canonical five-state enum, not a type change**:

| Canonical | Brand-data bucket |
|---|---|
| `pending` | pending |
| `approved` | confirmed |
| `reversed` | declined |
| `paid` | confirmed (settled) |
| `other` | residual — surfaced, never dropped, never miscounted as one of the three |

"Total tracked" commission = pending + confirmed (which includes paid). Declined
never enters totals. The `other` residual is shown in the snapshot health block
exactly as an unavailable network is, so the dataset never silently collapses
five states into three. This is the status-level analogue of the partial-failure
rule below.

### Side-agnostic shape, advertiser side first

The canonical dataset is side-agnostic: both publisher and advertiser data map
into `BrandTxnRow` and `BrandClicksRow`. v1 wires the **advertiser/brand side
first**, with Awin as the reference network, because that matches the existing
brand skills and the client-ready QBR framing. Clicks and conversions come from
`ProgrammePerformanceRow` (which carries counts); the publisher-side `Click` type
is individual events with no count and is not the clicks source. The publisher
side maps into the same shape in later work without changing the contract.

### Time windows and currency

Four windows — yesterday, rolling 7d, rolling 30d, YTD — bucketed by `eventDate`
(`dateConverted` for transactions, `date` for clicks rows) in one canonical brand
timezone, default `Europe/London`, midnight-to-midnight. Minor day-boundary bleed
from networks reporting in their own zone is footnoted, not engineered away. No
live FX in v1: program tables stay in native currency; only a cross-network
roll-up total may convert, using a fixed rate stored in brand config, with a
visible "converted to {ccy} at {rate}, {date}" note. `reportingCurrency` and an
optional `fxRates` go into brand config now regardless.

### Hybrid storage

The MCP-local store is the source of truth:
`~/.affiliate-mcp/brand-data/<slug>/{snapshot.json, rows-30d.jsonl,
history.jsonl}`, atomic temp-and-rename at 0600, directories at 0700, read fresh,
honouring `AFFILIATE_MCP_CONFIG_DIR`, mirroring the `client-strategy.ts` idiom.
The Claude artifact caches the latest snapshot in its own persistent storage
(`window.claude`, 5MB/key) for fast render and offline view only; it is never the
source of truth. `rows-30d.jsonl` is capped at ~10,000 rows; on overflow it
collapses to per-`(date, publisher, currency, statusBucket)` aggregates and the
snapshot carries `rowsTruncated: true` (coarser pivot, survives).

### Three new meta-tools, all gated

Registered the existing way (`META_TOOL_OPERATIONS` + `generateMetaTools`):

- `affiliate_build_brand_snapshot` — pull, normalise, bucket, compute, persist,
  return the `BrandSnapshot` (four windows x per-currency metrics, count-honest
  `byNetwork` health, `rowsTruncated`, `generatedAt`, `schemaVersion`).
- `affiliate_get_brand_rows` — CSV-grade rows from the store, `format: rows | csv`.
- `affiliate_get_brand_action_bundle` — the AI-action input contract: snapshot +
  recorded strategy/KPI (reusing `loadClientStrategy`) + the brand's action-map
  readiness slice (reusing `collectActionDescriptors` / `computeReadiness`) +
  entitlement state. It never receives the raw 30-day rows.

All three are gated by the companion record's entitlement check. Tables read the
snapshot and rows; the snapshot JSON is identical to the AI actions' input, so
the free and paid surfaces cannot drift.

### Partial-failure health (non-negotiable)

Any network pull can partly fail. `snapshot.byNetwork` carries one entry per
*bound* network, never per *successful* network, with state `ok | degraded |
failed` and the verbatim `NetworkErrorEnvelope` when failed. Totals state which
networks they exclude ("CJ unavailable — totals exclude CJ"). A four-of-five pull
is never presented as five. A wrong number in a QBR is a client-trust incident;
partial-but-honest beats complete-but-wrong.

### Decisions D1–D5 from the brief, as accepted defaults

D1 total-tracked EPC headline, confirmed EPC secondary. D2 declined excluded from
conversions, shown separately. D3 ~10k row cap then aggregate fallback. D4 single
reporting currency assumed, fixed-rate roll-up only if mixed, no live FX. D5
sub-id cut from v1 (captured on the row if cheap, never a pivot).

## Workstream brief

- **User outcome.** A brand operator sees one brand's performance across up to
  five networks, normalised and time-windowed, as free pivotable tables, and can
  export CSV and generate a QBR or weekly report on the paid tier — without
  bouncing between network dashboards.
- **Owning domains.** Brand-data module (new); MCP tool/server surface (additive);
  the four reporting skills (rewired as consumers); the gate (companion record).
- **Dependency graph.** 0a (gate decision) and 0b (this) -> PR-1 foundation ->
  PR-2 Awin consumer -> {PR-3 fan-out, PR-5 action bundle, PR-6 reconciliation
  harness} -> PR-4 CSV+gate (needs 0a merged) -> PR-7 tables + skill rewire.
- **Risk gates.** PR-2 and PR-4 are `active-risk` (new public tool / payment
  surface) and never sit review-ready at the same time. PR-1, PR-3, PR-5, PR-6,
  PR-7 are routine.
- **Acceptance proof per PR.** PR-1: `npm test` green over pure-function fixtures.
  PR-2: a live Awin snapshot persists and the reconciliation script PASSes
  against the Awin dashboard. PR-3: a forced single-network failure yields N
  health entries, never N−1, and each promoted network reconciles. PR-4:
  unentitled call returns `entitlement_required`, CSV round-trips, deny is
  audited. PR-5: the bundle returns all sections plus entitlement. PR-6: the
  script runs against at least two networks. PR-7: skills produce identical
  numbers via the new tool with no aggregation rebuilt.
- **Stop conditions.** No code (PR-1+) until both 0a and 0b merge. No network
  promoted in PR-3 until its reconciliation PASSes. No payment or licence
  verification logic anywhere — `isEntitled` stays a stub. No new fields on the
  frozen shared types. No aggregation re-implemented in skills once the tool
  exists.

## Rejected alternatives

- **Add the canonical row to `src/shared/types.ts`.** Rejected: that is the
  adapter contract, frozen; the brand-data row is derived and belongs in the
  feature module.
- **Re-add `confirmed`/`declined` to `TransactionStatus`.** Rejected: it would
  churn the contract for 80+ adapters to serve one consumer's vocabulary. The
  split is a projection.
- **Rebuild aggregation inside the new module.** Rejected: EPC/AOV/status-split/
  window logic already lives in the skills; the module factors out only the
  snapshot primitive and the skills become consumers.
- **Make the Claude artifact the source of truth.** Rejected: it is
  client-specific and per-artifact; the local store survives across sessions and
  clients. The artifact caches, it does not own.
- **A second data store separate from the existing cache conventions.** Rejected:
  reuse the established local-store idiom and the opt-in result cache; a parallel
  store invites drift.

## Consequences and implementation follow-ups

Keep all dependent PRs in draft until both decision records are accepted. The PR
sequence is PR-1 through PR-7 as in the workstream brief above. After this record
merges, retarget the foundation PR to `main`, and land in dependency order with
at most one `active-risk` PR review-ready at a time.

## Open questions for the maintainer

- **First networks for PR-3 fan-out.** The launch five are Awin, CJ, Impact,
  Rakuten, Partnerize; confirm the order and whether all five are in scope before
  any sixth.
- **Brand timezone default.** `Europe/London` is assumed; confirm or set per
  brand in config.
- **Free-tier scope.** Whether tables stay fully free or carry any ceiling
  (handled jointly with the companion record's open question).
