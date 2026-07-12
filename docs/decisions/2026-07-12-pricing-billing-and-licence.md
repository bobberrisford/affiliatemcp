# Pricing, billing, and licence for the paid tiers

- **Date:** 2026-07-12
- **Status:** Accepted (2026-07-12, Rob; "Plan accepted" covering this record
  and the solo revenue plan it implements)
- **Affects:** the paid-tier structure across the desktop skill packs and the
  hosted tier, the billing integration, the website pricing page, and the
  project licence posture
- **Builds on:** [`2026-07-01-desktop-premium-skill-packs.md`](./2026-07-01-desktop-premium-skill-packs.md)
  (accepted), [`2026-06-30-paid-tier-entitlement-gate.md`](./2026-06-30-paid-tier-entitlement-gate.md)
  (accepted 2026-07-12), [`2026-07-12-hosted-credential-custody.md`](./2026-07-12-hosted-credential-custody.md)
  (accepted 2026-07-12)
- **Relates to:** `docs/product/solo-50k-revenue-plan.md` (the commercial
  plan these prices implement)

## Context

The commercial plan needs settled price points before the founding offer can
go on the website, and a billing provider before the accepted £20 skill packs
can take money. Rob answered the open pricing questions on 2026-07-12; this
record makes those answers a reviewable contract.

## Decision

### Tiers and prices

| Tier | Price | Surface | Includes |
| --- | --- | --- | --- |
| Skill packs | £20/month | Desktop, local | The accepted premium skill-pack subscription. First two packs: the agency pack (QBR prep, client weekly report, portfolio rollup) and the publisher money pack (unpaid-commission chaser, earnings rollup, reversal investigation). |
| Solo | £34/month | Hosted | Hosted connector, up to 5 networks, weekly earnings digest. |
| Pro | £99/month | Hosted | All hosted-eligible networks, scheduled anomaly watch, unpaid-commission digest, QBR and weekly-report actions, CSV export. |
| Team | £299/month | Hosted | 5 seats, client workspaces, shared brand context, audit log, client-ready report export. Card-only, self-serve, no SLA, no custom contracts. Team is the hard ceiling of the no-sales model. |

### Founding offer

Founding Pro: £699/year (41% off the £1,188 annual price), clearly labelled
pre-launch, refundable until the hosted tier ships to the buyer. The Phase 0
build gate is 30 founding pre-orders or 500 qualified waitlist emails.

### Billing: Stripe directly

Rob chose Stripe direct over a merchant of record. Consequence, stated
plainly: Rob (or his company) is the merchant. That means Stripe Checkout and
Stripe Billing for subscriptions, Stripe Tax for calculation, and the
following compliance obligations stay in-house rather than with a merchant of
record:

- UK VAT registration (digital-services B2C sales to EU consumers require
  registration for VAT OSS from the first sale, not from the UK threshold);
- EU OSS (or UK equivalent scheme) filing cadence;
- monitoring US state sales-tax nexus as volume grows;
- issuing VAT invoices for Team-tier customers.

Follow-up before first paid invoice: confirm the trading entity, complete UK
VAT and OSS registration, and enable Stripe Tax. This is an operational
prerequisite recorded in the technical roadmap's Phase 0. If the compliance
burden proves heavier than expected, migrating to a merchant of record later
is possible but disruptive (customer re-consent to a new billing descriptor);
the choice should be revisited only with evidence.

### Licence

The core stays MIT. The moat is maintenance velocity, adapter breadth, the
network-employee contribution flywheel, and hosted infrastructure, none of
which a fork acquires. The hosted boundary layer (vault, tenancy, billing)
may live in a separate private repository; that separation is an
implementation choice, not a licence change to this repo.

## Rejected alternatives

- **Merchant of record (Paddle or Lemon Squeezy).** Removes all tax
  compliance from the operator for roughly 5% + 50p per transaction. Rejected
  by the maintainer in favour of Stripe's lower fees and direct control; the
  compliance consequences above are the accepted cost.
- **Cheaper anchors (~£19/£59/£199).** Larger audience needed (~1,100
  accounts for £50k); rejected as under-pricing the agency value.
- **Premium anchors (~£49/£149/£499).** Fewer accounts needed but a harder
  self-serve sell without sales conversations; rejected.
- **Deciding price after the pre-sell.** Rejected; the founding offer itself
  tests the Pro anchor.
- **Relicensing (fair-source/BSL).** Rejected; it would chill the network
  contribution motion the plan depends on.

## Consequences and implementation follow-ups

- Skill-pack checkout (Stripe Checkout + webhook + entitlement issuance) is
  the first billing build; hosted entitlement reuses the same subscription
  state at the transport boundary later.
- The pricing page carries the tier table above and, for networks that fail
  the hosted terms-of-service check, an honest local-only marker.
- Prices are launch anchors, not permanent: repricing is routine, but
  grandfathering founding buyers at their rate is a promise and is kept.
- The Phase 0 gate numbers (30 pre-orders / 500 emails) live in
  `docs/product/solo-50k-revenue-plan.md` and are read from the gate
  dashboard, not adjusted retrospectively.
