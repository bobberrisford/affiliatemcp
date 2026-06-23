---
name: prepare-for-review
description: |
  Prepare, open, update, or request review for an affiliate-mcp pull request.
  Use when asked to create a PR, make a PR review-ready, update a PR body,
  request @offmann's review, or check whether a branch is ready for review.
---

# Prepare a pull request for review

Follow the delivery and review protocol in `AGENTS.md`. This skill prepares a
reviewable handoff; it never merges a PR.

## 1. Inspect before changing PR state

Gather evidence, do not rely on the existing PR description:

```bash
git status --short --branch
git fetch origin
git diff --stat origin/main...HEAD
git diff origin/main...HEAD
git log --oneline origin/main..HEAD
gh pr view --json number,title,url,isDraft,baseRefName,headRefName,mergeable,mergeStateStatus,reviewDecision,reviewRequests,statusCheckRollup,body
gh pr list --state open --json number,title,url,isDraft,reviewDecision,reviewRequests
gh pr checks
```

If the PR targets a base other than `main`, compare against that base instead.
Inspect the complete diff, including generated files and lockfiles.
If the branch has no PR, complete the initial classification and verification,
then create a draft PR using the applicable template. Never open a new PR as
ready for review.

Classify and record:

- one user outcome;
- intended customer journey and affected cohort;
- the owning architectural layer;
- dependencies and whether they are merged;
- workstream, dependency graph, lane, and semantic conflict domains;
- public contracts changed;
- risk domains and failure modes;
- deliberately excluded scope;
- changed-file count and additions.

## 2. Apply the readiness gates

Keep the PR draft and explain the next action when any gate fails:

- The branch has conflicts, failed or pending required CI, or an unmerged
  dependency.
- A product or architecture decision required by this PR remains unresolved.
  Propose a small decision PR using the decision template. Keep this PR to
  discovery or an explicitly disposable prototype; do not prepare production
  foundations or implementation for review.
- The diff combines independent outcomes or separable high-risk domains.
  Propose concrete PR slices.
- The review brief is incomplete or does not match the diff.
- The agent has not inspected the complete diff.
- The PR exceeds 1,000 additions or 20 files without a credible split
  rationale.

Do not use line count alone to demand a split. Keep tests, fixtures, directly
related docs, and generated artefacts with the feature they validate.

## 3. Verify

For code, configuration, fixtures, generated artefacts, or runtime changes:

```bash
npm run check:change -- --base origin/main
npm run verify
```

For a documentation/instruction-only PR:

```bash
git diff --check origin/main...HEAD
git diff --name-only origin/main...HEAD
```

Confirm the docs-only path list contains only Markdown, agent skills,
instruction files, or GitHub community files. Do not claim checks passed unless
you ran them. Record failures and uncertainty in the PR body.

The coding agent owns failures caused by its branch. Inspect failed CI, make the
smallest scoped repair, rerun the relevant local proof, push when authorised,
and watch the replacement checks before requesting review. Do not hand a known
branch-caused CI failure to the reviewer as an undiagnosed problem.

## 4. Write the review brief

Update the PR body to follow the applicable template under
`.github/PULL_REQUEST_TEMPLATE/`. Make the brief concise and evidence-based.

The body must state:

- the user outcome and exact reviewer decision or focus;
- mode: `decision`, `implementation`, or `ready-to-merge`;
- intended customer journey and any changed product assumption;
- owning layer, contracts changed, and dependencies;
- workstream, lane, dependency graph, and merge order when multi-PR;
- risk domains, failure modes, out-of-scope items, and split rationale;
- documentation, examples, tool descriptions, roadmap status, or release notes
  checked or updated;
- verification commands and results;
- what the coding agent inspected and what remains uncertain;
- exact questions or decisions for the reviewer, especially around abstraction,
  ownership boundaries, or live-proof gaps.

Optionally include a `Delivery-system learning` when this work produced concrete
evidence for a process improvement. Keep it to observation, evidence, and the
smallest proposed update. Omit it when there is no meaningful lesson, and do
not add unrelated governance edits to the PR.

Use `gh pr edit --body-file <file>` after preparing the body in a temporary
file. Do not hide failed checks, conflicts, unresolved decisions, or dependency
status.

## 5. Enter the review queue

Risk-based review is required for:

- public MCP/domain contracts or shared/core behaviour;
- cross-network semantics;
- authentication, credentials, privacy, or security;
- write actions, browser automation, consent, or audit behaviour;
- payments, licensing, releases, or deployment architecture;
- cross-client architecture or Claude/Codex parity decisions;
- product-direction decisions with implementation consequences.

Inspect all open PRs and apply the canonical lanes from `AGENTS.md`. Another PR
occupies `active-risk` when it is open, not draft, requests `offmann`, and has
not received a review decision. If the risk lane is occupied, keep this PR
draft as `queued-risk` and report which PR is ahead of it. Routine work may
enter review concurrently only when fewer than two routine PRs are active, all
required decisions are merged, public contracts are preserved, and the owning
domains do not conflict.

When every gate passes:

1. Mark the PR ready with `gh pr ready`.
2. Request `@offmann` with `gh pr edit --add-reviewer offmann` only when the PR
   is in a risk-based category, his queue is empty, and he is not the PR author.
   When `@offmann` is the author, request the repository maintainer instead.
3. For routine isolated changes, mark ready without requesting `@offmann`.
4. Report the PR URL, verification evidence, lane, dependency status, risk
   classification, and reviewer request made.

Never approve or merge the PR yourself.

## 6. Respond to review

For each blocking review finding, reply with one of:

- `fixed`: name the commit and proof run;
- `needs decision`: state the smallest unresolved choice;
- `not changing`: explain the evidence-based reason and leave the thread open
  for the reviewer.

After fixes, rerun the affected checks plus `npm run check:change -- --base
origin/main`, update the PR body's verification and uncertainty sections, and
request re-review. Do not introduce unrelated cleanup while addressing review.
