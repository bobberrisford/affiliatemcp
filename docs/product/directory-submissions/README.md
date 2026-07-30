# Directory submission pack

_Status: Current. Ready-to-paste copy, fields and assets for the aggregator and
marketplace listings in `../distribution-listings-plan.md` Tier 2._

**Scope.** This pack covers the catalogues and client marketplaces. The **Claude
and ChatGPT connector directories are owned by
[`../directory-listing-submissions.md`](../directory-listing-submissions.md)**;
use that document's copy for those two, not this one. The MCP Registry is
handled in the repository itself (`server.json`, see `RELEASING.md`) and needs
no form.

**An agent prepares; Rob submits.** Nothing here is submitted by an agent.

**Take live values at submission time.** Everything below was correct on
2026-07-29. Counts come from the `README.md` badges, maturity from
`network.json` `claim_status`, pricing from the live site. Do not retype a
number that has a source of truth.

---

## Assets

| File | Size | Where it is needed |
| --- | --- | --- |
| `logo-400.png` | 400x400 | Cline MCP Marketplace (hard requirement) |
| `logo-256.png` | 256x256 | General fallback for form uploads |
| `logo-128.png` | 128x128 | Small avatar slots |

All three are downscaled from `desktop/build/icon.png` (1024x1024), so they
match the shipped desktop app icon. Source marks in `design-system/assets/`.

---

## Shared field values

| Field | Value |
| --- | --- |
| Name | affiliate-mcp |
| Package | `affiliate-networks-mcp` (npm) |
| Registry name | `ai.agenticaffiliate/affiliate-networks-mcp` |
| Repository | https://github.com/bobberrisford/affiliatemcp |
| Website | https://agenticaffiliate.ai |
| Hosted connector | https://mcp.agenticaffiliate.ai/mcp |
| Licence | MIT |
| Author | Robert Berrisford (@bobberrisford) |
| Language | TypeScript, Node >= 20 |
| Transports | stdio (local) and streamable HTTP (hosted) |
| Auth, local | None. The user's own API keys, on their machine. |
| Auth, hosted | OAuth 2.1 authorization code with PKCE |
| Privacy | https://agenticaffiliate.ai/privacy.html |
| Security | https://agenticaffiliate.ai/security.html |
| Pricing | https://agenticaffiliate.ai/hosted.html (link it, do not retype figures) |
| Categories | analytics / reporting, or sales and marketing. Pick from the directory's own list; do not invent one. |
| Tags | affiliate, affiliate-marketing, reporting, analytics, ecommerce, awin, cj, impact, rakuten, partner-marketing |

**Maturity, stated the same way everywhere.** 86 adapters across 72 network
families. One is `production` (Awin), three are `partial` (CJ, Impact,
Rakuten), and 82 are `experimental`. Say so. Do not imply broad production
readiness.

**Never state a tool count.** Adapters register their tools automatically, so
any number typed into a listing goes stale silently.

---

## Copy

### One-liner (canonical, from `README.md`)

> Integrate your affiliate networks with Claude or Codex.

### Short, under 100 characters (matches the live registry entry)

> Affiliate network reporting in your AI client. Bring your own keys. Most adapters experimental.

### Medium, about 50 words

> affiliate-mcp is a local-first MCP server for affiliate data. It connects
> publisher and advertiser accounts across affiliate networks so you can check
> earnings, chase unpaid commissions, review programme performance and prepare
> client updates without leaving your AI client. Bring your own API keys. Most
> adapters are community-built and experimental.

### Long, about 130 words

> Affiliate reporting means opening one dashboard per network, exporting a CSV
> from each, and reconciling them in a spreadsheet. affiliate-mcp turns those
> networks into tools your AI client can query directly, so you can ask what you
> earned last month, which transactions are still unpaid after 90 days, or how a
> programme performed this quarter, and get an answer across every network at
> once.
>
> It covers both sides of the market: publishers tracking earnings and unpaid
> commissions, and advertisers or agencies reviewing programme and partner
> performance.
>
> The server runs locally and you bring your own API keys, so credentials and
> affiliate data stay on your machine. A hosted connector is available for
> clients that cannot run a local server. Most network adapters are
> community-built and experimental; the per-network state is published in the
> repository.

