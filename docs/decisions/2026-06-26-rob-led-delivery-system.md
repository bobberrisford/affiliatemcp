# Rob-led delivery and review model

- **Date:** 2026-06-26
- **Status:** Proposed
- **Affects:** `AGENTS.md`, `CLAUDE.md`, repo-local delivery and review skills,
  roadmap ownership notes, pull request review routing, and contributor
  expectations.
- **Supersedes:** the Othman-specific reviewer routing in
  [`2026-06-20-risk-based-delivery-system.md`](./2026-06-20-risk-based-delivery-system.md).

## Context

The previous delivery model assumed a two-maintainer operating loop:

- Rob owned affiliate-domain truth, customer journeys, product direction, and
  industry judgement.
- Othman owned architecture, privacy, security, deployment, cross-client
  trade-offs, and the scarce risk-review lane.

That operating assumption is no longer true. Othman is no longer contributing
to this repository. Keeping `@offmann` as a required reviewer would block Rob's
delivery, create stale PR queues, and confuse future contributors.

The useful parts of the delivery system still stand: small reviewable outcomes,
decision-first sequencing, one active risk lane, up to two routine lanes, green
checks, complete diff inspection, independent review for risky work, and
explicit merge authority. The change is ownership, not a relaxation of the
safety bar.

## Decision

Rob is the current maintainer and default decision owner for:

- affiliate-domain truth and network behaviour;
- customer journeys and product direction;
- architecture, privacy, security, deployment, and cross-client trade-offs;
- release readiness and public claims.

Do not request `@offmann` for review. For Rob-authored risk-based PRs, the
default backstop is an independent agent review: a fresh Claude/Codex review
inspects the complete diff, accepted decisions, changed tests, CI, and
customer-journey implications before Rob decides whether to merge.

External contributor PRs still require maintainer or CODEOWNER review. When a
separate CODEOWNER or maintainer owns the touched area, request that owner. When
Rob is the only maintainer available, Rob may review and merge after the normal
readiness gates are satisfied.

Agents may implement, validate, repair, review, push, and recommend a merge.
Agents must not merge unless Rob or another maintainer explicitly asks them to
merge that specific PR. Rob may self-merge his own PRs when:

- the PR has one coherent outcome;
- required decisions are accepted or the PR itself is the decision;
- CI and relevant local checks are green;
- the complete diff has been inspected;
- an independent agent review has been used for risk-based PRs, or Rob records
  why it is unnecessary;
- remaining risk is documented and deliberately accepted.

## Operating Rules

- Keep `active-risk` as WIP 1, but define it as "awaiting deliberate maintainer
  judgement", not "awaiting Othman".
- Keep up to two `routine` lanes for disjoint, decision-complete, low-risk work.
- Continue decision-first sequencing for shared/public contracts, privacy,
  security, deployment, cross-client architecture, writes, consent, releases,
  and product-direction decisions with implementation consequences.
- Keep provider-neutral behaviour in core and MCP layers; host-specific
  behaviour remains a thin integration.
- Keep PR bodies explicit about owner, lane, dependencies, risks, verification,
  and residual uncertainty.
- Prefer focused independent agent review over passive waiting when Rob authored
  the work and no separate maintainer exists.

## Rejected Alternatives

- **Keep requiring `@offmann`.** No longer matches the contributor reality and
  would block delivery.
- **Remove risk review entirely.** Fast but brittle. Writes, public contracts,
  privacy, security, deployment, releases, and cross-client changes still need
  deliberate review and acceptance.
- **Require an external human reviewer for every Rob-authored PR.** Safer in
  theory but unrealistic for a small open-source project. Independent agent
  review plus green checks is the practical default until another maintainer or
  CODEOWNER exists.
- **Let agents auto-merge by default.** Still too much trust for the current
  evidence. Agent-performed merges require explicit maintainer instruction for
  the specific PR.

## Consequences

- Rob and his coding agents can keep shipping without waiting for Othman.
- Contributors get one clear maintainer route instead of a split ownership
  model that no longer exists.
- The delivery system remains risk-based and reviewable, but the scarce review
  lane belongs to the maintainer actually operating the project.
- Future maintainers or CODEOWNERS can be added without changing the model:
  route review to the owner of the touched area, and keep independent agent
  review as a useful backstop.

## Implementation Follow-Ups

1. Update `AGENTS.md` and `CLAUDE.md` to remove Othman-specific review routing.
2. Update `delivery-steward`, `prepare-for-review`, and `review-pr` language to
   describe maintainer-led review and Rob-authored PR backstops.
3. Update roadmap ownership notes so open work packages no longer assign work
   to Othman.
4. Keep CODEOWNERS pointed at `@bobberrisford` until additional maintainers or
   network owners are real.
