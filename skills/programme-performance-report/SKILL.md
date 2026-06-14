---
name: programme-performance-report
description: |
  Use this skill when an agency operator asks for a performance report for a single brand across one or more advertiser-side affiliate networks: per-publisher rollup, status split, and period-over-period delta. This is also the one reporting workflow behind the cadence deliverables an account manager ships: the daily snapshot, the weekly client note, the month-close report, and the quarterly business review (QBR). Match the output profile to the cadence the user asks for.
  Trigger on: "How is Acme performing this quarter?", "Show me the programme report for [brand]", "[brand] performance last month", "Which publishers are driving Acme's revenue?", "Acme's weekly report", "How did Acme do this week?", "Acme's month-end report", "Prepare Acme's QBR", "Build the Q2 review for [brand]".
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

## Cadence output profiles

Steps 1 to 4 produce the full ad-hoc report. The named cadence deliverables an
account manager ships (daily, weekly, monthly, quarterly) are this same
workflow with a fixed window, a fixed comparison, and a tighter output. They are
not separate skills; pick the profile that matches what the user asked for. If
they only asked "how is [brand] doing", use the full report above.

### Daily snapshot (internal pulse)

- Window: yesterday. Comparison: the day before, or the same weekday last week if the user prefers.
- Output: the headline block only (gross sale, commission, conversions, clicks with deltas) plus any anomaly. No top-10 table unless asked. This is usually for the AM or their team, not the client.
- Triggers: "Give me Acme's numbers for yesterday", "Daily snapshot for Acme".

### Weekly client note (the Monday artefact)

- Window: the most recent complete week, Monday to Sunday, ending before today. Do not include the current partial week unless the user asks for "this week so far". Comparison: the prior complete week.
- Output: keep it short enough to paste into an email: a one-line plain-language verdict (lead with the direction of travel), a small headline table per network, and the top three risers and top three fallers by gross sale week-on-week. Add a short "watch items" line only if something needs a heads-up. Skip the full status split and the full top-10 table; point the user at the full report if they want them.
- On a schedule the default already does the right thing: each Monday it reports the week that just ended against the week before.
- Triggers: "Acme's weekly report", "How did Acme do this week vs last?".

### Month-close report

- Window: the most recent complete calendar month. Comparison: the prior calendar month.
- Output: the full report above (headline, status split, top 10) framed as the month-close, with the month-over-month delta as the headline comparison. Pair with `affiliate_<network>_list_transactions` for the status breakdown where the adapter supports it.
- Triggers: "Acme's month-end report", "Close out Acme for May".

### Quarterly Business Review (QBR)

- Window: the most recent complete calendar quarter (Q1 = Jan to Mar, Q2 = Apr to Jun, Q3 = Jul to Sep, Q4 = Oct to Dec); honour an explicit quarter. Comparison: the prior whole quarter for the headline, plus the same quarter last year only if the user asks for a year-on-year view.
- Extra fetch: call the performance tool once per calendar month of the quarter so you can show the month-by-month trend, and call `affiliate_<network>_list_media_partners({ brand })` once for the roster mix (active / pending / inactive).
- Output: a presentation-ready narrative in this order: executive summary (three to five sentences covering the QoQ direction and the one or two things that moved the number); monthly trend table; partner mix and top contributors with each contributor's share of the total (flag any single partner above ~30% as a concentration risk); wins; risks and watch items; and two to four recommended actions for next quarter. Every recommendation must follow from the data shown; do not propose actions the figures do not support.
- Triggers: "Prepare Acme's QBR", "Build the Q2 review for Acme".

Every profile uses the same `get_programme_performance` calls as Step 3; only
the dates, the comparison, and the depth of the written output change. The
currency, no-invented-figures, and per-network rules below apply to all of them.

## Constraints

- Never invent figures. If a row is missing, say "no data" — don't backfill zeros.
- Currency: respect the per-row `currency`. If a single binding spans multiple currencies, output each currency separately.
- Don't normalise across networks. Per-network totals stay in their own currency.
- Pair with `affiliate_impact-advertiser_list_transactions({ brand, from, to })` when the user drills into "what makes up this number?".
- Use `affiliate_impact-advertiser_list_media_partners({ brand })` if the user asks "who else could be promoting us?" — that endpoint includes inactive partners that won't appear in the performance rollup.
