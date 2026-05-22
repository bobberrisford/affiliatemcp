---
name: contribute-to-affiliate-mcp
description: |
  Use this skill when the user wants to contribute to the affiliate-mcp project —
  adding a new affiliate network adapter, fixing a broken network adapter, adding
  a new Claude Code skill, or improving the documentation. Trigger on:
  "add [network] to affiliate-mcp", "contribute a network", "fix the [network]
  adapter", "the [network] adapter is broken", "add a skill to affiliate-mcp",
  "improve the docs for [network]".
---

# Contributing to affiliate-mcp

You are helping a contributor add to or fix the `affiliate-mcp` project. This
skill is project-local; it loads automatically when a contributor opens the
repository in Claude Code. The repository's `AGENTS.md` is the prerequisite
read — open it before the user asks their first concrete question.

The project is matter-of-fact, UK English, no marketing. The user-visible
noun is "programme", not "program". Read the editorial-tone note in
`AGENTS.md` before drafting any prose.

## 0. Before you start

1. Read `AGENTS.md` at the repository root.
2. Read `src/shared/types.ts` — it is the contract every network adapter speaks.
3. Read the file-level comment in `src/networks/awin/adapter.ts` — it names the
   six cardinal rules that apply across every contribution path below.
4. Ask the user which task they want to do. The five tasks this skill covers:
   - Task 1: Add a new network adapter.
   - Task 2: Fix an existing network adapter.
   - Task 3: Add a Claude Code skill.
   - Task 4: Improve setup documentation for a network.
   - Task 5: File a finding for the public REPORT.

Do not start writing code before confirming which task. The five flows
diverge sharply.

## 1. Task 1 — add a new network adapter

This is the most common contribution. The structure is rigid by design — the
goal is that anyone reading Awin can write CJ, Impact, or Rakuten by analogy.

### Step 1. Confirm prerequisites with the user

Ask the user:

- The network's name and the lowercase, kebab-case slug they want.
  Examples: `ebay-partner-network` → slug `ebay`; `Pepperjam` → slug `pepperjam`.
- The URL of the network's public API documentation. Do not proceed without it.
- Whether they have working credentials for at least one publisher account on
  the network. Without credentials you cannot validate the adapter beyond a
  schema check.
- Whether they have the authority to release the adapter under the project's
  MIT licence (i.e. they are not using internal-only docs covered by an NDA).

If any of these are missing, stop and tell the user what is missing.

### Step 2. Check the network isn't already in the project

Look for the slug under `src/networks/<slug>/`. If present, the network exists
— route to Task 2 instead.

Look at open pull requests (the user may need to check GitHub). A draft PR
adding the same network usually means waiting or co-ordinating, not racing.

### Step 3. Copy the template

```
cp -r templates/new-network src/networks/<slug>
```

Then rename / replace identifiers throughout the copied files. The template
ships with deliberately enriched TODO comments that name the Awin equivalent
for every method. Read each TODO before deleting it.

### Step 4. Read the reference implementation

Open `src/networks/awin/adapter.ts` and read it end to end. Pay particular
attention to:

- `mapTransactionStatus` and `mapProgrammeStatus` — the status normalisation
  pattern and why "unknown" is preferable to a wrong guess.
- `computeAgeDays` — anchored on `validationDate` then `transactionDate`. The
  unpaid-age affordance (PRD §15.9) depends on this.
- `chunkDateRange` — Awin caps `/transactions` at 31 days; the adapter chunks
  rather than pushing the cap onto callers.
- `generateTrackingLink` — deterministic URL construction (no API call).
- The module-level `registerAdapter` side effect and why it lives at the
  bottom of `adapter.ts`.
- The `_internals` export pattern for unit-testable helpers.

Also skim `src/networks/awin/auth.ts`, `src/networks/awin/client.ts`,
`src/networks/awin/setup.ts`, and `src/networks/awin/network.json`. The
template's auth/client/setup files describe what they should contain.

### Step 5. Implement `auth.ts` and `client.ts` first

`client.ts` is the only file that calls `fetch`. Wrap every outbound call in
`withResilience` (from `src/shared/resilience.ts`). Throw `HttpStatusError` on
non-2xx so the retry policy applies uniformly. Always preserve the verbatim
response body for the envelope.

