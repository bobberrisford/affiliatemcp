# AGENTS.md

This file orients AI coding agents (Claude Code and equivalents) opening
`affiliate-mcp` for the first time. Read it before touching code.

## What this project is

`affiliate-mcp` is a Model Context Protocol server that exposes four affiliate
networks — Awin, CJ Affiliate, Impact, Rakuten Advertising — to MCP-capable
clients (Claude Desktop, Claude Code, others). The user brings their own API
credentials; the server is local-only, with no hosted version. Optional
telemetry is opt-in, off by default, and aggregate-only; it conforms to
`PRIVACY.md` and the decision record
`docs/decisions/2026-06-13-privacy-first-telemetry.md`. UK English throughout,
including the canonical noun "programme".

The project is in public beta. The full state of each network's adapter — what
ships, what is stubbed, what is known to misbehave — is in `REPORT.md`.

## Product north star

Affiliate data should be available where affiliate work happens. This repo
turns public affiliate network APIs into local-first MCP tools, skills, prompts,
and workflows so affiliate professionals can use their own data from the AI
workspace they already use.

The product is workflow-oriented. A user should be able to investigate
performance, find partners, prepare a QBR, check unpaid commissions, draft
outreach, audit links, or diagnose anomalies without bouncing between network
dashboards, CSV exports, spreadsheets, docs, and email.

## Target cohorts

Keep these audiences in mind when writing docs, tools, setup flows, and PR
notes:

- **Advertisers, brands, and agencies** who manage programmes, optimise
  partners, prepare client updates, and use Claude, ChatGPT, or similar tools.
- **Publishers** who track earnings, pending commissions, unpaid transactions,
  link health, programme performance, and cross-network reporting.
- **Semi-technical operators** who can follow guided setup, GitHub instructions,
  terminals, Claude Code, Codex, Cowork, or Cursor, but should not need to read
  the internals.
- **Developers and data teams** building internal tools, reporting workflows,
  reconciliation jobs, or agent-native affiliate operations.
- **Affiliate network employees** who may adopt, correct, own, or improve their
  own adapter.
- **AI coding agents** that need explicit boundaries so changes stay focused,
  safe, and reviewable.

## Product boundaries

- API-first. Prefer a network's public, documented API. Where no usable API
  exists, or it covers only part of the job, automate the user's own
  authenticated session to do what they could do by hand. Keep browser-driven
  operations behind the same typed contract and label them as more brittle.
- Local-first by default. Users bring their own credentials and credentials stay
  on the user's machine unless a future remote option is explicitly designed
  with auth, consent, auditability, and security.
- Safe typed tools, not raw chaos. The assistant can reason over operations,
  but must not invent data or hide upstream API limitations.
- Workflows over endpoint trivia. Prefer affiliate tasks such as performance
  briefs, anomaly checks, QBR prep, partner discovery, outreach, unpaid
  commission checks, and link audits.
- Honest network truth. Document whether support is production, partial,
  experimental, unsupported, gated, or unverified, and whether an operation is
  API-backed or browser-driven.

## Editorial tone

Matter-of-fact. Not snarky. No marketing language. When a network's API is
awkward, say what is awkward and why; do not editorialise. The findings docs
under `docs/findings/` set the tone — copy that register.

## File layout

```
.
├── AGENTS.md                          (this file)
├── README.md                          public-facing summary; auto-generated table
├── REPORT.md                          per-network capability + findings report
├── LICENSE
├── package.json
├── tsconfig.json / tsconfig.dev.json  strict TypeScript; dev variant includes tests
├── vitest.config.ts
├── .eslintrc.cjs / .prettierrc
├── .env.example                       schema of every env var the project reads
├── docs/
│   ├── networks/                      per-network setup walkthroughs (user-facing)
│   └── findings/                      per-network honest findings (verifiable claims)
├── scripts/                           generators + validators (tsx)
│   ├── generate-readme-table.ts
│   ├── generate-report.ts
│   ├── generate-report-image.ts
│   └── validate-network-json.ts       npm run validate:network <slug>
├── src/
│   ├── index.ts                       CLI dispatch (server / setup / test / doctor)
│   ├── server.ts                      MCP server bootstrap
│   ├── cli/                           setup wizard, test, doctor
│   │   ├── setup.ts / test.ts / doctor.ts
│   │   └── wizard/                    envfile, paths, prompts
│   ├── shared/                        load-bearing primitives — STABLE; do not modify
│   │   ├── types.ts                   the canonical contract every adapter speaks
│   │   ├── resilience.ts              timeout + retry + circuit breaker (the only path)
│   │   ├── errors.ts                  envelope helpers; principle 4.1 lives here
│   │   ├── config.ts                  credential loader (~/.affiliate-mcp/.env)
│   │   ├── registry.ts                adapter registry
│   │   ├── diagnostic.ts              validateNetwork(slug) — the verification engine
│   │   └── logging.ts                 pino, stderr-only
│   ├── tools/
│   │   └── generate.ts                turns each adapter into MCP tools (7 per network)
│   ├── networks/
│   │   ├── index.ts                   aggregator: importing this registers every adapter
│   │   ├── awin/                      *** canonical reference implementation ***
│   │   ├── cj/                        CJ Affiliate
│   │   ├── impact/                    Impact
│   │   └── rakuten/                   Rakuten Advertising
│   └── skills/                        Claude Code skills for end users (not contributors)
├── templates/
│   └── new-network/                   copy this folder to add a network adapter
├── tests/
│   ├── shared/ networks/ cli/ integration/ scripts/ tools/ docs/ skills/
│   └── fixtures/                      verbatim sample API responses per network
└── .claude/
    └── skills/contribute/             skill that auto-loads for contributors
```

