# affiliate-mcp

> Integrate your affiliate networks with Claude or ChatGPT.

I wanted to chat to my affiliate network data with Claude and none of the
networks have shipped a Claude integration yet, so I built them all one
(well, the biggest ones).

So you can now add this to Claude and ask:

> *"What did I earn across all networks last month?"*
>
> *"Which programmes have transactions still pending after 90 days?"*
>
> *"Compare my earnings month on month."*
>
> *"Find me some opportunities to grow."*

Claude figures out which networks to call, fetches the data live from
their API, and gives you the answer. You can use Claude to turn it into
a sheet, an artifact, an email to your boss, whatever you want.

Free and open source. MIT licensed. Bring your own keys.

## Who this is for

You are an affiliate marketer. You have started using AI in your daily
life and your affiliate network isn't helping.

You do **not** need to know what an API is. You do not need to write code.
You need:

- Your existing logins to the affiliate networks you already work with.
- Five minutes to run the setup wizard.
- Claude Desktop installed.

That is the whole list.

## Why bother?

**One question, every network.** "Show me earnings by programme" hits
Awin, CJ, eBay, Impact and Rakuten in parallel and merges the results.
The dashboards can't do that — they don't know about each other.

**Plain English, not filters.** No more clicking through date pickers
and saved views. "Last quarter, status pending, sorted by amount" is
the whole prompt.

**Your data, your machine.** It runs locally. Your publisher keys live
in a file on your own computer (`~/.affiliate-mcp/.env`, locked to your
user account). Nothing is sent to a third party, no account to sign up
for, no telemetry. The networks see the same API calls they'd see if
you used their own dashboard.

**Catches what dashboards bury.** Stale transactions, programmes that
have quietly gone inactive, links pointing at deeplinks that no longer
resolve — the packaged skills look for these without being asked.

## Getting started

You'll need Node.js 20 or newer installed. If you don't have it, the
[Node.js download page](https://nodejs.org/) takes about two minutes.

**1. Run the setup wizard.** Open Terminal (macOS) or PowerShell
(Windows) and paste:

```
npx affiliate-networks-mcp setup
```

It walks you through one network at a time. For each one it tells you
where in the dashboard to find the credential, asks you to paste it,
and checks it against the live network before moving on. If a key is
wrong, you'll know in the same minute you typed it.

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
just configured.

That's it. Ask it questions.

## What you can ask

The packaged skills are pre-written conversation patterns. You don't
need to invoke them — Claude picks the right one based on what you
type. A few starting points:

- **"What did I earn last month?"** — pulls a consolidated earnings
  report across every configured network, splits by status (pending,
  approved, paid, reversed), and flags anything sitting unpaid for
  more than 90 days.
- **"Are all my affiliate networks healthy?"** — a one-shot status
  check: auth working, API reachable, which operations the network
  supports.
- **"Help me set up Awin"** *(or CJ, Impact, Rakuten)* — guides you
  through credential setup for one of the bundled networks
  conversationally, with the dashboard menu paths quoted verbatim.
- **"Audit the affiliate links in my sitemap at https://mysite.com/sitemap.xml"**
  — reads the sitemap, classifies every affiliate link by network,
  checks each programme is still active, and flags the dead or
  declined ones. You can also paste a list of URLs or an HTML/markdown
  document directly.

## Networks

The networks bundled today are listed below. Each one supports the same
seven operations: list programmes, get a single programme, list
transactions, list clicks, summarise earnings for a period, mint a
tracking link, and confirm auth.

<!-- AFFILIATE_MCP_NETWORK_TABLE_START -->
| Network | Setup time | Approval required | Supported ops | Notes |
| --- | ---: | --- | ---: | --- |
| Awin | 5 min | no | 6 / 7 | no clicks |
| CJ Affiliate | 8 min | no | 6 / 7 | no clicks |
| eBay Partner Network | 10 min | yes (~3 days) | 7 / 7 | see notes |
| Impact | 6 min | no | 7 / 7 | upstream variability |
| Rakuten Advertising | 12 min | yes (~5 days) | 6 / 7 | clicks gated |
<!-- AFFILIATE_MCP_NETWORK_TABLE_END -->

A few networks make you wait for approval (eBay, Rakuten) before they
hand over API access. The setup wizard tells you exactly what to do in
each case. "Supported ops" being less than 7/7 just means the network
itself doesn't expose that data to publishers — not a missing feature
on our side. The full editorial position lives in
[`REPORT.md`](./REPORT.md).

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
(file mode `0600`). That file is the only place your API keys exist
outside the network dashboards themselves. You can open it in any
text editor; you can delete it to start over; you can copy it to a
new machine when you upgrade your laptop.

There is no hosted service. There is no account to create with us.
There is nothing to cancel.

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

- [Awin](./docs/networks/awin.md) — API token + publisher ID.
- [CJ Affiliate](./docs/networks/cj.md) — Developer Key (GraphQL).
- [eBay Partner Network](./docs/networks/ebay.md) — OAuth client + secret + campaign ID; approval required.
- [Impact](./docs/networks/impact.md) — Account SID + Auth Token.
- [Rakuten Advertising](./docs/networks/rakuten.md) — OAuth client + SID; approval required.

## For the curious (or technical)

`affiliate-mcp` is a Model Context Protocol server. MCP is the protocol
Claude uses to talk to outside tools. Each configured network becomes
a set of tool calls Claude can invoke, named
`affiliate_<network>_<operation>` — for example
`affiliate_awin_list_transactions`. Two meta-tools are always present:
`affiliate_list_networks` and `affiliate_run_diagnostic`.

The packaged skills under [`src/skills/`](./src/skills) are the
conversation patterns Claude follows for common requests:

- [`affiliate-earnings-report`](./src/skills/affiliate-earnings-report/SKILL.md)
- [`affiliate-network-status`](./src/skills/affiliate-network-status/SKILL.md)
- [`affiliate-network-setup-help`](./src/skills/affiliate-network-setup-help/SKILL.md)
- [`audit-affiliate-links`](./src/skills/audit-affiliate-links/SKILL.md)

For per-network capability detail, known upstream quirks, and the
editorial baseline used when accepting new network claims, see
[`REPORT.md`](./REPORT.md). It is regenerated from each adapter's
`network.json` on every merge, so it stays in step with the code.

## Adding a network

If your favourite network isn't in the table, you can add it — and you
don't necessarily need to be a developer to do it. Open this repo in
Claude Code and say *"add [network name] to affiliate-mcp"*. The
`contribute` skill kicks in and walks the whole process: research the
network's API, scaffold the adapter, write the tests, draft the docs.
You're the editor; Claude does the typing.

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

Pre-launch. The five bundled adapters ship as `claim_status: partial`
(or `experimental`, for the most recent addition) until they have been
exercised against real publisher accounts. If you hit something that
doesn't behave, open an issue — we treat every bug report as evidence
about the underlying API, not just our code.

## Licence

MIT. See [`LICENCE`](./LICENCE).

## Acknowledgements

This project is only possible because the engineering teams at Awin, CJ
Affiliate, eBay Partner Network, Impact, and Rakuten Advertising publish
public, documented APIs for their publisher data. The adapters here read
those APIs; they do not scrape, simulate, or work around any rate or
access limits.
