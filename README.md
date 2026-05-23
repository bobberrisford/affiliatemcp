# affiliate-mcp

> Integrate your affiliate networks with Claude or ChatGPT.

Affiliate networks have two sides — and neither has a Claude integration.

**Publishers** earn commissions from the programmes they join.
**Brands** (and the agencies who manage them) run those programmes
and pay the commissions out. I wanted to chat to my own affiliate
data with Claude; none of the networks had shipped an integration
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

Claude figures out which networks to call, fetches the data live from
their APIs, and gives you the answer. You can use Claude to turn it
into a sheet, an artifact, an email to your boss, whatever you want.

Free and open source. MIT licensed. Bring your own keys.

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
- Claude Desktop installed.

That is the whole list.

## Why bother?

**One question, every network — and every brand.** "Show me earnings
by programme" hits Awin, CJ, eBay, Impact and Rakuten in parallel and
merges the results. On the brand side, "show me revenue across all my
clients this week" fans out across every brand × network pair you've
registered. The dashboards can't do that — they don't know about each
other.

**Plain English, not filters.** No more clicking through date pickers
and saved views. "Last quarter, status pending, sorted by amount" is
the whole prompt — on either side.

**Your data, your machine.** It runs locally. Your keys live in a
file on your own computer (`~/.affiliate-mcp/.env`, locked to your
user account). Nothing is sent to a third party, no account to sign
up for, no telemetry. The networks see the same API calls they'd see
if you used their own dashboard.

**Catches what dashboards bury.** Stale transactions, programmes that
have quietly gone inactive, links pointing at deeplinks that no
longer resolve, brands whose top publisher dropped 40% week-on-week
— the packaged skills look for these without being asked.

## Getting started