## Read these in order

1. `AGENTS.md` (this file)
2. `.claude/skills/contribute/SKILL.md` — task-specific contributor playbook
3. `src/shared/types.ts` — the contract every adapter implements
4. `src/networks/awin/adapter.ts` — the canonical reference; read the file-level
   header comment and the inline "why" notes on `mapTransactionStatus`,
   `computeAgeDays`, `chunkDateRange`, `generateTrackingLink`, and the
   aggregator import pattern.
5. The specific files relevant to your task.

When in doubt: open an issue describing the question, read Awin again, do not
guess at the shape of `src/shared/types.ts`.

## Before touching code

1. Confirm the task type: docs-only, adapter implementation, setup flow, skill,
   workflow, fixture, generated report, or infrastructure.
2. Read the files that own the relevant contract before editing. For adapters,
   read `src/shared/types.ts` and the Awin reference first.
3. Check `git status --short` and preserve any existing user changes.
4. Keep the change set small. Do not combine unrelated docs, code, fixtures,
   generated files, and dependency changes in one PR.
5. If the user asks for documentation or alignment, do not edit source code.
   Keep the PR documentation-only. At the end, run `git diff --name-only` and
   confirm that only Markdown, docs, templates, or GitHub community files
   changed.

## Documentation-first behaviour

- Prefer updating docs when the requested change is about product direction,
  contributor guidance, setup clarity, known limitations, or workflow framing.
- Do not make runtime changes to make a documentation point.
- If docs and code disagree, document the mismatch in the PR and only change
  code when the user explicitly asked for implementation.
- Keep prose practical. Avoid hype, vague claims, and startup language.
- Avoid em dashes in new prose. Use commas, colons, semicolons, or short
  sentences.

## Branch naming

Use descriptive branch names that explain the work:

- `docs/manifesto-product-direction`
- `docs/contribution-onboarding`
- `feat/network-skimlinks-publisher`
- `feat/network-awin-advertiser-tools`
- `fix/impact-pagination`
- `fix/cj-auth-error-envelope`
- `chore/cowork-install-flow`

Avoid random poetic names, vague names such as `updates` or `fixes`, and
generated names that do not explain the work.

## PR discipline

- One PR should do one thing. Split product docs, adapter behaviour, generated
  reports, and dependency changes unless the maintainer explicitly asks for a
  combined change.
- Explain what changed, why it changed, how it was checked, and what remains
  uncertain.
- For AI-assisted PRs, state what the assistant generated and what a human or
  agent manually reviewed.
- Do not include credentials, real account IDs, unsanitised fixtures, or local
  config files.
- Run the relevant commands from this file. For docs-only changes, at minimum
  inspect the diff and confirm the changed paths are documentation or GitHub
  community files only.

## Delivery and review protocol

Start each change from one user outcome. Before implementation, identify:

- the architectural layer that owns the behaviour;
- any PRs or decisions it depends on;
- any public MCP, domain, CLI, or client contract it changes;
- the failure modes and deliberately excluded scope.

Keep provider-neutral domain behaviour in shared core and MCP layers. Claude,
Codex, Desktop, CLI, and other client integrations should remain thin clients
of those shared contracts. Do not solve a client-parity problem by duplicating
domain behaviour inside each client.

