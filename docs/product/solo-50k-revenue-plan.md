# Solo revenue plan: £50k/month without sales

> Status: accepted direction (2026-07-12, Rob). This document plans the
> commercial path to £50,000/month recurring revenue operated by one person
> alongside a day job. The custody and pricing decisions it depends on are
> accepted under [`../decisions/`](../decisions). Accepted decisions and
> shipped behaviour take precedence where they differ.

## 1. The constraint set

Every choice below follows from five constraints:

1. **One operator with a day job.** Realistically 8 to 12 focused hours per
   week, plus AI agents doing delivery work under the existing maintainer-led
   protocol.
2. **No consulting.** No retainers, custom builds, or billable hours.
3. **No sales or account management.** No demos, procurement, security
   questionnaires, enterprise contracts, or renewal calls. Everything must be
   self-serve at card-swipe price points.
4. **Distribution is LinkedIn.** Organic content is the top of funnel that
   already works; the plan must feed it, not fight it.
5. **£50k/month is the target, not the promise.** The plan uses evidence gates
   at each phase so effort stops or redirects when a gate fails.

The structural consequence: the product must acquire, convert, onboard,
support, and retain customers without the operator in the loop. Anything that
needs a human conversation to close or keep a customer is out.

## 2. Where the money is: the value audit

[`hosted-version-scoping.md`](./hosted-version-scoping.md) established that
value concentrates in three properties, none network-specific: consolidation
across 72 network families, workflows instead of endpoints, and plain language
inside the tool the user already works in. It also established that value
scales with how non-technical the user is, and that the highest-value cohort
is currently blocked by the install wall.

The journeys with money directly attached, in order of willingness to pay:

1. **Unpaid commission recovery** (publishers, agencies). Recovered cash is
   the cleanest ROI story in the product: the tool pays for itself in found
   money. This is the conversion wedge.
2. **QBR and client reporting** (agencies). Hours of CSV stitching per client
   per quarter become one prompt. Agencies already bill this time, so saving
   it has a price.
3. **Anomaly watch** (brands, agencies). Losses avoided from broken tracking,
   sudden reversals, or dead links. Critically, this only works when a server
   is awake to notice.
4. **Cross-network earnings rollup** (multi-network publishers). Recurring
   weekly need, lower price point, largest audience.

The structural insight the whole plan rests on: **the features people will pay
monthly for are exactly the ones a local stdio server cannot provide.**
Scheduled monitoring, alerts that fire while the laptop is shut, zero-install
access, and team sharing all need hosted infrastructure. That makes the paid
boundary natural rather than artificial: local stays free and open, and the
paid product is the server-shaped half. This is the same principle the desktop
free decision called D3: sell things that run on our infrastructure, never
things that run on the user's.

## 3. Values audit: what carries over, what was circumstance

The values are not decoration; several are the marketing. But they need
sorting into load-bearing values and circumstantial postures.

**Load-bearing, kept unchanged, and used as positioning:**

- **Honest network truth.** No competitor publishes candid per-network API
  findings. This is both a product property and the content engine (section 7).
- **No fake support, typed tools, verbatim errors.** Trust compounds; agencies
  relying on reports for clients need it contractually, not aspirationally.
- **The user's data is never monetised.** No selling data, no aggregate resale,
  no sponsored steering. Telemetry stays opt-in and aggregate-only per
  `PRIVACY.md`.
- **Open core stays open.** MIT core is the contributor moat (network
  employees owning adapters), the auditability proof, and the top of funnel.
- **Matter-of-fact editorial tone, UK English.**

**Circumstantial, revised deliberately:**

- **"Local-only, never hosted" was a custody posture, not the mission.** The
  mission is affiliate data available where affiliate work happens. Manifesto
  Principle 2 already carries the escape hatch: credentials stay local
  "unless a future remote option is explicitly designed with auth, consent,
  auditability, and security". The hosted tier is that designed option.

The promise, restated for the paid era: *local is free and open forever; the
hosted tier holds your API keys encrypted under a published contract, uses
them only to serve you, and never touches your data for any other purpose.
Export everything, delete completely, at any time.*

One monetisation route is refused outright because it breaks the values: any
form of commission skimming, link injection, sponsored result placement, or
steering users toward programmes that pay us. That is the obvious dirty money
in this category and ruling it out is part of the trust position.

