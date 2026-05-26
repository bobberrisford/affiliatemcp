# Contributing to affiliate-mcp

**If you work for an affiliate network, this is for you.** The project's
working assumption is that each network is the canonical author of its
own adapter — you know your API, your dashboard, your tiers, and your
quirks better than anyone outside the company. The adapters bundled
today (Awin, CJ Affiliate, eBay Partner Network, Impact, Rakuten
Advertising, plus advertiser-side adapters for Awin, CJ, and Impact)
are placeholders until each network adopts its own. We'd rather hand
the keys over than maintain a guess at your API.

If you don't work for the network but want to contribute one anyway,
that's also welcome — see "Adding a network from outside" below.

This document is the human-facing companion to
[`.claude/skills/contribute/SKILL.md`](./.claude/skills/contribute/SKILL.md)
(which targets Claude Code). You do not need to use Claude Code to
contribute — everything here can be done by hand.

## Overview

Contributions, in roughly the order we care about:

- **Networks adopting their own adapter(s)** — see "Adopting your
  network" below. This is the canonical path. Adoption can cover the
  publisher side, the advertiser side, or both.
- **Adding a network from outside** — same workflow, smaller surface.
- **Bug fixes and adapter regressions** when a network changes its API.
- **Setup-doc improvements** — clearer screenshots, additional
  common-failure entries, dashboard navigation updates.
- **Corrections to [`REPORT.md`](./REPORT.md)** — if a claim about a
  network's API is wrong, we want to fix it.
- **New skills** that compose existing tools in useful ways — publisher
  or brand/agency side.

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

Node 20+ is required. There are no native dependencies. The test suite
does not hit any live API — fixtures live under
`tests/networks/<slug>/fixtures/`.

## Adopting your network

The canonical path: you work for the network, you have access to your
own API, and you want the adapter that ships in `affiliate-mcp` to be
the one you stand behind.

A network adapter has two possible sides:

- **Publisher side** (`src/networks/<slug>/`) — for publishers logging
  in with publisher-tier credentials. Implements the seven canonical
  publisher operations from [`src/shared/types.ts`](./src/shared/types.ts):
  `listProgrammes`, `getProgramme`, `listTransactions`,
  `getEarningsSummary`, `listClicks`, `generateTrackingLink`,
  `verifyAuth`.
- **Advertiser side** (`src/networks/<slug>-advertiser/`) — for brands
  and agencies logging in with advertiser-tier credentials. Same seven
  canonical operations, but the resolver translates a `brand` argument
  to a `networkBrandId` before each call. Awin, CJ, and Impact ship
  reference advertiser adapters today.

You can adopt one side or both, in one PR or two. Two starting points:

1. **No adapter yet for your network** (one side or both). Scaffold
   from `templates/new-network/` and follow the steps below. Skip the
   advertiser side if your network only exposes one side of its API to
   you.
2. **A placeholder adapter exists already** (you're one of the
   currently bundled networks, or a community contributor shipped
   one). Open an issue saying you want to take ownership; we'll add
   you to `.github/CODEOWNERS` for the relevant
   `src/networks/<your-slug>*/` directories and you can replace the
   implementation against your real API.

Either way, the work per side is:

1. **Implement the seven canonical operations.** Operations your API
   does not expose to that side must return the documented
   "unsupported" envelope — never throw, never invent data.
2. **Fill in `network.json`** honestly: `setup_time_estimate_minutes`,
   `setup_requires_approval` and `setup_approval_days_typical` if
   applicable, `known_limitations` for anything your API does not yet
   support, `side: 'publisher' | 'advertiser'`, and
   `credential_scope: 'single-brand' | 'multi-brand'` (advertiser
   networks where one credential set reaches many brands — Impact, CJ,
   Awin advertiser — are `multi-brand`). `claim_status: production`
   is permissible — you, the network, are the source of truth.
3. **Write the setup doc** at `docs/networks/<slug>.md` (or
   `<slug>-advertiser.md`). Use the existing docs as templates. Quote
   dashboard button names verbatim — anything the user will literally
   see.
4. **Add fixtures and adapter tests** under
   `tests/networks/<slug>/`. Strip credentials and account IDs from
   the fixtures before committing — scrub then commit, not the other
   way round. The test suite never makes a live call; everything runs
   against fixtures.
5. **Wire the adapter** into `src/networks/index.ts` (one import line).
6. **For advertiser-side: implement `listBrands()`** if
   `credential_scope: 'multi-brand'`. The setup wizard's
   brand-discovery sub-flow calls it after `verifyAuth()` succeeds and
   uses the result to populate `~/.affiliate-mcp/brands.json`.
