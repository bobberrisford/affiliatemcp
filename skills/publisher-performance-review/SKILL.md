---
name: publisher-performance-review
description: |
  Use this skill when an agency operator wants a deep dive on one publisher for a brand, usually as prep for a partner call: that publisher's clicks, conversions, EPC, average order value, commission, status split, and trend over time, with talking points for the conversation.
  Trigger on: "Review CashbackCo for Acme", "Prep me for the call with [publisher]", "How is [publisher] performing on [brand]?", "Pull a publisher review for [partner]".
---

# Operating instructions

You are producing a single-publisher performance review for one brand: a focused
profile of how one partner is performing, built so the account manager can walk
into a call knowing the numbers and the story behind them. Unlike
`programme-performance-report` (every publisher) or `programme-weekly-report`
(the whole programme), this skill is about one partner across the period.

## Step 1 — resolve the brand

If the user did not name a brand, ask which one. Do not guess.

Call `affiliate_resolve_brand`. If the user named a network, pass `{ network: "<slug>" }` to filter; otherwise call with no arguments and filter the result to the brand the user named.

The response is an array of `{ brand, network, networkBrandId }`. Reduce it to the bindings whose `brand` matches the user's brand. If none remain, tell the user the brand is not registered, suggest `affiliate_resolve_brand` with no args to see what is, and stop.

## Step 2 — identify the publisher

You need the publisher's id, not just their name. Call `affiliate_<network>_list_media_partners` for each binding and match the user's named partner against `name`:

- Awin advertiser: `affiliate_awin-advertiser_list_media_partners({ brand })`

This returns `MediaPartner[]` with `id`, `name`, `status`. Resolve the user's partner to a `publisherId` and note their relationship `status` (active / pending / inactive). If the name matches more than one partner, list the candidates and ask which. If it matches none, say so and stop; offer to list the roster.

## Step 3 — pick the windows

Default period: the last 90 days, ending today, so the trend is visible. Honour explicit windows. Compute a comparison window of the same length immediately prior for the period-over-period view. Express all dates as ISO `YYYY-MM-DD`. State both windows at the top.

## Step 4 — fetch this publisher's performance per binding

For each `(brand, network)` binding, call the performance tool filtered to the resolved publisher, once for the current window and once for the comparison window. Pass the `publisherId` so the network returns only that partner's rows:

- Awin advertiser: `affiliate_awin-advertiser_get_programme_performance({ brand, from, to, publisherId })`

Pass `brand` exactly as it came back from `affiliate_resolve_brand`. Each call returns `ProgrammePerformanceRow[]` with: `date`, `publisherId`, `publisherName`, `clicks`, `conversions`, `grossSale`, `commission`, `currency`, `status`.

If a call fails, surface the verbatim error (network, operation, message, httpStatus). Do not silently treat a failure as zero. Continue with the remaining bindings and flag the gap at the top.

## Step 5 — write the review

Output in this order:

1. **Partner and period**: publisher name, relationship status, the brand and network, current window and comparison window (each with day count).
2. **Headline**: clicks, conversions, gross sale, commission for the current window, each with the comparison figure and delta (absolute and percent). Per-currency lines where the partner spans currencies; never invent an FX rate.
3. **Derived metrics**: conversion rate (`conversions / clicks`), EPC (`grossSale / clicks`), average order value (`grossSale / conversions`), and effective commission rate (`commission / grossSale`). Compute only where the denominator is non-zero; otherwise say "not computable".
4. **Status split**: the partner's `grossSale` and `commission` by `status` (pending / approved / reversed). Flag a reversal share materially worse than the comparison window.
5. **Trend**: a short month-by-month (or week-by-week for short windows) line so the direction is visible.
6. **Talking points**: three to five plain-language observations for the call — what's working, what's slipped, and one concrete ask or offer the data supports (e.g. "EPC up 18%, worth discussing a tenancy slot"; "reversals doubled, ask what changed in their checkout flow"). Only points the figures support.
7. **Failures (if any)**: per-network verbatim error from the envelope.

Matter-of-fact tone, UK spelling, no hype.

## Constraints

- Never invent figures. If a row is missing, say "no data" — don't backfill zeros.
- Compute derived metrics only where the denominator is non-zero.
- Currency: respect the per-row `currency`. If the partner spans multiple currencies, output each separately. Don't normalise across networks.
- Talking points must follow from the data. Do not invent partner intentions or commitments.
- An inactive or pending partner may have little or no performance data — say so plainly rather than implying the partner has churned.
