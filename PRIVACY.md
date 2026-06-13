# Privacy Policy

_Last updated: 2026-05-29_

**affiliate-networks-mcp** is a local-only, open-source tool. It is designed so
that the maintainer never sees your data.

## What we collect

**Nothing.** The maintainer and this project collect no data of any kind:

- No analytics, no telemetry, no usage tracking.
- No crash reporting.
- No account, sign-up, or registration.
- No data is ever transmitted to the maintainer or any third-party service
  operated by this project.

## How your data is handled

- The tool runs entirely on **your own machine**.
- Your affiliate-network credentials are stored locally in
  `~/.affiliate-mcp/.env`, with file permissions locked to your user account
  (mode `0600`). They never leave your computer except to authenticate
  directly with the affiliate networks you have configured.
- Affiliate data (earnings, transactions, programme performance, etc.) is
  fetched live from each network's official API at the moment you ask a
  question and processed locally. It is not forwarded anywhere by this tool.
  Persistent result caching is off by default. Setting
  `AFFILIATE_MCP_CACHE=on` stores selected programme inventory and closed
  reporting-window results locally under `~/.affiliate-mcp/cache/`, including
  raw upstream data. The cache directory uses mode `0700`, entry files use
  `0600`, open or current reporting windows always go live, and expired
  entries are deleted during later cache access.

## Who your data is shared with

The only outbound network connections this tool makes are to the **official
APIs of the affiliate networks you configure**, for example:

- Awin — `api.awin.com`
- CJ (Commission Junction) — `api.cj.com`
- eBay Partner Network — `api.ebay.com`
- Impact — `api.impact.com`
- Rakuten Advertising — `api.linksynergy.com`

These connections use credentials **you** supply, and the networks receive only
the same API requests they would receive from their own dashboards. Each
network's own privacy policy governs the data it returns.

## Your control

Because everything is local and bring-your-own-keys, you are in full control:

- Remove a network by deleting its keys from `~/.affiliate-mcp/.env`.
- Delete locally cached results with `affiliate-networks-mcp cache clear`.
- Uninstall entirely with `npx affiliate-networks-mcp uninstall` (or
  `claude plugin uninstall affiliate-networks-mcp`), then delete the
  `~/.affiliate-mcp/` directory.

## Contact

Questions about this policy: open an issue at
<https://github.com/bobberrisford/affiliatemcp/issues>.
