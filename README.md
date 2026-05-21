# affiliate-mcp

> An MCP server for affiliate networks. Bring your own keys.

`affiliate-mcp` exposes four affiliate networks — Awin, CJ Affiliate, Impact,
and Rakuten Advertising — through the Model Context Protocol, so an MCP-capable
client (Claude Desktop, Claude Code, or any other) can answer questions like
"which programmes are still pending after 90 days?" without you having to log
into four dashboards.

The project is pre-launch. The companion document `REPORT.md` describes the
state of each network's API surface in matter-of-fact terms.

## Quick start

Install and run the interactive setup wizard:

```
npx affiliate-mcp setup
```

The wizard walks one network at a time, validates each credential against the
live API as you enter it, and writes the configuration to
`~/.affiliate-mcp/.env` with permissions `0600`. No telemetry. No phone-home.

Once configured, point your MCP client at the server. Example (Claude Desktop
`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "affiliate-mcp": {
      "command": "npx",
      "args": ["affiliate-mcp"]
    }
  }
}
```

Restart your client. The networks you configured will appear as tool calls
prefixed `affiliate_<network>_…`.

## Networks

<!-- AFFILIATE_MCP_NETWORK_TABLE_START -->
| Network | Setup time | Approval required | Supported ops | Notes |
| --- | ---: | --- | ---: | --- |
| Awin | 5 min | no | 6 / 7 | no clicks |
| CJ Affiliate | 8 min | no | 6 / 7 | no clicks |
| Impact | 6 min | no | 7 / 7 | upstream variability |
| Rakuten Advertising | 12 min | yes (~5 days) | 6 / 7 | clicks gated |
<!-- AFFILIATE_MCP_NETWORK_TABLE_END -->

The table above is regenerated from each adapter's `network.json` by
`npm run generate:readme`. For a per-network breakdown — operation-level
support, latency, known limitations, and full findings prose — see
[`REPORT.md`](./REPORT.md).

Per-network setup notes live under `docs/networks/`:

- [Awin](./docs/networks/awin.md)
- [CJ Affiliate](./docs/networks/cj.md)
- [Impact](./docs/networks/impact.md)
- [Rakuten Advertising](./docs/networks/rakuten.md)

## Tool surface

Each registered network exposes the seven canonical publisher operations as
MCP tools, named `affiliate_<network>_<snake_case_op>`:

- `list_programmes`, `get_programme` — programmes (joined or available).
- `list_transactions`, `get_earnings_summary` — transactions and aggregates.
- `list_clicks` — click-level data, where the network exposes it.
- `generate_tracking_link` — mint or construct a deeplink.
- `verify_auth` — confirm credentials and surface the publisher identity.

Two meta tools are always present regardless of how many networks are
configured: `affiliate_list_networks` and `affiliate_run_diagnostic`. They let
a client enumerate the active adapters and check live capabilities without
calling each per-network tool one by one.

## Status

Pre-launch. The state of each network's adapter — what is implemented, what is
stubbed, what known limitations apply — is described in
[`REPORT.md`](./REPORT.md). All four adapters currently ship with
`claim_status: partial`; promotion to `production` happens after live
acceptance testing against real publisher accounts (a later chunk).

## For developers

`affiliate-mcp` is designed to be contributed to with the help of Claude Code.
The repository ships a `templates/new-network/` scaffold and (in a future
chunk) a `.claude/skills/contribute/` skill that walks an LLM agent through
adding a new network adapter end-to-end. A `CONTRIBUTING.md` covering the
human-side workflow is on the roadmap; until then, the per-chunk handoffs in
`handoffs/` are the best entry point for understanding how the codebase fits
together.

Local development:

```
npm install
npm test
npm run typecheck
npm run lint
npm run build
```

Generators:

```
npm run generate:report       # writes REPORT.md
npm run generate:readme       # updates the table block in this README
npm run generate:report-image # renders the summary table as a PNG (needs Playwright)
```

## Licence

MIT. See [`LICENSE`](./LICENSE).