### Install commands

```
# Claude Desktop and most clients
npx affiliate-networks-mcp setup

# Claude Code
claude plugin marketplace add bobberrisford/affiliatemcp
claude plugin install affiliate-networks-mcp@affiliatemcp

# Codex
npx affiliate-networks-mcp install --codex
```

### Client config block

```json
{
  "mcpServers": {
    "affiliate": {
      "command": "npx",
      "args": ["-y", "affiliate-networks-mcp"]
    }
  }
}
```

---

## Per-directory instructions

Ordered by what to do first. **Hold** means the listing makes the server
one-click installable, and the tool-surface question in
`../distribution-listings-plan.md` §3 should land first: a frictionless install
into a very large tool list converts discovery into bad first impressions.

### 1. PulseMCP: claim, do not submit

https://www.pulsemcp.com/servers?q=affiliate+networks

Already listed since 22 May 2026, crawled from GitHub, roughly 158 estimated
weekly visitors, unclaimed. Claim it through the site, then correct the
description, which currently reads "Query earnings and performance data across
72+ affiliate marketing networks". Replace with the medium copy above. **Safe
now.**

### 2. mcp.so

https://mcp.so/submit

Public GitHub servers only. Repo URL, name, the medium copy, tags, logo.
**Safe now**, being a catalogue rather than an install path.

### 3. mcpservers.org

https://mcpservers.org/submit

Submission front-end for the Awesome MCP Servers site. Same fields. **Safe now.**

### 4. MCP Server Finder

https://www.mcpserverfinder.com

Form-based. Same fields. **Safe now.**

### 5. `punkpeye/awesome-mcp-servers`

https://github.com/punkpeye/awesome-mcp-servers

Pull request. Match the file's existing format exactly and keep alphabetical
order within the category. One line, using the one-liner above. **Safe now.**

### 6. Glama

https://glama.ai/mcp/servers

Not listed as of 2026-07-29. It crawls GitHub and the official registry, and the
registry entry is new, so check again before submitting. It renders the repo
README, so README quality is listing quality. **Safe now** once it appears;
claim ownership.

### 7. MCPCentral

https://mcpcentral.io/submit-server

Reportedly accepts `mcp-publisher`-based submission. The site refuses scripted
requests, so verify the mechanism by hand before spending time. **Safe now.**

### 8. Cline MCP Marketplace (**hold**)

https://github.com/cline/mcp-marketplace

Open an issue with:

- **Repo URL:** https://github.com/bobberrisford/affiliatemcp
- **Logo:** `logo-400.png` from this folder (400x400 is a hard requirement)
- **Reason for addition:**

> Affiliate marketers currently reconcile earnings by exporting a CSV from each
> network dashboard and merging them by hand. This server exposes publisher and
> advertiser reporting across 86 adapters covering 72 affiliate network
> families, so Cline users can query earnings, unpaid commissions and programme
> performance directly. It runs locally with the user's own API keys, so no
> credentials or affiliate data leave the machine. One adapter is production
> quality (Awin), three are partial (CJ, Impact, Rakuten), and the rest are
> community-built and experimental; the per-network state is published in the
> repository.

### 9. LobeHub (**hold**)

https://lobehub.com/mcp

Large catalogue with its own submission route and a one-click install path.

### 10. mcp.directory (**hold**)

https://mcp.directory

Renders one-click install panels for Cursor, Claude Desktop and VS Code, so a
listing is also an install surface.

### 11. Smithery (**hold**)

```
smithery mcp publish "https://mcp.agenticaffiliate.ai/mcp" -n agenticaffiliate/affiliate-networks-mcp
```

Publishes the hosted remote and makes it one-click installable from the
Smithery CLI.

### 12. Docker MCP Catalog (optional)

https://github.com/docker/mcp-registry

Pull request adding `servers/affiliate-networks-mcp/` with `server.yaml`,
`tools.json` and `readme.md`. Only worth it if a containerised path fits the
local-first model. Note `tools.json` would be a very large generated file.
