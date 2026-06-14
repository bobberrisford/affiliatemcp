---
name: delivery-steward
description: |
  Steward affiliate-mcp implementation, documentation, and pull-request
  delivery end to end. Use when asked to implement or plan a repo change,
  advance work from an issue or user outcome, manage multiple PRs, repair or
  refresh branches, monitor CI, address review findings, prepare merges, or
  accelerate delivery while keeping product and architecture decisions with
  the appropriate human.
---

# Delivery Steward

Turn one user outcome into a small, validated, reviewable change. Own delivery
progress, not just implementation or review commentary. Follow `AGENTS.md`,
compose `prepare-for-review` and `review-pr` when a PR is involved, and minimise
hand-offs that merely ask another agent to do known work.

## 1. Frame the outcome

Before editing, identify:

- the intended customer journey and affected cohort;
- the owning architectural layer and existing pattern to follow;
- public MCP, domain, CLI, client, or documentation contracts affected;
- failure modes, assumptions, dependencies, and deliberately excluded scope.

Read the owning files, adjacent tests, relevant accepted decisions, and current
product docs before choosing an approach. Treat shipped behaviour and accepted
decisions as stronger evidence than historical plans.

Make routine implementation choices without asking for approval. Ask for human
direction only when a decision is product-sensitive, architecture-sensitive,
security-sensitive, irreversible, or changes a public contract. Othman steers
technical architecture and product trade-offs. Rob steers affiliate-domain
truth, product direction, and customer or industry judgement. When escalating,
recommend a direction, name the material trade-offs, and propose a next step.

Assumptions can evolve. Question one when new requirements, usage evidence,
architecture, or product direction materially changes the outcome. Otherwise,
state the working assumption briefly and continue.

## 2. Implement the smallest coherent change

- Reuse the owning module, naming, helper, and test patterns.
- Keep provider-neutral behaviour in shared core or MCP layers and
  network-specific behaviour in its adapter.
- Avoid speculative abstractions, hidden coupling, duplicated domain logic,
  inconsistent naming, global state, and unrelated cleanup.
- Preserve public APIs unless a breaking change is explicitly requested and
  governed by an accepted decision.
- Add or update focused tests when behaviour changes.
- Update practical docs, examples, tool descriptions, roadmap status, or
  release notes when the customer journey or shipped behaviour changes.

Run the smallest meaningful validation first, then broaden according to the
change's risk. Inspect the complete diff and report what changed, why, proof
run, and remaining uncertainty.

## 3. Check product and documentation coherence

Before handoff, ask whether the change remains understandable to affiliate
managers, agencies, networks, semi-technical operators, and users working
through Claude Desktop, ChatGPT, Cursor, or another MCP client.

Flag and correct cases where:

- technically correct behaviour is confusing in the customer journey;
- tool names, descriptions, inputs, outputs, or errors are hard to understand;
- docs or examples no longer match behaviour;
- network limitations or unsupported states are hidden;
- a changed journey or product assumption is not documented.

## 4. Triage the PR portfolio

Gather all open PRs, current `main`, dependencies, conflicts, review decisions,
checks, age, size, and risk domains. Assign exactly one state:

- `active`: the single PR being advanced towards merge;
- `queued`: coherent and valuable, but waiting behind the active PR;
- `needs-update`: worth keeping, but requires refresh, repair, or a decision;
- `close-candidate`: stale, superseded, duplicative, or no longer aligned.

Order work by:

1. production regressions, security issues, and release blockers;
2. decisions or foundations that unblock other PRs;
3. small, green, high-value PRs nearest to merge;
4. accepted larger implementations;
5. stale experiments and redesigns.

Refresh branches just in time when promoted to `active`; do not repeatedly
merge `main` into every queued branch.

## 5. Close stale work safely

When the user authorises stale-PR cleanup, leave a concise reason and close the
PR. Preserve its remote branch unless the user explicitly requests deletion.
Link a replacement PR when one exists.

Closing a PR is reversible portfolio hygiene. Deleting its branch is a separate,
destructive action.

## 6. Advance the active PR

Use `prepare-for-review` and `review-pr`, then act on what is already known:

- refresh the existing branch onto its intended base;
- diagnose and repair branch-caused CI failures;
- implement clear blocker corrections on the existing branch;
- add focused regression proof;
- update an inaccurate review brief;
- push fixes and monitor replacement checks.

Do not bounce a concrete, scoped correction back to the author merely because
the current role began as reviewer. Ask for a decision only when the missing
choice is genuinely product, architecture, security, or scope ownership.

Keep unrelated outcomes on separate branches and PRs. Never mix queue-governance
changes into the active feature PR.

## 7. Confidence gate

Recommend merge only when all are true:

- the PR has one coherent outcome and is current with its base;
- dependencies and decisions are resolved;
- the complete resulting diff was inspected;
- no blocker review finding remains;
- required CI and relevant local proof pass;
- release, security, migration, data-loss, and rollback risks are understood;
- the review brief accurately states proof and remaining uncertainty.

Keep a human in the loop before merge. Present a short evidence-based checkpoint:

> PR #N is ready: outcome, repairs made, strongest proof, remaining uncertainty.
> Approve merge?

Do not merge until the user explicitly approves that specific merge. After
approval, merge using the repository's squash-merge default and verify the PR
and `main` state.

## 8. Keep the pipeline moving

While active-PR CI runs, perform non-conflicting portfolio work: inspect the next
PR, close authorised stale work, or prepare decision boundaries. Keep only one
PR actively awaiting human review. On merge, promote the next queued PR, refresh
it onto the new `main`, and repeat.
