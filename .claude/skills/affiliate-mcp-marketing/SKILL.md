---
name: affiliate-mcp-marketing
description: |
  Use this skill to prepare affiliate-mcp's find-users marketing in prepare-and-approve mode: the weekly branded LinkedIn card and post, directory and registry listing submissions, and free lead-magnet content. It applies the voice and ship-checks and queues everything as Buffer drafts; it never publishes or queues a live post.
  Trigger on: "prepare this week's launch post", "draft the marketing", "queue the weekly card", "prepare directory listings", "run the marketing loop".
---

# Operating instructions

You prepare marketing as **drafts only**. Social posts become **Buffer drafts**
(never `addToQueue`, never published). Copy and asset changes become **draft
pull requests**. This honours the authority boundary in
`docs/decisions/2026-07-20-agentic-company-operations.md`.

The acquisition motion is the accepted organic one in
`docs/product/solo-50k-revenue-plan.md` section 7: weekly content, directory and
registry listings, and free lead magnets. No paid ads, no cold outreach, no
scraping, no bought lists.

## Weekly launch (alternating publisher / agency)

Follow the pattern in `docs/product/launches/week-03-unpaid-commission-finder/`
and `week-04-anomaly-alert/`:

- a 1080x1080 branded card, rendered by the `affiliate-mcp-design` skill;
- a LinkedIn post whose links go in the **first comment**, not the body;
- tagline "Automate the drudgery."; call to action agenticaffiliate.ai.

Queue the post as a **Buffer draft** on the connected channel. Alternate the
cohort week to week (publisher, then agency).

## Ship-checks (apply to every artefact before it reaches the brief)

- **One real number, never a bare claim.** Every figure is real anonymised data
  or explicitly reframed as a demo. Never present invented client data as real.
- Matter-of-fact, UK English, no marketing hype. Use "programme", not "program".
- Outcome first, tool second. Be honest about experimental network support.
- Links live in the first comment, not the post body.

## Directory and registry listings

Draft submissions or updates for the Claude and ChatGPT connector directories
and the MCP registry as **draft pull requests** or brief items for the operator
to submit. Ground every claim in `README.md`, `docs/`, and `network.json` truth;
do not overstate coverage or maturity.

## Lead magnets

Draft free-tool content (for example a link auditor or an unpaid-commission
estimator) that leads to email capture, as **draft pull requests**. No gated
core data, no dark patterns, no fake scarcity.

## Hand back to the brief

Give `company-ops` a compact list: each Buffer draft (channel, hook line,
proposed date), and each listing or lead-magnet draft PR. Nothing is posted.

## Constraints

- Draft-only, and the launch cadence is weekly, not daily. Never publish or
  queue a live post.
- Never invent figures; pass every artefact through the ship-checks above.
- No new MCP tools; use existing tools, the launch bundles, and Buffer drafts.
- Marketing copy changes stay documentation and asset changes; do not touch
  runtime behaviour to make a marketing point.
