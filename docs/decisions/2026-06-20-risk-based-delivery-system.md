# Risk-based delivery concurrency and agent autonomy

- **Date:** 2026-06-20
- **Status:** Proposed, requires Othman and Rob's acceptance
- **Affects:** `AGENTS.md`, the repo-local delivery and review skills, pull
  request sequencing, reviewer workload, and future repository controls
- **Depends on:** the existing agent-native workflow introduced by PRs #153,
  #165, #166, and refined by #198

## Context and evidence

The current system is coherent and has prevented unsafe merges. `AGENTS.md`
owns durable repository invariants and human decision ownership;
`delivery-steward` owns an outcome across the portfolio;
`prepare-for-review` owns readiness and handoff; and `review-pr` owns
independent review. `.claude/skills/` is canonical and `.agents/skills/`
exposes the three shared skills through tested relative symlinks.

Recent work shows both the strength and the remaining gap:

- PRs #217-#223 used a decision, foundation, tools, skills, and lifecycle
  sequence to land a multi-PR client-strategy feature. The slices were small
  enough to review independently and merged in dependency order.
- PR #231 was reviewed, materially narrowed, accepted, and merged. The gate
  worked: incompatible PRs #233 and #234 did not land.
- However, #233 and #234 had already implemented a canonical-read catalogue
  and framework that accepted #231 explicitly rejected. Keeping dependent PRs
  draft controlled merge state, but did not control speculative build cost.
- PRs #153, #165, #166, and #198 are repository-authored practice. Their PR
  descriptions and history do not claim an external process framework as
  provenance. The external sources below are benchmarks for this proposal,
  not invented origins of the current skills.

The current one-active-review rule is a useful reviewer WIP limit, but it
conflates Othman's scarce risk-review lane with all delivery. DORA recommends
small batches and limiting work in process; short-lived branch practice also
favours rapid integration. Neither implies serialising unrelated, low-risk
work behind a single reviewer lane.

## Proposed decision

Replace “one active PR” with a risk-based delivery board. Keep one active
human/risk-review lane for Othman, while allowing bounded autonomous lanes for
decision-complete, low-risk work. Draft exploration is not a licence to build
against an unresolved contract.

### Concurrency model

Every PR has one state (`exploration`, `blocked-decision`, `queued-risk`,
`active-risk`, `autonomous`, `merge-queued`, or `close-candidate`), explicit
dependencies, and affected risk domains.

1. **Human/risk lane: WIP 1.** Only one review-ready PR may await Othman's
   architecture/security/public-contract review. Decision and foundation PRs
   that unblock a workstream take priority.
2. **Autonomous lanes: WIP 2 initially.** At most two unrelated, low-risk PRs
   may be advanced concurrently. They must touch disjoint ownership domains,
   have no unresolved decision, preserve public contracts, and be independently
   green. A maintainer may merge them under the autonomy ladder below.
3. **Draft exploration: unbounded only in discovery, bounded in code.** Notes,
   spikes, interface sketches, and disposable tests may proceed in parallel.
   Production implementation must not begin beyond an unresolved decision or
   public-contract gate. A prototype that crosses the gate must be labelled
   disposable and cannot become a merge candidate without re-authorisation.
4. **Conflict detection.** PRs conflict when they touch the same owning module,
   public contract, decision, migration, generated authority, release surface,
   or customer journey. File overlap is a signal, not the definition. Conflicts
   share a lane and merge order even when Git reports a clean merge.
5. **Ordering.** Merge decision, then foundation, then vertical implementation
   slices, then integration/docs that could not stay with a slice. After each
   merge, retarget the next stacked PR to `main`, refresh once, rerun its proof,
   and re-check the complete resulting diff. Do not continually merge `main`
   into every queued branch.

### Bigger-feature protocol

Create one short workstream brief before branches multiply. It names the user
outcome, owner, accepted decisions, risk domains, acceptance proof, dependency
graph, and stop conditions. Each node must be independently coherent.

Use this sequence:

1. **Decision PR:** settle architecture, security, public contracts, writes,
   cross-client behaviour, and rejected alternatives. No production code.
2. **Foundation PR:** after acceptance, add the smallest shared contract or
   infrastructure with executable proof. Avoid a framework without a concrete
   first consumer.
3. **Stacked implementation drafts:** branch from the immediate dependency only
   when the parent boundary is accepted. Each PR has its own acceptance criteria
   and demonstrates one vertical customer-visible or operable increment.
4. **Integration proof:** the final functional slice proves the composed path,
   failure behaviour, docs, and rollback. Tests and directly related docs stay
   with the slice they validate.
5. **Retargeting:** after a parent merges, retarget its child to `main`, update
   once, validate the resulting diff, then promote it to the appropriate lane.

