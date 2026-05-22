# Smithery submission — affiliate-mcp

Submit at https://smithery.ai/. Smithery's listing form asks for a short
name, a category tag, a long description, install instructions, and a
sample configuration. The text below is the matter-of-fact body to paste;
fields marked `[FILL IN]` are filled at submission time.

## Fields to fill in

- [ ] Repository URL: `[FILL IN]`
- [ ] Maintainer handle on Smithery: `[FILL IN]`
- [ ] Listing icon / logo (optional): `[FILL IN]` (project ships none at v0.1)
- [ ] Screenshot(s): `docs/images/report-table.png` once rendered; a
      terminal capture of `affiliate-networks-mcp setup` running. Both `[FILL IN]`.
- [ ] Category tag: **publisher tools** (preferred). Fallback: **data**.

## Name

`affiliate-mcp`

## Tagline (≤80 chars)

Local MCP server for affiliate networks. Bring your own keys.

## Category

`publisher tools` — the server exists for affiliate-marketing publishers.
If Smithery's taxonomy does not include a publisher-tools tag, use
`data` (the tools surface programme, transaction, click, and earnings
data).

## Description

`affiliate-mcp` is a Model Context Protocol server that exposes five
affiliate-network APIs — Awin, CJ Affiliate, eBay Partner Network,
Impact, and Rakuten Advertising — through a single uniform interface
to any MCP-capable client. Each configured network exposes seven
canonical publisher operations (`list_programmes`, `get_programme`,
`list_transactions`, `get_earnings_summary`, `list_clicks`,
`generate_tracking_link`, `verify_auth`); two meta tools
(`affiliate_list_networks`, `affiliate_run_diagnostic`) sit alongside.
At five networks this is 35 tools.

The server runs locally on the publisher's machine. There is no hosted
service, no sign-up, and no telemetry. Credentials sit in
`~/.affiliate-mcp/.env` with file mode `0600`; they never leave the
host. An interactive setup wizard (`affiliate-networks-mcp setup`) walks one
network at a time and validates each credential against the live API
before writing it.

The companion document `REPORT.md` describes each network's API in
matter-of-fact terms: what each operation supports, what it does not,
and where the upstream behaviour is known to surprise. Adapters ship
with explicit `claim_status` values (`production`, `partial`,
`experimental`, `unsupported`) so the reader can tell how confident the
project is in a given operation.

## Install

```
npm install -g affiliate-networks-mcp
```

Or run on demand without installing:

```
npx affiliate-networks-mcp
```

Then run the interactive wizard once:

```
affiliate-networks-mcp setup
```

## Sample client configuration

Worked example at `examples/claude-desktop-config.json`. Minimum
shape (Claude Desktop):

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

## Supported networks

- Awin
- CJ Affiliate
- eBay Partner Network
- Impact
- Rakuten Advertising

Adapter claim status, supported operations, and known limitations per
network: see `REPORT.md` in the repository.

## Bring your own keys

`affiliate-mcp` reads publisher credentials from the local
`~/.affiliate-mcp/.env` file. The publisher obtains credentials from
each network's own dashboard. No keys are sent to the project, to
Smithery, or to any third party. The Code of Conduct contact and a
public issue tracker are the only project-side communication paths.

## Licence

MIT. Repository: `[FILL IN]`.

## Contact

Issues: `[FILL IN]/issues`. Conduct: see `CODE_OF_CONDUCT.md`.
