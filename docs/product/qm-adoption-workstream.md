# QM adoption workstream: what we take from yc-software/qm

- **Date:** 2026-08-01
- **Status:** Proposed workstream brief, awaiting Rob's acceptance of scope and
  ordering. No implementation has started.
- **Source:** review of `yc-software/qm` (multiplayer org-agent harness, MIT,
  read at commit `7f2c916`, 2026-07-31). This brief records only what survives
  contact with our accepted decisions; ideas qm validates but we already ship
  are listed at the end so nobody re-proposes them.

## User outcome

Operators get safer supply-chain defaults, report artefacts that look designed
rather than defaulted, scheduled daily awareness of their own book, a guided
first-run moment that proposes concrete routines, and, behind a decision,
per-client credential separation for agencies. Contributors and reviewers get
sharper review doctrine borrowed from a repo run the same maintainer-led,
agent-assisted way as this one.

## What we are NOT adopting, and why

- **The platform itself** (scopes, sandboxes, Postgres core, multi-surface).
  qm is a harness; we are tooling that lives inside harnesses. If anything, qm
  deployments are a future install target alongside Claude Desktop and Cowork.
- **Zero-comments policy.** Conflicts with our load-bearing "why" comments
  convention (PRD §15.30, the Awin reference).
- **Strategy revision history.** Decision
  `2026-06-12-client-strategy-recording.md` deliberately chose local living
  markdown; users who want history can version their config directory.
  Revisit only on agency demand.
- **CI test sharding, Node built-in test runner.** No current pain; noted for
  the day vitest wall clock becomes one.

## Already settled here, do not re-propose

- Honest credential allowlist and unconfigured-credential hints:
  `2026-06-30-unconfigured-credential-guidance.md`, implemented.
- Consent-link connection where the agent never sees the secret:
  `2026-07-15-hosted-connector-oauth.md`, accepted.
- Per-client advisory context: `2026-06-12-client-strategy-recording.md`,
  `2026-06-16-client-strategy-kpi-grammar-and-tools.md`, shipped with the
  `client-onboarding` skill.
- Schedule-driven background checking: `skills/programme-anomaly-watch` is
  already designed for host scheduling (weekly, agency-wide).
- Small tool surface, growth through skills: existing AGENTS.md rule; qm is
  independent evidence for it, nothing to change.

## Dependency graph

```
PR1 supply-chain hygiene ──► PR2 dead-code gate        (both routine, sequenced: both touch CI)
PR3 house-style rule in report skills                  (routine, disjoint from PR1/PR2)
PR4 review doctrine (governance)                        (risk lane, independent)
PR5 hosted known-limitations register (security docs)   (risk lane, after PR4 clears the lane)
PR6 decision: per-client credential profiles            (risk lane; BLOCKS any profile implementation)
PR7 first-run routine-proposal skill                    (routine, independent of PR6)
PR8 daily digest skill                                  (routine, after PR7 to avoid skill-catalogue churn)
```

The risk lane holds one PR at a time (PR4, then PR5, then PR6). Routine lanes
hold at most two concurrent PRs in disjoint domains. Current open PRs keep
their own lanes; this workstream queues behind them rather than displacing
them.

## The PRs

### PR1: supply-chain hygiene (chore)

qm ages new npm releases for 7 days before they may enter a lockfile
(`min-release-age=7` in `.npmrc`, npm >= 11.10) and pins every GitHub Action to
a full commit SHA. We do neither, and we ship publish, deploy, and desktop
release workflows with real secrets.

- **Owning domain:** repo build config and `.github/workflows/` (all 11
  workflow files).
- **Change:** add `.npmrc` with `min-release-age=7`; confirm or pin the npm
  version that honours it; pin every `uses:` to a full SHA with a trailing
  version comment; document the cooldown in `SECURITY.md`.
- **Acceptance proof:** full CI green on the branch; `npm ci` unaffected
  (installs from the committed lockfile); every workflow `uses:` resolves; no
  dependency versions change.
- **Risk gate:** none beyond normal review. Purely additive hardening.

### PR2: dead-code and unused-dependency gate (chore)