Create and merge a small decision PR before implementation when the work has an
unresolved architecture, public-contract, security, payment, licensing,
action-execution, or cross-client decision. Record the decision under
`docs/decisions/YYYY-MM-DD-<slug>.md` with context, the chosen direction,
rejected alternatives, consequences, and implementation follow-ups. Keep
dependent implementation PRs draft until the decision or foundation PR merges.

Split a PR when it combines independent user outcomes or separable high-risk
domains. Tests, directly related docs, fixtures, and generated artefacts may
stay with their feature. A PR over 1,000 additions or 20 changed files is not
automatically rejected, but its description must explain why splitting would
make the change harder to understand or validate.

Use the repo-local `prepare-for-review` skill before opening, updating, or
requesting review on a PR. Use the repo-local `review-pr` skill for independent
review and re-review. Both are available to Claude Code and Codex. Only one
PR at a time may actively await `@offmann`'s review. Other work may continue in
draft. A PR is review-ready only when:

- it is conflict-free and based on its intended foundation;
- CI is green;
- the review brief is complete;
- no product or architecture decision needed for this PR remains unresolved;
- the complete diff has been inspected by the coding agent;
- the PR has one coherent outcome and an explicit split rationale when large.

The coding agent owns CI failures caused by its branch and should diagnose and
repair them before requesting review. Reviewers may repair or rerun CI when
explicitly asked to unblock the PR, but should keep the fix on the existing
branch and report the exact proof.

Request `@offmann` for changes involving shared/public contracts,
cross-network semantics, authentication or security, write actions or consent,
payments or licensing, deployment architecture, cross-client architecture, or
product-direction decisions with implementation consequences. Routine isolated
changes do not require this risk-based review gate. A PR author must never be
requested to review their own PR; when `@offmann` authors a risk-based change,
request the maintainer instead.

## Conventions

- **TypeScript strict.** `tsconfig.json` runs strict mode and `noUnusedLocals`.
  The dev variant `tsconfig.dev.json` widens to include tests.
- **UK English.** The user-visible noun is "programme", not "program". Spellings:
  "behaviour", "recognise", "normalise", "licence" (noun), "centralise". Lint
  is not configured to enforce this — review your own prose.
- **Principle 4.1** (errors): every failure surfaces through a
  `NetworkErrorEnvelope` from `src/shared/types.ts`. The envelope names the
  network and the operation, carries the verbatim upstream response body in
  `networkErrorBody`, never invents success, never collapses distinct failures
  to "an error occurred". Use `buildErrorEnvelope` from `src/shared/errors.ts`.
- **Resilience is the only path.** Every outbound HTTP call goes through
  `withResilience` (from `src/shared/resilience.ts`) via the per-network
  `client.ts`, except token exchange owned by `auth.ts`. Never call `fetch`
  directly outside `client.ts` or `auth.ts`. Never retry on 4xx other than 429.
- **Stderr-only logging.** Use `createLogger(component)` from
  `src/shared/logging.ts`. Logs go to stderr because stdout is the MCP transport.
  Never `console.log`.
- **Tool description pattern (PRD §5.5).** Generated tools describe the
  operation in matter-of-fact terms and name the network. Look at
  `src/tools/generate.ts` for the canonical phrasing; do not invent new shapes.
- **Tests live beside their subject.** `tests/networks/<slug>/` for adapter
  tests; `tests/fixtures/<slug>/` for verbatim API samples.

## Commands

| Command | What it does |
| --- | --- |
| `npm install` | Install dependencies. |
| `npm test` | Run vitest once. The baseline is green. |
| `npm run test:watch` | Watch mode. |
| `npm run typecheck` | `tsc -p tsconfig.dev.json` (no emit; includes tests). |
| `npm run lint` | ESLint over `src`, `scripts`, `tests`. |
| `npm run build` | Compile `src/` to `dist/`. |
| `npm run check:change -- --base origin/main` | Check newly changed lines and paths for architecture and review-scope risks. |
| `npm run dev` | Run the MCP server via `tsx` (stdio transport). |
| `npm run validate:network -- <slug>` | Validate `network.json` and run the live diagnostic if the adapter is registered. |
| `npm run generate:readme` | Regenerate the network table in README.md from each adapter's `network.json`. |
| `npm run generate:report` | Regenerate `REPORT.md`. |
| `npm run generate:report-image` | Render the summary table to PNG (needs Playwright). |

CLI entry points (built or via `npm run dev`):

- `affiliate-networks-mcp` — start the MCP server (default).
- `affiliate-networks-mcp setup [slug]` — interactive credential wizard.
- `affiliate-networks-mcp test [slug]` — run capability checks per network.
- `affiliate-networks-mcp doctor` — environment + config diagnostic.

