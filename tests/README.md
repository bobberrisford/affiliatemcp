# `tests/`

The vitest suite. No live API calls — every adapter test reads
verbatim API samples from `fixtures/`. Run with `npm test` or
`npm run test:watch`.

Layout mirrors the source:

- `shared/` — unit tests for `src/shared/` primitives.
- `networks/<slug>/` — per-adapter tests; each pairs with
  `fixtures/<slug>/` for upstream response samples. Advertiser-side
  adapters have their own `<slug>-advertiser/` folders.
- `cli/` — `setup`, `test`, `doctor`, and brand-discovery subcommand
  tests.
- `tools/` — MCP tool-surface generation.
- `skills/` — structural checks on the bundled Claude skills.
- `docs/`, `governance/`, `contribute/` — content tests on README,
  AGENTS.md, the contribute skill, and the per-network setup docs.
- `integration/`, `scripts/` — end-to-end flows and script behaviour.
