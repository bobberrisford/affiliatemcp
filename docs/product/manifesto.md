# Manifesto: AI-native affiliate data

> Status: current product direction. Accepted decisions and shipped behaviour
> take precedence where later work changes a product boundary.

## The problem

Affiliate work is spread across network dashboards, exports, spreadsheets,
emails, decks, and planning docs. AI workspaces are becoming the place where
knowledge work happens, but affiliate operational data is still trapped
elsewhere.

The result is familiar: a manager asks a good question, then has to leave the
conversation to pull a CSV, check a dashboard filter, paste rows into a sheet,
draft the explanation, and remember which caveats apply to each network.

## The mission

Make affiliate network data available where affiliate work happens.

This project wraps affiliate network access into local-first MCP tools, skills,
prompts, and workflow guidance. The preferred path is a network's public,
documented API. Where a network has no usable API, or only exposes part of the
job through one, the project can drive the user's own authenticated session to
do what the user could already do by hand in the dashboard. Users bring their
own credentials. Everything runs against access the user already has, then gives
AI clients a typed and auditable way to work with that data.

## What AI-native affiliate data means

AI-native affiliate data is not a dashboard clone and it is not a raw endpoint
catalogue. It means:

- **Typed tools** that expose understandable affiliate operations.
- **Reusable workflows** that match real affiliate tasks.
- **Honest responses** that preserve upstream limits, errors, and missing API
  support, and that make clear when data came from an API or from a browser-driven
  session.
- **Local control** so credentials stay on the user's machine by default.
- **Portable context** so Claude, ChatGPT, Codex, Cursor, Cowork, and future MCP
  clients can use the same affiliate data layer.

## What this enables

The useful workflow is not only pulling data. It is pulling network data and
then doing the next piece of affiliate work. For networks with a capable API
this runs through the API; for legacy networks it can run through the user's own
dashboard session:

- Performance analysis across programmes, brands, partners, and networks.
- Partner discovery and programme opportunity reviews.
- Transaction checks, unpaid commission reviews, and reversal investigations.
- Link audits and tracking-link generation.
- Anomaly reviews for sudden drops, spikes, or stale activity.
- Publisher outreach drafts and partner follow-up planning.
- QBR prep, client updates, and internal performance briefs.
- Setup and diagnostic guidance for semi-technical operators.

## Who this is for

- **Publishers** who care about earnings, pending commissions, unpaid
  transactions, link health, programme performance, and cross-network reporting.
- **Advertisers, brands, and agencies** who manage programmes, optimise partner
  performance, prepare reports, and increasingly use AI tools in daily work.
- **Semi-technical operators** who are comfortable with guided setup flows,
  GitHub instructions, terminals, Claude Code, Codex, Cowork, or similar tools,
  but do not want to understand the internals.
- **Developers and data teams** building reporting workflows, reconciliation
  jobs, internal tools, or AI-native affiliate operations.
- **Affiliate network employees** who want their own network adapter to be
  correct, supported, and owned by people who know the API.
- **AI coding agents** that need explicit instructions so their changes stay
  small, safe, and reviewable.

## Principles

1. **API-first, browser as fallback.** Prefer a network's public, documented
   API. Where no usable API exists, or it covers only part of the job, automate
   the user's own authenticated session to do what they could do by hand.
   Browser-driven operations are more brittle and UI-dependent, so label them as
   such and keep them behind the same typed contract as API-backed operations.
2. **Local-first by default.** Users bring their own credentials. Credentials
   stay on the user's machine unless a future remote option is designed with
   explicit auth, consent, auditability, and security.
3. **Safe typed tools.** Tools should expose affiliate operations with clear
   inputs and outputs. They should not ask the assistant to guess at raw API
   behaviour.
4. **Workflows over endpoint trivia.** Users should not need to know API names
   to prepare a QBR, investigate unpaid commissions, or draft publisher
   outreach.
5. **Honest network truth.** Every adapter must be clear about what is
   supported, partial, experimental, unsupported, gated, or unverified, and
   whether an operation is API-backed or browser-driven.
6. **No fake support.** If a network does not expose click data, brand-side
   access, or a reporting field through any available path, the docs and adapter
   should say so.
7. **Contributor-friendly and agent-friendly.** Humans and AI agents should be
   able to find the right files, understand the boundaries, run the checks, and
   open focused PRs.
8. **UK English.** User-facing docs use "programme" and the repo's existing UK
   spelling convention.

## What the project will not do

- Store user credentials in a hosted service by default.
- Phone home with telemetry or analytics.
- Pretend unsupported operations work by returning empty arrays.
- Hide upstream API errors or replace them with vague failures.
- Add broad abstractions before multiple networks prove the same shape.
- Expand the public tool surface without a clear contract change.

## Contribution model

Community contributors can improve setup docs, add fixtures, correct API
behaviour, add workflow packs, fix adapter bugs, or contribute new network
adapters. Semi-technical contributors can help by documenting dashboard paths,
common setup failures, and real affiliate workflows that should become skills
or prompts.

Affiliate networks are invited to adopt and own their own adapter. That is the
preferred path. Network employees know their API, access tiers, dashboard
language, approval requirements, and edge cases better than the community can
guess them.

Good contributions are small, honest, and easy to review. If something remains
uncertain, say so in the docs, the fixture notes, or the PR description.
