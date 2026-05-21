# affiliate-mcp

> An MCP server for affiliate networks. Bring your own keys.

**Status:** pre-launch. The four bundled adapters ship with `claim_status: partial` until they have been exercised against real publisher accounts.

## What this is

`affiliate-mcp` is a Model Context Protocol server that exposes affiliate
network APIs as MCP tools. With four networks bundled — Awin, CJ Affiliate,
Impact, and Rakuten Advertising — it surfaces roughly 30 tools that a
publisher can call from any MCP-capable client (Claude Desktop, Claude Code,
or any other) to answer questions like "which programmes are still pending
after 90 days?" without logging in to four dashboards.

The server runs locally on your machine. There is no hosted service, no
account, and no telemetry. Credentials live in `~/.affiliate-mcp/.env` with
file mode `0600`; they never leave your host. You bring your own publisher
keys for each network you want wired in.

The companion document [`REPORT.md`](./REPORT.md) describes — in matter-of-fact
terms — what each network's API supports, what it does not, and what is known
to be flaky. It is regenerated from each adapter's `network.json` and findings
docs, so it stays in step with the code.

## Quick-start

Install and run the interactive setup wizard:

```
npx affiliate-mcp setup
```

The wizard walks one network at a time, validates each credential against the
live API as you enter it, and writes the configuration to
`~/.affiliate-mcp/.env` with permissions `0600`. No telemetry. No phone-home.

Once configured, point your MCP client at the server. A sample Claude Desktop
config lives at [`examples/claude-desktop-config.json`](./examples/claude-desktop-config.json)
(with explanatory notes at [`examples/claude-desktop-config.md`](./examples/claude-desktop-config.md)):

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
| eBay Partner Network | 10 min | yes (~3 days) | 7 / 7 | see notes |
| Impact | 6 min | no | 7 / 7 | upstream variability |
| Rakuten Advertising | 12 min | yes (~5 days) | 6 / 7 | clicks gated |
<!-- AFFILIATE_MCP_NETWORK_TABLE_END -->

The table above is regenerated from each adapter's `network.json` by
`npm run generate:readme`. For a per-network breakdown — operation-level
support, latency, known limitations, and full findings prose — see
[`REPORT.md`](./REPORT.md).

## Per-network setup

Each bundled network has a short setup document covering dashboard navigation,
credential locations, and common stumbling blocks:

- [Awin](./docs/networks/awin.md) — API token + publisher ID.
- [CJ Affiliate](./docs/networks/cj.md) — Developer Key (GraphQL).
- [Impact](./docs/networks/impact.md) — Account SID + Auth Token.
- [Rakuten Advertising](./docs/networks/rakuten.md) — OAuth client + SID; approval required.

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

## Skills

Four packaged skills nudge an MCP-capable client toward useful workflows
without you having to remember tool names. Each lives under
`src/skills/<name>/` and ships with examples:

- [`affiliate-earnings-report`](./src/skills/affiliate-earnings-report/SKILL.md)
  — consolidated period earnings across every configured network.
- [`affiliate-network-status`](./src/skills/affiliate-network-status/SKILL.md)
  — health check: auth, reachability, supported operations.
- [`affiliate-network-setup-help`](./src/skills/affiliate-network-setup-help/SKILL.md)
  — guides the user through setup for a specific network.
- [`audit-affiliate-links`](./src/skills/audit-affiliate-links/SKILL.md)
  — checks that affiliate links on a page or sitemap still resolve to active
  programmes.

## Status report

[`REPORT.md`](./REPORT.md) is the editorial position: per-network capability,
known limitations, and where the upstream API surprised us. It is regenerated
on every adapter merge; treat it as the source of truth before opening an
issue.

## For developers

Contributions are welcome — especially new network adapters. Start with
[`CONTRIBUTING.md`](./CONTRIBUTING.md) for the human-side workflow, then read
[`AGENTS.md`](./AGENTS.md) (the primer for AI coding agents — file layout,
conventions, "what not to do") and `.claude/skills/contribute/SKILL.md` (the
playbook a Claude Code session loads automatically when you open this repo).
[`templates/new-network/`](./templates/new-network/) is the scaffold to copy.
[`WANTED.md`](./WANTED.md) lists networks and ideas explicitly on the
roadmap, and [`REPORT.md`](./REPORT.md) is the editorial baseline for any
new claim about a network's API.

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

MIT. See [`LICENCE`](./LICENCE).

## Acknowledgements

This project is only possible because the engineering teams at Awin, CJ
Affiliate, Impact, and Rakuten Advertising publish public, documented APIs
for their publisher data. The adapters here read those APIs; they do not
scrape, simulate, or work around any rate or access limits.
