---
name: programme-performance-report
description: |
  Use this skill when an agency operator asks for a performance report for a single brand across one or more advertiser-side affiliate networks — per-publisher rollup, status split, and period-over-period delta.
  Trigger on: "How is Acme performing this quarter?", "Show me the programme report for [brand]", "[brand] performance last month", "Which publishers are driving Acme's revenue?".
---

# Operating instructions

You are producing a per-publisher performance report for one brand across the networks it is bound to.

## Step 1 — resolve the brand

If the user did not name a brand, ask which one. Do not guess.

Call `affiliate_resolve_brand`. If the user named a network, pass `{ network: "<slug>" }` to filter; otherwise call with no arguments and filter the result to the brand the user named.

The response is an array of `{ brand, network, networkBrandId }`. Reduce it to the bindings whose `brand` matches the user's brand. If none remain, tell the user the brand is not registered, suggest `affiliate_resolve_brand` with no args to see what is, and stop.

## Step 2 — pick the windows

Default period: the last 30 days, ending today. Honour explicit user windows ("Q1", "last month", named dates).

Compute a comparison window of the same length immediately prior. Express all dates as ISO `YYYY-MM-DD`. Surface both windows in the final report so the user can confirm.

## Step 3 — fetch per-publisher performance per binding

For each `(brand, network)` binding from step 1, call the network's performance tool twice — current window and comparison window. Tool names follow `affiliate_<network>_get_programme_performance`:

- Impact advertiser: `affiliate_impact-advertiser_get_programme_performance({ brand, from, to })`

Pass `brand` exactly as it came back from `affiliate_resolve_brand`. The chassis resolves it to the right `networkBrandId` before the call goes out.

Each call returns `ProgrammePerformanceRow[]` with: `date`, `publisherId`, `publisherName`, `clicks`, `conversions`, `grossSale`, `commission`, `currency`, `status`. Roll up rows by `publisherId` for the headline; keep the status field for the status split.

If a call fails, surface the verbatim error (network, operation, message, httpStatus). Do not silently treat a failure as zero. Continue with the remaining bindings and flag the gap clearly at the top of the report.

## Step 4 — present the report

Output in this order:

1. **Windows**: current `from YYYY-MM-DD to YYYY-MM-DD` and comparison `from YYYY-MM-DD to YYYY-MM-DD` (each with day count).
2. **Headline per network**: total `grossSale`, total `commission`, total `conversions`, total `clicks`. Show the comparison-window figure and the delta in both absolute currency and percent. If a brand-network binding produced rows in more than one currency, list each currency separately — do not invent an FX rate.
3. **Status split**: per network, sum `grossSale` and `commission` by `status` (`pending` / `approved` / `reversed`). Call out a status that has flipped to >50% reversed compared to the comparison window.
4. **Top 10 publishers** by current-period `grossSale` (descending). For each: publisher name, conversions, gross sale, commission, and the same per-publisher delta vs. the comparison window.
5. **Anomalies**: anything that looks broken — a publisher with zero clicks but historical clicks, a programme with 100% reversed status this window, a publisher that contributed >25% of last period's revenue and 0% this period.
6. **Failures (if any)**: per-network verbatim error from the envelope.

Matter-of-fact tone, UK spelling. Keep tables compact.

## Constraints

- Never invent figures. If a row is missing, say "no data" — don't backfill zeros.
- Currency: respect the per-row `currency`. If a single binding spans multiple currencies, output each currency separately.
- Don't normalise across networks. Per-network totals stay in their own currency.
- Pair with `affiliate_impact-advertiser_list_transactions({ brand, from, to })` when the user drills into "what makes up this number?".
- Use `affiliate_impact-advertiser_list_media_partners({ brand })` if the user asks "who else could be promoting us?" — that endpoint includes inactive partners that won't appear in the performance rollup.