Decision PRs are human-merged. High-risk foundations and public contracts are
human-merged. Low-risk implementation layers may be maintainer- or agent-merged
only at the approved autonomy level. The #233/#234 failure is prevented by the
hard rule: a draft may express a dependency, but unresolved decision nodes
permit discovery only, not production implementation.

### Autonomy ladder

| Level | Scope and merge permission | Evidence and controls |
| --- | --- | --- |
| 0. Human-led | Humans direct implementation and merge everything. | Normal CI and review. |
| 1. Agent-prepared | Agents implement, repair, and recommend; a human approves every merge. | Current default, complete diff review, green required checks. |
| 2. Bounded autonomous | Agents or the maintainer may merge allowlisted low-risk PRs; humans merge decisions, contracts, security/privacy, writes, releases, dependencies, migrations, and cross-client changes. | Two independent agent reviews or one agent review plus deterministic checks; rollback identified; post-merge `main` verified. |
| 3. Policy autonomous | Auto-merge low-risk allowlisted paths after required checks and CODEOWNER policy; exceptions route to humans. | Protected branch, required checks, measured false-negative/rollback rate, audit trail, kill switch. |
| 4. Near-autonomous | Agents sequence and merge most reversible work; humans set policy and decide high-impact exceptions. | Sustained Level 3 evidence, production monitoring, tested rollback, incident learning. |

Adopt **Level 1 now**, with a Level 2 pilot limited to docs, tests, fixtures,
and isolated bug fixes that do not alter runtime/public behaviour. Move up only
after at least 20 pilot merges with: 100% required-check success, no rollback or
escaped material defect, no premature implementation, accurate risk labels,
and a declining human-correction rate. Any escaped contract/security/privacy
defect immediately suspends that allowlist.

### Chief-of-Staff loop

Maintain a checkpoint containing last inspection time plus PR/issue update
timestamps. Run on a twice-daily cadence during active delivery and on triggers:
PR opened/ready, review submitted, checks completed, merge, conflict, or seven
days without movement. Do not create an automation until the humans accept the
notification and authority boundaries.

For each run:

1. Query only open items changed since the checkpoint and newly merged/closed
   items needed to update dependencies.
2. Read PR metadata, checks, dependency fields, and the latest worker final
   report first. Read earlier turns, raw logs, or full diffs only for a material
   gap or changed risk.
3. Classify active, queued, blocked, autonomous, and close-candidate; detect
   domain conflicts and invalid build-ahead.
4. Delegate focused workers for CI diagnosis, review, branch refresh, or a
   scoped correction. Workers return outcome, proof, residual risk, and next
   action, not raw logs.
5. Report only decisions needed, merges, blockers/risks, close candidates, and
   the next promoted item. Emit nothing when state is unchanged and no action
   is due.

### Instruction and DRY architecture

DRY concerns duplicated knowledge, not all repeated words. Safety reminders
may intentionally repeat at the point of action, but their definition must have
one owner.

- **`AGENTS.md`, canonical policy:** project invariants, ownership and human
  gates, risk taxonomy, concurrency limits, merge authority, dependency rule,
  canonical source/symlink layout, and validation commands.
- **`delivery-steward`, orchestration:** frame one outcome, build/repair it,
  classify portfolio state, apply dependency ordering, and invoke specialist
  skills. Refer to policy; do not redefine risk categories or merge authority.
- **`prepare-for-review`, producer handoff:** inspect, validate, write the brief,
  and change PR/reviewer state. It may repeat a compact “stop if unresolved
  decision/failed check” guardrail, explicitly labelled as enforcement of
  `AGENTS.md`.
- **`review-pr`, independent consumer:** risk-ordered review, finding severity,
  re-review, and scoped repair when asked. It should consume the canonical risk
  taxonomy rather than restating ownership or queue policy.
- **PR templates:** collect evidence and decisions; do not become a fourth
  prose copy of policy.
- **Deterministic checks/settings:** enforce mechanical facts only. Human or
  agent review handles semantic coherence and domain conflict.

Today, outcome framing, escalation categories, decision readiness, CI
ownership, coherent-diff requirements, and merge gates are repeated across
`AGENTS.md`, `delivery-steward`, and `prepare-for-review`. The wording is mostly
consistent, so repetition currently reinforces safety, but it has drift risk.
After this decision is accepted, retain short action-local stop rules and
replace the duplicated definitions with links to named `AGENTS.md` sections.

### Repository controls

Apply these only after confirming the repository plan supports them and the
humans accept the authority model:

1. Protect `main`; require the existing CI jobs and require branches to be
   current through a merge queue if review volume justifies it.
2. Allow squash merge only, matching documented practice.
3. Turn on automatic branch deletion after merge unless preserving a branch is
   explicitly required.
4. Extend CODEOWNERS only for real ownership boundaries. Require Othman for
   shared/public/security paths and Rob for affiliate-domain/product paths;
   avoid ownership rules on every documentation file.