## 4. The product ladder

Three paid surfaces on one spine, in the order they ship:

### Rung 1: premium skill packs, £20/month (accepted, ship first)

Already accepted in
[`2026-07-01-desktop-premium-skill-packs.md`](../decisions/2026-07-01-desktop-premium-skill-packs.md).
Its role in this plan is floor revenue, billing-ops learning, and
willingness-to-pay evidence, not the destination: £50k at £20 needs 2,500
subscribers, which is not realistic solo. Ship it, learn from it, keep it as
the entry rung.

### Rung 2: hosted connector, the core money product

The bring-your-own-key hosted execution option from
[`hosted-version-scoping.md`](./hosted-version-scoping.md): log in with a
browser, connect networks through a guided flow, use the tools from Claude,
ChatGPT, or any remote MCP client with no runtime, no terminal, and no
laptop-awake constraint. Read-only first; writes and browser handoffs stay
local-only.

Self-serve tiers (confirmed 2026-07-12 in the pricing decision record):

| Tier | Price | For | Includes |
| --- | --- | --- | --- |
| Solo | ~£34/month | Multi-network publishers | Hosted connector, up to 5 networks, weekly earnings digest |
| Pro | ~£99/month | Advertisers, agency staff, serious publishers | All networks, scheduled anomaly watch, unpaid-commission digest, QBR and weekly-report actions, CSV export |
| Team | ~£299/month | Small agencies | 5 seats, client workspaces, shared brand context, audit log, report export for client delivery |

Team is the ceiling of the no-sales constraint: card payment, self-serve seat
management, no invoicing, no SLA, no custom contracts. Anything above it is
deliberately not offered.

The paid features map onto the entitlement gate already proposed in
[`2026-06-30-paid-tier-entitlement-gate.md`](../decisions/2026-06-30-paid-tier-entitlement-gate.md):
CSV export, QBR, and weekly report are Pro features whether entitlement is
local or hosted. One entitlement family, two surfaces.

### Rung 3: certified adapter listings (later, inbound only)

Networks are already invited to own their adapters. A self-serve annual fee
(order of £2k to £5k/year) for a "certified by the network" badge, priority
maintenance, and a named contact route formalises that. This only happens on
inbound interest generated by the content engine; there is no outbound
pitching, because that would be sales. Treat as opportunistic upside, not a
plan pillar.

### Why anyone pays when the core is MIT

The skill-packs decision already answered this honestly: a local, copyable
artefact cannot sell secrecy, only currency and maintenance. The hosted tier
extends the same logic: customers pay for liveness (monitoring while the
laptop is shut), zero setup, guided credential connection, team features, and
the ongoing maintenance of 86 adapters as networks' APIs drift. The licence
stays MIT: the moat is maintenance velocity, adapter breadth, the contributor
flywheel, and hosted infrastructure, none of which a fork gets for free. A
licence change would burn the network-employee contribution motion for
nothing.

## 5. The arithmetic, honestly

A workable £50k/month mix:

| Line | Count | Price | MRR |
| --- | --- | --- | --- |
| Pro | 300 | £99 | £29,700 |
| Team | 40 | £299 | £11,960 |
| Solo | 150 | £34 | £5,100 |
| Skill packs | 200 | £20 | £4,000 |
| **Total** | **690 accounts** | | **£50,760** |

Roughly 700 paying accounts at a blended ~£74. For scale: the product needs
about 0.5% of the plausibly reachable audience (affiliate managers, agency
staff, and professional publishers active on LinkedIn number in the low
hundreds of thousands).

Churn reality: B2B prosumer tools in this bracket run 3 to 6% monthly churn.
At 5%, steady state at target requires ~35 replacement customers per month,
and the growth phase needs more than that in net adds. At a 5% trial-to-paid
rate on a warm audience, that is several hundred trials per month at maturity,
fed by LinkedIn, the free local product, MCP directories, and the content
engine. This is the hardest number in the plan and the reason the content
flywheel matters more than any feature.

Cost structure is favourable: the hosted tier proxies API calls and stores
encrypted keys, but the user's own Claude or ChatGPT does the inference, so
there is no LLM cost of goods. Infrastructure plus payment fees
should leave gross margin above 85%.