You'll need Node.js 20 or newer installed. If you don't have it, the
[Node.js download page](https://nodejs.org/) takes about two minutes.

**1. Run the setup wizard.** Open Terminal (macOS) or PowerShell
(Windows) and paste:

```
npx affiliate-networks-mcp setup
```

It walks you through one network at a time. For each one it asks
which **side** you want — publisher or brand — tells you where in
the dashboard to find the credential, asks you to paste it, and
checks it against the live network before moving on. If a key is
wrong, you'll know in the same minute you typed it.

For brand-side networks, after credentials check out the wizard asks
the network which brands those credentials can reach, then lets you
pick a local nickname for each (e.g. `acme`, `globex`). That mapping
goes into `~/.affiliate-mcp/brands.json` — see [Managing brands](#managing-brands)
below.

**2. Check everything is wired up.**

```
npx affiliate-networks-mcp test
```

You should see one line per network: `ok` for everything that's healthy,
`error — <reason>` for anything that isn't.

**3. Tell Claude about it.** If you're on Claude Desktop, open the
config file (the example at
[`examples/claude-desktop-config.md`](./examples/claude-desktop-config.md)
shows you where it lives on your operating system) and paste:

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

Restart Claude Desktop. Open a new conversation and type
**"list my affiliate networks"** — you should see every network you
configured. If you registered any brands, also try **"list my brands"**.

That's it. Ask it questions.

## What you can ask

The packaged skills are pre-written conversation patterns. You don't
need to invoke them — Claude picks the right one based on what you
type.

### Publisher side

- **"What did I earn last month?"** — pulls a consolidated earnings
  report across every configured publisher network, splits by status
  (pending, approved, paid, reversed), and flags anything sitting
  unpaid for more than 90 days.
- **"Are all my affiliate networks healthy?"** — a one-shot status
  check: auth working, API reachable, which operations the network
  supports.
- **"Help me set up Awin"** *(or CJ, Impact, Rakuten)* — guides you
  through credential setup for one of the bundled networks
  conversationally, with the dashboard menu paths quoted verbatim.
- **"Audit the affiliate links in my sitemap at https://mysite.com/sitemap.xml"**
  — reads the sitemap, classifies every affiliate link by network,
  checks each programme is still active, and flags the dead or
  declined ones. You can also paste a list of URLs or an HTML /
  markdown document directly.

### Brand side

- **"How is Acme performing this quarter?"** — a single-brand report
  across whichever networks that brand is registered on. Top
  publishers by revenue, status splits, period-over-period delta.
- **"Show me revenue across all my clients this week."** — a
  portfolio rollup across every brand and every network in the book.
  Brand-aggregated, with a "needs attention" subsection for brands
  trending down.
- **"Any anomalies in the affiliate data this week?"** — a
  week-over-week scan for revenue drops, reversal spikes, top-10
  publisher dropouts, and dead programmes. Designed to run on a
  schedule via Claude's own scheduling so you learn about problems
  before clients do.

## Networks

Five network families are bundled today. Three of them — **Awin**,
**CJ Affiliate**, and **Impact** — ship adapters for both the
publisher and the advertiser side, so the same network appears on
two rows. **eBay Partner Network** is publisher-only (eBay is the
sole advertiser on its own network — no brand-side product to
integrate with). **Rakuten Advertising** is publisher-only at v0.1;
the brand-side has a more complex auth model and we skipped it for
now.

<!-- AFFILIATE_MCP_NETWORK_TABLE_START -->
| Network | Setup time | Approval required | Supported ops | Notes |
| --- | ---: | --- | ---: | --- |
| Awin | 5 min | no | 6 / 7 | no clicks |
| Awin (advertiser) | 6 min | no | 7 / 7 | see notes |
| CJ Affiliate | 8 min | no | 6 / 7 | no clicks |
| CJ Affiliate (advertiser) | 8 min | no | 7 / 7 | pagination quirks |
| eBay Partner Network | 10 min | yes (~3 days) | 7 / 7 | see notes |
| Impact | 6 min | no | 7 / 7 | upstream variability |
| Impact (advertiser) | 8 min | no | 7 / 7 | see notes |
| Rakuten Advertising | 12 min | yes (~5 days) | 6 / 7 | clicks gated |
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

## Where your credentials live

When you run the setup wizard it writes a single file at
`~/.affiliate-mcp/.env` on your machine, locked to your user account
(file mode `0600`). That file is the only place your API keys exist
outside the network dashboards themselves. The same file holds both
publisher and brand-side credentials, each keyed by network slug.
You can open it in any text editor; you can delete it to start over;
you can copy it to a new machine when you upgrade your laptop.

If you registered any brand-side networks, the wizard also writes a
`~/.affiliate-mcp/brands.json` file next to the `.env`. It maps your
local nickname for each brand (e.g. `acme`) to the network's own
brand id, and lists every network that brand is bound to. Same file
mode, same machine, same deal — open, edit, delete, copy. The file
stays empty for the publisher-only path.

There is no hosted service. There is no account to create with us.
There is nothing to cancel.

## Managing brands

The brand-side flow has one extra concept the publisher flow doesn't:
the local **brand slug**. You give each client (or each of your own
brands) a short nickname, and the tool maps that nickname onto the
network's own brand id on every network the brand is registered on.

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

- [`programme-performance-report`](./src/skills/programme-performance-report/SKILL.md)
  — one brand across its bound networks. Per-publisher rollup, status
  split, period-over-period delta.
- [`agency-portfolio-rollup`](./src/skills/agency-portfolio-rollup/SKILL.md)
  — every brand × every network in the book. Brand-aggregated headline
  with week-over-week deltas.
- [`programme-anomaly-watch`](./src/skills/programme-anomaly-watch/SKILL.md)
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
- [Impact](./docs/networks/impact.md) — Account SID + Auth Token.
- [Rakuten Advertising](./docs/networks/rakuten.md) — OAuth client + SID; approval required.

**Brand / advertiser side:**

- [Awin (advertiser)](./docs/networks/awin-advertiser.md) — OAuth bearer token; multi-brand via `GET /accounts`; gated to Accelerate / Advanced plans; read-only.
- [CJ Affiliate (advertiser)](./docs/networks/cj-advertiser.md) — Personal Access Token (GraphQL); multi-brand via CID list; read-only.
- [Impact (advertiser)](./docs/networks/impact-advertiser.md) — Account SID + Auth Token; agency or brand-direct; read-only.

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

The packaged skills under [`src/skills/`](./src/skills) are the
conversation patterns Claude follows for common requests:

**Publisher side:**

- [`affiliate-earnings-report`](./src/skills/affiliate-earnings-report/SKILL.md)
- [`affiliate-network-status`](./src/skills/affiliate-network-status/SKILL.md)
- [`affiliate-network-setup-help`](./src/skills/affiliate-network-setup-help/SKILL.md)
- [`audit-affiliate-links`](./src/skills/audit-affiliate-links/SKILL.md)

**Brand side:**

- [`programme-performance-report`](./src/skills/programme-performance-report/SKILL.md)
- [`agency-portfolio-rollup`](./src/skills/agency-portfolio-rollup/SKILL.md)
- [`programme-anomaly-watch`](./src/skills/programme-anomaly-watch/SKILL.md)

For per-network capability detail, known upstream quirks, and the
editorial baseline used when accepting new network claims, see
[`REPORT.md`](./REPORT.md). It is regenerated from each adapter's
`network.json` on every merge, so it stays in step with the code.

## Adding a network

If your favourite network isn't in the table, you can add it — and
you don't necessarily need to be a developer to do it. Open this
repo in Claude Code and say *"add [network name] to affiliate-mcp"*.
The `contribute` skill kicks in and walks the whole process: it asks
early which side you're adding (publisher, brand-side, or both),
picks the right scaffold and credential-scope conventions, researches
the network's API, writes the tests, drafts the docs. You're the
editor; Claude does the typing.

If you'd rather drive it yourself, [`CONTRIBUTING.md`](./CONTRIBUTING.md)
is the human-side workflow, [`AGENTS.md`](./AGENTS.md) is the primer
for AI coding agents, and [`templates/new-network/`](./templates/new-network/)
is the scaffold to copy. [`WANTED.md`](./WANTED.md) lists networks
explicitly on the roadmap.

Local development:

```
npm install
npm test
npm run typecheck
npm run lint
npm run build
```

## Status

Pre-launch. The five publisher adapters ship as `claim_status:
partial`. The three brand-side adapters (Awin, CJ, Impact) ship as
`claim_status: experimental` until they've been exercised against
real agency or in-house brand accounts — the read-only stance and
per-network rate handling are in, but a few endpoint shapes are
still marked `// TODO(verify)` in the adapter code until we can
confirm them against a live tenant. If you hit something that
doesn't behave on either side, open an issue — we treat every bug
report as evidence about the underlying API, not just our code.

## Licence

MIT. See [`LICENCE`](./LICENCE).

## Acknowledgements

This project is only possible because the engineering teams at Awin,
CJ Affiliate, eBay Partner Network, Impact, and Rakuten Advertising
publish public, documented APIs — both the publisher endpoints and
(for Awin, CJ, and Impact) the brand-side advertiser endpoints. The
adapters here read those APIs; they do not scrape, simulate, or work
around any rate or access limits.
