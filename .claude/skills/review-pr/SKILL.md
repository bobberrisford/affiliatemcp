---
name: review-pr
description: |
  Review an affiliate-mcp pull request for correctness, architecture, tests,
  product and customer-journey clarity, documentation, and merge readiness.
  Use when asked to review, re-review, supervise, or unblock a PR.
---

# Review a pull request

Follow the delivery and review protocol in `AGENTS.md`. This skill is the
independent engineering backstop for fast agent-authored and maintainer-authored
work, including Rob-authored PRs where no separate human reviewer exists. Find
material problems without turning preferences or hypothetical future needs into
blockers.

## 1. Establish the review target

Gather current evidence:

```bash
git status --short --branch
git fetch origin
gh pr view <number> --json number,title,url,author,isDraft,baseRefName,headRefName,mergeable,mergeStateStatus,reviewDecision,reviewRequests,statusCheckRollup,body,files,commits,reviews
gh pr diff <number> --patch
gh pr checks <number>
```

Read the applicable repo instructions, PR body, complete diff, changed tests,
adjacent ownership boundaries, accepted decisions, and direct dependency
diffs. Do not rely on the PR summary alone. Treat implementation beyond an
unresolved decision as a sequencing blocker even when the PR is draft or CI is
green.

## 2. Review in risk order

Review these concerns in order:

1. Public contracts, shared behaviour, authentication, security, writes,
   payments, releases, deployment, and cross-client or cross-network semantics.
2. Dependency and sequencing validity: accepted decisions, semantic conflicts,
   intended merge order, and whether a foundation has a concrete first consumer.
3. Concrete correctness failures, unhappy paths, error handling, and data loss.
4. Tests that are absent, misleading, or unable to catch the claimed behaviour.
5. Ownership and maintainability: logic in the wrong layer, hidden coupling,
   duplicated domain behaviour, or an abstraction that obscures rather than
   simplifies.
6. Product and customer journey: technically correct but confusing behaviour,
   unclear tool names or descriptions, hidden network limitations, or a changed
   journey that the PR does not explain.
7. Documentation accuracy across the README, MCP tool docs, examples, skills,
   roadmap or product docs, contribution docs, and release notes when relevant.

Read past the touched file when needed. Follow the real call path from entrypoint
to owner module, shared helper, and external boundary. Prefer executable proof
and current source over comments or confident PR prose.

## 3. Keep the bar practical

Block only when there is a concrete correctness, security, contract,
architecture, testability, or reviewability problem.

- Do not block on naming preferences, minor local duplication, style already
  enforced by tooling, or speculative extensibility.
- Keep network-specific behaviour inside its network unless multiple real
  implementations share the same semantics.
- Recommend a refactor only when it makes the current invariant clearer or
  removes a demonstrated bug class.
- Say `not proven` when evidence is missing. Do not manufacture edge cases.

Classify findings:

- `blocker`: must change before merge.
- `important`: material concern that should normally change, but can merge when
  the reviewer explicitly accepts the risk.
- `suggestion`: useful polish or maintainability improvement; non-blocking.
- `follow-up ticket`: worthwhile work outside this PR's user outcome.

Omit style nits unless they affect maintainability or consistency. Every
blocker or important concern must name the path or symbol, concrete failure
mode, and smallest acceptable correction.

## 4. Handle CI and hand back clearly

If CI is red, inspect the failing job and decide whether the failure is caused by
the PR. When asked to fix or unblock the PR, make the smallest scoped repair,
run the relevant local proof, push to the existing branch when authorised, and
watch the replacement checks. Otherwise, report the exact failing check and
likely owner; do not merely say CI is red.

Return findings first. Then state:

- strongest proof inspected;
- remaining uncertainty or live-proof gap;
- whether the customer journey, tool behaviour, and documentation remain clear;
- whether the current design is understandable and appropriately contained;
- exact next action for the coding agent.

When the review exposes a systemic delivery lesson rather than a one-off code
finding, optionally add a short `Delivery-system learning` side note with the
evidence and smallest proposed workflow change. Do not force a lesson into
every review or make process preferences blocking findings.

Do not approve, merge, or resolve review threads unless explicitly asked. For a
Rob-authored PR, return a clear recommendation and the residual risk so Rob can
make the maintainer decision.

## 5. Re-review

For re-review, read the previous findings and inspect changes since the reviewed
commit. Confirm each blocker and important concern is fixed or consciously
accepted, then briefly re-check the complete resulting diff and current CI. Do
not restart a full stylistic review or introduce unrelated requirements.