Timeline honesty: solo, part-time, £50k/month is a top-decile outcome.
The realistic band is 18 to 30 months, with 12 months as the aggressive case.
The phase gates below are the actual plan; the number is the direction.

## 6. Operating model: no sales, no support desk

- **Billing.** Decided 2026-07-12: Stripe directly (Checkout, Billing, and
  Stripe Tax), per
  [`2026-07-12-pricing-billing-and-licence.md`](../decisions/2026-07-12-pricing-billing-and-licence.md).
  Rob is the merchant, so UK VAT and EU OSS registration and Stripe Tax setup
  are Phase 0 prerequisites before the first paid invoice.
- **Trial.** 14 days, no card, usage-capped. Upgrade walls sit at natural
  points: scheduling anything, exceeding the network count, inviting a
  teammate, exporting CSV, running the QBR action. Visible-but-locked, per the
  entitlement-gate decision's honesty posture.
- **Onboarding replaces account management.** Guided per-network connect flow,
  then an automatic first-value report (the roadmap's "guided first value"
  item) so a new user sees their own numbers within minutes. Automated weekly
  usage-health email; a dormant Pro account gets a re-engagement sequence,
  not a phone call.
- **Support.** Docs, an AI support agent grounded in the setup and findings
  docs, and GitHub Discussions. Team tier gets email with no SLA. A generous
  refund policy is cheaper than a support queue.
- **Delivery.** The repo already runs maintainer-led, agent-assisted delivery.
  The same system builds and maintains the hosted tier; the operator's scarce
  hours go to decisions, content, and the weekly review of gates and metrics.

## 7. The LinkedIn engine

Position: **the honest data layer for AI-native affiliate work.** The unique,
hard-to-copy content asset already exists in this repo: candid, verifiable,
per-network API truth (`REPORT.md`, `docs/findings/`). Nobody else publishes
it because networks do not audit themselves and competitors do not want to be
honest.

A cadence sustainable alongside a day job, three posts per week, each
generated from artefacts the product already produces:

1. **Workflow demos.** 60 to 90 second screen captures: a QBR across four
   networks in one prompt, an unpaid-commission sweep finding real money.
   Outcome first, tool second.
2. **Network API findings.** Matter-of-fact teardowns from the findings docs.
   These pull affiliate managers and, importantly, network employees into the
   comments. Every network employee who ends up co-owning an adapter becomes
   in-network distribution.
3. **The Affiliate Network API Index (quarterly).** Rank networks on API
   quality, coverage, and reliability, generated from `network.json` metadata
   and findings. Networks share it, argue with it, and are invited to improve
   their score by owning their adapter. This is the compounding distribution
   asset and the inbound source for certified listings.

Supporting motion: free lead-magnet tools (a link auditor, an
unpaid-commission estimator) that capture email; a short newsletter that
recycles the same three content types; listings in the MCP registries and
connector directories (Claude, ChatGPT) as zero-effort discovery.

Explicitly not doing: paid ads at the start, cold outreach, conference
sponsorship, influencer deals. Each either costs money before evidence or
costs hours the operator does not have.

## 8. Sequencing and gates

The sequencing respects the delivery protocol: decisions before foundations,
smallest foundation with its first real consumer, then stacked slices.

### Phase 0 (months 0 to 2): decide, pre-sell, start the floor

- Land the decision records this plan depends on: **hosted credential
  custody** (the crux named in the scoping doc), **pricing and tier
  structure**, and a **hosted privacy contract** extending `PRIVACY.md`.
  Until custody is accepted, hosted work stays at discovery.
- Ship the accepted £20 skill packs: first revenue, first billing ops, first
  churn data.
- Put the hosted tier on the website as a founding offer (annual, discounted,
  clearly pre-launch) behind a waitlist.
- **Gate to build:** 30 founding pre-orders (roughly £15k to £20k cash) or
  500 qualified waitlist emails. If the gate fails, the wedge or price is
  wrong; revisit before building anything.

### Phase 1 (months 2 to 6): hosted MVP, charge from day one

- Exactly the scoping doc's recommendation: bring-your-own-key, read-only,
  the four production networks (Awin, CJ, Impact, Rakuten), guided connect
  flow, per-user encrypted vault, request-scoped identity.
- One paid-only feature at launch: the scheduled digest (earnings plus unpaid
  commissions). It is the simplest thing a local server cannot do.
