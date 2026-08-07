# Technical roadmap: the to-do list for the £50k plan

> Status: accepted direction (2026-07-12, Rob). Companion to
> [`solo-50k-revenue-plan.md`](./solo-50k-revenue-plan.md); this document turns
> that plan's phases into ordered, checkable work items. Items marked
> **[decision]** need an accepted record under
> [`../decisions/`](../decisions) before dependent implementation, per
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

- [x] **[decision]** Hosted credential custody: accepted by Rob (2026-07-12)
      as
      [`2026-07-12-hosted-credential-custody.md`](../decisions/2026-07-12-hosted-credential-custody.md).
      Hosted foundation work is unblocked.
- [x] **[decision]** Pricing, billing, and licence: accepted by Rob
      (2026-07-12) as
      [`2026-07-12-pricing-billing-and-licence.md`](../decisions/2026-07-12-pricing-billing-and-licence.md)
      (anchors £34/£99/£299, packs £20, founding Pro £699/year, Stripe
      direct, MIT stays).
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
- [x] **[build]** The brand-data entitlement gate from
      [`2026-06-30-paid-tier-entitlement-gate.md`](../decisions/2026-06-30-paid-tier-entitlement-gate.md)
      is already shipped on `main` (`src/brand-data/entitlement.ts`, the
      single dispatch choke point in `src/server.ts`, and tests; landed via
      the brand-data workstream PRs). The record's acceptance in this change
      set regularises that. Known deviation to resolve with billing: the
      shipped default is entitled-by-default, asserted in a code comment as a
      maintainer decision; the real billing wiring must set the final default
      deliberately.
- [ ] **[build]** First two premium skill packs, chosen by Rob (2026-07-12):
      the agency pack (QBR prep, client weekly report, portfolio rollup,
      drawn from
      [`agency-account-manager-deliverables.md`](./agency-account-manager-deliverables.md))
      and the publisher money pack (unpaid-commission chaser, earnings
      rollup, reversal investigation), delivered through the desktop skills
      step.
- [ ] **[content]** Pricing page and checkout flow on the website.

### Funnel foundation