`auth.ts` owns:

- `verifyAuth()` — make a cheap, identity-revealing call (Awin: `/publishers`).
  Return `{ ok: true, identity }` or `{ ok: false, reason }`.
- `validateCredential(field, value)` — per-field live validation used by the
  wizard.
- Token caching, if the network uses OAuth2 (see Rakuten's `auth.ts`).

Credentials are read via `requireCredential` from `src/shared/config.ts`. Never
read `process.env` directly inside an adapter — missing values must surface as
`config_error` envelopes.

### Step 6. Implement the seven operations one at a time

Implement in this order:

1. `listProgrammes` — discovery; most networks expose this first and validating
   it confirms the auth + client + pagination story.
2. `getProgramme` — usually one extra endpoint or the same endpoint with a
   filter.
3. `listTransactions` — the workhorse. Hardest because of date windowing and
   status normalisation.
4. `getEarningsSummary` — derive from `listTransactions`. Do NOT call a
   separate "report" endpoint unless you have a reason; the user must be able
   to recompute the summary from the transactions they see.
5. `listClicks` — many networks do not expose this. If unsupported, throw
   `NotImplementedError` with a one-line reason. Do not return `[]`.
6. `generateTrackingLink` — deterministic where possible (see Awin); API call
   where required (see Impact). Either way, validate the inputs before the
   call.
7. `capabilitiesCheck` — probe each op with the minimum viable query
   (`limit: 1`); record latency; record known-unsupported without probing.

Pattern every op around Awin. If your network's behaviour diverges, document
the divergence inline with a "why" comment.

### Step 7. Implement `setup.ts`

Return a `SetupStep[]` from `setupSteps()`. Each step has:

- `field` — the env-var name, e.g. `EBAY_API_TOKEN`.
- `label` and `description` — verbatim dashboard navigation. Use button names
  the user will literally see ("Click Account → API → Generate token").
- `type` — `password` for secrets, `text` for IDs, `number` for numerics.
- `validateOnEntry` — a live check where feasible. Keep it fast.

Where one credential can be derived from another (Awin derives
`AWIN_PUBLISHER_ID` from the token), expose a `derivedValues()` method on the
adapter that the wizard calls between steps.

### Step 8. Write `network.json`

The schema is enforced by `scripts/validate-network-json.ts`. Required fields:

- `slug` — lowercase, kebab-case. Must match the directory name.
- `name` — human-readable.
- `base_url` — production API base. Must be a valid URL.
- `auth_model` — one of `bearer | oauth2 | basic | custom`.
- `env_vars` — `string[]`, each `[A-Z][A-Z0-9_]*`, non-empty.
- `setup_time_estimate_minutes` — integer, positive. Honest estimate.
- `setup_requires_approval` — boolean. If true, also set
  `setup_approval_days_typical`.
- `known_limitations` — `string[]`. Be specific. "No click data" is fine if
  true; vague hedging is not.
- `claim_status` — one of `production | partial | experimental | unsupported`.
  New adapters ship `partial` or `experimental`; promotion to `production`
  needs live acceptance testing.
- `adapter_version` — semver. Start `0.1.0`.
- `last_verified` — ISO date `YYYY-MM-DD`. The date you last ran the live
  diagnostic against a real account.
- `supports_brand_ops` — boolean. False at v0.1 for everyone.
- `docs_url` — optional, but include it.

### Step 9. Write `docs/networks/<slug>.md`

Use `docs/networks/awin.md` as the template. Sections:

- Prerequisites (account, region, approval).
- Credentials needed (one heading per env var with the exact dashboard path).
- Setup steps (numbered, screenshot-able).
- Common failures (what the user sees, how to recover).
- Known limitations (mirror `known_limitations` in `network.json`).
- Verifying (`affiliate-networks-mcp test <slug>`).

Tone: matter-of-fact, UK English. No marketing.

### Step 10. Run the validator

```
npm run validate:network -- <slug>
```

Two stages run:

1. Schema check on `network.json`.
2. Live diagnostic if the adapter is registered.

Both must pass before you continue. The diagnostic engine's pass is the
verification contract.

### Step 11. Register the adapter

Add one line to `src/networks/index.ts`:

```ts
import './<slug>/adapter.js';
```

That import triggers the module-level `registerAdapter` call in `adapter.ts`.
Without it, the server never sees the network.

### Step 12. Regenerate the README table and the REPORT

```
npm run generate:readme
npm run generate:report
```

Commit the changes to `README.md` and `REPORT.md`. Do not hand-edit the
between-marker rows of the README network table.

### Step 13. Update CODEOWNERS

If the repo has `CODEOWNERS` (it will, once Chunk 12 ships), add a line
claiming `src/networks/<slug>/` for your handle.

### Step 14. Update `WANTED.md`

If the network was on `WANTED.md`, remove it. If it wasn't there in the first
place, no action.

### Step 15. Open a draft PR

The PR template (Chunk 12) ships the full checklist. At minimum:

- Title: `Add <network> adapter`.
- Description states `claim_status`, `last_verified`, the operations
  implemented, and the known limitations.
- Confirm: `npm test`, `npm run typecheck`, `npm run lint`, and
  `npm run validate:network -- <slug>` all pass locally.

### Step 16. Hand back to the user

Tell the user what you've done, what is left for them to do (review the diff,
push the branch, request review), and what they should expect from CI.

