# A metered free tier for the hosted connector, replacing the hard paywall

- **Date:** 2026-07-18
- **Status:** Proposed (awaiting Rob's acceptance; no implementation until
  accepted)
- **Affects:** the hosted MCP transport tier gate
  (`src/hosted-transport/tier-gate.ts`, `entitlement-client.ts`, and the
  dispatch path), the hosted billing entitlement model
  (`hosted/src/billing.ts`), the connect and billing funnel pages
  (`hosted/src/routes/connect.ts`, `hosted/src/routes/billing-page.ts`), and
  the marketing pricing pages (`site/hosted.html`, `site/index.html`, and a new
  `site/pricing.html`)
- **Amends:** [`2026-07-12-pricing-billing-and-licence.md`](./2026-07-12-pricing-billing-and-licence.md)
  (accepted), whose tier table has no hosted free tier and whose entitlement
  gate refuses every hosted tool call without an active Solo or Pro
  subscription. This record adds a free tier below Solo; it does not change the
  Solo, Pro, or Team prices, the Stripe-direct billing choice, the founding
  offer, or the licence stance.
- **Builds on:** [`2026-06-30-paid-tier-entitlement-gate.md`](./2026-06-30-paid-tier-entitlement-gate.md)
  (accepted; the "visible-but-locked, honest structured refusal" gate shape
  this record reuses), [`2026-07-12-hosted-credential-custody.md`](./2026-07-12-hosted-credential-custody.md)
  (accepted; the custody posture the meter must not weaken)
- **Relates to:** `docs/product/solo-50k-revenue-plan.md` (the commercial plan
  this funnel change serves) and the product philosophy on record: "charge for
  operation, assurance, collaboration, or specialised service, not for
  unlocking a user's own data" (`docs/product/roadmap.md`).

## Context

The hosted connector funnel asks for a subscription before the user has felt
any value. The transport is a hard paywall: `checkTierEntitlement`
(`src/hosted-transport/tier-gate.ts`) refuses every tool call unless the caller
holds an active Solo (£34/mo) or Pro (£99/mo) subscription. So the connect page
must tell a working, connected account "Running reports needs an active plan …
subscribe in a minute below", and the billing page is two bare buttons with no
comparison and no reason to prefer one plan.

This is value-after-payment, the weakest possible order for a self-serve,
no-sales product. It also sits awkwardly beside the honest fact the marketing
site already states: the free, open-source local server does everything hosted
does, for every network. A prospective buyer's cheapest path to "does this even
work for me" is therefore to install and self-host, not to pay.

Rob's direction (2026-07-18, in-session): introduce a freemium model centred on
**metered free consumption** ("a few free reports a week"), with **no card
required to start**, so the funnel becomes value-first:

> connect → add the connector to Claude → run your first few reports free → hit
> the weekly cap (or want automation) → upgrade.

## Decision

### The free tier

Add a `free` tier to the hosted product. An authenticated hosted user who holds
no active subscription is `free`, not `none`. `none` is retired to mean only
"not a valid hosted session".

| Tier | Price | Boundary |
| --- | --- | --- |
| **Free** | £0, no card | Connect and query **your own affiliate data** live in an MCP client, metered at **3 reports per rolling 7 days**. No scheduled digests, no anomaly watch, no AI report actions, no CSV export. |
| Solo | £34/month | Meter removed. Up to 5 networks. Weekly earnings digest. *(unchanged)* |
| Pro | £99/month | All hosted-eligible networks. Anomaly watch, unpaid-commission digest, QBR and weekly-report actions, CSV export. *(unchanged)* |
| Team | £299/month | *(unchanged from the pricing decision; still unimplemented, out of scope here)* |

The boundary follows the product philosophy exactly: the free tier lets a user
**see their own data** (metered), and every paid capability is **operation,
assurance, or collaboration** layered on top (scheduled automation, AI-authored
deliverables, export, seats). Scheduled features cannot sensibly be
"free-metered" and so stay paid by nature.