With 86 adapters, orphaned exports and stale devDependencies accumulate
silently. qm gates this with knip in CI.

- **Owning domain:** lint tooling and the main CI job.
- **Change:** add `knip` as a devDependency (justification: the one dependency
  buys repo-wide dead-export and unused-dependency detection), a `knip.json`
  tuned to our entry points (server, CLI, scripts, generators), a `lint:knip`
  script, and a CI step. First run will surface a backlog; fix what is safe,
  suppress the rest explicitly in config so the gate starts green and strict.
- **Acceptance proof:** `npm run lint:knip` green locally and in CI; any
  deleted code covered by an unchanged green test suite.
- **Risk gate:** sequenced after PR1 because both edit `ci.yml`. Dependency
  addition is named and justified per AGENTS.md.

### PR3: house style for report artefacts (docs/skills)

qm's rule: anything browsable should look designed, not defaulted; load the
house-style skill before building the UI. Our report-producing skills
(`programme-performance-report`, `publisher-performance-review`,
`agency-portfolio-rollup`, `affiliate-earnings-report`) do not reference
`design-system/` today.

- **Owning domain:** `skills/` prose only.
- **Change:** one shared instruction block in the affected skills: when the
  output is a rendered artefact (HTML report, card, page), apply the repo
  design system's tokens and reference `design-system/`; plain-text chat output
  is unaffected. Update `skills/README.md` with the convention.
- **Acceptance proof:** `git diff --name-only` shows skills Markdown only;
  skills structural tests pass.
- **Risk gate:** none; docs-only, no tool surface change.

### PR4: review doctrine (governance, risk lane)

Four sentences from qm's AGENTS.md that our review flow leaves implicit:

1. Never self-review in the authoring context; the context that produced a
   diff already believes it is correct, and a green CI run is not review.
2. Judge blast radius by callers, not by file count; a one-line edit to a
   `src/shared/` helper with many importers is not a small change.
3. The reviewer, not the author, has the last word on depth: a modest review
   that finds risk beyond its brief escalates on its own initiative.
4. Fix every instance, not just the reported one: grep the repo for the same
   pattern before closing a bug (with 86 adapters copying Awin patterns, this
   matters more here than it did there).

- **Owning domain:** `AGENTS.md`, `.claude/skills/review-pr/`,
  `.claude/skills/prepare-for-review/`, and their structural tests.
- **Acceptance proof:** skills structural tests pass; diff is governance prose
  only; no feature content rides along.
- **Risk gate:** governance change; Rob's deliberate acceptance required.
  Independent agent review as backstop per the standing rule.

### PR5: hosted known-limitations register (security docs, risk lane)

qm's SECURITY.md carries a blunt "known limitations" register ("command policy
is bypassable", "credentials are plaintext while in use", "audit supports
investigation, it does not prevent"). Our SECURITY.md and
`docs/security/overview.md` are honest but have no equivalent register for the
now-live hosted tier.

- **Owning domain:** `SECURITY.md` and `docs/security/overview.md` only. This
  documents the already-accepted custody contract
  (`2026-07-12-hosted-credential-custody.md`); it authorises nothing new.
- **Change:** a "Known limitations" section: plaintext-in-memory during hosted
  request handling, what operator or Cloudflare-account compromise means,
  bearer-session residual risk, browser-driven adapter brittleness and
  confinement limits, what audit does and does not guarantee.
- **Acceptance proof:** docs-only diff; each stated limitation traceable to
  shipped behaviour or an accepted decision, no aspirational controls.
- **Risk gate:** security-sensitive prose; risk-lane review by Rob.

### PR6: decision record, per-client credential profiles (risk lane, blocking)

The one genuine architecture gap qm exposes. Strategy and KPIs are per-client
today, but credentials are a single set per network in one `.env`. An agency
managing two advertisers on the same network cannot separate them, and the
hosted tier will eventually need the same boundary per tenant client.

- **Owning domain:** a decision record,
  `docs/decisions/2026-08-XX-per-client-credential-profiles.md`. Touches the
  STABLE `src/shared/config.ts` contract, so the decision comes first, per
  AGENTS.md.