7. **Validate, regenerate, file a finding**:

   ```
   npm run validate:network -- <slug>
   npm run generate:readme
   npm run generate:report
   ```

   Commit the regenerated `README.md` table and `REPORT.md`.
8. **Open a PR.** Use the `new-network.md` template for new adapters
   or the default template for replacing a placeholder. The full
   per-step quality bar is in
   [`.claude/skills/contribute/SKILL.md`](./.claude/skills/contribute/SKILL.md).

### What "adopting" buys you

- A `@your-handle` entry in `.github/CODEOWNERS` for your adapter
  directories so PRs touching them route to you for review.
- The placeholder is replaced; `claim_status: production` is
  permissible because the network itself is verifying the adapter.
- Future API changes route through you. We won't merge community
  patches to your adapter without your sign-off.

### What we ask in exchange

- A named contact in the PR description (a public alias is fine).
- Best-effort response to issues opened against your adapter. We
  don't expect 24/7 support — but if your API changes in a way that
  breaks the adapter, we'd appreciate a heads-up.
- That you treat the seven canonical ops as the contract. Network-
  specific extras can live as additional tools (Awin's publisher
  adapter does this), but the seven ops must speak the shared shapes.

## Adding a network from outside

Same workflow as adoption, with two adjustments:

- **Publisher side only** is the safer scope. Lighting up the
  advertiser side needs advertiser-tier credentials, and we'd rather
  wait for the network itself to do it. If you do have advertiser-tier
  credentials, the workflow is the same — just expect ownership to
  transfer to the network when it adopts the adapter.
- **`claim_status` starts at `partial` or `experimental`**, not
  `production`. Promotion to `production` happens when the network
  adopts the adapter, or after enough community evidence accumulates.

Networks people most often ask for (Skimlinks, Webgains, FlexOffers,
Sovrn) are tracked in GitHub Issues under the `good first issue`
label. Open an issue before starting so we can flag if the network
itself is already in conversation about adopting.

## Fixing a broken adapter

1. Reproduce the failure with `npx affiliate-networks-mcp doctor <slug>`.
   Capture the verbatim diagnostic envelope.
2. Open an issue using the `network-broken.yml` template before
   sending a PR — that lets other people pile on if they are seeing
   the same thing, and it pings the network's CODEOWNER if one is set.
3. Update the fixture in `tests/networks/<slug>/fixtures/` to capture
   the new upstream shape. Adjust the adapter. Add a regression test.
4. If the network's API has changed substantively, also update the
   relevant section of `docs/findings/<slug>.md` so the change is
   recorded in `REPORT.md` on the next regeneration.

If the network has a CODEOWNER, they have to approve the PR. If they
don't respond within a reasonable window and users are stuck, a
maintainer can merge defensively and ping the CODEOWNER on the PR.

## Improving setup docs

Setup docs live in `docs/networks/`. Each doc has the same structure —
prerequisites, step-by-step, common failures, "what success looks like".
Stick to that shape. Screenshots are welcome; put them under
`docs/networks/images/` with a descriptive filename.

## Filing a finding for REPORT.md

`REPORT.md` is regenerated from `docs/findings/<slug>.md` and the
adapter's `network.json`. To add or correct a finding:

- Edit `docs/findings/<slug>.md`. Each finding has a category, a
  verdict (`works`, `partial`, `broken`, `unsupported`), and a short
  evidence paragraph linking to dashboard screenshots, API docs, or
  HTTP traces.
- Run `npm run generate:report`. Commit the regenerated `REPORT.md`.

## API gaps and browser handoffs

Some things the networks let publishers do — apply to a programme, change
a payout method, download a creative ZIP, accept revised terms — only
exist in the dashboard. There is no API. Rather than refusing those
requests or pretending they failed, an adapter operation can return an
`ApiGapResponse` describing the gap and (when possible) a `BrowserHandoff`
the calling agent can drive in the user's own authenticated browser
session (e.g. via Claude for Chrome).

Both types live in `src/shared/types.ts`. An `ApiGapResponse` is **never
thrown** — it is a normal return value. The calling agent surfaces
`userMessage` to the user verbatim and waits for an explicit yes.

### When to use it

Use an `ApiGapResponse` when:

- The network's API has no endpoint for the requested operation, **and**
- The operation does exist in the publisher dashboard, **and**
- The flow is something a user could reasonably authorise an agent to do
  on their behalf.

