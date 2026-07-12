# Technical roadmap: the to-do list for the £50k plan

> Status: working proposal, pre-decision. Companion to
> [`solo-50k-revenue-plan.md`](./solo-50k-revenue-plan.md); this document turns
> that plan's phases into ordered, checkable work items. It is direction, not
> authorisation: every item marked **[decision]** needs an accepted record
> under [`../decisions/`](../decisions) before dependent implementation, per
> AGENTS.md. [`roadmap.md`](./roadmap.md) remains canonical for
> non-commercial sequencing; section "Relation to the canonical roadmap"
> below records the one deliberate divergence.

## How to read this

- **[decision]** items are decision records Rob accepts. They block the items
  listed after them and travel in the `active-risk` lane one at a time.
- **[build]** items are implementation an agent can deliver under
  `delivery-steward` once their decisions are accepted.
- **[ops]** and **[content]** items are operational or marketing work, mostly
  outside the repo, listed so the plan is complete.
- Each phase ends with the revenue plan's evidence gate. A failed gate stops
  the next phase; it does not stop hygiene or content work.

## Dependency spine

The order that matters, compressed:

1. Hosted credential custody decision unblocks everything hosted.
2. Identity and tenancy foundation unblocks the vault; the vault unblocks the
   remote transport; the transport unblocks the connect flow; the connect flow
   unblocks the scheduled digest, which is the first paid hosted feature.
3. Pricing decision unblocks skill-pack billing and the founding offer.
4. Adapter promotion gates unblock hosted network promotion and the API Index.
5. Telemetry reconciliation precedes remote hosting (canonical roadmap,
   Sequence 5).

## Phase 0: decide, pre-sell, first revenue (months 0 to 2)

### Decisions

- [ ] **[decision]** Hosted credential custody: accepted in principle by Rob
      (2026-07-12) and drafted as
      [`2026-07-12-hosted-credential-custody.md`](../decisions/2026-07-12-hosted-credential-custody.md).
      Remaining step: deliberate acceptance of the record. Nothing hosted is
      built before that.
- [ ] **[decision]** Pricing, billing, and licence: answers taken (anchors
      £34/£99/£299, packs £20, founding Pro £699/year, Stripe direct, MIT
      stays) and drafted as
      [`2026-07-12-pricing-billing-and-licence.md`](../decisions/2026-07-12-pricing-billing-and-licence.md).
      Remaining step: deliberate acceptance of the record.
- [ ] **[ops]** Stripe-direct compliance prerequisites before the first paid
      invoice: confirm trading entity, UK VAT and EU OSS registration, enable
      Stripe Tax. This replaces the merchant-of-record item; the consequences
      are recorded in the pricing decision.
- [x] **[ops]** Day-job contract review: checked and cleared by Rob
      (2026-07-12). Re-check on contract renewal.

### Ship the accepted £20 skill packs (first revenue)

- [ ] **[build]** Billing backend: Stripe Checkout and Billing with Stripe
      Tax, webhook receiver, subscription state store, entitlement issuance.
- [ ] **[build]** Desktop entitlement check per
      [`2026-07-01-desktop-premium-skill-packs.md`](../decisions/2026-07-01-desktop-premium-skill-packs.md):
      periodic online check with an offline grace period.
- [ ] **[build]** Land the stubbed brand-data entitlement gate from
      [`2026-06-30-paid-tier-entitlement-gate.md`](../decisions/2026-06-30-paid-tier-entitlement-gate.md)
      once that record is accepted: single dispatch choke point in
      `src/server.ts`, `src/brand-data/entitlement.ts` stub, visible-but-locked
      refusal. The stub is the seam the real billing later replaces.
- [ ] **[build]** First two premium skill packs, chosen by Rob (2026-07-12):
      the agency pack (QBR prep, client weekly report, portfolio rollup,
      drawn from
      [`agency-account-manager-deliverables.md`](./agency-account-manager-deliverables.md))
      and the publisher money pack (unpaid-commission chaser, earnings
      rollup, reversal investigation), delivered through the desktop skills
      step.
- [ ] **[content]** Pricing page and checkout flow on the website.

### Funnel foundation

