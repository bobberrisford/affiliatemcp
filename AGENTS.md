# AGENTS.md

This file orients AI coding agents (Claude Code and equivalents) opening
`affiliate-mcp` for the first time. Read it before touching code.

## What this project is

`affiliate-mcp` is a Model Context Protocol server that exposes four affiliate
networks — Awin, CJ Affiliate, Impact, Rakuten Advertising — to MCP-capable
clients (Claude Desktop, Claude Code, others). The user brings their own API
credentials; the server is local-only, no hosted version, no telemetry. UK
English throughout, including the canonical noun "programme".

The project is pre-launch. The full state of each network's adapter — what
ships, what is stubbed, what is known to misbehave — is in `REPORT.md`.

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
  `client.ts`. Never call `fetch` directly outside `client.ts`. Never retry on
  4xx other than 429.
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

## What not to do

- No hosted version. No OAuth proxy. No phone-home telemetry. The user's
  credentials never leave their machine.
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
