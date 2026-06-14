---
name: programme-qbr
description: |
  Use this skill when an agency operator needs to prepare a Quarterly Business Review for one brand: the quarter's trend month by month, partner mix, wins and risks, and a quarter-over-quarter comparison, written as a narrative the account manager can present to the client.
  Trigger on: "Prepare Acme's QBR", "Build the Q2 review for [brand]", "Quarterly business review for [brand]", "I need the quarterly deck for [brand]".
---

# Operating instructions

You are preparing a Quarterly Business Review for one brand across the networks
it is bound to. This is the set-piece client deliverable: longer than a weekly or
monthly report, structured as a narrative with supporting tables, and built to be
read aloud or pasted into a deck. It tells the story of the quarter — what grew,
what slipped, which partners drove it, and what to do next quarter.

If the user only wants this quarter's numbers without the narrative and
quarter-over-quarter framing, point them at `programme-performance-report`.

## Step 1 — resolve the brand

If the user did not name a brand, ask which one. Do not guess.

Call `affiliate_resolve_brand`. If the user named a network, pass `{ network: "<slug>" }` to filter; otherwise call with no arguments and filter the result to the brand the user named.

The response is an array of `{ brand, network, networkBrandId }`. Reduce it to the bindings whose `brand` matches the user's brand. If none remain, tell the user the brand is not registered, suggest `affiliate_resolve_brand` with no args to see what is, and stop.

## Step 2 — pick the quarter and the comparison

Default period: the **most recent complete calendar quarter** (Q1 = Jan–Mar, Q2 = Apr–Jun, Q3 = Jul–Sep, Q4 = Oct–Dec). Honour an explicit quarter ("Q2 2026", "last quarter").

You need three things, all as ISO `YYYY-MM-DD` ranges:

- the reported quarter, as three calendar-month sub-windows (for the month-by-month trend);
- the prior quarter, whole, for the quarter-over-quarter headline;
- optionally the same quarter last year if the user asks for a year-on-year view.

State the quarter and comparison window at the top so the client can confirm.

## Step 3 — fetch performance and partner mix per binding

For each `(brand, network)` binding from step 1:

- Call the performance tool once per month of the reported quarter and once for the whole prior quarter. Tool names follow `affiliate_<network>_get_programme_performance`:
  - Awin advertiser: `affiliate_awin-advertiser_get_programme_performance({ brand, from, to })`
- Call `affiliate_awin-advertiser_list_media_partners({ brand })` once for the partner mix (active vs pending vs inactive), so the review can speak to roster health, not just the partners that converted.

Pass `brand` exactly as it came back from `affiliate_resolve_brand`. The chassis resolves it to the right `networkBrandId` before the call goes out.

Each performance call returns `ProgrammePerformanceRow[]` with: `date`, `publisherId`, `publisherName`, `clicks`, `conversions`, `grossSale`, `commission`, `currency`, `status`. Roll up by month for the trend and by `publisherId` for the partner mix.

If a call fails, surface the verbatim error (network, operation, message, httpStatus). Do not silently treat a failure as zero. Continue with the remaining bindings and flag the gap at the top of the review.

## Step 4 — write the review

Structure it as a narrative with supporting tables, in this order:

1. **Period**: reported quarter (with month ranges) vs comparison quarter.
2. **Executive summary**: three to five sentences. The quarter-over-quarter direction, the one or two things that moved the number, and the headline figure per network (gross sale, commission, conversions) with the QoQ delta in absolute currency and percent. Per-currency lines where a binding spans currencies; never invent an FX rate.
3. **Monthly trend**: a small table per network — month, gross sale, commission, conversions, clicks — so the shape of the quarter is visible (ramp, dip, spike).
4. **Partner mix and top contributors**: roster split (active / pending / inactive) from `list_media_partners`, then the top contributing partners by quarter gross sale with their share of the total. Note any single partner above ~30% as a concentration risk.
5. **Wins**: the two or three partners or trends that drove growth, stated plainly.
6. **Risks and watch items**: declining partners, rising reversal share, dead links, concentration, anything that needs a decision.
7. **Recommended next quarter**: two to four concrete, evidence-backed actions (e.g. "reactivate the three dormant cashback partners", "investigate the May reversal spike"). Only recommend what the data supports.
8. **Failures (if any)**: per-network verbatim error from the envelope.

Matter-of-fact tone, UK spelling, no hype. The narrative explains the numbers; it does not inflate them.

## Constraints

- Never invent figures. If a month or row is missing, say "no data" — don't backfill zeros.
- Currency: respect the per-row `currency`. If a single binding spans multiple currencies, output each currency separately. Don't normalise across networks.
- Recommendations must follow from the data shown. Do not propose actions the figures do not support.
- This is the quarterly narrative. For an ad-hoc window without the QoQ story use `programme-performance-report`; for the whole book use `agency-portfolio-rollup`.
