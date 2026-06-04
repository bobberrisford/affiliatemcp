# affiliate-mcp

> Integrate your affiliate networks with Claude or Codex.

Affiliate networks have two sides — and neither has a first-class AI workspace integration.

**Publishers** earn commissions from the programmes they join.
**Brands** (and the agencies who manage them) run those programmes
and pay the commissions out. I wanted to chat to my own affiliate
data in the AI workspace I already use; none of the networks had shipped an integration
for either side, so I built one that covers both. Well, for the
biggest networks.

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

Either way, you do **not** need to know what an API is. You do not
need to write code. You need:

- Your existing logins to the affiliate networks you already work with.
- Five minutes to run the setup wizard.
- Claude Desktop, Claude Code, or Codex installed.

That is the whole list.

**And if you work for an affiliate network**, this is also for you. The
bundled adapters are placeholders until each network adopts its own. See
[`CONTRIBUTING.md`](./CONTRIBUTING.md) under "Adopting your network".

## Why bother?

**One question, every network and every brand.** "Show me earnings by
programme" hits Awin, CJ, eBay, Impact and Rakuten in parallel. On the brand
side, "show me revenue across all my clients this week" fans out across every
brand × network pair you've registered.

**Plain English, not filters.** No more clicking through date pickers and saved
views. "Last quarter, status pending, sorted by amount" is the whole prompt.

**Your data, your machine.** It runs locally. Your keys live in
`~/.affiliate-mcp/.env`, locked to your user account. No hosted account, no
telemetry. The networks see the same API calls they'd see from their dashboard.

**Catches what dashboards bury.** Stale transactions, inactive programmes, dead
deeplinks and week-on-week drops are surfaced by the packaged skills.

## Getting started

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

**3. Connect it to Claude or Codex.** Pick the path that matches your client.
The setup wizard offers this at the end automatically.

**Claude Desktop (Mac/Windows app) — most users:**

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
`install` command above — it detects Claude Code too.)

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

**Check it worked.** In a new Claude conversation, ask **"What affiliate
networks do you have access to?"** — you should see every network you
configured. If you registered any brands, also try **"list my brands"**.

To disconnect later: `npx affiliate-networks-mcp uninstall`, or
`claude plugin uninstall affiliate-networks-mcp` for the plugin path.

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

## Networks

Five network families are bundled today. Three of them — **Awin**,
**CJ Affiliate**, and **Impact** — ship adapters for both the
publisher and the advertiser side, so the same network appears on
two rows. **eBay Partner Network** is publisher-only (eBay is the
sole advertiser on its own network — no brand-side product to
integrate with). **Rakuten Advertising** is publisher-only at v0.1;
the brand-side has a more complex auth model and we skipped it.

