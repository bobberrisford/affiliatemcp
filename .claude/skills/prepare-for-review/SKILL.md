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
- the owning architectural layer;
- dependencies and whether they are merged;
- public contracts changed;
- risk domains and failure modes;
- deliberately excluded scope;
- changed-file count and additions.

## 2. Apply the readiness gates

Keep the PR draft and explain the next action when any gate fails:

- The branch has conflicts, failed or pending required CI, or an unmerged
  dependency.
- A product or architecture decision required by this PR remains unresolved.
  Propose a small decision PR using the decision template.
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

## 4. Write the review brief

Update the PR body to follow the applicable template under
`.github/PULL_REQUEST_TEMPLATE/`. Make the brief concise and evidence-based.

The body must state:

- the user outcome and exact reviewer decision or focus;
- mode: `decision`, `implementation`, or `ready-to-merge`;
- owning layer, contracts changed, and dependencies;
- risk domains, failure modes, out-of-scope items, and split rationale;
- verification commands and results;
- what the coding agent inspected and what remains uncertain.

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

Inspect all open PRs. Another PR occupies `@offmann`'s queue when it is open,
not draft, requests `offmann`, and has not received a review decision. If the
queue is occupied, keep this PR draft and report which PR is ahead of it.

When every gate passes:

1. Mark the PR ready with `gh pr ready`.
2. Request `@offmann` with `gh pr edit --add-reviewer offmann` only when the PR
   is in a risk-based category, his queue is empty, and he is not the PR author.
   When `@offmann` is the author, request the repository maintainer instead.
3. For routine isolated changes, mark ready without requesting `@offmann`.
4. Report the PR URL, verification evidence, risk classification, and reviewer
   request made.

Never approve or merge the PR yourself.