- **Gate to continue:** £3k MRR and trial-to-paid at or above 5%.

### Phase 2 (months 6 to 12): breadth and the money features

- Extend hosted coverage to the top 12 networks by waitlist demand.
- Ship scheduled anomaly watch and the unpaid-commission chaser digest.
- Ship the brand-data QBR and weekly-report actions behind Pro (the
  entitlement-gate decision's feature set).
- List in the ChatGPT and Claude connector directories.
- **Gate:** £10k to £15k MRR, monthly churn under 5%.

### Phase 3 (months 12 to 24): team tier and the flywheel at full speed

- Self-serve Team tier: seats, client workspaces, audit log.
- Quarterly API Index as a public ritual; certified-adapter offer for inbound
  networks.
- Target band: £30k to £50k MRR by month 24.

## 9. Risks, stated plainly

- **Network terms of service.** Some networks prohibit third-party credential
  use or gate hosted access behind partner agreements. Mitigation: a
  per-network ToS check becomes part of promotion to hosted; use OAuth where
  offered; accept that some networks stay local-only forever and say so on
  the pricing page. This can cap hosted breadth.
- **Credential custody is the largest personal risk.** An encrypted key vault
  for hundreds of tenants, operated solo, is a real liability: breach
  exposure, GDPR scope, eventually SOC 2 expectations from Team customers.
  Mitigations: read-only keys wherever networks allow, established secrets
  infrastructure rather than home-rolled crypto, a written disclosure plan,
  and insurance. The custody decision record must name this owner.
- **Platform risk.** Anthropic or OpenAI could ship first-party affiliate
  connectors, or networks could ship official single-network MCP servers.
  Mitigation: cross-network consolidation is the moat; official
  single-network servers are actually helpful and interoperable, not fatal.
- **The funnel is the bottleneck, not the product.** 700 paying accounts from
  organic LinkedIn is the hard part. If Phase 1 conversion is healthy but
  volume is not, the correct response is more distribution surface (directory
  listings, the Index, free tools), not more features.
- **Solo bus factor and hours.** Everything automated, agents doing delivery,
  brutal scope discipline on the hosted MVP. If the day job flexes, the gates
  simply take longer; nothing in the plan requires a sprint.
- **Day-job conflict.** Checked and cleared by Rob (2026-07-12): the
  contractor agreement permits this independent product. Re-check on any
  contract renewal.
- **Churn and seasonality.** Affiliate income is seasonal (Q4 heavy); expect
  publisher-tier churn to breathe with it and judge cohorts annually.

## 10. What this plan refuses to do

- Consulting, retainers, custom integrations, or paid setup services.
- Enterprise sales: procurement, security questionnaires beyond a published
  trust page, SLAs, custom contracts, or invoicing above the Team tier.
- Monetising the user's traffic or data: no commission skimming, no link
  injection, no sponsored placement in results, no data resale.
- Closing the open core or rug-pulling shipped free features (the D3 line).
- Outbound sales of any kind, including to networks for certified listings.

## 11. Decisions taken (2026-07-12)

Rob answered the open questions on 2026-07-12 and accepted the plan the same
day. The binding decision records are Accepted:

1. **Hosted credential custody: accepted.** Recorded in
   [`2026-07-12-hosted-credential-custody.md`](../decisions/2026-07-12-hosted-credential-custody.md)
   (Accepted 2026-07-12). Hosted foundation work is unblocked.
2. **Pricing: the section 4 anchors stand** (£34/£99/£299, packs £20).
   Founding offer: annual Pro at £699/year (41% off £1,188), gate of 30
   pre-orders or 500 waitlist emails. Billing is Stripe direct, with the
   tax-compliance consequences recorded in
   [`2026-07-12-pricing-billing-and-licence.md`](../decisions/2026-07-12-pricing-billing-and-licence.md)
   (Accepted 2026-07-12).
3. **Licence: core stays MIT.** Same record.
4. **Day-job conflict: checked and cleared.**
5. **First skill packs: the agency pack and the publisher money pack.**
6. **Operator capacity: ~15 hours/week across both lanes**, content cadence
   and risk-PR review in parallel from Phase 0.

## Next step

Both decision records are accepted, so Phase 0 proceeds: the premium skill
packs, skill-pack billing, the founding-offer landing page, and the content
cadence. This document is direction; the decision records carry the
authorisation.
