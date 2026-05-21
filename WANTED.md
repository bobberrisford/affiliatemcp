# Wanted contributions

A running list of networks, skills, and docs work that would have the
biggest impact. Pick one. Open an issue first so we can sanity-check
scope. The detailed playbook for a new network lives in
[`.claude/skills/contribute/SKILL.md`](./.claude/skills/contribute/SKILL.md);
the human-side workflow lives in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Networks

### Tier 1 — high publisher demand

- **Skimlinks** — content-monetisation network, REST API available to
  approved publishers.
- **Webgains** — UK-strong network, REST API, similar setup story to
  Awin.
- **FlexOffers** — large US/UK network, REST API.
- **Sovrn** (Viglink successor) — content-monetisation; REST API.

### Tier 2

- **Pepperjam** (now Ascend) — REST API.
- **AvantLink** — REST API; long-standing publisher network.
- **ShareASale** — older XML API; some publishers depend on it.
- **Refersion** — REST API; primarily Shopify-merchant programmes.

### Tier 3 / niche

- **TUNE** (HasOffers) — SaaS platform that many smaller networks run
  on; one adapter potentially covers many programmes.
- **Affise** — similar pattern to TUNE.
- **Tradedoubler** — European network, REST API.

### Shipped

Move networks here as they merge.

- Awin
- CJ Affiliate
- Impact
- Rakuten Advertising

## Skill ideas

Discussed during PRD planning; none of these are implemented yet.

- **Seasonal coupon finder** — given a category and a date window, surface
  programmes that historically run promotions in that window.
- **Cross-network unpaid-sale chaser** — look across every configured
  network for transactions sitting in `pending` past the typical lock
  date and produce an actionable follow-up list.
- **Programme-categorisation auditor** — flag programmes whose declared
  category seems wrong based on their merchant URL or recent transaction
  pattern.

## Docs improvements

- Refresh per-network setup screenshots when a dashboard changes.
- Additional "common failure" entries in `docs/networks/<slug>.md` as new
  pitfalls are reported.
- Expand `docs/network-claim-process.md` once the first adapter is
  promoted from `partial` to `production`.
- Walkthrough video / asciinema cast for `affiliate-mcp setup` (linked
  from each setup doc, not bundled in the package).
