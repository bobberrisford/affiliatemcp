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
`programme-performance-report` (every publisher), this skill is about one
partner across the period.

## Step 1 — resolve the brand

If the user did not name a brand, ask which one. Do not guess.

Call `affiliate_resolve_brand`. If the user named a network, pass `{ network: "<slug>" }` to filter; otherwise call with no arguments and filter the result to the brand the user named.

The response is an array of `{ brand, network, networkBrandId }`. Reduce it to the bindings whose `brand` matches the user's brand. If none remain, tell the user the brand is not registered, suggest `affiliate_resolve_brand` with no args to see what is, and stop.

Call `affiliate_list_networks` once and retain the metadata for those bindings.
Use each network's `knownLimitations` when deciding whether clicks or another
field are genuinely observed. Do not interpret a normalised zero as observed
zero when the network says that metric is unavailable.

## Step 2 — identify the publisher

Publisher ids are network-specific. Call
`affiliate_<network>_list_media_partners` for each binding and match the user's
named partner against `name` separately on each network:

- Awin advertiser: `affiliate_awin-advertiser_list_media_partners({ brand })`

This returns `MediaPartner[]` with `id`, `name`, `status`. Record a separate
`publisherId` and relationship status for every matching network binding. If a
name matches more than one partner on a network, list the candidates and ask
which. If it matches none on one network, report that gap and continue with
the remaining bindings. Stop only when no binding has a match.

## Step 3 — pick the windows

Default period: the last 90 days, ending today, so the trend is visible. Honour explicit windows. Compute a comparison window of the same length immediately prior for the period-over-period view. Express all dates as ISO `YYYY-MM-DD`. State both windows at the top.

## Step 4 — fetch this publisher's performance per binding

For each matching `(brand, network, publisherId)` tuple, call the performance
tool once for the current window and once for the comparison window. Pass that
network's publisher id so the network returns only that partner's rows:

- Awin advertiser: `affiliate_awin-advertiser_get_programme_performance({ brand, from, to, publisherId })`

Pass `brand` exactly as it came back from `affiliate_resolve_brand`. Each call returns `ProgrammePerformanceRow[]` with: `date`, `publisherId`, `publisherName`, `clicks`, `conversions`, `grossSale`, `commission`, `currency`, `status`.

Defensively keep only rows whose `publisherId` matches the id passed for that
binding. If a call returns other publishers, exclude those rows and flag that
the network did not honour the filter.

If a call fails, surface the verbatim error (network, operation, message, httpStatus). Do not silently treat a failure as zero. Continue with the remaining bindings and flag the gap at the top.

## Step 5 — write the review

Output in this order:

1. **Partner and period**: publisher name, relationship status, the brand and network, current window and comparison window (each with day count).
2. **Headline**: clicks, conversions, gross sale, commission for the current window, each with the comparison figure and delta (absolute and percent). Per-currency lines where the partner spans currencies; never invent an FX rate. Label clicks as unavailable where the network's limitations say they are unavailable; do not present a normalised zero as observed zero.
3. **Derived metrics**: conversion rate (`conversions / clicks`), EPC (`grossSale / clicks`), average order value (`grossSale / conversions`), and effective commission rate (`commission / grossSale`). Compute only where the denominator is non-zero and the underlying metric is known to be available; otherwise say "not computable" and why.
4. **Status split**: the partner's `grossSale` and `commission` by `status` (pending / approved / reversed). Flag a reversal share materially worse than the comparison window.
5. **Trend**: a short month-by-month (or week-by-week for short windows) line so the direction is visible.
6. **Talking points**: three to five plain-language observations for the call — what's working, what's slipped, and questions the data supports (for example, "reversals doubled; ask whether their traffic mix changed"). Only points the figures support. When advisory client strategy is available, use it as context; never present a suggestion as an approved commitment or action.
7. **Failures (if any)**: per-network verbatim error from the envelope.

Matter-of-fact tone, UK spelling, no hype.

## Constraints

- Never invent figures. If a row is missing, say "no data" — don't backfill zeros.
- Compute derived metrics only where the denominator is non-zero and the
  source metric is available. Treat unavailable normalised zeros as unknown.
- Currency: respect the per-row `currency`. If the partner spans multiple currencies, output each separately. Don't normalise across networks.
- Talking points must follow from the data. Do not invent partner intentions or commitments.
- Do not claim a partner's rank without comparing it against the other
  publishers in the programme.
- An inactive or pending partner may have little or no performance data — say so plainly rather than implying the partner has churned.
