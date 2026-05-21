# Contributing to affiliate-mcp

Thanks for considering a contribution. This document is the human-facing
companion to `.claude/skills/contribute/SKILL.md` (which targets Claude
Code). You do not need to use Claude Code to contribute — everything here
can be done by hand.

## Overview

Welcome contributions, roughly in priority order:

- **New network adapters.** [`WANTED.md`](./WANTED.md) lists the networks
  publishers most often ask for. Skimlinks, Webgains, FlexOffers, and Sovrn
  are the current top of the queue.
- **Bug fixes and adapter regressions** when a network changes its API.
- **Setup-doc improvements** — clearer screenshots, additional common-failure
  entries, dashboard navigation updates.
- **Corrections to [`REPORT.md`](./REPORT.md)** — if a claim about a
  network's API is wrong, we want to fix it. See
  [`CORRECTIONS.md`](./CORRECTIONS.md).
- **New publisher skills** that compose existing tools in useful ways.

## Code of Conduct

This project follows the Contributor Covenant 2.1. By participating you
agree to abide by [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md).

## Setup

```
git clone https://github.com/bobberrisford/affiliatemcp.git
cd affiliatemcp
npm install
npm test
npm run typecheck
npm run lint
npm run build
```

Node 20+ is required. There are no native dependencies. The test suite does
not hit any live API — fixtures live under `tests/networks/<slug>/fixtures/`.

## Adding a new network

The full playbook — including the per-step quality bar — lives in
[`.claude/skills/contribute/SKILL.md`](./.claude/skills/contribute/SKILL.md).
At the human level the path is:

1. Copy `templates/new-network/` to `src/networks/<slug>/`. Fill in
   `network.json`, `adapter.ts`, and a `findings.md` skeleton.
2. Implement the seven canonical operations from `src/shared/types.ts`.
   Operations the network does not support must return the documented
   "unsupported" envelope — never throw, never invent data.
3. Add fixtures and an adapter test under `tests/networks/<slug>/`.
4. Add a setup doc at `docs/networks/<slug>.md` (use the existing four as
   templates).
5. Wire the adapter into `src/shared/registry.ts`.
6. Run `npm run validate:network -- <slug>` and `npm run generate:readme`.
   Commit the regenerated README table.
7. Open a PR using the `new-network.md` template (see PR process below).

## Fixing a broken adapter

1. Reproduce the failure with `npx affiliate-mcp doctor <slug>`. Capture the
   verbatim diagnostic envelope.
2. Open an issue using the `network-broken.yml` template before sending a
   PR — that lets other people pile on if they are seeing the same thing.
3. Update the fixture in `tests/networks/<slug>/fixtures/` to capture the
   new upstream shape. Adjust the adapter. Add a regression test.
4. If the network's API has changed substantively, also update the relevant
   section of `docs/findings/<slug>.md` so the change is recorded in
   `REPORT.md` on the next regeneration.

## Improving setup docs

Setup docs live in `docs/networks/`. Each doc has the same structure —
prerequisites, step-by-step, common failures, "what success looks like".
Stick to that shape. Screenshots are welcome; put them under
`docs/networks/images/` with a descriptive filename.

## Filing a finding for REPORT.md

`REPORT.md` is regenerated from `docs/findings/<slug>.md` and the adapter's
`network.json`. To add or correct a finding:

- Edit `docs/findings/<slug>.md`. Each finding has a category, a verdict
  (`works`, `partial`, `broken`, `unsupported`), and a short evidence
  paragraph linking to dashboard screenshots, API docs, or HTTP traces.
- Run `npm run generate:report`. Commit the regenerated `REPORT.md`.

## PR process

1. Branch from `main`. Use a descriptive name (`feature/network-skimlinks`,
   `fix/awin-pagination`, `docs/cj-setup-clarification`).
2. Make sure `npm run typecheck`, `npm run lint`, `npm test`, and
   `npm run build` are all green locally.
3. Open the PR with one of the templates under
   `.github/PULL_REQUEST_TEMPLATE/`:
   - For a new network adapter, use the `new-network.md` template
     (`?template=new-network.md` in the PR-create URL).
   - For everything else, the default template (a short summary + test
     plan) is enough.
4. Tag a maintainer for review. CI must be green before merge.
5. Squash-merge is the default. Keep the squashed commit message brief and
   matter-of-fact.

## What not to do

The project has a small number of deliberate non-goals (PRD §18). Please
do not file PRs that:

- Add telemetry, analytics, error-reporting beacons, or any phone-home.
- Add a hosted service, dashboard, web UI, or credential broker. This is a
  local-only MCP server; credentials never leave the user's machine.
- Bundle credentials, sample tokens, or shared developer keys. Every user
  brings their own.
- Add affiliate-link cloaking, click-spoofing, or anything that would
  violate a network's terms of service.
- Add scraping fallbacks when a network's API is down. Surface the failure
  with the verbatim error envelope; do not invent data.
- Add a network without a real public API. (Browser-automation adapters are
  out of scope for now.)
- Marketing or promotional language anywhere in the codebase, docs, or
  generated outputs. Matter-of-fact tone, UK spelling.

## Licence note

`affiliate-mcp` is released under the MIT licence — see
[`LICENCE`](./LICENCE). By submitting a contribution you agree that your
contribution is released under the same terms.