## When adding a network

- Check whether the network exposes a public REST or GraphQL API for the side
  being added and prefer it. Where no usable API exists, a browser-driven
  adapter over the user's own authenticated session is acceptable; mark those
  operations as browser-driven and brittle.
- Start from `templates/new-network/` or the existing side-specific reference.
- Implement only the adapter contract from `src/shared/types.ts`. Do not invent
  extra generated tools for one network.
- Record unsupported, gated, or unverified operations honestly in
  `network.json`, setup docs, tests, and PR notes.
- Add scrubbed fixtures. Never commit real credentials, publisher IDs,
  advertiser IDs, order IDs, or account-specific secrets.
- Keep changes inside the new network's directory unless the task explicitly
  needs shared contract work.
- Run `npm run validate:network -- <slug>` and the standard checks before
  requesting review.

## When adding a skill or workflow

- Start with an affiliate job-to-be-done: QBR prep, anomaly review, partner
  discovery, publisher outreach, unpaid commission check, link audit, setup
  guidance, or performance brief.
- Use existing tools and adapter operations. Do not add new tool surfaces just
  because a workflow would be convenient.
- Include the assumptions, required credentials, expected inputs, and known
  unsupported cases.
- Make the workflow useful to semi-technical operators. They should not need to
  know endpoint names.
- Keep network limitations visible. A skill may explain a gap, but must not
  hide it.

## When only doing docs

- Do not edit TypeScript, tests, package files, generated reports, build config,
  dependencies, fixtures, or runtime behaviour.
- Prefer Markdown, files under `docs/`, templates, `.github/` community files,
  and repo-level contributor guidance.
- Do not regenerate README tables or REPORT unless the task explicitly asks for
  generated artefacts.
- Run `git diff --name-only` before committing and confirm the paths are docs
  or community files only.
- If a follow-up requires code, list it separately instead of implementing it.

## What not to do

- No hosted version. No OAuth proxy. The user's credentials and affiliate data
  never leave their machine. Telemetry, where enabled, must stay opt-in (off by
  default), aggregate-only, and conform exactly to `PRIVACY.md`: never
  credentials, affiliate data, or account identifiers.
- Do not modify files under `src/shared/` unless extending the contract is the
  only path forward. Open an issue first.
- Do not modify another network's adapter. Each network owns its directory.
  Cross-network changes need a co-ordinated discussion.
- Do not modify Awin's adapter except to add a missing "why" comment per
  PRD §15.30; behavioural changes require a separate PR.
- Do not add new tools beyond the `NetworkAdapter` surface. Tools are
  generated; expanding the surface changes the public contract.
- Do not commit `.env`, `~/.affiliate-mcp/.env`, or any credentials. The
  `.gitignore` covers the obvious paths; review your diff anyway.
- Do not retry on 4xx other than 429. The resilience config makes this
  enforceable; do not subvert it.
- Do not catch and ignore network errors. Throw a `NetworkError` carrying a
  populated envelope, or let one bubble up.
- Do not add a dependency without justification — current deps are
  `@modelcontextprotocol/sdk`, `pino`, `zod`. New ones need a reason in the PR.
- Do not use US spellings in user-visible strings or documentation.
- Do not `console.log`. Use the logger; logs go to stderr.

## External contract notes

- 30 tools ship at v0.1: 7 publisher operations × 4 networks (28) + 2 meta
  tools (`affiliate_list_networks`, `affiliate_run_diagnostic`).
- Tool names follow `affiliate_<network>_<snake_case_op>`. Stable.
- `NetworkErrorEnvelope` shape is stable; downstream MCP clients depend on its
  field names.
- Adding a fifth network adds 7 tools automatically — no edits to
  `src/tools/generate.ts` needed.

## Forward shape

- **Tier-ready**: paid-tier scaffolding exists in `claim_status` and the
  setup/approval fields on `NetworkMeta`. Not active at v0.1.
- **Brand-side scaffolded**: `listPublishers` and `listPublisherSectors` are on
  the adapter interface and throw `NotImplementedError` at v0.1. They light up
  in v0.2 when a network claims brand support.
- **Network claim process**: each adapter declares a `claim_status` of
  `production | partial | experimental | unsupported`. Promotion to
  `production` happens only after a live acceptance test against a real
  publisher account; the test infrastructure is queued for a later chunk.

When in doubt, read Awin and ask before refactoring shared types.