- [ ] **[content]** Founding-offer landing page for the hosted tier with
      waitlist capture, including the per-network demand question that later
      orders Phase 2 breadth.
- [ ] **[ops]** Privacy-respecting site analytics (for example Plausible) and
      an email list tool; wire waitlist and checkout events to it.
- [ ] **[ops]** A simple gate dashboard: pre-orders, waitlist count, skill-pack
      MRR, so the Phase 0 gate is read from data, not memory.

### Hygiene that gates later phases (already on the canonical roadmap)

- [ ] **[build]** Reconcile public claims (README, website, package metadata);
      re-word the local-first stance once the custody decision lands so no
      surface contradicts another.
- [ ] **[decision]** Adapter verification and promotion gates (canonical
      roadmap package 3). Needed before any adapter is promoted to hosted and
      before the API Index can rank networks defensibly.
- [ ] **[build]** Telemetry reconciliation (canonical roadmap package 10): one
      taxonomy, one consent contract, retention and deletion operations.
      Sequence 5 makes this a prerequisite for evaluating remote hosting.

**Gate to build Phase 1:** 30 founding pre-orders or 500 qualified waitlist
emails, and the custody decision accepted.

## Phase 1: hosted MVP, charge from day one (months 2 to 6)

### Identity and tenancy foundation

The server is identity-blind today: credentials load once from
`~/.affiliate-mcp/.env` into `process.env`, OAuth tokens cache in module-level
state, and `brands.json` plus client-strategy files live on local disk. Every
one of these becomes request-scoped, keyed by an authenticated user, with the
local single-user path preserved unchanged.

- [ ] **[build]** Request-scoped credential resolution replacing process-global
      loading; the local server resolves to the single local user.
- [ ] **[build]** Request-scoped OAuth token cache.
- [ ] **[build]** Per-tenant brand and client-strategy storage behind the same
      interfaces the local file paths implement today.
- [ ] **[build]** User accounts and login (email magic link or OAuth sign-in;
      no passwords to store).
- [ ] **[build]** Encrypted per-user credential vault: KMS-backed envelope
      encryption, decrypt only at call time, key rotation procedure written
      down. Use established secrets infrastructure, nothing home-rolled.

### Remote MCP transport

- [ ] **[build]** Streamable HTTP MCP endpoint with per-user token auth
      following the MCP authorisation spec; adapters untouched.
- [ ] **[build]** Per-tier rate limits and quotas at the transport boundary.
- [ ] **[build]** Per-user audit log of tool calls (network, operation,
      timestamp; never response payloads).
- [ ] **[ops]** Deploy pipeline with staging, managed secrets, backups, and a
      tested restore.

### Guided connect flow

- [ ] **[build]** Browser onboarding for the four production networks (Awin,
      CJ, Impact, Rakuten): OAuth where the network supports it, guided
      paste-once where it does not, connection test on save.
