---
name: qbr-prep
description: |
  Use this skill when an agency operator needs a presentation-ready Quarterly Business Review for a client brand: an executive-summary narrative, a multi-quarter trend (not just this quarter vs last), and a check of whether last quarter's recommended actions actually happened. This is the premium extension of the free `programme-performance-report` skill's QBR output profile, not a replacement for it.
  Trigger on: "Build the full QBR deck for Acme", "Prepare Acme's QBR with a trend and last quarter's action follow-up", "Get me presentation-ready for the Acme quarterly review", "Did we deliver on what we said last QBR for Acme?".
---

# Premium scope note

The free `programme-performance-report` skill already produces a full QBR
output profile: quarter window, quarter-over-quarter delta, monthly trend
within the quarter, partner mix, wins, risks, and two-to-four recommended
actions. Run that skill first, or as Step 1 below, if it has not been run for
this quarter. Do not re-derive figures this skill already computed.

This premium skill adds three things the free profile does not do:

1. A **multi-quarter trend** (typically the last four to six quarters, not
   just this quarter vs. last), so the narrative can say "third consecutive
   quarter of growth" rather than only one delta.
2. A **commitment follow-up**: it re-reads last quarter's recommended actions
   (if the operator has them, pasted or recalled) and reports, against this
   quarter's data, whether each one visibly happened.
3. A **presentation-ready structure**: a slide-outline shape (title, agenda,
   one idea per section) rather than a report-shaped document, so the
   operator can paste sections straight into slides.

It never re-sells the underlying numbers pull; it is a narrative and
structuring layer on top of data the free skill already knows how to fetch.

## Assumptions and requirements

- The brand is already registered via `affiliate_resolve_brand` (bindings to
  one or more advertiser-side networks). If it is not, stop and point the
  user at `affiliate-networks-mcp setup`.
- Credentials for the bound networks are configured. When credential state is
  uncertain, recommend `affiliate-networks-mcp doctor <slug>` rather than
  guessing.
- A recorded client strategy/KPI file is optional but improves the narrative
  (Step 2). Its absence is normal, not an error.
- Last quarter's recommended actions are optional input. If the user has no
  record of them, say so plainly in the follow-up section rather than
  inventing what might have been recommended.

## Step 1 — get this quarter's numbers

If the user has not already run it this session, run the free
`programme-performance-report` skill's QBR profile for this brand and
quarter: resolve the brand, load the client strategy via
`affiliate_get_client_strategy({ brand })`, and produce the quarter window,
partner mix, and current recommended actions exactly as that skill
specifies. Treat its output as this skill's input; do not duplicate its tool
calls if the user already has the numbers in front of them this session.

## Step 2 — pull the multi-quarter trend

Call the brand's bound networks' performance tool once per of the last four
to six complete calendar quarters (fewer if the brand has less history).
Tool names follow `affiliate_<network>_get_programme_performance`:

- Impact advertiser: `affiliate_impact-advertiser_get_programme_performance({ brand, from: <quarter-start>, to: <quarter-end> })`
- Awin advertiser: `affiliate_awin-advertiser_get_programme_performance({ brand, from: <quarter-start>, to: <quarter-end> })`

Sum `grossSale` and `commission` per quarter, per network, per currency. If a
network's history does not reach back that far (a new binding, or a call
fails), say so for that quarter rather than treating missing data as zero.
Do not blend currencies; show each currency's own trend line.

## Step 3 — check last quarter's commitments

If the user supplies or recalls last quarter's recommended actions (a
pasted list, or "we said we'd chase the coupon partner concentration"), test
each one against this quarter's data where the data can speak to it:

- An action about partner mix or concentration: compare this quarter's
  top-contributor share against last quarter's.
- An action about a specific programme or reversal rate: compare the metric
  named.
- An action the data cannot verify (e.g. "have a call with the client"):
  mark it "not verifiable from data" rather than guessing whether it
  happened.

If no prior actions are supplied, write one line: "No recorded actions from
last quarter were provided; skipping the follow-up section" and move on.
Never fabricate what a prior QBR might have recommended.

## Step 4 — assemble the presentation outline

Produce sections in this order, each short enough to become one slide:

1. **Title** — brand, quarter, date range.
2. **Executive summary** — three to five sentences: the quarter's headline
   direction, the multi-quarter trend in one sentence, and the one or two
   things that moved the number.
3. **Multi-quarter trend** — a compact table (quarter, gross sale, commission,
   conversions, per currency) plus one sentence describing the shape (growing,
   flat, seasonal, declining).
4. **This quarter vs. last** — from Step 1's output, unchanged.
5. **Partner mix** — from Step 1's output, unchanged.
6. **Last quarter's commitments** — from Step 3, one line per action:
   delivered / partially delivered / not delivered / not verifiable from
   data, each with the number that supports the verdict.
7. **Wins and risks** — from Step 1's output, unchanged.
8. **Recommended actions for next quarter** — from Step 1's output, unchanged,
   unless Step 3's follow-up surfaces a reason to revise one (say so
   explicitly if it does).
9. **Failures/gaps (if any)** — every network call that failed or a quarter
   that could not be pulled, verbatim.

Matter-of-fact tone, UK spelling. This is a narrative layer; every figure must
trace back to a tool call from Step 1 or Step 2. Never invent a figure to fill
a slide.

## Constraints

- Never invent figures, quarters, or prior commitments. A gap is stated, not
  filled.
- Currency: respect each network's currency. Show each currency's own
  multi-quarter trend; never invent an FX rate to combine them.
- The commitment follow-up only reports what the data can verify. Anything
  it cannot verify is marked "not verifiable from data", never assumed done
  or not done.
- This skill is read-only. It produces a narrative document; it does not
  send, publish, or action anything.
- Pair with `client-onboarding` to record a strategy/KPI file if the brand
  has none, which sharpens the executive summary's verdict framing.
