# Website copy deck

> Status: working draft. Companion to [`website-plan.md`](./website-plan.md).
> Voice: plain and concrete. No filler, no rhetorical triads, no
> "not just X, it's Y", minimal em-dashes. UK English ("programme"). Jargon
> (MCP, adapter, stdio) stays off user-facing pages.
>
> **Positioning:** the goal is affiliate work that runs itself, with the user
> deciding what it is allowed to do. The site shows the destination
> (automation) and the path to it (five steps), and is honest about what works
> today vs. what is on the roadmap.

## Homepage

### Hero
**Headline:** Take the grind out of affiliate marketing.

**Sub-line:** Connect your affiliate networks to Claude or Codex, ask across all
of them in plain English, and automate the repetitive checks. You approve
anything that acts.

**Buttons:** [ Get started ] · [ See how it works ]

Headline alternates (kept for reference):
- Affiliate marketing, minus the daily grind.
- Automate the daily grind of affiliate marketing.

### The problem
Affiliate data lives in a dozen network dashboards. Getting a straight answer
means logging into each one, exporting, and stitching it together by hand. This
reads all of them for you, inside the AI tools you already use.

### The five steps
Each step says what works today and what is still coming.

1. **Connect** · `Available now`
   Add your network logins. They stay on your machine. Claude and Codex can then
   read your data.
2. **Analyse** · `Available now`
   Ask across every network at once: earnings, pending commissions, reversals,
   dead links. In plain English, no filters or exports.
3. **Strategy & KPIs** · `Available now`
   Record the targets you care about with client-onboarding. Reports, anomaly
   watches, and portfolio rollups use them as advisory context, not authority to
   change network data.
4. **Approvals** · `Coming`
   Decide what runs on its own and what waits for your sign-off.
5. **Automation** · `Coming`
   The checks and actions you've approved run on a schedule. Everything else
   comes to you.

### Pick your side
**You earn commissions** *(publishers and creators)*
- *"What did I earn across all networks last month?"*
- *"Anything still pending after 90 days?"*
- *"Compare my earnings month on month."*
→ Publisher examples

**You run programmes** *(brands and agencies)*
- *"How is Acme doing this quarter?"*
- *"Revenue across all my clients this week."*
- *"Any anomalies this week?"*
→ Brand examples

### Trust
- **Your data stays on your machine.** Logins are stored locally, not in a
  hosted account. Networks see the same calls as your own dashboard.
- **Automation only does what you've approved.** Nothing acts without your
  sign-off.
- **Privacy-first opt-in telemetry.** Runtime telemetry is off by default,
  aggregate-only, and never includes affiliate data, credentials, prompts,
  arguments, results, or error text.
- **Open source, MIT licensed.** Read the code, or contribute to it.

### Things dashboards don't surface
Transactions stuck pending, dead links across your site, reversal spikes,
week-on-week drops, programmes trending to zero. Ask for any of these now, or
run the scheduled-watch skills in a host that supports scheduling.

### Mission teaser
We're building toward affiliate work that runs itself, with you in control of
what it's allowed to do. → Read the mission

### Closing CTA
**Heading:** Try it on your own data.

**Body:** No code, and you don't need to know what an API is. Setup takes about
five minutes and it's free.

**Button:** [ Get started ]

**Footer row:** For networks · For developers · Privacy · GitHub

---

## Tagline system (three lines, by role)

Three lines came out of the exploration. Each is used where it works hardest
rather than picking one:

| Line | Role |
| --- | --- |
| **Agentic affiliate** | Short category tagline: logo lockup, meta/OG title, the one-sentence description of what this is |
| **Affiliate AI that actually does things** | Optional section label introducing the five steps |
| **Automating affiliate** | `/mission` page H1 |

The homepage hero is the grind line ("Take the grind out of affiliate
marketing") because a verb aimed at the reader pulls harder than a label for the
product.

## Notes & rejected directions

Hero directions considered (kept for reference):
- "The doing layer for affiliate." "Layer" reads as technical; moved "Agentic
  affiliate" into the tagline slot instead.
- "Affiliate work that runs itself, with you in control."
- "Chat with your affiliate data in the AI you already use." Dropped once the
  goal was clarified as automation rather than chat.

Network and adapter counts must be pulled from the same data the README
auto-generates (see `website-plan.md` §8), never hand-typed.

## Pricing

### Overview
The local server runs free and complete. Premium options add skills and hosted connectivity for teams and agencies.

### Free: local server
The open-source MCP server runs on your machine. All 86 network adapters, all core workflows, your credentials. No account, no telemetry unless you opt in. MIT licence.

### Skill packs
Premium workflow packs, maintained and updated, delivered as Claude Desktop extensions. £20/month per pack. Use them alongside your free local server.

**Agency pack** (coming soon)
QBR prep, client weekly report, portfolio rollup. Cross-programme performance analysis and client-ready exports.

**Publisher money pack** (coming soon)
Unpaid-commission chaser, earnings rollup across all networks, reversal investigation. Monthly earnings digest.

### Hosted tier
Connector-hosted setup for organisations and teams. Pre-launch, waitlist-only, refundable until the tier ships to you.

**Solo — £34/month**
Hosted connector, up to 5 networks, weekly earnings digest, email delivery. For individual publishers testing hosted connectivity.

**Pro — £99/month**
All hosted-eligible networks, scheduled anomaly watch with email alert, unpaid-commission digest, QBR and weekly-report generation, CSV export, email delivery.

**Team — £299/month**
5 seats, client workspaces, shared brand context, audit log, client-ready report export, email delivery. Card self-serve, no SLA, no custom contracts. Contact for additional seats.

### Founding offer
Lock in **Founding Pro at £699/year** — the Pro plan at 41% discount (normally £1,188/year as monthly equivalent). Available to founding customers during pre-launch. Money-back guarantee: if the hosted tier doesn't ship to your region or networks in six months, refund is immediate, no questions asked. Clearly labelled pre-launch throughout.

**Waitlist question:** Which networks matter most to you for hosted first? Helps us prioritise.

### Honesty notes on hosted
- **Pre-launch.** The hosted tier is not yet available. Founding offer holds your place.
- **Not all networks go hosted.** Some affiliate networks' terms do not allow third-party credential holders. Those networks stay local-only, free, and complete.
- **Local stays free and complete.** Whether or not you use hosted, the open-source server has full parity to what shipped before hosted existed.
- **Keys are encrypted.** Hosted credentials are stored encrypted at rest, used only to serve you, and deletable any time. No network sees your hosted session; we forward requests on your behalf with your keys.

## To draft next
- `/get-started` — the non-technical onboarding page.
- `/what-you-can-ask` — full publisher/brand prompt list.
- `/mission` — the manifesto retold, with the today vs. roadmap line.
