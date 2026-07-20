# Product documentation

Product documents capture direction, proposals, research, and historical
planning. They are useful context, but accepted records under
[`../decisions/`](../decisions) and shipped behaviour take precedence.

## Current direction

- [`manifesto.md`](./manifesto.md) describes the product mission and principles.
- [`roadmap.md`](./roadmap.md) is the canonical current product and technical
  roadmap. It recommends direction and sequencing; accepted decisions and
  shipped behaviour remain authoritative.
- [`ai-native-affiliate-data.md`](./ai-native-affiliate-data.md) describes the
  intended AI-native product shape and is supporting context for the canonical
  roadmap.
- [`openai-parity.md`](./openai-parity.md) records the current split between
  shipped Codex support and future ChatGPT support. The canonical roadmap owns
  cross-client sequencing.
- [`feedback-loop.md`](./feedback-loop.md) is the operating model for how user
  feedback is captured across GitHub, the desktop app, and the hosted product,
  and turned into docs fixes, adapter repairs, and roadmap items.

## Active proposals and working drafts

- [`solo-50k-revenue-plan.md`](./solo-50k-revenue-plan.md) is the working
  commercial plan for reaching £50k/month solo, building on
  [`hosted-version-scoping.md`](./hosted-version-scoping.md) and the accepted
  paid-tier decisions. Direction, not authorisation.
- [`solo-50k-technical-roadmap.md`](./solo-50k-technical-roadmap.md) is the
  phased technical to-do list for that plan. Decision-gated items need
  accepted records before implementation.
- [`phase-0-go-live-checklist.md`](./phase-0-go-live-checklist.md) is the
  maintainer-only operational checklist (Stripe, Worker deploy, key swap,
  end-to-end proof) for taking the skill-pack tier live.
- [`hosted-mvp-workstream.md`](./hosted-mvp-workstream.md) is the active
  Phase 1 workstream brief (slices H1 to H6), started 2026-07-13 under the
  build-hosted-without-presell decision.
- [`hosted-version-scoping.md`](./hosted-version-scoping.md) is the original
  discovery proposal for a hosted version; superseded by the accepted
  custody decision and the active workstream brief.
- [`chatgpt-scoping.md`](./chatgpt-scoping.md) is a pre-implementation proposal.
- [`agency-account-manager-deliverables.md`](./agency-account-manager-deliverables.md)
  is the active, capability-aware backlog for agency deliverables and skills.
- [`website-copy.md`](./website-copy.md) is working copy for the website.

## Historical and implemented plans

These explain how existing work was scoped. They are not current requirements:

- [`claude-desktop-app-scoping.md`](./claude-desktop-app-scoping.md)
- [`desktop-app-plan.md`](./desktop-app-plan.md)
- [`website-plan.md`](./website-plan.md)
- [`deployment-plan.md`](./deployment-plan.md)
- [`design-system/README.md`](./design-system/README.md), the original design
  brief; the implemented source of truth is
  [`../../design-system/README.md`](../../design-system/README.md)

## Research

- [`global-coverage-research.md`](./global-coverage-research.md)
- [`wecantrack-integration-plan.md`](./wecantrack-integration-plan.md)

## Maintaining this index

Add every new product document here with an explicit status. When a proposal is
accepted, link its decision record. When implementation or a later decision
supersedes a plan, move it to the historical section instead of deleting the
context.
