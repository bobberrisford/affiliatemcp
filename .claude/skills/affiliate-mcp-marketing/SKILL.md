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

## How a post is written

Rob writes short. Model the cadence on how he actually talks, not on how
marketing copy usually reads. This section exists because a run of posts was
drafted at 900 to 1,100 characters, dense with em dashes and balanced clauses,
and he rejected the lot as "too long and AI sloppy". Everything below is the
specific fix.

**Length.** Aim 350 to 500 characters. Hard ceiling 600. If it is longer, the
idea is not sharp enough yet, so cut rather than compress. One idea per post.

**Shape.** Open with the sharpest line in the post, standing alone. Paragraphs
of one or two sentences. Most sentences under fifteen words. Fragments are
fine. Stop when the point lands; no closing restatement of the thesis.

**Banned outright.** These are the tells:

- em dashes, anywhere (AGENTS.md bans them in prose; that includes posts)
- semicolons
- "It isn't X. It's Y." and every variant of the balanced correction
- rule-of-three lists ("faster, cheaper, simpler")
- signposting before the point: "here's the thing", "the part I didn't expect
  is", "what's worth sitting with", "let me be clear"
- restating the opening as a closing line
- intensifiers used as filler: genuinely, simply, truly, incredibly. These
  words are fine when they carry meaning ("the terms I've actually read", as
  opposed to skimmed) and banned when they only add emphasis
- "not just X but Y"

**Required.** Contractions throughout: it's, doesn't, isn't, we'd, you've.
Writing "it is not" and "I am going to" where a person would say "it isn't"
and "I'm going to" is the single clearest AI tell in the rejected drafts.

**Before and after**, from the run that was rejected:

> Every piece of affiliate reporting automation has the same failure mode: it
> only runs when you are already at your desk. Which means it is not
> automation. It is a faster version of you doing it.

becomes

> Most affiliate reporting automation only runs when you're already at your
> desk. That isn't automation. That's you, slightly faster.

Same claim, 40 percent shorter, no em dash, contracted, and the correction
lands in four words instead of a balanced pair.

**Read it aloud before it ships.** If you run out of breath, or it sounds like
a press release, rewrite it.

## Ship-checks (apply to every artefact before it reaches the brief)

- **One real number, never a bare claim.** Every figure is real anonymised data
  or explicitly reframed as a demo. Never present invented client data as real.
- **No invented first-person anecdotes.** Do not write "a client asked me" or
  "a beta user told me" unless Rob has said it happened. If the scenario is
  useful, write it in second person as a scenario. This has been caught twice.
- Matter-of-fact, UK English, no marketing hype. Use "programme", not "program".
- Outcome first, tool second. Be honest about experimental network support.
- **Value, not features.** Name the work the reader stops doing. Encryption,
  OAuth, vaults and network counts appear only where they answer an objection,
  never as the subject of a post.
- Links live in the first comment, not the post body.
- Every post passes the length ceiling and the banned-construction list above.

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

- Draft-only by default, and the default cadence is weekly, not daily. Never
  publish or queue a live post outside a campaign.
- **Campaign mode is the one exception**, per
  `docs/decisions/2026-07-27-campaign-mode-for-reviewed-social-runs.md`. A named,
  time-boxed run whose copy Rob has reviewed in a tracked PR, and which he has
  explicitly authorised, may be scheduled into the Buffer queue. Scheduling only:
  approved copy at agreed slots, no new copy, no edits, no extra channel. Replies
  and comments are never agent-posted, campaign or not.
- Never invent figures; pass every artefact through the ship-checks above.
- No new MCP tools; use existing tools, the launch bundles, and Buffer drafts.
- Marketing copy changes stay documentation and asset changes; do not touch
  runtime behaviour to make a marketing point.