5. Enable auto-merge for approved Level 2 PRs after required checks. A merge
   queue is useful when concurrent ready PRs regularly invalidate each other;
   with today's volume, branch protection and required checks come first.
6. Use protected environments only for release/deployment jobs with secrets or
   irreversible external effects. Applying environments to ordinary tests is
   bureaucracy.

Current API inspection found no visible `main` protection, auto-merge disabled,
all three merge methods enabled, and branch deletion disabled. These settings
do not match the documented squash-first, green-before-merge contract.

### Measures and review cadence

Review a rolling 20 merged/closed PR window monthly:

- median and 90th-percentile ready-to-first-review latency;
- median time from first CI run to green;
- blocker-driven rework commits and changed lines after review;
- premature implementation count and discarded implementation hours/PRs;
- drafts stale for more than seven days;
- escaped material defects and rollbacks within seven days of merge;
- percentage of PRs needing human intervention after entering an autonomous
  lane; and
- autonomous merge success: green, no rollback, no material follow-up within
  seven days.

Metrics are diagnostic, not targets. Pair latency with escaped defects and
rework so speed does not hide quality loss. Confidence to expand autopilot
comes from repeated correct risk classification, low review correction, clean
rollback, reliable checks, and uneventful post-merge operation.

## Consequences

- Othman's scarce attention stays serialised where judgment is required, not
  across all safe delivery.
- Rob and Claude can continue quickly on accepted, disjoint slices while a
  decision is reviewed, but cannot build production foundations past it.
- The skill set remains three focused delivery/review skills rather than adding
  another coordinator skill.
- The Chief-of-Staff becomes event- and delta-driven, reducing noise and token
  use while preserving human visibility.
- Level 2 requires a separately accepted merge-authority change; this proposal
  does not grant it.

## Operational fragment for Rob and Claude

> Before coding, create or update the workstream brief: user outcome,
> dependency graph, owning domains, risk gates, and acceptance proof per PR.
> If any architecture, security, privacy, write, public-contract, or
> cross-client decision is unresolved, open the decision PR first and do only
> explicitly disposable exploration behind it. Do not implement production
> foundations or child PRs yet. After acceptance, build the smallest concrete
> foundation with its first consumer, then stack coherent drafts in dependency
> order. Keep tests and directly related docs with each slice. After each
> parent merges, retarget the child to `main`, refresh once, rerun proof, inspect
> the resulting diff, and promote only if its lane and risk gate are clear.

## Provenance and future refinement

Record changes to this system as proposed/accepted decision records. Each
refinement must name the observed PRs/incidents/metrics, the rule being changed,
the expected effect, and a review date. Skill commits and PR bodies should link
the accepted decision they implement. Keep external references in the decision
record as evidence, never as implied authorship of repository practice.

External benchmarks:

- [DORA: working in small batches](https://dora.dev/capabilities/working-in-small-batches/)
  and [work in process limits](https://dora.dev/capabilities/wip-limits/)
- [Trunk Based Development: short-lived feature branches](https://trunkbaseddevelopment.com/short-lived-feature-branches/)
- [GitHub: merge queues](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/merging-a-pull-request-with-a-merge-queue),
  [protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches),
  [auto-merge](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request),
  [CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners),
  and [environments](https://docs.github.com/en/actions/reference/deployments-and-environments)
- [The Pragmatic Programmer tips: DRY is about knowledge](https://pragprog.com/tips/)
- [OpenAI: `AGENTS.md`](https://developers.openai.com/codex/guides/agents-md),
  [Agent Skills](https://developers.openai.com/codex/skills), and
  [Auto-review](https://alignment.openai.com/auto-review/)
- [Anthropic: project memory](https://code.claude.com/docs/en/memory),
  [skills](https://code.claude.com/docs/en/skills), and
  [subagents](https://code.claude.com/docs/en/sub-agents)

## Decisions required

1. Accept, amend, or reject the risk-based WIP limits: one risk lane and two
   autonomous low-risk lanes.
2. Decide whether unresolved decisions prohibit production implementation
   entirely or permit explicitly disposable prototypes under a time budget.
3. Approve the Level 2 pilot scope and who may perform its merges.
4. Approve repository settings: protected `main`, required checks, squash-only,
   branch deletion, and later auto-merge/merge queue criteria.
5. Choose the Chief-of-Staff cadence and what constitutes a report-worthy
   state change.

## Implementation follow-ups after acceptance

1. Consolidate canonical policy in `AGENTS.md`; remove duplicate definitions
   from the three skills while retaining compact action-local safety checks.
2. Update PR templates with workstream/dependency/lane fields and extend
   structural tests to prevent policy copies from drifting.
3. Configure the accepted GitHub controls, then baseline the rolling 20-PR
   measures before piloting Level 2 autonomy.
