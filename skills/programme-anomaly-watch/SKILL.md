---
name: programme-anomaly-watch
description: |
  Use this skill to spot week-over-week anomalies across an agency's portfolio of brands and networks — revenue drops, reversal spikes, dead links, publishers that fell out of the top 10. Designed to run on a schedule via Claude's own scheduling so the agency learns about problems before clients do.
  Trigger on: "Are there any problems with the affiliate programmes this week?", "Anomaly check", "Anything weird in the affiliate data?".
---

# Operating instructions

You are checking the book for week-over-week anomalies. Output is a short, ranked list — nothing more.

## Step 1 — enumerate the book

Call `affiliate_resolve_brand` with no arguments. The response is an array of `{ brand, network, networkBrandId }` bindings.

If the array is empty, say "No brands registered — nothing to watch" and stop. Do not pad.

## Step 1b - load recorded plans

Call `affiliate_list_client_strategies` once to see which registered brands have a plan recorded (`hasStrategy` / `hasKpi`) and whether any strategy directories are orphaned. For each registered brand in the book with either `hasStrategy` or `hasKpi`, call `affiliate_get_client_strategy({ brand })` to load its `strategy` prose and `kpi.targets`. Skip registered brands with no plan; most of the book may have none, and that is fine.

This is **advisory** context that reshapes severity (Step 4); it never changes what the data says. Report any `kpi.parseErrors` verbatim and ignore those targets. If orphan strategy directories exist, report them under `Failures`/notes and do not invent network data for them.

## Step 2 — pick the windows

Default period: the last 7 days, ending today. Comparison window: the 7 days immediately prior. Express all dates as ISO `YYYY-MM-DD`. Honour explicit user overrides ("this month vs last month", named dates).

## Step 3 — fan out per binding

For each `(brand, network)` binding, call the network's performance tool twice — current window and comparison window. Tool names follow `affiliate_<network>_get_programme_performance`:

- Impact advertiser: `affiliate_impact-advertiser_get_programme_performance({ brand, from, to })`

Issue in parallel. Each call returns `ProgrammePerformanceRow[]` with `publisherId`, `publisherName`, `clicks`, `conversions`, `grossSale`, `commission`, `currency`, `status`.

If a binding fails, capture the verbatim error and report it under a `Failures` line at the end. Do not treat a failure as an anomaly.

## Step 4 — compute anomalies

Walk each `(brand, network)` binding and emit an anomaly for any of:

- **Revenue drop**: current-period `grossSale` is down more than 25% vs. the comparison window. Quote both figures and the percent drop.
- **Reversal spike**: the share of rows with `status: 'reversed'` (weighted by `grossSale`) is more than 2x the comparison-window baseline. Quote both ratios.
- **Top-10 dropout**: a publisher that was in the top 10 by `grossSale` in the comparison window is absent from the top 10 in the current window. Name the publisher and quote both ranks.
- **Publisher silenced**: a publisher with non-zero `conversions` in the comparison window has zero `conversions` in the current window (a 100% drop). Name the publisher.
- **Dead programme**: the binding produced zero `clicks` in the current window. Likely a tracking break or a dead link.

Also emit an anomaly for a **KPI threshold breach** where a brand has a compatible target: `reversal_rate` over a `<=` or `<` limit, or `approval_rate` under a `>=` or `>` floor, this window. Quote the actual rate and the target. For unsupported comparators or unavailable metrics, say the target is unsupported for this anomaly scan and exclude it rather than guessing.

Compute severity as the absolute current-period revenue at risk: for a revenue drop, the lost gross sale; for a silenced publisher, their comparison-period gross sale; for a dead programme, the comparison-period gross sale of the whole binding. Use the per-row `currency` — do not normalise.

**Reshape severity by the recorded plan** (when one exists for the brand):

- A drop in a partner type the brand's `Strategy.md` **deprioritised** can be lower concern only when the row data or publisher name makes that partner type evident. Down-rank it, keep the anomaly visible, and say why ("down 30%, but coupon is a deprioritised channel for this brand"). If partner type is not evident, do not guess.
- A drop in a **preferred / priority** partner type, or anything that crosses a recorded **escalation threshold** ("flag any drop over 20%"), is urgent. Up-rank it within the anomaly list while still quoting the underlying current and comparison figures.
- A KPI threshold breach is ranked by the recorded limit, not a generic baseline.

With no plan recorded for a brand, rank it exactly as today on raw revenue at risk. Absence of a plan is never itself an anomaly.

## Step 5 — present the report

Output a single compact list, ordered by severity desc. Each line: `<brand> · <network> · <anomaly type> · <magnitude> · <publisher(s)>`. One line per anomaly. No tables, no preamble.

If there are no anomalies, say "No anomalies this week" in one line and stop. Do not pad with "good news" commentary.

At the end, list any per-binding failures verbatim under a `Failures` heading so the user can retry. If a binding failed, the absence of anomalies for that binding is not safe to assume — say so.

## Scheduling

This skill is designed to be useful when run on a schedule. When invoked by Claude's scheduler, the output should be short enough to read on a phone — keep the anomaly list under ~12 lines if possible. If the book genuinely has more than 12 anomalies, group by brand and emit one line per brand summarising the count and the top reason.

## Constraints

- Never call something an anomaly without quoting both the current and comparison figures.
- Currency: respect the per-row `currency`. If a brand spans currencies, compute anomalies per currency.
- Do not invent thresholds. The thresholds in step 4 are the contract; if the user wants different ones, ask. A recorded KPI target adds a brand-specific threshold; it never loosens the step-4 ones.
- Recorded strategy and KPIs are advisory: they reshape severity and add KPI-breach checks, but never authorise an action and never change the underlying figures.
- A KPI target on a metric a bound network cannot supply is reported as unsupported for that network and excluded from anomaly ranking; never zero-fill it.
- Pair with `programme-performance-report` when the user wants the full per-publisher detail behind an anomaly.
