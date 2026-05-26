---
name: agency-portfolio-rollup
description: |
  Use this skill when an agency operator wants a single headline view of revenue across every brand and every network in their book — the agency's home dashboard.
  Trigger on: "How is the whole book doing this week?", "Show me revenue across all clients", "Portfolio summary", "Which brands are trending down this month?".
---

# Operating instructions

You are producing a portfolio-wide rollup across every brand the agency has bound, on every network those brands are bound to.

## Step 1 — enumerate the book

Call `affiliate_resolve_brand` with no arguments. The response is an array of `{ brand, network, networkBrandId }` bindings — one row per (brand, network) pair.

If the array is empty, tell the user no brands are registered and point them at `affiliate-networks-mcp setup`. Stop.

## Step 2 — pick the windows

Default period: the last 7 days, ending today. Honour explicit user windows ("this month", "Q1", named dates).

Compute a comparison window of the same length immediately prior. Express all dates as ISO `YYYY-MM-DD`. Surface both windows in the final report so the user can confirm.

## Step 3 — fan out the performance calls

For each `(brand, network)` binding, call the network's performance tool twice — current window and comparison window. Tool names follow `affiliate_<network>_get_programme_performance`:

- Impact advertiser: `affiliate_impact-advertiser_get_programme_performance({ brand, from, to })`

Issue these in parallel — the chassis resolves `brand` to the correct `networkBrandId` per call. Do not serialise unless rate limits force it.

Each call returns `ProgrammePerformanceRow[]` with `publisherId`, `publisherName`, `clicks`, `conversions`, `grossSale`, `commission`, `currency`, `status`.

If a binding fails, capture the verbatim error (network, operation, message, httpStatus). Do not treat a failure as zero. Continue with the rest and report the gap under the affected brand's line.

## Step 4 — aggregate by brand, not by network

The user thinks in brands. Sum each brand's bindings together for the headline. If a brand spans multiple currencies across its networks, keep each currency on its own sub-line — do not invent FX.

For each brand:

- Current-period `grossSale`, `commission`, `conversions`, `clicks`.
- Comparison-period `grossSale`.
- Delta in absolute currency and percent.

## Step 5 — present the report

Output in this order:

1. **Windows**: current `from YYYY-MM-DD to YYYY-MM-DD` and comparison `from YYYY-MM-DD to YYYY-MM-DD` (each with day count).
2. **Per-brand headline**: one row per brand, sorted by current-period `grossSale` desc. Each row: brand name, gross sale, commission, conversions, delta (currency and percent). If a brand had errors on one or more networks, append the per-network errors verbatim at the end of its row — never silently drop data.
3. **Needs attention**: a subsection listing every brand whose `grossSale` is down more than 20% vs. the comparison window. One line each: brand, current vs. comparison figure, percent delta.
4. **Portfolio totals**: totals across every brand. Per-currency if the book spans currencies.
5. **Long tail**: if there are more than 12 brands, show the top 12 in full and collapse the remainder under one `Others (N brands, <total>, <percent delta>)` line per currency.
6. **Failures (if any)**: per (brand, network) verbatim error block, in case the user wants to retry.

Matter-of-fact tone, UK spelling. Keep the table compact.

## Constraints

- Never invent figures. If a binding returned no rows, say "no data" — don't backfill zeros.
- Currency: respect the per-row `currency`. Per-brand totals stay in the currency of their underlying rows. Across-brand totals stay per-currency.
- Do not normalise across networks or across brands. The agency runs reports in the currencies its clients invoice in.
- Pair with `programme-performance-report` when the user drills into a single brand from the rollup.
- Pair with `affiliate_resolve_brand({ network: "<slug>" })` if the user wants to scope the rollup to a single network.