- [ ] **[build]** Automatic first-value report after the first successful
      connection (the roadmap's "guided first value" item, hosted edition).

### First paid-only feature and billing

- [ ] **[build]** Scheduled digest job runner: earnings plus unpaid
      commissions, delivered by email on the user's cadence. The simplest
      thing a local stdio server cannot do.
- [ ] **[build]** Hosted entitlement: merchant-of-record subscription state
      drives tier checks at the transport boundary, replacing the Phase 0
      stub seam. Trial logic: 14 days, no card, usage-capped.

### Trust surface

- [ ] **[build]** Self-serve full account export and hard delete.
- [ ] **[content]** Public trust page: what is stored, how it is encrypted,
      who can access it, how deletion works, the disclosure commitment.
- [ ] **[ops]** Incident and disclosure runbook written before launch, not
      after the first incident.

**Gate to continue:** £3k MRR and trial-to-paid at or above 5%.

## Phase 2: breadth and the money features (months 6 to 12)

- [ ] **[build]** Hosted promotion for the top 12 networks by waitlist demand.
      Promotion per network requires: the accepted adapter promotion gate met,
      a terms-of-service check for third-party credential use recorded in the
      network's docs, and the connect flow extended. Networks that fail the
      ToS check stay local-only and the pricing page says so.
- [ ] **[build]** Scheduled anomaly watch (Pro): threshold and trend checks
      over the same adapter operations the local anomaly skill uses.
- [ ] **[build]** Unpaid-commission chaser digest (Pro).
- [ ] **[build]** Brand-data QBR and weekly-report actions plus CSV export
      behind Pro, per the entitlement-gate decision's feature set.
- [ ] **[build]** Upgrade walls, visible-but-locked: network count,
      scheduling, teammate invite, export.
- [ ] **[build]** MCP Registry metadata published; Claude and ChatGPT
      connector directory listings (canonical roadmap, Sequence 3, item 5).
- [ ] **[build]** AI support agent grounded in the setup and findings docs,
      embedded on the site and docs.
- [ ] **[ops]** Lifecycle email automation: onboarding sequence, weekly
      usage-health, dormancy win-back.

**Gate to continue:** £10k to £15k MRR and monthly churn under 5%.

## Phase 3: team tier and the flywheel (months 12 to 24)

- [ ] **[decision]** Team-tier boundary: seats, roles, client workspaces,
      what the audit log exposes to a team admin, and the hard ceiling
      (card-only, no SLA, no custom contracts) restated as contract.
- [ ] **[build]** Team workspaces: seat management, shared brand context,
      client workspaces, admin audit view.
- [ ] **[build]** Client-ready report export (the agency deliverable that
      justifies £299).
- [ ] **[decision]** Certified adapter listing: self-serve purchase, badge
      semantics, and the independence rules that keep payment from ever
      affecting reliability claims (the canonical roadmap's stated risk).
- [ ] **[build]** Certified listing flow, inbound only.
- [ ] **[ops]** SOC 2 readiness track, started only if Team-tier demand shows
      it is needed: access controls, logging, and written policies first.

**Target band:** £30k to £50k MRR by month 24.

## Continuous workstreams (every phase)

### Content engine tooling

- [ ] **[build]** API Index generator: a script deriving the quarterly ranking
      from `network.json` metadata and the findings docs, so the Index is
      reproducible and arguable rather than editorial.
- [ ] **[content]** Demo-recording template and a backlog of workflow demos,
      three posts a week fed from product artefacts.
- [ ] **[build]** Free lead-magnet tools. Note the constraint: credential-free
      versions only (for example a link auditor over pasted URLs, an
      unpaid-commission estimator over an uploaded CSV export). A lead magnet
      must not create credential custody before the hosted contract exists.

### Ops guardrails

- [ ] **[ops]** Weekly metrics ritual generated automatically: MRR, churn,
      trials, conversion, gate status.
- [ ] **[ops]** Infrastructure cost monitoring with an alert threshold, so
      margin claims stay true.
- [ ] **[ops]** A security review pass before each phase promotion, scoped to
      what that phase adds.

## Lane discipline for this roadmap

The delivery protocol allows one `active-risk` PR at a time. The risk queue,
in order: custody decision record, pricing/billing/licence decision record
(both drafted 2026-07-12, awaiting acceptance), entitlement gate landing,
identity foundation, credential vault, remote transport, hosted billing,
Team-tier decision, certified-listing decision.
Routine lanes carry the content tooling, docs reconciliation, and funnel work
in parallel, since they are decision-complete and disjoint.

## Relation to the canonical roadmap

[`roadmap.md`](./roadmap.md) section 11 recommends monetising through support
contracts and managed agency setup first. The revenue plan's constraints (no
consulting, no account management) rule both out, so this roadmap skips them
and goes straight to the skill packs already accepted and the hosted gateway
the canonical roadmap places mid-term. Everything else here builds on the
canonical technical sequences: the trustworthy baseline, metadata and registry
standardisation, telemetry reconciliation before remote, and the testing
strategy all still apply and are referenced rather than repeated. If the
revenue plan is accepted as direction, the canonical roadmap's monetisation
section should gain a forward pointer in a follow-up docs change.

## What is deliberately not on this list

- Hosted write actions and browser handoffs (local-only until a hosted-action
  safety contract exists).
- Dashboards or BI surfaces; the AI client is the interface.
- Enterprise SSO, procurement, or compliance work beyond the trust page,
  unless SOC 2 readiness is triggered in Phase 3.
- General browser automation in the hosted tier.
- More speculative adapters ahead of the promotion-gate decision.