## 2. Task 2 — fix an existing network adapter

A network's API is misbehaving, or the adapter has a bug.

1. **Reproduce.** Ask the user for the exact tool call that failed and the
   verbatim error envelope they received. If they cannot reproduce, ask them
   to run `affiliate-networks-mcp doctor` and share the output.
2. **Read the existing adapter.** Find the operation in
   `src/networks/<slug>/adapter.ts`. Read it carefully. Look for an existing
   "why" comment near the suspicious behaviour.
3. **Check the changelog / known issues.** Re-read `docs/findings/<slug>.md`.
   The bug may already be a known limitation rather than a regression.
4. **Minimum change.** Fix the bug inside the affected operation. Do not
   refactor adjacent code. Do not change behaviour elsewhere in the adapter.
5. **Bump `adapter_version` and `last_verified`** in `network.json`. A bug fix
   warrants a patch bump.
6. **Add or update a finding** in `docs/findings/<slug>.md` describing what
   was broken and what is now true. Be specific and verifiable.
7. **Regenerate the README + REPORT.**
8. **Open a PR** with the bug reproduction and the fix.

## 3. Task 3 — add a Claude Code skill

Skills under `src/skills/` are user-facing — they tell Claude Code how to
answer a particular question using the project's tools.

1. **Check existing skills.** Look under `src/skills/` to confirm the skill
   doesn't already exist or duplicate one in a different name.
2. **Create the directory** `src/skills/<skill-name>/`.
3. **Write `SKILL.md`** with YAML frontmatter (`name`, `description`). Use the
   existing skills as the format reference.
4. **Add an example file** under `src/skills/<skill-name>/examples/`. Walk a
   concrete user query end-to-end.
5. **Add supporting scripts** only if needed. Most skills are pure prose.
6. **Test manually.** Open a fresh Claude Code session in the repo, invoke the
   trigger phrase, confirm the skill loads and produces the intended output.
7. **Open a PR.**

## 4. Task 4 — improve setup documentation

When a user reports the setup wizard or the per-network setup doc is confusing.

1. **Identify what is confusing.** Ask for the specific step that failed.
2. **Re-screenshot the dashboard** if the UI has changed since the doc was
   written. Place images under `docs/networks/images/<slug>/`.
3. **Update the step** in `docs/networks/<slug>.md`. Verbatim button names,
   no paraphrasing.
4. **Add the new failure to "Common failures"** in the same doc.
5. **Bump `last_verified`** in `src/networks/<slug>/network.json`.
6. **Open a PR.**

## 5. Task 5 — file a finding for the public REPORT

When a user has direct evidence that a network's API behaves in a way worth
documenting publicly.

1. **Be specific and verifiable.** "Sometimes slow" is not a finding.
   "Returned HTTP 500 on `/Campaigns` 14 times between 2026-04-01 and
   2026-04-15 against my account; sample IDs attached" is a finding.
2. **Add the finding** to `docs/findings/<slug>.md` with a date, the
   reproducible test, and the verbatim observed behaviour.