- **Contents:** context (agency cohort, hosted boundary), the direction
  (named credential profiles layered over the existing env schema, default
  profile preserving today's behaviour), rejected alternatives (one config dir
  per client via `AFFILIATE_MCP_CONFIG_DIR`, which already half-works and must
  be evaluated honestly as the do-nothing option), consequences, and
  implementation follow-ups.
- **Acceptance proof:** the record merges with Rob's explicit acceptance.
- **Stop condition:** until this merges, no production implementation, no
  foundation PRs, no changes to `src/shared/config.ts`. Discovery and
  disposable prototypes only.

### PR7: first-run routine-proposal skill (routine)

qm's onboarding connects accounts, reads a light snapshot of real work,
proposes concrete automations, and persists a profile. Our setup wizard proves
credentials work; nothing then proposes what to do with them.

- **Owning domain:** one new skill, `skills/` only, composing existing tools
  (`affiliate_list_networks`, `affiliate_run_diagnostic`, adapter reads,
  `affiliate_set_client_strategy`); no new tool surface.
- **Change:** after setup verifies, the skill snapshots the account (networks,
  sides, recent activity, anything pending or unpaid), proposes which shipped
  skills fit and on what schedule (anomaly watch weekly, digest daily, unpaid
  commission check monthly), and offers to record the strategy via the
  existing `client-onboarding` flow. It must follow the settled honesty rules:
  never advertise a network or capability that is not configured.
- **Acceptance proof:** skills structural tests; a scripted dry run against
  fixture-backed adapters showing the proposal output; docs cross-link from
  the setup walkthroughs.
- **Risk gate:** none beyond normal review; it composes existing contracts.

### PR8: daily digest skill (routine)

qm ships `morning-digest` as its flagship seed skill: one message answering
"what changed since yesterday?", with an explicit rule that if nothing changed
it says so and stops. Our `programme-anomaly-watch` is weekly and
agency-shaped; there is no daily, single-operator "what changed" skill.

- **Owning domain:** one new skill, `skills/` only.
- **Change:** a daily digest over the operator's configured networks:
  yesterday's transactions and earnings movement, status changes, anything
  newly pending or reversed; one short message; an honest "nothing changed"
  path; written explicitly for host scheduling like anomaly-watch. The skill
  states its overlap with `programme-anomaly-watch` (daily operator digest
  versus weekly agency anomaly scan) and cross-references it.
- **Acceptance proof:** skills structural tests; fixture-backed dry run;
  sequenced after PR7 so the two new skills land coherently in the catalogue
  and README table.
- **Risk gate:** none; existing tools only.

## Follow-ups recorded, not built

- **Hosted budget ceilings and tighten-only posture.** qm gives orgs USD
  budgets per window and a security posture narrower scopes may only tighten.
  Relevant to hosted per-key spend and rate ceilings; add one line to
  `docs/product/hosted-mvp-workstream.md` follow-ups when PR5 lands, build
  nothing without its own decision.
- **Skill packs as an extension point.** qm imports skill packs from git so
  orgs customise without forking core. The affiliate analogue (an agency's own
  skill pack layered over ours) is direction, not work; note in
  `docs/product/roadmap.md` when convenient.
- **Text-first contribution lane.** qm accepts external contributions as
  human-written prose and the maintainers implement. Our CONTRIBUTING ladder
  already ends with "file an issue describing what you want to do", and
  adapter code PRs from network employees are a cohort we want. Recommendation:
  do not adopt; the delta over our existing issue path is not worth a
  contributor-contract change. Rob may overrule.

## Stop conditions

- PR6 unaccepted blocks any credential-profile implementation.
- Nothing in this workstream touches hosted custody surfaces beyond the PR5
  documentation of what already shipped.
- Governance prose (PR4) never rides a feature PR, and vice versa.
- Each PR stays docs-only or code-only as declared; a PR that needs both
  splits.
- If Rob rejects a wave, the later waves that do not depend on it proceed
  unchanged; only PR2 (after PR1), PR5 ordering, and PR6-gated work resequence.
