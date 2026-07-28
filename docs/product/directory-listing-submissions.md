# Directory listing submissions

_Status: Current. Operational brief for the connector-directory submissions named
in `solo-50k-technical-roadmap.md` Phase 2 and roadmap package 8._

Discovery, not capability, is the current bottleneck. The MCP Registry listing is
handled in the repository itself (`server.json`, see `RELEASING.md`). This
document covers the two surfaces that are external submission forms rather than
files: the Claude connector directory and the ChatGPT connector directory.

**Preparation only.** Per `.claude/skills/affiliate-mcp-marketing/SKILL.md`, an
agent assembles the copy and assets and hands them over. Rob submits. Nothing
here is submitted, published, or posted by an agent.

## Shared facts

Every listing draws from the same set, so they cannot drift apart. Take the live
values at submission time rather than trusting any number typed below.

| Field | Value | Source of truth |
| --- | --- | --- |
| Name | affiliate-mcp | `README.md` |
| One-liner | Integrate your affiliate networks with Claude or Codex. | `README.md` blockquote |
| Network / adapter counts | Read the badges | `README.md` badges, generated from each `network.json` |
| Maturity | Most adapters are community-built and `experimental` | `REPORT.md`, `network.json` `claim_status` |
| Canonical operations | Seven publisher operations | `REPORT.md` methodology |
| Meta-tools | Seven, always present | `AGENTS.md` external contract notes |
| Hosted connector URL | `https://mcp.agenticaffiliate.ai/mcp` | `hosted/README.md` |
| Local install | `npx affiliate-networks-mcp setup`, or the `.mcpb` bundle | `README.md`, `mcpb/README.md` |
| Licence | MIT | `LICENCE` |
| Security answers | Link, do not restate | `site/security.html` ("vendor assessment, pre-answered") |
| Privacy | Link, do not restate | `PRIVACY.md`, `site/privacy.html` |
| Pricing | Link the live pricing page; do not retype figures | `site/` |

### Claims discipline

The same rule that governs site copy governs a listing, and for the same reason:
`docs/decisions/2026-07-27-hosted-trust-surface-and-web-analytics.md` exists
because published pages described a product that no longer matched reality.

- Do not imply broad production readiness. Only Awin is `production`; CJ, Impact
  and Rakuten are `partial`; the rest are `experimental`. Say so.
- Do not claim tested support for a client that has no tested setup journey.
  `docs/product/roadmap.md` §6 is the authority on which clients are proven.
- Do not restate the security or privacy posture in a listing field. Link to the
  pages that own it, so there is one place to keep correct.
- Do not hand-maintain a tool count. Adapters register their tools
  automatically (`AGENTS.md`).

## Claude connector directory

The strongest listing, because both delivery paths work for Claude: the free
local server (`.mcpb` for Claude Desktop, plugin for Claude Code) and the hosted
connector over OAuth.

Draft copy to submit:

> Ask your own affiliate data questions in Claude. affiliate-mcp connects
> publisher and advertiser accounts across affiliate networks, so you can check
> earnings, chase unpaid commissions, review programme performance, and prepare
> client updates without opening each network's dashboard. Bring your own API
> keys. The local server is free and open source; a hosted connector is
> available for people who cannot self-host. Most network adapters are
> community-built and experimental — the per-network state is published in the
> repository.

- **Category:** pick from the directory's own list at submission time. Closest
  fits are analytics/reporting or sales and marketing. Do not invent a category
  name.
- **Auth to describe:** OAuth 2.1 authorization-code with PKCE for the hosted
  connector (`docs/decisions/2026-07-15-hosted-connector-oauth.md`); the local
  path needs no account.
- **Security questionnaire:** link `site/security.html`.

## ChatGPT connector directory

**Blocked on a stale claim, not on capability.** `site/faq.html` currently
answers "which ai do i need?" with "ChatGPT requires a remote HTTPS MCP path,
which is planned but not shipped." That was true when written and is not true
now: the hosted remote MCP transport is live. Submitting a ChatGPT listing while
the public FAQ says ChatGPT is unsupported would put two contradictory claims on
two live surfaces, which is precisely the failure the trust-surface decision
corrected.

Fix `site/faq.html` first, then submit. Raise it with Rob as a small site-copy
change rather than folding it in here.

The asymmetry to state honestly in the listing itself: ChatGPT cannot run the
local stdio server, so a ChatGPT user needs the hosted connector. The free local
path is not available to them. Do not imply otherwise.

## Assets

`design-system/assets/mark.svg` and `mark-glyph.svg` are the brand marks.
Directories generally want raster icons at fixed sizes, and no PNG export of the
mark is committed. Generating those is an asset task for whoever submits; the
`affiliate-mcp-design` skill owns the rendering path.

## Open items for Rob

1. **Category choice** for each directory, from their real lists.
2. **`site/faq.html` correction** before any ChatGPT submission (see above).
3. **Raster icon export** from `mark.svg`.
4. **Submission itself**, on both directories.