3. **Link sources** where possible — a community forum thread, an official
   status-page incident.
4. **Avoid speculating about motive.** State what is observable; let the
   reader draw conclusions.
5. **Regenerate the REPORT.**
6. **Open a PR.**

## What you should NOT do

The list in `AGENTS.md` is canonical; here is the contributor-specific
reminder:

- Do not modify `src/shared/` to make your adapter's life easier. The shared
  types are stable. If you genuinely need a new field, raise an issue first.
- Do not modify another network's adapter. Each network owns its directory.
- Do not modify Awin's adapter for behavioural changes. The only allowed
  Awin edit is adding a missing "why" comment (PRD §15.30).
- Do not add new methods to `NetworkAdapter`. The seven publisher ops + two
  admin stubs + setup helpers are the surface.
- Do not commit credentials. Review your diff before pushing.
- Do not retry on 4xx other than 429. The resilience config enforces this.
- Do not catch and ignore network errors.
- Do not add a new dependency without justification in the PR description.
- Do not use US spellings in user-visible strings or documentation.
- Do not `console.log`. Use `createLogger` from `src/shared/logging.ts`. Logs
  go to stderr; stdout is the MCP transport.

## Common failures and how to recover

- **The diagnostic passes but a real query fails.** The diagnostic uses the
  minimum viable query (`limit: 1`); production-shaped queries can stress
  pagination or date windowing. Reproduce the failing query, add a test
  fixture for it under `tests/fixtures/<slug>/`, then a regression test under
  `tests/networks/<slug>/`.
- **`validateCredential` keeps returning `false`.** Almost always a typo in
  the env-var name in `auth.ts` versus the `field` in `setupSteps()`. They
  must match exactly.
- **The data doesn't fit the shared types.** Resist the urge to widen
  `src/shared/types.ts`. Preserve the upstream shape in `rawNetworkData` and
  map the common fields. Only request a type widening when a concept is
  genuinely shared across at least two networks.
- **Tempted to add a method to `NetworkAdapter`.** Don't. The 30-tool surface
  at v0.1 depends on the current shape. Talk to the maintainers first.
- **Setup wizard works locally but fails for the user.** Check
  `AFFILIATE_MCP_CONFIG_DIR` — the wizard honours an override that you may not
  have set. Run `affiliate-networks-mcp doctor` to see the resolved paths.
- **Tests pass locally but fail in CI.** Check the date in any test that uses
  `new Date()` without injection. The Awin adapter accepts a `now` argument
  on its helpers; CJ/Impact/Rakuten follow the same pattern. Tests that drift
  with the current date are the most common CI flake.

## When to ask the user, when to proceed

Proceed autonomously when:

- Choosing a code style detail (variable name, helper placement) within the
  network's own directory.
- Generating fixtures from API responses the user already produced.
- Writing prose for setup docs or findings, then asking the user to review.

Ask the user before:

- Touching code outside the network's directory (anything in
  `src/shared/`, `src/cli/`, `src/tools/`, `src/server.ts`,
  `src/index.ts`, `scripts/`).
- Modifying another network's adapter.
- Adding any dependency.
- Anything in the "What you should NOT do" list above.

## Closing checklist before opening the PR

Run through this before the user clicks "Create pull request":

- [ ] `npm run typecheck` is green.
- [ ] `npm run lint` is green.
- [ ] `npm test` is green.
- [ ] `npm run validate:network -- <slug>` passes.
- [ ] No credentials in the diff (`git diff | grep -iE 'token|secret|password|key='`).
- [ ] No `console.log` left in the code.
- [ ] No `@ts-ignore` without an explanatory comment.
- [ ] Tool descriptions follow PRD §5.5 (matter-of-fact; name the network).
- [ ] Error messages follow principle 4.1 (named network + operation +
      verbatim body in envelope).
- [ ] UK spellings throughout. The user-visible noun is "programme".
- [ ] README network table regenerated via `npm run generate:readme`.
- [ ] CODEOWNERS updated (if the file exists).
- [ ] WANTED.md updated (if applicable).
- [ ] Per-network setup doc written at `docs/networks/<slug>.md`.
- [ ] PR template filled out — including the live-test evidence section.

Hand the user the checklist results, not your assertions. They can verify.