### The meter: what counts as one "report"

A meter over raw tool calls would be wrong: one natural-language question fans
out to several MCP tool calls, so "3 calls a week" would be spent on a single
question and would punish multi-call prompts. Instead the meter counts **report
windows**:

- The first successful data tool call opens a **30-minute window**. Every tool
  call within that window is free and does not open a new window.
- One window = one "report". The free tier allows **3 windows per rolling
  7 days** (a sliding window, not a calendar-week reset).
- `N = 3` and the window length `= 30 minutes` are the two tunable knobs. They
  are launch values, adjustable without a new decision as long as the model
  (metered free windows, no card) is unchanged.

A call beyond the cap returns a structured `free_quota_exceeded` refusal
(reusing the `HostedTierRefusal` shape from the entitlement-gate decision):
`isError: true`, a plain-language message, and an `upgradeHint` linking to
billing. It is never an opaque transport error, honouring Principle 4.1.

### How we charge

- **Free is not a Stripe object.** It is the absence of an active subscription.
  There is no card, no Stripe customer, and no checkout at sign-up. Stripe
  Checkout, Billing, and Tax (`hosted/src/stripe.ts`) are unchanged.
- The card is captured only at conversion, through the existing checkout route,
  when the user chooses to lift the meter or unlock a paid capability.
- `resolveEntitlement` (`hosted/src/billing.ts`) returns `free` for an
  authenticated-but-unsubscribed user; `tierEntitledToDigest` returns `false`
  for `free`.

### Privacy

The meter stores **counts and window timestamps only**, keyed on the existing
hosted `userId`. It records no affiliate data, no credentials, and no account
identifiers beyond the `userId` the transport already uses. `PRIVACY.md` holds
verbatim. The meter store is durable (KV), because an in-memory counter would
reset on every Worker restart and silently grant unlimited free use; the
existing in-memory `rate-limiter.ts` is therefore not the meter of record.

### The funnel, reordered

The connect page's post-connection screen leads with the add-to-Claude steps
and a first prompt, tells the user they have 3 free reports a week, and frames
upgrading as unlocking automation and removing the cap, not as a prerequisite
to doing anything. The billing page becomes a Free / Solo / Pro comparison with
concrete reasons to upgrade. This is copy and ordering only; the checkout and
portal wiring are unchanged.

## Rejected alternatives

- **Keep the hard paywall, just improve the copy.** Rejected: no wording fixes
  asking for a card before the product has proven itself to this account, when a
  free self-host path exists.
- **Time-limited free trial (e.g. 14-day Pro).** A cleaner fit for Stripe
  (`trialing` already counts as active) and considered, but rejected in favour
  of a recurring metered taste: a trial expires into nothing, whereas "a few
  free reports every week" keeps a permanent, low-commitment on-ramp and a
  standing reason to return.
- **Free-forever unlimited read tier.** Rejected: it burns hosted infrastructure
  on users who never convert and undercuts Solo, whose differentiator over free
  should be "no cap plus a digest", not "the only way to run more than nothing".
- **Meter raw tool calls.** Rejected: punishes multi-call prompts and makes the
  free allowance unpredictable and user-hostile.
- **Require a card for the free tier.** Rejected by Rob: the point is a
  no-friction taste; the card belongs at conversion.

## Consequences and implementation follow-ups

- The transport gate change is a public-contract and security-sensitive change:
  it ships as its own PR with independent agent review of the complete diff and
  green CI before Rob accepts the risk (per `AGENTS.md`).
- The pricing page and both funnel pages gain a Free column and value-first
  framing; `site/pricing.html` (already linked from the site nav) is created.
- The Solo tier's value proposition should be sharpened in the funnel copy so
  the free→Solo step reads as "remove the cap and add the digest", not merely
  "pay to keep going".
- Prices are unchanged; the meter values are launch anchors and may be retuned
  with evidence without a new decision.
- Team (£299) remains unimplemented and out of scope for this workstream.