- [x] **[content]** Pricing and founding-offer page shipped (PR #350).
      Waitlist capture was rescinded on 2026-07-13
      ([`2026-07-13-build-hosted-without-presell.md`](../decisions/2026-07-13-build-hosted-without-presell.md));
      the CTA repoints to the hosted product as slices ship.
- [ ] **[ops]** Privacy-respecting site analytics (for example Plausible),
      once Rob picks the account.
- Gate dashboard: dropped with the pre-sell gate.

### Hygiene that gates later phases (already on the canonical roadmap)

- [ ] **[build]** Reconcile public claims (README, website, package metadata);
      re-word the local-first stance once the custody decision lands so no
      surface contradicts another.
- [x] **[decision]** Adapter verification and promotion gates: already
      accepted as `2026-06-15-adapter-promotion-gates.md`; this checkbox was
      stale. The API Index generator is unblocked (Rob, 2026-07-12), with
      publication of a ranking still a separate go/no-go.
- [ ] **[build]** Telemetry reconciliation (canonical roadmap package 10): one
      taxonomy, one consent contract, retention and deletion operations.
      Sequence 5 makes this a prerequisite for evaluating remote hosting.

**Gate to build Phase 1: rescinded** (2026-07-13, Rob). The custody
decision is accepted and the hosted MVP proceeds per
[`hosted-mvp-workstream.md`](./hosted-mvp-workstream.md).

## Phase 1: hosted MVP, charge from day one (months 2 to 6)

> **Status (2026-07-18):** the hosted MVP shipped and is live. Slices H1–H6
> merged — H1 request-scoped identity seam (#356), H2 hosted scaffold +
> magic-link auth (#357), H3 encrypted credential vault (#359), H4 remote MCP
> transport (#360), H5 guided connect flow (#361), H6 scheduled digest +
> billing tie-in (#362), plus the billing page/checkout/portal (#364) and the
> OAuth 2.1 connector-auth migration (#371–#375). `hosted.agenticaffiliate.ai`
> and the transport at `mcp.agenticaffiliate.ai` are serving. The checkboxes
> below are updated to match; `docs/product/hosted-mvp-workstream.md` and
> `docs/product/hosted-oauth-ship-runbook.md` are the detailed source of truth.
> Still open before public launch: per-user audit log, automatic first-value
> report, self-serve account export, public trust page, incident/disclosure
> runbook, and the vault key-rotation procedure written down.

### Identity and tenancy foundation

The server is identity-blind in the local single-user path: credentials load
once from `~/.affiliate-mcp/.env` into `process.env`, OAuth tokens cache in
module-level state, and `brands.json` plus client-strategy files live on local
disk. In the hosted path each of these is request-scoped, keyed by an
authenticated user, with the local single-user path preserved unchanged.

- [x] **[build]** Request-scoped credential resolution replacing process-global
      loading; the local server resolves to the single local user. (H1, #356)
- [x] **[build]** Request-scoped OAuth token cache. (H1, #356)
- [ ] **[build]** Per-tenant brand and client-strategy storage behind the same
      interfaces the local file paths implement today.
- [x] **[build]** User accounts and login (email magic link or OAuth sign-in;
      no passwords to store). (H2 magic link #357; OAuth 2.1 #371–#375)
- [x] **[build]** Encrypted per-user credential vault: KMS-backed envelope
      encryption, decrypt only at call time, key rotation procedure written
      down. Use established secrets infrastructure, nothing home-rolled. (H3,
      #359 — vault shipped; the written-down key-rotation procedure is still
      outstanding, see Trust surface below.)

### Remote MCP transport

- [x] **[build]** Streamable HTTP MCP endpoint with per-user token auth
      following the MCP authorisation spec; adapters untouched. (H4, #360;
      OAuth discovery slice 2b, #375)
- [ ] **[build]** Per-tier rate limits and quotas at the transport boundary.
- [ ] **[build]** Per-user audit log of tool calls (network, operation,
      timestamp; never response payloads).
- [ ] **[ops]** Deploy pipeline with staging, managed secrets, backups, and a
      tested restore.

### Guided connect flow

- [x] **[build]** Browser onboarding for the four production networks (Awin,
      CJ, Impact, Rakuten): OAuth where the network supports it, guided
      paste-once where it does not, connection test on save. (H5, #361)
- [ ] **[build]** Automatic first-value report after the first successful
      connection (the roadmap's "guided first value" item, hosted edition).

### First paid-only feature and billing

- [x] **[build]** Scheduled digest job runner: earnings plus unpaid
      commissions, delivered by email on the user's cadence. The simplest
      thing a local stdio server cannot do. (H6, #362)
- [x] **[build]** Hosted entitlement: merchant-of-record subscription state
      drives tier checks at the transport boundary, replacing the Phase 0
      stub seam. Trial logic: 14 days, no card, usage-capped. (H6 + billing
      #364 — entitlement gate and Stripe subscription state shipped; confirm
      the 14-day trial parameters at go-live.)

### Trust surface

- [ ] **[build]** Self-serve full account export and hard delete. (Hard delete
      shipped — `DELETE /account`; self-serve export still to add.)
- [ ] **[content]** Public trust page: what is stored, how it is encrypted,
      who can access it, how deletion works, the disclosure commitment.
- [ ] **[ops]** Incident and disclosure runbook written before launch, not
      after the first incident.

**Gate to continue:** £3k MRR and trial-to-paid at or above 5%.

## Phase 2: breadth and the money features (months 6 to 12)

- [ ] **[build]** Hosted promotion for the top 12 networks, ordered by
      hosted usage and connect-flow requests (the waitlist signal was
      rescinded 2026-07-13), with an explicit maintainer call where the
      signal is thin.
      Promotion per network requires: the accepted adapter promotion gate met,
      a terms-of-service check for third-party credential use recorded in the
      network's docs, the connect flow extended, and any module-level OAuth
      token cache keyed by request identity (nine non-MVP adapters hold
      unkeyed caches today; promoting one without keying would
      cross-contaminate tenants; see the H1 review finding, 2026-07-14).
      Networks that fail the ToS check stay local-only and the pricing page
      says so.
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
in order: custody and pricing/billing/licence decision records (accepted
2026-07-12; the entitlement gate is already shipped on `main`), skill-pack
billing, identity foundation, credential vault, remote transport, hosted
billing, Team-tier decision, certified-listing decision.
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
