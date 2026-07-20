# affiliate-mcp

> Integrate your affiliate networks with Claude or Codex.

[![npm version](https://img.shields.io/npm/v/affiliate-networks-mcp?label=release)](https://www.npmjs.com/package/affiliate-networks-mcp) ![networks](https://img.shields.io/badge/networks-72-blue) ![adapters](https://img.shields.io/badge/adapters-86-blue) [![maintained by](https://img.shields.io/badge/maintained%20by-community%20%2F%20networks-orange)](./docs/networks)

> **Network operators:** most adapters are community-built and `experimental`. Adoption gives your team ownership and a verification path; promotion to `partial` or `production` still requires current evidence and maintainer review. Find your network's issue under the [`adopt-this-network`](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3Aadopt-this-network) label.

Affiliate networks have two sides — and neither has a first-class AI workspace integration.

**Publishers** earn commissions from the programmes they join.
**Brands** (and the agencies who manage them) run those programmes
and pay the commissions out. I wanted to chat to my own affiliate
data in the AI workspace I already use; none of the networks had shipped an
integration for either side, so I built a broad beta set that covers both
publisher and advertiser-side work.

If you're a **publisher**, you can ask:

> *"What did I earn across all networks last month?"*
>
> *"Which programmes have transactions still pending after 90 days?"*
>
> *"Compare my earnings month on month."*

If you're on the **brand side** — running a programme, or an agency
managing several — you can ask:

> *"How is Acme's programme doing this quarter?"*
>
> *"Show me revenue across all my clients this week."*
>
> *"Any anomalies in the affiliate data?"*

Your AI workspace figures out which networks to call, fetches the data live from
their APIs, and gives you the answer. You can use Claude or Codex to turn it
into a sheet, an artifact, an email to your boss, whatever you want.

Free and open source. MIT licensed. Bring your own keys. For the product
philosophy, read the [AI-native affiliate data manifesto](./docs/product/manifesto.md).

## Who this is for

This tool serves two audiences. Pick the one that fits — or both, if
you wear both hats.

**You're a publisher.** You earn commissions from affiliate
programmes, your dashboards can't keep up with how fast you can think,
and you want one conversation that spans every network you're on.

**You're on the brand side.** You run an affiliate programme — or
you're an agency managing several brands' programmes. You want one
question that fans out across networks and brands, and surfaces what
the dashboards bury: publishers trending down, reversal spikes, dead
links, programmes drifting toward zero.

Either way, you do **not** need to know what an API is or write code. The
non-technical Claude Desktop track needs:

- Your existing logins to the affiliate networks you already work with.
- Claude Desktop installed.

The technical track uses a terminal, Node.js 20 or newer, and Claude Desktop,
Claude Code, Codex, or another compatible local stdio MCP client; check the support states below before relying on an untested client journey.

**And if you work for an affiliate network**, this is also for you. The
bundled adapters are placeholders until each network adopts its own. See
[`CONTRIBUTING.md`](./CONTRIBUTING.md) under "Adopting your network".

## Why bother?

**One question, every network and every brand.** "Show me earnings by
programme" hits your configured publisher networks in parallel. On the brand
side, "show me revenue across all my clients this week" fans out across every
brand and network pair you've registered.

**Plain English, not filters.** No more clicking through date pickers and saved
views. "Last quarter, status pending, sorted by amount" is the whole prompt.

**Your data, your machine, by default.** It runs locally. Your keys live in
`~/.affiliate-mcp/.env`, locked to your user account. Optional anonymous
usage telemetry is off by default and never contains affiliate data,
credentials, prompts, arguments, results, or error text. The networks see
the same API calls they'd see from their dashboard.

**Catches what dashboards bury.** Stale transactions, inactive programmes, dead
deeplinks and week-on-week drops are surfaced by the packaged skills.

**Optional local result cache.** Persistent caching is off by default. Set
`AFFILIATE_MCP_CACHE=on` in `~/.affiliate-mcp/.env` to cache selected programme
inventory and closed reporting windows locally with owner-only permissions.
Open and current windows always go live. On a shared machine where you cannot
rely on file permissions, leave caching off. Run
`affiliate-networks-mcp cache clear` to remove cached results; see
[`PRIVACY.md`](./PRIVACY.md) for the storage and retention contract.

## Getting started

Choose one of two primary tracks. Both run the same local MCP server and keep your credentials on your machine.

### Track 1: non-technical, Claude Desktop

Use the host-native Claude Desktop `.mcpb`. No Terminal, Node.js, or manual
configuration is required.

1. Download `affiliate-networks-mcp-<version>.mcpb` from the latest
   [GitHub release](https://github.com/bobberrisford/affiliatemcp/releases/latest).
2. In Claude Desktop, open **Settings → Extensions → Advanced settings →
   Install Extension…** and select the downloaded file.
3. Add credentials for the networks you use, then ask Claude
   **"What affiliate networks do you have access to?"**

The extension does not update itself: download the latest `.mcpb` and install it over the top; saved credentials are kept ([full steps for every install path](./docs/updating.md)).
The native extension currently offers secure setup fields for Awin, CJ, Impact,
and Partnerize. It runs the complete server, so an existing
`~/.affiliate-mcp/.env` continues to enable every other adapter. A portable
browser setup flow for the remaining networks is planned; until then, use the
technical track below when adding them.

The standalone Electron/DMG setup app is a **fixes-only compatibility
fallback** for existing macOS users. It is not a third primary onboarding
track. See [`desktop/README.md`](./desktop/README.md) for its remaining use
case.

### Track 2: technical and semi-technical, CLI plus local stdio

You'll need Node.js 20 or newer installed. If you don't have it, use the
[Node.js download page](https://nodejs.org/).

**1. Run the setup wizard.** Open Terminal (macOS) or PowerShell (Windows):

```
npx affiliate-networks-mcp setup
```

It walks you through one network at a time, asks which **side** you want,
shows where to find each credential, then checks it against the live network.

For brand-side networks, the wizard asks which brands those credentials can
reach, then lets you pick local nicknames. The mapping is saved to
`~/.affiliate-mcp/brands.json`, see [Managing brands](#managing-brands).

**2. Check everything is wired up.**

```
npx affiliate-networks-mcp test
```

You should see one line per network: `ok` for everything that's healthy,
`error — <reason>` for anything that isn't.

**3. Connect it to your local MCP client.** Use a host-native package, the CLI
installer, or local stdio configuration. The setup wizard offers the shipped
CLI installer targets at the end automatically.

**Claude Desktop (Mac/Windows app):**

```
npx affiliate-networks-mcp install
```

Finds your Claude Desktop config, adds the `affiliate` entry alongside
anything else you already have, takes a timestamped backup first. Restart
Claude Desktop after it finishes. Flags: `--desktop` / `--code` / `--codex`
to pick one, `--all` to include Codex and skip prompting, `--dry-run` to
preview, `--force-overwrite` if
your existing config is malformed JSON.

**Claude Code (terminal):**

```
claude plugin marketplace add bobberrisford/affiliatemcp
claude plugin install affiliate-networks-mcp@affiliatemcp
```

Registers the MCP server and bundled skills in one step. (Or use the
`install` command above — it detects Claude Code too.) Already inside a
Claude Code session? Just ask it to install the affiliate-mcp plugin and it
runs these commands for you; no terminal juggling needed.

**Codex (OpenAI, terminal or IDE extension):**

```
npx affiliate-networks-mcp install --codex
```

This adds the local stdio MCP server to `~/.codex/config.toml`; the same MCP
config is used by the Codex CLI and Codex IDE extension. Manual setup:

```
codex mcp add affiliate -- npx -y affiliate-networks-mcp
```

Verify: open Codex, run `/mcp`, then ask **"What affiliate networks do you
have access to?"** This is OpenAI/Codex support, not ChatGPT connector
support. ChatGPT requires a reachable HTTPS MCP server and is scoped separately.

**Claude Cowork desktop (org accounts):**

Cowork syncs plugins from a GitHub repo, but blocks **public** repos from org
marketplaces — so you need a **private mirror** first. The setup wizard offers
this at the end, or run `install` and pick Cowork:

```
npx affiliate-networks-mcp install      # detects your clients, offers Cowork
```

(Or go straight to it: `npx affiliate-networks-mcp cowork-mirror`.)

It creates `<you>/affiliatemcp-internal` as a private repo and mirrors the
upstream into it. If you have the GitHub CLI (`gh`) signed in, it's used
automatically; otherwise it tells you exactly where to get a GitHub token and
prompts you to paste it — the same "paste a credential" flow as setting up a
network. Re-run with `--sync` to refresh against new releases.

Then, with **org-admin** access, in Cowork: **Organization settings → Plugins
→ Add plugin → GitHub** → enter `<you>/affiliatemcp-internal` → install
`affiliate-networks-mcp` from the synced marketplace.

<details>
<summary>Prefer to edit Claude Desktop config by hand?</summary>

Open the Claude Desktop config file at:

- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

Add the `affiliate` entry inside `mcpServers` — keep any siblings:

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

Restart Claude Desktop after saving.

</details>

For another local stdio MCP client, configure the server command
`npx -y affiliate-networks-mcp`. These clients are compatible in principle,
not yet tested first-party journeys. Draft PR
[#49](https://github.com/bobberrisford/affiliatemcp/pull/49) is the existing
VS Code/Copilot installer candidate.

### Client support states

These labels describe the onboarding journey, not whether every network
adapter is live-verified. "Tested" below means repository-owned automated
validation, not live proof against every host version. See
[`REPORT.md`](./REPORT.md) for adapter maturity.

| Client or path | Support state | What that means |
| --- | --- | --- |
| Claude Desktop `.mcpb` | **Shipped and release-tested** | Primary non-technical path. CI builds and smoke-tests the bundle. Secure setup fields currently cover Awin, CJ, Impact, and Partnerize. |
| Claude Desktop CLI/manual config | **Shipped and tested** | Technical local stdio path. Installer/config behaviour has automated coverage. |
| Claude Code plugin and CLI registration | **Shipped and tested** | Technical path with packaged skills and local MCP registration. |
| Codex CLI and IDE extension | **Shipped and tested** | Technical path using the shared local Codex MCP configuration. This is not ChatGPT connector support. |
| Claude Cowork private mirror | **Partially shipped** | Requires a private mirror and org-admin follow-through; it is not a simple individual setup path. |
| Cursor, VS Code, and generic local MCP clients | **Possible, not yet a tested first-party journey** | The local stdio server is compatible in principle. Client-specific setup, packaging, and support ownership are tracked in [#207](https://github.com/bobberrisford/affiliatemcp/issues/207). |
| Portable browser credential setup | **Planned, not shipped** | Intended to make all network credentials available without a terminal. Its security and DMG-retirement decision is tracked in [#206](https://github.com/bobberrisford/affiliatemcp/issues/206). |
| ChatGPT connector or remote HTTPS MCP | **Planned, not shipped** | ChatGPT cannot use this local stdio server directly. The separate remote architecture decision is tracked in [#208](https://github.com/bobberrisford/affiliatemcp/issues/208). |

**Check it worked.** In a new Claude conversation, ask **"What affiliate
networks do you have access to?"** — you should see every network you
configured. If you registered any brands, also try **"list my brands"**.

To disconnect later: `npx affiliate-networks-mcp uninstall`, or
`claude plugin uninstall affiliate-networks-mcp` for the plugin path.

## Anonymous telemetry

The project reads aggregate npm and GitHub adoption statistics. npm downloads
are downloads, not users: they include repeated `npx` runs, CI, caches, and
other automated traffic.

Optional runtime telemetry is explicitly opt-in and sent at most once per
active day. It contains package version, launch surface, a random identifier
that rotates monthly, and counts by network, operation, and coarse outcome. See
the [privacy policy](./PRIVACY.md) for the exact contract.

```sh
affiliate-networks-mcp telemetry status
affiliate-networks-mcp telemetry enable
affiliate-networks-mcp telemetry disable
```

### Troubleshooting install

**"Unknown skill: plugin" in a Claude session.** The `/plugin` syntax is a
shell command, not a chat slash command. Run `claude plugin marketplace
add ...` from your terminal, not inside the conversation.

**Cowork rejects the marketplace repo.** Confirm the repo is **private**.
Public repos are blocked for org-marketplace sync. Run `npx
affiliate-networks-mcp cowork-mirror` to create a private mirror.

**`What affiliate networks…` returns nothing.** The MCP server is loaded
but credentials are missing. Trigger the bundled
[`affiliate-network-setup-help`](./skills/affiliate-network-setup-help/SKILL.md)
skill (ask "help me set up my affiliate network credentials") or run
`npx affiliate-networks-mcp setup` in a terminal.

**Stale npm cache.** `npx --yes affiliate-networks-mcp@latest` forces a
fresh fetch. Verify the published version with
`npm view affiliate-networks-mcp version`.

## What you can ask

The packaged skills are pre-written conversation patterns. You don't
need to invoke them — Claude picks the right one based on what you
type.

### Publisher side

- **"What did I earn last month?"** — consolidated earnings report
  across every publisher network, split by status (pending, approved,
  paid, reversed), with anything unpaid >90 days flagged.
- **"Are all my affiliate networks healthy?"** — one-shot auth and
  capability check.
- **"Help me set up Awin"** *(or CJ, Impact, Rakuten)* — guided
  credential setup with dashboard menu paths quoted verbatim.
- **"Audit the affiliate links in my sitemap at https://mysite.com/sitemap.xml"**
  — reads the sitemap, classifies every affiliate link by network,
  and flags the dead or declined ones. URLs, HTML, or markdown also
  accepted directly.

### Brand side

- **"How is Acme performing this quarter?"** — single-brand report
  across that brand's bound networks. Top publishers, status splits,
  period-over-period delta.
- **"Show me revenue across all my clients this week."** — portfolio
  rollup, brand-aggregated, with a "needs attention" subsection for
  brands trending down.
- **"Any anomalies in the affiliate data this week?"** — week-over-week
  scan for revenue drops, reversal spikes, top-10 dropouts, dead
  programmes. Designed to run on a schedule via Claude's own scheduling.
- **"Set up Acme's strategy and KPIs"** — bind the brand during setup, record
  advisory context with `client-onboarding`, then reports, anomaly watches, and
  portfolio rollups use it to frame verdicts. It never authorises a network
  write or changes the figures.

## Networks

The repository currently ships 86 adapters across 72 network families. The
breadth is real, but maturity varies; most adapters are `experimental`. Check
the table below and [`REPORT.md`](./REPORT.md) before relying on one for
production work.

<!-- AFFILIATE_MCP_NETWORK_TABLE_START -->
| Network | Setup time | Approval required | Supported ops | Notes |
| --- | ---: | --- | ---: | --- |
| 2Performant | 5 min | no | 6 / 7 | no clicks |
| AccessTrade | 10 min | no | 6 / 7 | no clicks |
| Adcell | 10 min | no | 6 / 7 | no clicks |
| Addrevenue | 5 min | no | 7 / 7 | pagination quirks |
| Admitad | 15 min | no | 6 / 7 | clicks gated |
| Admitad (advertiser) | 12 min | no | 7 / 7 | see notes |
| Adrecord | 5 min | no | 6 / 7 | no clicks |
| Adservice | 10 min | no | 6 / 7 | no clicks |
| Adtraction | 5 min | no | 6 / 7 | no clicks |
| Adtraction (advertiser) | 6 min | no | 7 / 7 | see notes |
| Affilae | 5 min | no | 6 / 7 | no clicks |
| Affiliate Future | 5 min | no | 6 / 7 | no clicks |
| Affise | 10 min | no | 7 / 7 | no clicks |
| Afilio | 10 min | no | 6 / 7 | no clicks |
| Amazon Creators | 10 min | yes (~1 days) | 6 / 7 | no clicks |
| AvantLink | 10 min | no | 6 / 7 | no clicks |
| Awin | 5 min | no | 6 / 7 | no clicks |
| Awin (advertiser) | 6 min | no | 7 / 7 | see notes |
| Belboon | 10 min | no | 6 / 7 | no clicks |
| CAKE | 10 min | no | 6 / 7 | no clicks |
| CJ Affiliate | 8 min | no | 6 / 7 | no clicks |
| CJ Affiliate (advertiser) | 8 min | no | 7 / 7 | pagination quirks |
| ClickBank | 10 min | no | 6 / 7 | no clicks |
| Commission Factory | 10 min | no | 6 / 7 | clicks gated |
| Commission Factory (advertiser) | 7 min | no | 7 / 7 | pagination quirks |
| Connexity | 10 min | no | 6 / 7 | no clicks |
| Coupang Partners | 10 min | no | 6 / 7 | no clicks |
| Daisycon | 15 min | no | 6 / 7 | no clicks |
| Daisycon (advertiser) | 15 min | no | 7 / 7 | see notes |
| Digistore24 | 5 min | no | 6 / 7 | no clicks |
| eBay Partner Network | 10 min | yes (~3 days) | 7 / 7 | see notes |
| Eduzz | 10 min | no | 6 / 7 | no clicks |
| Effiliation | 5 min | no | 6 / 7 | no clicks |
| eHUB | 5 min | no | 7 / 7 | see notes |
| Everflow | 10 min | yes (~1 days) | 7 / 7 | see notes |
| Everflow (Advertiser) | 10 min | no | 7 / 7 | no clicks |
| financeAds | 10 min | yes (~2 days) | 6 / 7 | no clicks |
| FirstPromoter | 5 min | no | 6 / 7 | no clicks |
| FlexOffers | 10 min | no | 6 / 7 | no clicks |
| Flipkart Affiliate | 10 min | no | 6 / 7 | no clicks |
| GrowSurf | 10 min | no | 6 / 7 | no clicks |
| Hotmart | 10 min | no | 6 / 7 | no clicks |
| Howl | 5 min | no | 6 / 7 | clicks gated |
| Impact | 6 min | no | 7 / 7 | upstream variability |
| Impact (advertiser) | 8 min | no | 7 / 7 | see notes |
| Indoleads | 5 min | no | 6 / 7 | no clicks |
| Involve Asia | 5 min | no | 6 / 7 | no clicks |
| Kwanko | 10 min | no | 6 / 7 | no clicks |
| Kwanko (advertiser) | 10 min | no | 6 / 7 | no clicks |
| LeadDyno | 5 min | no | 6 / 7 | no clicks |
| Levanta | 5 min | no | 6 / 7 | no clicks |
| LinkConnector | 5 min | no | 6 / 7 | no clicks |
| Lomadee | 15 min | no | 6 / 7 | no clicks |
| Monetizze | 5 min | no | 6 / 7 | no clicks |
| mrge | 10 min | no | 6 / 7 | no clicks |
| NetRefer | 15 min | yes (~5 days) | 6 / 7 | no clicks |
| Offer18 | 10 min | no | 6 / 7 | no clicks |
| Optimise Media | 10 min | no | 6 / 7 | no clicks |
| Partnerize | 10 min | no | 7 / 7 | no clicks |
| Partnerize (Advertiser) | 5 min | no | 6 / 7 | no clicks |
| Partnero | 5 min | no | 6 / 7 | no clicks |
| PartnerStack | 5 min | no | 6 / 7 | no clicks |
| PartnerStack (advertiser) | 6 min | no | 7 / 7 | no clicks |
| Pepperjam | 5 min | no | 6 / 7 | no clicks |
| Post Affiliate Pro | 5 min | no | 6 / 7 | no clicks |
| Profitshare | 5 min | no | 6 / 7 | no clicks |
| Rakuten Advertising | 12 min | yes (~5 days) | 6 / 7 | clicks gated |
| Refersion | 5 min | no | 6 / 7 | no clicks |
| Rewardful | 5 min | no | 6 / 7 | no clicks |
| Scaleo | 10 min | yes (~1 days) | 7 / 7 | see notes |
| ShareASale | 10 min | no | 6 / 7 | no clicks |
| ShopMy | 10 min | no | 6 / 7 | no clicks |
| Skimlinks | 10 min | no | 6 / 7 | no clicks |
| Sovrn Commerce | 10 min | no | 6 / 7 | no clicks |
| Tapfiliate | 5 min | no | 6 / 7 | no clicks |
| Tolt | 5 min | no | 6 / 7 | no clicks |
| Tradedoubler | 15 min | no | 6 / 7 | clicks gated |
| Tradedoubler (Advertiser) | 10 min | no | 7 / 7 | no clicks |
| TradeTracker | 10 min | no | 7 / 7 | see notes |
| Travelpayouts | 5 min | no | 6 / 7 | no clicks |
| TUNE | 10 min | no | 7 / 7 | no clicks |
| ValueCommerce | 10 min | no | 6 / 7 | no clicks |
| ValueCommerce (advertiser) | 10 min | no | 6 / 7 | no clicks |
| Webgains | 10 min | no | 6 / 7 | no clicks |
| Webgains (advertiser) | 10 min | no | 7 / 7 | see notes |
| Yieldkit | 5 min | no | 7 / 7 | see notes |
<!-- AFFILIATE_MCP_NETWORK_TABLE_END -->

A few networks make you wait for approval (eBay, Rakuten) before they
hand over API access. The setup wizard tells you exactly what to do
in each case. "Supported ops" being less than 7/7 just means the
network itself doesn't expose that data to its users — not a missing
feature on our side.

The **(advertiser)** rows are the brand-side adapters. They use a
separate credential type from the publisher row (sometimes the same
auth model with a different account behind it; the per-network notes
spell out which), and the brand-id is selected per call rather than
baked into the credential. Every brand-side adapter is read-only at
v0.1 — the client refuses any non-GET HTTP method before it leaves
your machine. The full editorial position, including known upstream
quirks and the read-only stance, lives in [`REPORT.md`](./REPORT.md).

## Contribute in 10 minutes

A first PR shouldn't take longer than an evening. The path:

1. **Pick an issue.** Browse the
   [`good-first-pr`](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3Agood-first-pr)
   queue. Each has a file path, acceptance bullets, and a how-to-test
   line. Comment to claim it.
2. **Get to green.** One command runs the full pre-PR check —
   typecheck, lint, tests, build — in a few seconds:

   ```
   git clone https://github.com/bobberrisford/affiliatemcp.git
   cd affiliatemcp
   npm install
   npm run verify
   ```

   If `npm run verify` passes locally, CI will pass.
3. **Open the PR.** Use the default template (a short summary + test
   plan). First review within 24h on weekdays — see
   [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the full PR process and
   the four ranked help-wanted areas.

If you work for an affiliate network, the highest-leverage contribution
is adopting your own adapter — see the
[`adopt-this-network`](https://github.com/bobberrisford/affiliatemcp/issues?q=is%3Aissue+is%3Aopen+label%3Aadopt-this-network)
issues.

## Wanted

Networks people have asked for but that don't have an adapter yet. If
you work for one of these — or just have API access and want to
contribute — this is the most useful place to start. See
[`CONTRIBUTING.md`](./CONTRIBUTING.md) for the workflow, and open (or
pile onto) a tracking issue before you start.

<!-- AFFILIATE_MCP_WANTED_TABLE_START -->
| Network | Side wanted | Notes | Tracking issue |
| --- | --- | --- | --- |
<!-- AFFILIATE_MCP_WANTED_TABLE_END -->

## Awin reference implementation

Awin is the current reference slice for the repo's future shape. It keeps the
seven canonical publisher tools and adds Awin-specific tools for accounts,
programme details, commission groups, transaction-by-ID lookup, transaction
queries, advertiser/creative/campaign reports, Link Builder, Offers, and safe
stubs for gated Product Feed and Proof of Purchase APIs.

Start here if you want to understand the product direction:

- [AI-native affiliate data rationale](./docs/product/ai-native-affiliate-data.md)
- [Awin public API inventory](./docs/networks/awin/api-inventory.md)
- [Awin setup and live validation notes](./docs/networks/awin.md)

## Where your credentials live

When you run the setup wizard it writes a single file at
`~/.affiliate-mcp/.env` on your machine, locked to your user account
(file mode `0600`). That's the only place your API keys exist outside the
network dashboards. Both publisher and brand-side credentials live here, each
keyed by network slug; open, edit, delete, or copy it like any other file.

If you registered any brand-side networks, the wizard also writes
`~/.affiliate-mcp/brands.json` next to it, mapping your local nickname for each
brand (e.g. `acme`) to the network's brand id on every network the brand is
bound to (empty for the publisher-only path).

That local path stays free and complete; a hosted tier is planned, opt-in.

## Managing brands

The brand-side flow adds one concept: a local **brand slug**. You give each
client (or each of your own brands) a short nickname; the tool maps it to the
network's own brand id on every network the brand is registered on. A real
`brands.json` looks like this:

```json
{
  "version": 1,
  "brands": {
    "acme": [
      { "network": "impact-advertiser", "credentialId": "default", "networkBrandId": "IA-12345" },
      { "network": "cj-advertiser", "credentialId": "default", "networkBrandId": "7654321" }
    ]
  }
}
```

The same logical brand can appear under multiple networks; that's how
*"earnings for Acme across all networks"* fans out across the right brand id on
each one. You can hand-edit this file to rename, remove, or add brands, or re-run
`npx affiliate-networks-mcp setup` to register new ones interactively (the wizard
skips brands already in the file).

Three skills are tuned for the brand side:
[`programme-performance-report`](./skills/programme-performance-report/SKILL.md)
(single-brand, per-publisher rollup),
[`agency-portfolio-rollup`](./skills/agency-portfolio-rollup/SKILL.md)
(every brand × network, brand-aggregated), and
[`programme-anomaly-watch`](./skills/programme-anomaly-watch/SKILL.md)
(scheduled week-over-week anomaly scan).

## Use it from the terminal

`call` runs the same registered operations as the MCP server, for quick checks,
scripts, and CI (`call --help` for full usage). Some calls contact an upstream
network (for example `generate_tracking_link` mints a link). Schema-aware
`key=value` parsing keeps string ids, converts numbers, and takes comma-separated
or JSON arrays; `--args '<json>'` passes a full object. Results are JSON on
stdout; failures are `NetworkErrorEnvelope` JSON on stderr with a non-zero exit.

```bash
npx affiliate-networks-mcp call --list [--network awin]
npx affiliate-networks-mcp call --describe awin list_transactions
npx affiliate-networks-mcp call awin list_transactions from=2026-01-01 limit=50
```

## When something goes wrong

```
npx affiliate-networks-mcp doctor
```

That runs a live diagnostic across every configured network and tells
you, in English, what's broken and how to fix it. If a specific
network is misbehaving, append its slug:

```
npx affiliate-networks-mcp doctor rakuten
```

Most failures are one of three things: an expired token, a network
that needs your approval re-confirmed, or a credential typed with a trailing
space. The JSON also reports `clientStrategies` health; it never deletes them.

## Giving feedback

If something is missing, confusing, or you have an idea, tell us. Feedback flows
through GitHub and turns into docs fixes, adapter repairs, and roadmap items.

- **Feature request, workflow gap, or general feedback:** open a
  [feedback issue](https://github.com/bobberrisford/affiliatemcp/issues/new?template=feedback.yml).
- **Blocked during setup:** use the
  [setup-stuck](https://github.com/bobberrisford/affiliatemcp/issues/new?template=setup-stuck.yml)
  template.
- **An adapter is broken:** use
  [network-broken](https://github.com/bobberrisford/affiliatemcp/issues/new?template=network-broken.yml).
- **Open-ended question:** start a
  [Discussion](https://github.com/bobberrisford/affiliatemcp/discussions).

Feedback stays on your terms: the local product never phones home, and telemetry
(if you opt in) sends only anonymous counts, never your feedback text. How
feedback becomes a product change is documented in
[`docs/product/feedback-loop.md`](docs/product/feedback-loop.md).

## Per-network setup notes

Each network has a short page covering dashboard navigation, where to
click for credentials, and common stumbling blocks:

**Publisher side:**

- [Awin](./docs/networks/awin.md) — API token + publisher ID.
- [CJ Affiliate](./docs/networks/cj.md) — Developer Key (GraphQL).
- [eBay Partner Network](./docs/networks/ebay.md) — OAuth client + secret + campaign ID; approval required.
- [Everflow](./docs/networks/everflow.md) — API key (admin-issued); experimental, built from public docs.
- [Impact](./docs/networks/impact.md) — Account SID + Auth Token.
- [mrge](./docs/networks/mrge.md) — API key + secret + site ID; experimental, built from public docs.
- [Partnerize](./docs/networks/partnerize.md) — application key + user API key; experimental, built from public docs.
- [PartnerStack](./docs/networks/partnerstack.md) — Partner API key; experimental, built from public docs.
- [Rakuten Advertising](./docs/networks/rakuten.md) — OAuth client + SID; approval required.
- [Skimlinks](./docs/networks/skimlinks.md) — OAuth client ID + secret + publisher ID + domain ID; experimental, built from public docs.
- [Sovrn Commerce](./docs/networks/sovrn-commerce.md) — API key + secret key; experimental, built from public docs.
- [Tradedoubler](./docs/networks/tradedoubler.md) — bearer token + organisation ID; experimental, built from public docs.
- [Admitad](./docs/networks/admitad.md) — OAuth2 client ID + secret + website ID; experimental, built from public docs.
- [Adservice](./docs/networks/adservice.md) — UID + login token (cookie session); experimental, built from public docs.
- [Adtraction](./docs/networks/adtraction.md) — API token; experimental, built from public docs.
- [Afilio](./docs/networks/afilio.md) — affiliate token + Aff ID; experimental, built from public docs.
- [Commission Factory](./docs/networks/commission-factory.md) — API key; experimental, built from public docs.
- [Coupang Partners](./docs/networks/coupang-partners.md) — access key + secret key (HMAC); experimental, built from public docs.
- [Daisycon](./docs/networks/daisycon.md) — OAuth2 client ID + secret + refresh token + publisher ID; experimental, built from public docs.
- [Eduzz](./docs/networks/eduzz.md) — email + public key + API key; experimental, built from public docs.
- [FlexOffers](./docs/networks/flexoffers.md) — API key; experimental, built from public docs.
- [Hotmart](./docs/networks/hotmart.md) — OAuth2 client ID + secret; experimental, built from public docs.
- [Indoleads](./docs/networks/indoleads.md) — bearer token; experimental, built from public docs.
- [Kwanko](./docs/networks/kwanko.md) — API token; experimental, built from public docs.
- [Lomadee](./docs/networks/lomadee.md) — app token + source ID + publisher ID + report login; experimental, built from public docs.
- [Monetizze](./docs/networks/monetizze.md) — API key; experimental, built from public docs.
- [ValueCommerce](./docs/networks/value-commerce.md) — report-API key pair; experimental, built from public docs.
- [Webgains](./docs/networks/webgains.md) — API key + publisher ID + campaign ID; experimental, built from public docs.
- [Affise](./docs/networks/affise.md) — per-tenant base URL + API-Key header; tenant CPA engine; experimental, built from public docs.
- [Scaleo](./docs/networks/scaleo.md) — per-tenant base URL + API key (query param); tenant engine; experimental, built from public docs.
- [Offer18](./docs/networks/offer18.md) — per-tenant base URL + key/aid/mid (query params); tenant engine; experimental, built from public docs.
- [CAKE](./docs/networks/cake.md) — per-instance base URL + API key + affiliate ID (XML API); experimental, built from public docs.
- [NetRefer](./docs/networks/netrefer.md) — per-operator base URL + OAuth2 (Azure AD); iGaming ASR reporting; experimental, built from public docs.
- [Affilae](./docs/networks/affilae.md) — Bearer token; single-brand; FR network; experimental, built from public docs.
- [Optimise Media](./docs/networks/optimise-media.md) — apikey header (Service Account); UK/IN/APAC; experimental, built from public docs.
- [AccessTrade](./docs/networks/accesstrade.md) — Token header + site ID; SE-Asia/Japan, per-country base URL; experimental, built from public docs.
- [Travelpayouts](./docs/networks/travelpayouts.md) — X-Access-Token; global travel; experimental, built from public docs.
- [Flipkart Affiliate](./docs/networks/flipkart.md) — affiliate ID + token headers; India; experimental, built from public docs.
- [Adrecord](./docs/networks/adrecord.md) — APIKEY header; Nordic; experimental, built from public docs.
- [Addrevenue](./docs/networks/addrevenue.md) — Bearer token + channel ID; Nordic; experimental, built from public docs.
- [ShareASale](./docs/networks/shareasale.md) — affiliate ID + token + secret (signed); US; experimental, built from public docs.
- [Pepperjam](./docs/networks/pepperjam.md) — apiKey query param; US (Ascend, distinct from Partnerize); experimental, built from public docs.
- [AvantLink](./docs/networks/avantlink.md) — affiliate ID + auth key + website ID (query params); US/outdoor; experimental, built from public docs.
- [Digistore24](./docs/networks/digistore24.md) — X-DS-API-KEY header; DE digital products; experimental, built from public docs.
- [ClickBank](./docs/networks/clickbank.md) — DEV:CLERK key header + nickname; digital products; experimental, built from public docs.
- [TUNE](./docs/networks/tune.md) — NetworkId + api_key (per-tenant host); HasOffers engine; experimental, built from public docs.
- [Involve Asia](./docs/networks/involve-asia.md) — key + secret (token exchange); APAC; experimental, built from public docs.
- [TradeTracker](./docs/networks/tradetracker.md) — customer ID + passphrase + site ID (SOAP session); NL/EU; experimental, built from public docs.
- [Amazon Creators](./docs/networks/amazon-creators.md) — API key + partner tag; single programme per marketplace; experimental, built from public docs.
- [Belboon](./docs/networks/belboon.md) — magic key + user ID (CSV export); DACH; experimental, built from public docs.
- [financeAds](./docs/networks/financeads.md) — API key + publisher ID; DACH finance; experimental, built from public docs.
- [Adcell](./docs/networks/adcell.md) — API key + affiliate ID; DACH; experimental, built from public docs.
- [ShopMy](./docs/networks/shopmy.md) — Brand Partner token; US creator network; experimental, built from public docs.
- [Levanta](./docs/networks/levanta.md) — Bearer token; Amazon creator platform; experimental, built from public docs.
- [Howl](./docs/networks/howl.md) — NRTV-API-KEY header + publisher ID; creator link network; smart-link minting; experimental, built from public docs.
- [Yieldkit](./docs/networks/yieldkit.md) — api_key + secret (query params); link monetisation; clicks supported; experimental, built from public docs.
- [eHUB](./docs/networks/ehub.md) — apiKey query param + publisher ID; CZ/CEE; clicks supported; experimental, built from public docs.
- [LinkConnector](./docs/networks/linkconnector.md) — API key (query param); US; experimental, built from public docs.
- [Connexity](./docs/networks/connexity.md) — publisher ID + API key; US CPC-commerce (distinct from Skimlinks); experimental, built from public docs.
- [Affiliate Future](./docs/networks/affiliate-future.md) — API key + password (query params); UK; 1-day pull window; experimental, built from public docs.
- [Effiliation](./docs/networks/effiliation.md) — API key (query param); FR; experimental, built from public docs.
- [2Performant](./docs/networks/2performant.md) — email + password (session login); Romania; experimental, built from public docs.
- [Profitshare](./docs/networks/profitshare.md) — API user + key (HMAC-signed); Romania; experimental, built from public docs.

**Brand / advertiser side:**

- [Awin (advertiser)](./docs/networks/awin-advertiser.md) — OAuth bearer token; multi-brand via `GET /accounts`; gated to Accelerate / Advanced plans; read-only.
- [CJ Affiliate (advertiser)](./docs/networks/cj-advertiser.md) — Personal Access Token (GraphQL); multi-brand via CID list; read-only.
- [Everflow (advertiser)](./docs/networks/everflow-advertiser.md) — API key (admin-issued); multi-brand; experimental, built from public docs.
- [Impact (advertiser)](./docs/networks/impact-advertiser.md) — Account SID + Auth Token; agency or brand-direct; read-only.
- [Partnerize (advertiser)](./docs/networks/partnerize-advertiser.md) — application key + user API key; multi-brand; experimental, built from public docs.
- [PartnerStack (advertiser)](./docs/networks/partnerstack-advertiser.md) — public + secret key pair (Vendor API); single-brand; experimental, built from public docs.
- [Tradedoubler (advertiser)](./docs/networks/tradedoubler-advertiser.md) — reports token + organisation ID; multi-brand; experimental, built from public docs.
- [Admitad (advertiser)](./docs/networks/admitad-advertiser.md) — OAuth2 client ID + secret + advertiser ID; multi-brand; read-only; experimental, built from public docs.
- [Adtraction (advertiser)](./docs/networks/adtraction-advertiser.md) — API token; multi-brand; read-only (POST-read allowlist); experimental, built from public docs.
- [Commission Factory (advertiser)](./docs/networks/commission-factory-advertiser.md) — API key; read-only; experimental, built from public docs.
- [Daisycon (advertiser)](./docs/networks/daisycon-advertiser.md) — OAuth2 client ID + secret + refresh token; multi-brand; read-only; experimental, built from public docs.
- [Kwanko (advertiser)](./docs/networks/kwanko-advertiser.md) — API token; multi-brand; read-only; experimental, built from public docs.
- [ValueCommerce (advertiser)](./docs/networks/value-commerce-advertiser.md) — report-API key pair; multi-brand; read-only; experimental, built from public docs.
- [Webgains (advertiser)](./docs/networks/webgains-advertiser.md) — API key + account ID; multi-brand; read-only; experimental, built from public docs.
- [Rewardful](./docs/networks/rewardful.md) — API Secret (HTTP Basic); single-brand; Stripe-native SaaS; experimental, built from public docs.
- [FirstPromoter](./docs/networks/firstpromoter.md) — API key + account ID (Bearer); single-brand; SaaS-referral; experimental, built from public docs.
- [Partnero](./docs/networks/partnero.md) — API token (Bearer); single-brand; SaaS-referral; experimental, built from public docs.
- [GrowSurf](./docs/networks/growsurf.md) — API key + campaign ID (Bearer); single-brand; referral-credit SaaS; experimental, built from public docs.
- [LeadDyno](./docs/networks/leaddyno.md) — private key (query param); single-brand; SaaS-referral; experimental, built from public docs.
- [Post Affiliate Pro](./docs/networks/post-affiliate-pro.md) — per-tenant base URL + API key (Bearer); single-brand; SaaS engine; experimental, built from public docs.
- [Tolt](./docs/networks/tolt.md) — Bearer key; single-brand; SaaS-referral; experimental, built from public docs.
- [Refersion](./docs/networks/refersion.md) — public + secret key headers; single-brand; Shopify-heavy SaaS; experimental, built from public docs.
- [Tapfiliate](./docs/networks/tapfiliate.md) — X-Api-Key header; single-brand; SaaS-referral; experimental, built from public docs.

## For the curious (or technical)

`affiliate-mcp` has five practical layers. **Adapters** under `src/networks/`
handle each network's auth, API quirks, normalisation, and capability metadata.
**MCP tools** expose typed operations such as `affiliate_awin_list_transactions`;
six meta-tools cover listing, diagnostics, brand resolution, and advisory client
strategy. **Skills and workflows** compose tools into affiliate jobs. **MCP
prompts** are reusable templates and currently Awin-specific. **Setup paths**
connect the same local server to Claude Desktop, Claude Code, Codex, Cowork, or
another compatible local stdio MCP client.

The packaged skills under [`skills/`](./skills) are the conversation patterns
Claude follows for common requests. Publisher side:
[`affiliate-earnings-report`](./skills/affiliate-earnings-report/SKILL.md),
[`affiliate-network-status`](./skills/affiliate-network-status/SKILL.md),
[`affiliate-network-setup-help`](./skills/affiliate-network-setup-help/SKILL.md),
[`audit-affiliate-links`](./skills/audit-affiliate-links/SKILL.md). Brand side:
[`programme-performance-report`](./skills/programme-performance-report/SKILL.md),
[`agency-portfolio-rollup`](./skills/agency-portfolio-rollup/SKILL.md),
[`programme-anomaly-watch`](./skills/programme-anomaly-watch/SKILL.md).

For per-network capability detail, known upstream quirks, and the
editorial baseline used when accepting new network claims, see
[`REPORT.md`](./REPORT.md). It is regenerated from each adapter's
`network.json` on every merge, so it stays in step with the code.

## Repository layout

If you're poking around the source, the top-level folders are:

- [`src/`](./src) — the MCP server. Entry point `index.ts`; one folder
  per network under [`src/networks/`](./src/networks) (publisher
  adapters at `<slug>/`, advertiser adapters at `<slug>-advertiser/`);
  shared primitives under [`src/shared/`](./src/shared); bundled
  Claude skills under [`skills/`](./skills).
- [`docs/networks/`](./docs/networks) — per-network setup walkthroughs
  (dashboard navigation, credentials, common failures), publisher and
  advertiser side.
- [`docs/README.md`](./docs/README.md) — documentation map, authority order,
  and review rules.
- [`templates/new-network/`](./templates/new-network) — scaffold to
  copy when adding a new network adapter.
- [`scripts/`](./scripts) — generators and validators
  (`validate:network`, `generate:readme`, `generate:report`).
- [`tests/`](./tests) — vitest suite. No live API calls; everything
  runs against verbatim fixtures.
- [`examples/`](./examples) — Claude Desktop config snippet.

## Adding a network

**If you work for an affiliate network**, the canonical path is in
[`CONTRIBUTING.md`](./CONTRIBUTING.md) under "Adopting your network".
You can take ownership via `.github/CODEOWNERS`, verify the adapter with live
evidence, and cover whichever sides your API exposes. Adoption does not
automatically grant `production`; promotion follows the same evidence,
freshness, and maintainer-review gates as every adapter.

If your favourite network isn't in the table and you don't work for
it, you can add it anyway — and you don't necessarily need to be a
developer to do it. Open this repo in Claude Code and say *"add
[network name] to affiliate-mcp"*. The `contribute` skill kicks in
and walks the whole process: it asks early which side you're adding
(publisher, brand-side, or both), picks the right scaffold and
credential-scope conventions, researches the network's API, writes
the tests, drafts the docs. You're the editor; Claude does the
typing.

If you'd rather drive it yourself, [`CONTRIBUTING.md`](./CONTRIBUTING.md)
is the human-side workflow, [`AGENTS.md`](./AGENTS.md) is the primer
for AI coding agents, and [`templates/new-network/`](./templates/new-network/)
is the scaffold to copy. Networks people most often ask for are
tracked in GitHub Issues under the `good first issue` label.

Local development:

```
npm install
npm test
npm run typecheck
npm run lint
npm run build
```

## Status

Beta — available now. The repository contains 86 adapters across 72 network
families: 63 publisher-side and 23 advertiser-side. Support varies by adapter;
check the generated network table and [`REPORT.md`](./REPORT.md) for each
adapter's declared operations, claim status, and known limitations. Adapters
remain `partial` or `experimental` until their behaviour is confirmed against
real publisher, agency, or in-house brand accounts.

## Licence

MIT. See [`LICENCE`](./LICENCE).

## Acknowledgements

This project is only possible because the engineering teams at Awin,
CJ Affiliate, eBay Partner Network, Impact, and Rakuten Advertising
publish public, documented APIs — both the publisher endpoints and
(for Awin, CJ, and Impact) the brand-side advertiser endpoints. These
adapters read those APIs directly. Where a network has no usable API,
an adapter may instead drive the user's own dashboard session (browser-driven).
