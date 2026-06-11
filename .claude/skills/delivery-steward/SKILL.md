---
name: delivery-steward
description: |
  Triage and advance an affiliate-mcp pull-request queue end to end. Use when
  asked to manage multiple PRs, choose the next PR, close stale PRs, repair or
  refresh branches, monitor CI, address review findings, prepare merges, or
  accelerate delivery while keeping a human approval gate before merge.
---

# Delivery Steward

Own delivery progress, not just review commentary. Compose the repo-local
`prepare-for-review` and `review-pr` skills, repair branches when the correction
is clear, and minimise hand-offs that merely ask another agent to do known work.

## 1. Triage the portfolio

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

## 2. Close stale work safely

When the user authorises stale-PR cleanup, leave a concise reason and close the
PR. Preserve its remote branch unless the user explicitly requests deletion.
Link a replacement PR when one exists.

Closing a PR is reversible portfolio hygiene. Deleting its branch is a separate,
destructive action.

## 3. Advance the active PR

Use `prepare-for-review` and `review-pr`, then act on what is already known:

- refresh the existing branch onto its intended base;
- diagnose and repair branch-caused CI failures;
- implement clear blocking review corrections on the existing branch;
- add focused regression proof;
- update an inaccurate review brief;
- push fixes and monitor replacement checks.

Do not bounce a concrete, scoped correction back to the author merely because
the current role began as reviewer. Ask for a decision only when the missing
choice is genuinely product, architecture, security, or scope ownership.

Keep unrelated outcomes on separate branches and PRs. Never mix queue-governance
changes into the active feature PR.

## 4. Confidence gate

Recommend merge only when all are true:

- the PR has one coherent outcome and is current with its base;
- dependencies and decisions are resolved;
- the complete resulting diff was inspected;
- no blocking review finding remains;
- required CI and relevant local proof pass;
- release, security, migration, data-loss, and rollback risks are understood;
- the review brief accurately states proof and remaining uncertainty.

Keep a human in the loop before merge. Present a short evidence-based checkpoint:

> PR #N is ready: outcome, repairs made, strongest proof, remaining uncertainty.
> Approve merge?

Do not merge until the user explicitly approves that specific merge. After
approval, merge using the repository's squash-merge default and verify the PR
and `main` state.

## 5. Keep the pipeline moving

While active-PR CI runs, perform non-conflicting portfolio work: inspect the next
PR, close authorised stale work, or prepare decision boundaries. Keep only one
PR actively awaiting human review. On merge, promote the next queued PR, refresh
it onto the new `main`, and repeat.
