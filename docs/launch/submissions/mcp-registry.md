# MCP Registry submission — affiliate-mcp

Submit at https://github.com/modelcontextprotocol/servers (open a PR adding
an entry under the community-servers list, or use whichever submission path
the registry's CONTRIBUTING document currently specifies).

The text below is matter-of-fact and avoids marketing language; it can be
pasted into the registry entry verbatim. Fields to fill in at submission
time are flagged `[FILL IN]`.

## Fields to fill in

- [ ] Repository URL: `[FILL IN]` (e.g. `https://github.com/<owner>/affiliate-mcp`)
- [ ] Homepage URL: same as repository URL (no separate homepage at v0.1)
- [ ] Author / maintainer GitHub handle: `[FILL IN]`
- [ ] Contact email for the registry's records: `[FILL IN]`
- [ ] Screenshot(s) for the listing (if requested): `docs/images/report-table.png`
      once rendered, plus a terminal screenshot of `affiliate-networks-mcp setup`
      running; both `[FILL IN]` until captured.

## Short description (one sentence)

A Model Context Protocol server that exposes five affiliate-network APIs
(Awin, CJ Affiliate, eBay Partner Network, Impact, Rakuten Advertising) as
MCP tools, run locally with the publisher's own credentials.

## Long description (3-5 sentences)

`affiliate-mcp` is an MCP server that lets any MCP-capable client — Claude
Desktop, Claude Code, or any other — query five major affiliate networks
through a single uniform interface. It ships with adapters for Awin, CJ
Affiliate, eBay Partner Network, Impact, and Rakuten Advertising, exposing
35 tools in total: seven canonical publisher operations
(`list_programmes`, `get_programme`, `list_transactions`,
`get_earnings_summary`, `list_clicks`, `generate_tracking_link`,
`verify_auth`) per network, plus two meta tools
(`affiliate_list_networks`, `affiliate_run_diagnostic`). The server runs
locally on the publisher's machine; there is no hosted service, no
account, and no telemetry. Credentials live in `~/.affiliate-mcp/.env`
with file mode `0600` and never leave the host. An interactive setup
wizard (`affiliate-networks-mcp setup`) validates each credential against the
live API as it is entered.

## Install

```
npm install -g affiliate-networks-mcp
# or, no install required:
npx affiliate-networks-mcp
```

## Example MCP client configuration

A worked Claude Desktop config is at
`examples/claude-desktop-config.json` in the repository. The minimum
shape:

```json
{
  "mcpServers": {
    "affiliate": {
      "command": "npx",
      "args": ["affiliate-networks-mcp"]
    }
  }
}
```

Restart the MCP client after editing the config. Configured networks
appear as tools prefixed `affiliate_<network>_…` (for example
`affiliate_awin_list_programmes`).

## Supported networks

- Awin (`affiliate_awin_…`)
- CJ Affiliate (`affiliate_cj_…`)
- eBay Partner Network (`affiliate_ebay_…`)
- Impact (`affiliate_impact_…`)
- Rakuten Advertising (`affiliate_rakuten_…`)

Each network's claim status, supported operations, and known limitations
are listed in `REPORT.md` and the per-network manifest
(`src/networks/<slug>/network.json`).

## Bring your own keys

The server reads publisher credentials from `~/.affiliate-mcp/.env`. The
publisher obtains each network's credentials from that network's own
dashboard; the setup wizard documents the dashboard path step by step
per network. No credentials are shared with the project, the registry,
or any third party.

## Licence

MIT. See `LICENCE` in the repository.

## Contact

Issues: `[FILL IN]/issues`. Code of Conduct contact: see
`CODE_OF_CONDUCT.md` (the contact email placeholder must be updated
before submission).
