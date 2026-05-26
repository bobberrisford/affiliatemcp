# `src/`

The MCP server's source. `index.ts` is the CLI entry point; `server.ts`
boots the MCP stdio transport. Subdirectories:

- [`shared/`](./shared) — load-bearing primitives every adapter shares
  (types, error envelopes, resilience, config, logging, registry,
  brand resolution).
- [`networks/`](./networks) — one folder per affiliate network adapter.
  Publisher-side adapters live at `<slug>/`; advertiser-side adapters
  at `<slug>-advertiser/`.
- [`cli/`](./cli) — the `setup`, `test`, and `doctor` subcommands.
- [`tools/`](./tools) — turns each registered adapter into the MCP tool
  surface Claude calls.
- [`skills/`](./skills) — conversation patterns Claude follows for
  common publisher and brand/agency questions.
- [`prompts/`](./prompts) — MCP prompts exposed to clients.
