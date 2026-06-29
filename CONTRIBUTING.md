# Contributing to affiliate-mcp

There are four ways to help, ranked by impact. Each links to live work:

1. **Adopt your network's adapter.** If you work for an affiliate
   network we ship today, take ownership of its adapter — you know
   your API better than we do. See the
   [`adopt-this-network`](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3Aadopt-this-network)
   issues (one per shipped network) and the "[Adopting your
   network](#adopting-your-network)" section below.
2. **Add a network we don't ship yet.** The
   [Wanted networks table in the README](./README.md#wanted) lists 20
   verified gaps with public APIs. Pick one, open a tracking issue,
   send a PR. See "[Adding a network from
   outside](#adding-a-network-from-outside)".
3. **Land a small first PR.** Browse the
   [`good-first-pr`](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3Agood-first-pr)
   queue — fixture refreshes, setup-doc screenshots, code TODOs scoped
   to ≤50 lines. Each issue has a file path, acceptance bullets, and a
   how-to-test line.
4. **Improve fixtures or setup docs.** See the
   [`fixture-refresh`](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3Afixture-refresh)
   and
   [`setup-doc`](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3Asetup-doc)
   queues.

**Review SLA.** First reply on external PRs within 24 hours on
weekdays. If you don't hear back in 48, ping `@bobberrisford` in the
PR — it slipped through.

If none of those fit, file an issue describing what you want to do.

This document is the human-facing companion to
[`.claude/skills/contribute/SKILL.md`](./.claude/skills/contribute/SKILL.md)
(which targets Claude Code). You do not need to use Claude Code to
contribute — everything here can be done by hand.

**AI-assisted PRs are welcome.** This repo ships a `contribute` skill
precisely so you can let Claude Code do the legwork — scaffolding an
adapter, wiring tests, drafting setup docs. We don't mind how a PR was
written; we care that it meets the bar. The same rules apply whether
you typed it or generated it: the seven canonical operations are the
contract, unsupported ops return the documented envelope rather than
inventing data, fixtures are scrubbed of real credentials, and CI is
green. If you used an AI assistant, give the diff the same read you'd
want a maintainer to give it before you open the PR.

## Overview

Contributions, in roughly the order we care about:

- **Networks adopting their own adapter(s)**, see "Adopting your
  network" below. This is the canonical path. Adoption can cover the
  publisher side, the advertiser side, or both.
- **New network adapters from the community**, especially publisher-side
  adapters backed by public API docs and scrubbed fixtures.
- **Bug reports and adapter regressions** when a network changes its API,
  authentication, pagination, field names, or rate limits.
- **API corrections** where our docs, fixtures, or adapter behaviour do
  not match the public API.
- **Setup-doc improvements**, clearer screenshots, additional
  common-failure entries, dashboard navigation updates, and wizard wording.
- **Fixtures** that capture real upstream response shapes after credentials,
  account IDs, order IDs, and other user-specific data have been removed.
- **Skills and workflow packs** that compose existing tools into useful
  affiliate work, such as QBR prep, anomaly review, link audits, unpaid
  commission checks, partner discovery, or outreach drafting.
- **Product docs** that explain direction, boundaries, contribution paths,
  and network ownership without marketing language.
- **Good first issues** for small docs fixes, fixture cleanup, setup guidance,
  and contained adapter corrections.

## Product direction

The project exists to make affiliate data available where affiliate work
happens. It wraps affiliate network access into local-first MCP tools, skills,
prompts, and workflow guidance so users can work with their own data in Claude,
Codex, Cowork, and compatible local stdio MCP clients. ChatGPT support requires
a separate remote HTTPS MCP path and is not shipped yet.

Useful contributions should reinforce these boundaries:

- API-first, browser as fallback. Prefer a network's public, documented API.
  Where no usable API exists, automate the user's own authenticated session to
  do what they could do by hand, and label those operations as browser-driven.
- Local-first by default. Users bring their own credentials and credentials stay
  on their machine.
- Safe typed tools. Do not ask the assistant to guess at raw API behaviour.
- Workflows over endpoint trivia. Affiliate professionals need briefs,
  diagnostics, outreach, reporting, and checks, not API memorisation.
- Honest network truth. Unsupported, gated, partial, experimental, or
  unverified support must be visible, and so must whether an operation is
  API-backed or browser-driven.

Read [`docs/product/manifesto.md`](./docs/product/manifesto.md) for the concise
product statement.

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

## AI-assisted contributions

AI-assisted PRs are welcome. Claude Code, Codex, Cursor agents, and similar
tools can be helpful for scaffolding, fixture tests, setup docs, and review
checklists. The contributor still owns the result.

Before opening an AI-assisted PR:

- Review the full diff yourself. Do not submit generated changes you cannot
  explain.
- Keep the PR small and focused. Do not mix unrelated adapter, docs, generated
  report, and dependency changes.
- Remove credentials, real account IDs, order IDs, publisher IDs, advertiser
  IDs, and user-specific data from fixtures and docs.
- Represent unsupported operations honestly. Do not return empty arrays or fake
  success for missing API support.
- Make sure CI is green, or explain clearly which command could not run and why.
- In the PR description, say what was generated, what was manually checked, and
  what remains uncertain.

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
   with `npm run scaffold:network -- <slug>` (add `--advertiser` for
   the brand side, `--name "Human Name"` to set the display name). That
   copies `templates/new-network/` into `src/networks/<slug>/`,
   substitutes the placeholders, drops the setup doc into
   `docs/networks/<slug>.md`, and stubs `tests/networks/<slug>/`. Then
   follow the steps below. Skip the advertiser side if your network only
   exposes one side of its API to you.
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
   Awin advertiser — are `multi-brand`). Set `claim_status` to the level
   supported by current evidence. Network-owned live proof can support a
   promotion request, but `production` still requires freshness and maintainer
   review.
3. **Write the setup doc** at `docs/networks/<slug>.md` (or
   `<slug>-advertiser.md`). Use the existing docs as templates. Quote
   dashboard button names verbatim — anything the user will literally
   see.
4. **Add fixtures and adapter tests** under
   `tests/networks/<slug>/`. Strip credentials and account IDs from
   the fixtures before committing — scrub then commit, not the other
   way round. The test suite never makes a live call; everything runs
   against fixtures. A fixture must mirror the **verbatim live response
   shape**, including the fields the live API omits — do not hand-write
   idealised values. A real-shaped fixture is what catches an adapter
   that keys on a field the API does not actually return. (A live Awin
   `notjoined` programmes query, for example, returns the advertiser's
   `status: "Active"` and no per-row relationship field; a fixture that
   invented relationship-style statuses hid a publisher-discovery bug
   until it surfaced against a real account.)
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
- The placeholder is replaced and your team has a clear route to verify and
  promote the adapter with current live evidence. Adoption does not
  automatically grant `production` status.
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
  `production`. Promotion requires current evidence, a freshness trail, and
  maintainer review. Network adoption helps establish ownership and access to
  live proof, but it is not a shortcut around the promotion gates.

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

## PR process

1. Branch from `main`. Use a descriptive name such as
   `docs/manifesto-product-direction`, `docs/contribution-onboarding`,
   `feat/network-skimlinks-publisher`, `feat/network-awin-advertiser-tools`,
   `fix/impact-pagination`, `fix/cj-auth-error-envelope`, or
   `chore/cowork-install-flow`. Avoid vague or generated branch names that do
   not explain the work.
2. Make sure `npm run verify` is green locally — it chains typecheck,
   lint, test, and build. If `verify` passes, CI will pass.
3. Open the PR with one of the templates under
   `.github/PULL_REQUEST_TEMPLATE/`:
   - For a new network adapter, use the `new-network.md` template
     (`?template=new-network.md` in the PR-create URL).
   - For everything else, the default template (a short summary + test
     plan) is enough.
4. For docs-only PRs, run `git diff --name-only` before opening the PR and
   confirm that only Markdown, docs, templates, or GitHub community files
   changed.
5. Tag the CODEOWNER if one is set; otherwise tag a maintainer. CI
   must be green before merge.
6. Squash-merge is the default. Keep the squashed commit message brief
   and matter-of-fact.

## What not to do

The project has a small number of deliberate non-goals. Please do not
file PRs that:

- Add telemetry, analytics, error-reporting beacons, or any phone-home beyond
  the privacy-first opt-in telemetry contract in [`PRIVACY.md`](./PRIVACY.md).
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
- Silently switch an API-backed operation to a browser fallback when the
  API is merely down. Surface the failure with the verbatim error
  envelope; do not invent data or quietly swap mechanisms. A
  browser-driven path is for networks with no usable API, and it must be
  labelled as such, not a hidden cover for an API outage.
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