Do **not** use it as a fallback when the API is *down* — that case still
goes through `NetworkErrorEnvelope` (principle 4.1). API gaps are a
permanent shape of the network's surface; outages are not.

### `userMessage` — the phrasing rules

`userMessage` is the sentence the calling agent shows the user. It is
the product. These rules are not stylistic; they preserve trust:

1. **Name the network and the limitation factually.** "X's API doesn't
   support Y" — not "this isn't supported" (sounds like our bug) and not
   "X doesn't let you" (sounds like blame).
2. **Hedge the offer with "try" or "probably".** Browser handoffs are
   best-effort. Never write "I'll do it" or "I can do this."
3. **State the prerequisite once, plainly.** "You'll need Claude for
   Chrome and to be logged in" — no wall of caveats.
4. **For mutating actions, mention the confirm step in the same
   sentence as the offer.** Don't bury it.
5. **End with a question.** The user opts in every time. No silent
   fallback from API to browser.
6. **UK spelling.**

When no fallback path is known, set `browserFallback: null` and let
`userMessage` invite the user to teach us:

> "Rakuten's API doesn't support this, and I don't have a known browser
> flow for it either. If you can point me at the dashboard page where
> you'd normally do it, I can try to drive it from there."

### `BrowserHandoff` — the payload

The handoff is consumed by one general-purpose browser-agent skill,
not a per-operation playbook. Keep it network-agnostic:

- `goal` — plain English, names the network and the specific target
  (campaign id, payout id, etc.).
- `startingUrl` — an https URL the user owns access to. Never embed
  credentials.
- `inputs` — the data the agent will fill in. Document the schema in
  the adapter method's docstring; the type is `Record<string, unknown>`
  by design.
- `constraints` — hard rules. Every mutating handoff must include
  "show the user a summary and wait for explicit confirmation before
  clicking submit". Anything page-specific (don't modify payout
  fields, don't accept new ToS the user hasn't seen) goes here too.
- `mutates` — true if the flow submits anything. The consumer skill
  uses this to enforce the confirm step regardless of constraint
  wording.
- `verify` — how to know it worked. A URL to revisit and a string
  describing what should now be true.
- `hints` (optional) — selectors or step sequences the adapter
  happens to know. **Best-effort, not contracts.** If they drift, the
  agent should retry from the goal, not give up.

### What this is not

- It is not a permission to scrape read paths the API does cover. If an
  endpoint exists, use it.
- It is not a permission to automate login, solve captchas, or store
  credentials. The user is already authenticated in their own browser;
  that is the whole reason this works.
- Handoffs do not get their own `findings.md` verdict. They show up in
  `capabilitiesCheck` as supported with `note: 'via browser handoff'`.

A worked example lives in `src/networks/impact/adapter.ts` →
`applyToProgram`.

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
4. Tag the CODEOWNER if one is set; otherwise tag a maintainer. CI
   must be green before merge.
5. Squash-merge is the default. Keep the squashed commit message brief
   and matter-of-fact.

## What not to do

The project has a small number of deliberate non-goals. Please do not
file PRs that:

- Add telemetry, analytics, error-reporting beacons, or any phone-home.
- Add a hosted service, dashboard, web UI, or credential broker. This
  is a local-only MCP server; credentials never leave the user's
  machine.
- Bundle credentials, sample tokens, or shared developer keys. Every
  user brings their own.
- Add affiliate-link cloaking, click-spoofing, or anything that would
  violate a network's terms of service.
- Add write operations that move money or reputation on the advertiser
  side — approving publishers, paying out commission, editing
  programme terms. Read-only insight ops only at this stage.
- Add scraping fallbacks when a network's API is down. Surface the
  failure with the verbatim error envelope; do not invent data.
- Add a network without a real public API. Pure browser-automation
  adapters (a network whose entire surface is scraped) remain out of
  scope. **Browser handoffs for API gaps** — operations the network's
  API genuinely does not expose — are in scope; see "API gaps and
  browser handoffs" above.
- Mix tiers in one adapter folder. If a network's brand-tier needs a
  separate credential bundle, prefix the env vars (e.g.
  `AWIN_ADVERTISER_*`) and ship a separate `<slug>-advertiser/`
  adapter. Do not silently extend the publisher credential.
- Marketing or promotional language anywhere in the codebase, docs, or
  generated outputs. Matter-of-fact tone, UK spelling.

## Licence note

`affiliate-mcp` is released under the MIT licence — see
[`LICENCE`](./LICENCE). By submitting a contribution you agree that
your contribution is released under the same terms.