<!-- AFFILIATE_MCP_NETWORK_TABLE_START -->
| Network | Setup time | Approval required | Supported ops | Notes |
| --- | ---: | --- | ---: | --- |
| Admitad | 15 min | no | 6 / 7 | clicks gated |
| Adservice | 10 min | no | 6 / 7 | no clicks |
| Adtraction | 5 min | no | 6 / 7 | no clicks |
| Afilio | 10 min | no | 6 / 7 | no clicks |
| Awin | 5 min | no | 6 / 7 | no clicks |
| Awin (advertiser) | 6 min | no | 7 / 7 | see notes |
| CJ Affiliate | 8 min | no | 6 / 7 | no clicks |
| CJ Affiliate (advertiser) | 8 min | no | 7 / 7 | pagination quirks |
| Commission Factory | 10 min | no | 6 / 7 | clicks gated |
| Coupang Partners | 10 min | no | 6 / 7 | no clicks |
| Daisycon | 15 min | no | 6 / 7 | no clicks |
| eBay Partner Network | 10 min | yes (~3 days) | 7 / 7 | see notes |
| Eduzz | 10 min | no | 6 / 7 | no clicks |
| Everflow | 10 min | yes (~1 days) | 7 / 7 | see notes |
| Everflow (Advertiser) | 10 min | no | 7 / 7 | no clicks |
| FlexOffers | 10 min | no | 6 / 7 | no clicks |
| Hotmart | 10 min | no | 6 / 7 | no clicks |
| Impact | 6 min | no | 7 / 7 | upstream variability |
| Impact (advertiser) | 8 min | no | 7 / 7 | see notes |
| Indoleads | 5 min | no | 6 / 7 | no clicks |
| Kwanko | 10 min | no | 6 / 7 | no clicks |
| Lomadee | 15 min | no | 6 / 7 | no clicks |
| Monetizze | 5 min | no | 6 / 7 | no clicks |
| mrge | 10 min | no | 6 / 7 | no clicks |
| Partnerize | 10 min | no | 7 / 7 | no clicks |
| Partnerize (Advertiser) | 5 min | no | 6 / 7 | no clicks |
| Rakuten Advertising | 12 min | yes (~5 days) | 6 / 7 | clicks gated |
| Skimlinks | 10 min | no | 6 / 7 | no clicks |
| Sovrn Commerce | 10 min | no | 6 / 7 | no clicks |
| Tradedoubler | 15 min | no | 6 / 7 | clicks gated |
| Tradedoubler (Advertiser) | 10 min | no | 7 / 7 | no clicks |
| ValueCommerce | 10 min | no | 6 / 7 | no clicks |
| Webgains | 10 min | no | 6 / 7 | no clicks |
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
| TradeTracker | publisher | Global, NL-headquartered. SOAP-based but functional; affiliate.tradetracker.com/webService. | [open one](https://github.com/bobberrisford/affiliatemcp/issues/new?template=new-network-request.yml&title=Add%20TradeTracker) |
| Adcell | publisher | DACH network (now under mrge holding). API exists for publishers but docs are dashboard-gated — expect reverse-engineering. | [open one](https://github.com/bobberrisford/affiliatemcp/issues/new?template=new-network-request.yml&title=Add%20Adcell) |
| ClickBank | publisher | Digital products giant. Analytics + Order APIs are public; no dev key required since 2023. | [open one](https://github.com/bobberrisford/affiliatemcp/issues/new?template=new-network-request.yml&title=Add%20ClickBank) |
| Amazon Creators API | publisher | Successor to PA-API (which deprecates 15 May 2026). Docs at affiliate-program.amazon.com/creatorsapi/docs. | [open one](https://github.com/bobberrisford/affiliatemcp/issues/new?template=new-network-request.yml&title=Add%20Amazon%20Creators%20API) |
| TUNE (HasOffers) | publisher + advertiser | Long-running CPA platform. Public REST docs at developers.tune.com. | [open one](https://github.com/bobberrisford/affiliatemcp/issues/new?template=new-network-request.yml&title=Add%20TUNE%20(HasOffers)) |
| ShopMy | publisher | US creator network. OAuth-based creator/brand API, public docs at docs.shopmy.us. | [open one](https://github.com/bobberrisford/affiliatemcp/issues/new?template=new-network-request.yml&title=Add%20ShopMy) |
| Levanta | publisher + advertiser | Amazon-focused creator platform. /partners /products /reports endpoints public (knowledge.levanta.io/creator-api). | [open one](https://github.com/bobberrisford/affiliatemcp/issues/new?template=new-network-request.yml&title=Add%20Levanta) |
| PartnerStack | publisher + advertiser | B2B SaaS partner standard. Separate Vendor + Partner APIs, both publicly documented at docs.partnerstack.com. | [open one](https://github.com/bobberrisford/affiliatemcp/issues/new?template=new-network-request.yml&title=Add%20PartnerStack) |
| Tolt | advertiser | SaaS-focused affiliate platform. Bearer-auth REST, public docs at docs.tolt.com. | [open one](https://github.com/bobberrisford/affiliatemcp/issues/new?template=new-network-request.yml&title=Add%20Tolt) |
| Rewardful | advertiser | Stripe-native SaaS affiliate tool. Public REST docs at developers.rewardful.com. | [open one](https://github.com/bobberrisford/affiliatemcp/issues/new?template=new-network-request.yml&title=Add%20Rewardful) |
| Refersion | advertiser | Shopify-heavy affiliate platform. Full public docs at refersion.dev. | [open one](https://github.com/bobberrisford/affiliatemcp/issues/new?template=new-network-request.yml&title=Add%20Refersion) |
| Tapfiliate | advertiser | Mid-market multi-platform. v1.6 X-Api-Key REST, public docs at tapfiliate.com/docs/rest. | [open one](https://github.com/bobberrisford/affiliatemcp/issues/new?template=new-network-request.yml&title=Add%20Tapfiliate) |
| Howl (Narrativ) | publisher | Independent creator / journalist link network. API key + REST documented at docs.narrativ.com. | [open one](https://github.com/bobberrisford/affiliatemcp/issues/new?template=new-network-request.yml&title=Add%20Howl%20(Narrativ)) |
| Involve Asia | publisher | APAC's growing network. Public REST docs. | [open one](https://github.com/bobberrisford/affiliatemcp/issues/new?template=new-network-request.yml&title=Add%20Involve%20Asia) |
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
(file mode `0600`). That's the only place your API keys exist outside
the network dashboards. Both publisher and brand-side credentials live
here, each keyed by network slug. Open, edit, delete, or copy it like
any other file.

If you registered any brand-side networks, the wizard also writes
`~/.affiliate-mcp/brands.json` next to it. That file maps your local
nickname for each brand (e.g. `acme`) to the network's brand id on
every network the brand is bound to. Empty for the publisher-only path.

There is no hosted service. There is no account to create with us.

## Managing brands

The brand-side flow adds one concept: a local **brand slug**. You give
each client (or each of your own brands) a short nickname; the tool
maps it to the network's own brand id on every network the brand is
registered on.

A real `brands.json` looks like this:

```json
{
  "version": 1,
  "brands": {
    "acme": [
      { "network": "impact-advertiser", "credentialId": "default", "networkBrandId": "IA-12345" },
      { "network": "cj-advertiser", "credentialId": "default", "networkBrandId": "7654321" }
    ],
    "globex": [
      { "network": "awin-advertiser", "credentialId": "default", "networkBrandId": "98765" }
    ]
  }
}
```

The same logical brand can appear under multiple networks; that's how
*"earnings for Acme across all networks"* fans out across the right
brand id on each one. You can hand-edit this file to rename, remove,
or add brands. Re-run `npx affiliate-networks-mcp setup` to register
new ones interactively — the wizard skips brands already in the file.

Three skills are tuned for the brand side:

- [`programme-performance-report`](./skills/programme-performance-report/SKILL.md)
  — one brand across its bound networks. Per-publisher rollup, status
  split, period-over-period delta.
- [`agency-portfolio-rollup`](./skills/agency-portfolio-rollup/SKILL.md)
  — every brand × every network in the book. Brand-aggregated headline
  with week-over-week deltas.
- [`programme-anomaly-watch`](./skills/programme-anomaly-watch/SKILL.md)
  — week-over-week anomaly scan, designed to run on a schedule.

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
that needs your approval re-confirmed, or a credential typed with a
trailing space. The doctor catches all three.

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

**Brand / advertiser side:**

- [Awin (advertiser)](./docs/networks/awin-advertiser.md) — OAuth bearer token; multi-brand via `GET /accounts`; gated to Accelerate / Advanced plans; read-only.
- [CJ Affiliate (advertiser)](./docs/networks/cj-advertiser.md) — Personal Access Token (GraphQL); multi-brand via CID list; read-only.
- [Everflow (advertiser)](./docs/networks/everflow-advertiser.md) — API key (admin-issued); multi-brand; experimental, built from public docs.
- [Impact (advertiser)](./docs/networks/impact-advertiser.md) — Account SID + Auth Token; agency or brand-direct; read-only.
- [Partnerize (advertiser)](./docs/networks/partnerize-advertiser.md) — application key + user API key; multi-brand; experimental, built from public docs.
- [Tradedoubler (advertiser)](./docs/networks/tradedoubler-advertiser.md) — reports token + organisation ID; multi-brand; experimental, built from public docs.

## For the curious (or technical)

`affiliate-mcp` is a Model Context Protocol server. MCP is the protocol
Claude uses to talk to outside tools. Each configured network becomes
a set of tool calls Claude can invoke, named
`affiliate_<network>_<operation>` — for example
`affiliate_awin_list_transactions` for the publisher side or
`affiliate_impact-advertiser_get_programme_performance` for the
brand side. Three meta-tools are always present:
`affiliate_list_networks`, `affiliate_run_diagnostic`, and
`affiliate_resolve_brand`.

The packaged skills under [`skills/`](./skills) are the
conversation patterns Claude follows for common requests:

**Publisher side:**

- [`affiliate-earnings-report`](./skills/affiliate-earnings-report/SKILL.md)
- [`affiliate-network-status`](./skills/affiliate-network-status/SKILL.md)
- [`affiliate-network-setup-help`](./skills/affiliate-network-setup-help/SKILL.md)
- [`audit-affiliate-links`](./skills/audit-affiliate-links/SKILL.md)

**Brand side:**

- [`programme-performance-report`](./skills/programme-performance-report/SKILL.md)
- [`agency-portfolio-rollup`](./skills/agency-portfolio-rollup/SKILL.md)
- [`programme-anomaly-watch`](./skills/programme-anomaly-watch/SKILL.md)

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
- [`templates/new-network/`](./templates/new-network) — scaffold to
  copy when adding a new network adapter.
- [`scripts/`](./scripts) — generators and validators
  (`validate:network`, `generate:readme`, `generate:report`).
- [`tests/`](./tests) — vitest suite. No live API calls; everything
  runs against verbatim fixtures.
- [`examples/`](./examples) — Claude Desktop config snippet.

Each folder has its own short README explaining what lives there.

## Adding a network

**If you work for an affiliate network**, the canonical path is in
[`CONTRIBUTING.md`](./CONTRIBUTING.md) under "Adopting your network".
You can take ownership via `.github/CODEOWNERS`, claim
`claim_status: production` directly, and cover both publisher and
advertiser sides — whichever your API exposes.

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

Beta — available now. Every bundled network adapter is live and ready to
use today; treat this as a public beta and expect the odd rough edge.
Eleven publisher adapters and six brand-side adapters ship across the
bundled networks. The four longest-standing publisher adapters — Awin, CJ,
Impact and Rakuten — ship as `claim_status: partial`; the newer publisher
adapters and every brand-side adapter ship as `experimental` until exercised
against real publisher, agency or in-house brand accounts. The brand side is
read-only and rate handling is in, but a few endpoint shapes remain
`// TODO(verify)` until live confirmation. If you hit something odd on either
side, open an issue — we treat every bug report as evidence about the
underlying API.

## Licence

MIT. See [`LICENCE`](./LICENCE).

## Acknowledgements

This project is only possible because the engineering teams at Awin,
CJ Affiliate, eBay Partner Network, Impact, and Rakuten Advertising
publish public, documented APIs — both the publisher endpoints and
(for Awin, CJ, and Impact) the brand-side advertiser endpoints. These
adapters read those APIs directly. Where a network has no usable API,
an adapter may instead drive the user's own dashboard session (browser-driven).
