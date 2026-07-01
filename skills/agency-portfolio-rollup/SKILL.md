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

## Step 1b - load recorded plans

Call `affiliate_list_client_strategies` once. It returns one row per slug with `hasStrategy` / `hasKpi` / `registered` / `orphan`. For each registered brand in the book with either `hasStrategy` or `hasKpi`, call `affiliate_get_client_strategy({ brand })` to load its `kpi.targets` and `strategy` framing. Skip registered brands with no plan.

Keep a count of how many registered brands in the book have no plan recorded; it drives the coverage line in Step 5. If `affiliate_list_client_strategies` returns orphan rows, mention them in the coverage line and do not invent network data for them. This context is **advisory**: it adds a verdict and a coverage prompt; it never changes the figures.

If `kpi.parseErrors` is non-empty for a loaded brand, report each malformed line verbatim in the coverage/failures area and exclude it from verdicts. Never guess what the target meant.

## Step 2 — pick the windows

Default period: the last 7 days, ending today. Honour explicit user windows ("this month", "Q1", named dates).

Compute a comparison window of the same length immediately prior. Express all dates as ISO `YYYY-MM-DD`. Surface both windows in the final report so the user can confirm.

## Step 2b — prefer per-brand snapshots for the standard windows

When the requested window is one of the snapshot windows (yesterday, last 7 days, last 30 days, year-to-date — the 7-day default is `last7d`), call `affiliate_build_brand_snapshot({ brand })` once per brand instead of fanning out `get_programme_performance` per binding. Each brand's snapshot already aggregates across that brand's networks into the four windows with per-currency totals and a count-honest `byNetwork` health block, so you skip the manual per-network fan-out and the Step 4 by-brand aggregation. Take the per-brand headline straight from `snapshot.windows.<window>.totals` (per currency), and surface any `byNetwork` entry that is not `ok` on that brand's line so a brand whose book is missing a network is never silently under-counted.

Fall back to the per-network fan-out below for **custom windows** the four fixed windows do not cover, and to compute the **comparison window** (a custom prior range the snapshot does not carry).

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
2. **Per-brand headline**: one row per brand, sorted by current-period `grossSale` desc. Each row: brand name, gross sale, commission, conversions, delta (currency and percent). For a brand with a `revenue` target, add a short verdict against the plan (on track / behind / ahead). When the target has a period, show pace to target, for example "behind: GBP 268k of GBP 400k quarter, about 7% short on run-rate". When the target has no period, compare the current-window total and say no period was recorded. Where a target's metric is unsupported on a brand's bound network, say so rather than guess. If a brand had errors on one or more networks, append the per-network errors verbatim at the end of its row; never silently drop data.
3. **Needs attention**: a subsection listing every brand whose `grossSale` is down more than 20% vs. the comparison window, **or** that is behind a recorded KPI target. One line each: brand, current vs. comparison figure (or target gap), percent delta. A brand down in a channel its strategy deprioritised can be noted as lower concern only when the row data or publisher name makes that partner type evident.
4. **Strategy coverage**: if any registered brands have no plan recorded, one line: "N of M brands have no strategy recorded; reports for them judge on bare deltas. Want to set them up?" If orphan strategy directories exist, add "Also found orphan strategy records: <slug...>; they have no registered brand binding." Omit when every registered brand has a plan and there are no orphans.
5. **Portfolio totals**: totals across every brand. Per-currency if the book spans currencies.
6. **Long tail**: if there are more than 12 brands, show the top 12 in full and collapse the remainder under one `Others (N brands, <total>, <percent delta>)` line per currency.
7. **Failures (if any)**: per (brand, network) verbatim error block, in case the user wants to retry.

Matter-of-fact tone, UK spelling. Keep the table compact.

## Constraints

- Never invent figures. If a binding returned no rows, say "no data" — don't backfill zeros.
- Currency: respect the per-row `currency`. Per-brand totals stay in the currency of their underlying rows. Across-brand totals stay per-currency.
- Do not normalise across networks or across brands. The agency runs reports in the currencies its clients invoice in.
- Recorded strategy and KPIs are advisory: they add a per-brand verdict and a coverage prompt, but never authorise an action or change the figures. Report KPI parse errors verbatim and exclude those targets.
- A KPI target on a metric a bound network cannot supply is reported as unsupported for that network and left out of its verdict; never zero-fill it or silently merge partial coverage into a cross-brand total.
- Pair with `client-onboarding` to record a plan for a brand surfaced by the coverage line.
- Pair with `programme-performance-report` when the user drills into a single brand from the rollup.
- Pair with `affiliate_resolve_brand({ network: "<slug>" })` if the user wants to scope the rollup to a single network.
