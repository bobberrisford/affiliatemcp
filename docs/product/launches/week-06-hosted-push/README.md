# Week 06 — hosted push

The launch bundle for the hosted marketing push, week of 27 July 2026.

Unlike weeks 03–05, this is not a single shareable automation. It is a
campaign: seven LinkedIn posts driving to the hosted funnel, landing after the
funnel has been made truthful and measurable.

## Contents

- `posts.md` — the seven posts, with slots, first comments, UTM slugs, the
  blockers that must clear before scheduling, and a source for every factual
  claim.

## Sequencing

This bundle **does not ship on its own**. It depends on:

1. **#414** — the trust-surface and analytics decision (Proposed, awaiting Rob).
2. **#415** — the trust-page rewrite. Post 2 asserts the security page is fixed
   and must not go out before this is live.
3. Analytics and the hosted landing-page rebuild, so the traffic lands
   somewhere measurable and conversion-shaped.
4. Rob's Phase 0 gates: Stripe on live keys, the seeded test tenant provisioned
   so the daily smoke stops no-opping, and one real Claude connector OAuth
   round-trip.

## Publishing

Copy is reviewed here, in this PR, before anything is scheduled. Scheduling
into Buffer then happens as a named campaign — see the campaign-mode amendment
to `docs/decisions/2026-07-20-agentic-company-operations.md`, which that record
currently forbids.

Channel is Rob's LinkedIn profile only. The company page is dropped for this
run; blitz #1 earned it a mean of ~20 impressions across 20 posts, decaying to
2 by the Friday.

## Measurement

Baseline to beat, from blitz #1 on the profile: mean ~310 impressions per post,
best 591, engagement rate 0.36–3.5%.

New this run: each post links to its own `/go/<slug>` path (PR #419), so page
views are attributable per post without attaching a tracking parameter to
anyone's URL. Hosted sign-in requests can be compared against the campaign
window from the worker's own logs.
