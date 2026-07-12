# `premium-skills/`

Content for the paid, maintained skill packs described in
[`docs/decisions/2026-07-01-desktop-premium-skill-packs.md`](../docs/decisions/2026-07-01-desktop-premium-skill-packs.md)
(accepted 2026-07-01). This tree is **not** part of the free product surface:

- it is deliberately kept out of `package.json`'s `files` array, so it does not
  ship in the published npm package or the `.mcpb` bundle;
- it is a sibling of `skills/`, not a subdirectory, so the Claude plugin
  manifest's auto-discovery of `skills/` does not pick it up;
- nothing under here is wired into the desktop app, an entitlement check, or
  billing. That is explicitly out of scope for this content — see
  "What ships here" below.

Each pack is a folder of `SKILL.md` folders in exactly the same shape as
`skills/`: YAML frontmatter (`name`, `description` with quoted trigger
phrases) plus prose operating instructions, and an `examples/` folder with at
least one worked example. The structural conventions, tone, and honesty rules
in [`skills/README.md`](../skills/README.md) and `AGENTS.md` ("When adding a
skill or workflow") apply here without change.

## Packs

### `agency-pack/`

Deeper agency/account-manager workflows, launched 2026-07-12 per Rob's pack
selection:

- [`qbr-prep/`](./agency-pack/qbr-prep) — a presentation-ready QBR narrative
  and commitment-tracking builder.
- [`client-weekly-report/`](./agency-pack/client-weekly-report) — a
  batch, branded Monday note across every client in the book in one pass.
- [`portfolio-rollup/`](./agency-pack/portfolio-rollup) — multi-period book
  trend and peer benchmarking across clients, plus cross-client partner
  concentration.

Each of these deliberately extends a **free** skill
(`programme-performance-report` or `agency-portfolio-rollup`) rather than
duplicating it. See each `SKILL.md`'s "Premium scope note" for exactly what is
already free and what this pack adds. This matters: the decision record's D3
amendment forbids moving anything already free behind the paywall, so none of
these packs may re-sell what the free skill already produces.

### `publisher-money-pack/`

Deeper publisher money-tracking workflows, also launched 2026-07-12:

- [`unpaid-commission-chaser/`](./publisher-money-pack/unpaid-commission-chaser)
  — multi-tier chase escalation with cross-source reconciliation, beyond the
  free skill's single first-touch draft.
- [`earnings-rollup/`](./publisher-money-pack/earnings-rollup) — multi-period
  earnings trend, concentration risk, and payment-timing forecasting, beyond
  the free skill's single-period snapshot.
- [`reversal-investigation/`](./publisher-money-pack/reversal-investigation)
  — a publisher-side reversal/decline deep dive with an evidence pack for
  raising a dispute. Net new: no free skill covers this today.

## What ships here (and what does not)

This PR is content and packaging only:

- no billing, entitlement check, or desktop "premium shelf" UI;
- no change to `src/`, `package.json`'s `files`, or the plugin manifest;
- no new MCP tool surface. Every tool a skill cites already exists; see the
  structural test in `tests/skills/premium-skills-exist.test.ts`, which
  validates frontmatter, trigger phrases, real tool citations, and example
  files for every skill under this tree, the same way
  `tests/skills/skills-exist.test.ts` validates `skills/`.

Wiring this content into the desktop app's "pick" flow, the premium shelf, and
the entitlement gate is later, separate work per the decision record's
implementation order (steps 3–4 land before a premium shelf can show step 5's
content).

## Known limitation of this content itself

Every skill here inherits the same per-network capability variance as the
free skills: an operation may be unsupported, gated, or unverified on a given
adapter. Each `SKILL.md` states its required tools and how to handle a
network that does not support one, exactly as the free skills do. No premium
skill invents a capability an adapter does not have.
