# Glama submission — affiliate-mcp

Submit at https://glama.ai/mcp/servers. Glama's listing form asks for a
name, repository URL, short and long descriptions, install commands, a
sample MCP client snippet, and a list of supported tools / categories.
The text below is the matter-of-fact body to paste; `[FILL IN]` markers
are filled at submission time.

## Fields to fill in

- [ ] Repository URL: `[FILL IN]`
- [ ] Maintainer handle on Glama (or GitHub if Glama auto-links): `[FILL IN]`
- [ ] Logo / icon (optional, v0.1 ships none): `[FILL IN]`
- [ ] Screenshot(s): `docs/images/report-table.png` (the summary table)
      and a terminal capture of `affiliate-mcp setup` running. Both
      `[FILL IN]` until captured.
- [ ] Tag(s) (Glama allows multiple): `publisher`, `data`, `affiliate`,
      `local-only`. Pick whichever ≤3 the form accepts.

## Name

`affiliate-mcp`

## Short description (one sentence)

A Model Context Protocol server for affiliate-network APIs (Awin, CJ
Affiliate, eBay Partner Network, Impact, Rakuten Advertising), run
locally with the publisher's own credentials.

## Long description

`affiliate-mcp` is a Model Context Protocol server that exposes five
affiliate-network APIs through a single uniform interface to any
MCP-capable client. It ships with adapters for Awin, CJ Affiliate, eBay
Partner Network, Impact, and Rakuten Advertising. Each adapter
implements seven canonical publisher operations: `list_programmes`,
`get_programme`, `list_transactions`, `get_earnings_summary`,
`list_clicks`, `generate_tracking_link`, and `verify_auth`. At five
networks the server exposes 35 tools (7 × 5 + 2 meta tools).

The server is local-only: no hosted version, no account, no telemetry.
Publisher credentials live in `~/.affiliate-mcp/.env` with file mode
`0600` and never leave the host. An interactive setup wizard
(`affiliate-mcp setup`) walks one network at a time and validates each
credential against the live API before writing it. A diagnostic CLI
(`affiliate-mcp test`, `affiliate-mcp doctor`) produces issue-paste-ready
JSON for triage.

Adapter quality is graded explicitly. Each adapter declares a
`claim_status` of `production`, `partial`, `experimental`, or
`unsupported`. Known limitations per network — for example, Awin and CJ
Affiliate do not expose click-level data; Rakuten's clicks endpoint is
paid-tier-gated; EPN's transaction reporting has a 24-48h delay — are
listed in each network's manifest and surfaced in `REPORT.md`. The
report regenerates from the manifests on every adapter change.

## Install

```
npm install -g affiliate-mcp
```

Or:

```
npx affiliate-mcp
```

Then:

```
affiliate-mcp setup
```

## Sample MCP client configuration

The repository's `examples/claude-desktop-config.json` is the
maintained reference. Minimum shape:

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

## Tool surface

Per configured network, the seven canonical publisher tools are exposed
as `affiliate_<network>_<snake_case_op>`:

- `affiliate_<network>_list_programmes`
- `affiliate_<network>_get_programme`
- `affiliate_<network>_list_transactions`
- `affiliate_<network>_get_earnings_summary`
- `affiliate_<network>_list_clicks`
- `affiliate_<network>_generate_tracking_link`
- `affiliate_<network>_verify_auth`

Two cross-network meta tools are always present:

- `affiliate_list_networks` — enumerate active adapters and their
  `claim_status` values.
- `affiliate_run_diagnostic` — run the diagnostic engine and return
  per-network capability results.

## Supported networks

- Awin
- CJ Affiliate
- eBay Partner Network
- Impact
- Rakuten Advertising

## Bring your own keys

`affiliate-mcp` does not include any credentials, does not provide a
shared key, and does not proxy credentials through any third party.
Publishers obtain each network's keys from that network's own
dashboard. The setup wizard documents the dashboard path step by step.

## Licence

MIT.

## Contact

Issues: `[FILL IN]/issues`. Conduct: see `CODE_OF_CONDUCT.md`.
