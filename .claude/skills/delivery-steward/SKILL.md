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

For multi-PR work, write the workstream dependency graph and acceptance proof
before implementation. If a required decision is unresolved, stop production
implementation at that boundary. Discovery and explicitly disposable
prototypes may continue; foundations and child implementation PRs may not.

Make routine implementation choices without asking for approval. Ask for
maintainer direction only when a decision is product-sensitive,
architecture-sensitive, security-sensitive, privacy-sensitive, irreversible, or
changes a public contract. Rob is the current maintainer and default decision
owner for affiliate-domain truth, product direction, architecture, privacy,
security, deployment, and cross-client trade-offs unless another maintainer or
CODEOWNER is explicitly assigned. When escalating, recommend a direction, name
the material trade-offs, and propose a next step.

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

- `active-risk`: the single PR awaiting deliberate maintainer risk review;
- `routine`: one of at most two decision-complete, disjoint low-risk PRs being
  advanced in parallel;
- `exploration`: discovery or disposable prototype work behind an unresolved
  decision, with no production implementation;
- `queued-risk`: coherent risk work waiting behind `active-risk`;
- `blocked`: waiting on a named dependency, decision, repair, or refresh;
- `merge-queued`: approved by a human and awaiting merge;
- `close-candidate`: stale, superseded, duplicative, or no longer aligned.

Detect semantic conflicts, not only overlapping files. PRs conflict when they
affect the same owning module, public contract, decision, migration, generated
authority, release surface, or customer journey. Conflicting PRs share a lane
and explicit merge order.

Order work by:

1. production regressions, security issues, and release blockers;
2. decisions or foundations that unblock other PRs;
3. small, green, high-value PRs nearest to merge;
4. accepted larger implementations;
5. stale experiments and redesigns.

Refresh branches just in time when promoted. After a stacked parent merges,
retarget the child to `main`, refresh once, and validate the resulting diff. Do
not repeatedly merge `main` into every queued branch.

## 5. Close stale work safely

When the user authorises stale-PR cleanup, leave a concise reason and close the
PR. Preserve its remote branch unless the user explicitly requests deletion.
Link a replacement PR when one exists.

Closing a PR is reversible portfolio hygiene. Deleting its branch is a separate,
destructive action.

## 6. Advance the selected lane

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
changes into a feature PR. Advance at most one `active-risk` PR and two routine
PRs at once; routine lanes must remain decision-complete and disjoint.

## 7. Confidence gate

Recommend merge only when all are true:

- the PR has one coherent outcome and is current with its base;
- dependencies and decisions are resolved;
- the complete resulting diff was inspected;
- no blocker review finding remains;
- required CI and relevant local proof pass;
- release, security, migration, data-loss, and rollback risks are understood;
- the review brief accurately states proof and remaining uncertainty.

Keep the maintainer in the loop before merge. Present a short evidence-based
checkpoint:

> PR #N is ready: outcome, repairs made, strongest proof, remaining uncertainty.
> Approve merge?

Do not merge until Rob or another maintainer explicitly approves that specific
merge, or explicitly asks the agent to merge it. Rob may self-merge his own PRs
after the readiness gates are met, CI is green, the complete diff has been
inspected, and any risk-based decision has been deliberately accepted. After
approval, merge using the repository's squash-merge default and verify the PR
and `main` state.

## 8. Keep the pipeline moving

While active-PR CI runs, perform non-conflicting portfolio work: inspect the next
PR, close authorised stale work, or prepare decision boundaries. Keep only one
PR actively awaiting maintainer risk review, but use the two routine lanes when
their domains are disjoint. On merge, promote the next ordered PR, retarget and
refresh its direct child if needed, then repeat. Every agent-performed merge
still requires explicit maintainer approval for that specific PR.

## 9. Learn from delivery

After meaningful work, reflect briefly on evidence from the interaction. If it
revealed a repeated failure, avoidable hand-off, missing or noisy guardrail, or
an effective pattern worth preserving, add a concise `Delivery-system learning`
side note: observation, evidence, and smallest proposed update. Omit the note
when no useful lesson emerged. Do not edit governance inside the feature PR;
propose the refinement separately for human acceptance.
