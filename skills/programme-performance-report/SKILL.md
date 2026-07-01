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

## Step 1b - load the client's plan (strategy and KPIs)

Call `affiliate_get_client_strategy({ brand })`. This returns the operator's recorded `strategy` (prose) and `kpi` (`{ present, targets, parseErrors, ... }`). It is **advisory context**: it changes how you read and frame the numbers; it never authorises any action and never changes what the data says.

- **No strategy recorded** (`strategy.present` and `kpi.present` both false): this is normal, not an error. Produce the report exactly as you would today on bare deltas, and add one short line offering to record a plan: "No strategy is recorded for [brand]. I can set one up so future reports judge against its targets." Then carry on.
- **Orphan** (`orphan: true`): a plan exists but the slug has no binding. Use the prose for framing, but say plainly that the strategy directory has no registered brand binding; do not invent network data for it.
- **Parse errors** (`kpi.parseErrors` non-empty): report each malformed target line verbatim ("KPI line ignored: ...") and exclude it from every verdict. Never guess what a malformed target meant.
- **Targets** (`kpi.targets`): each is `{ metric, comparator, value, unit?, period? }`. Use them in Step 4 to turn deltas into verdicts. Metrics map onto the data as: `revenue` -> total grossSale, `commission` -> total commission, `conversions` -> total conversions, `epc` -> commission / clicks when clicks are nonzero, `aov` -> grossSale / conversions when conversions are nonzero, `reversal_rate`/`approval_rate` -> from the status split. If a denominator is zero, report that the derived metric is unavailable rather than inventing zero.
- **Unsupported per network**: if a target names a metric a bound network cannot supply (for example a network with no `get_programme_performance`), say so for that network and exclude it from that network's verdict. Do not substitute zero, and do not blend it into a cross-network total without naming the gap.

## Step 1c — prefer the brand snapshot for the standard cadences

For the standard cadences (daily = yesterday, weekly = last 7 days, month ≈ last 30 days, QBR = year-to-date), do **not** rebuild the cross-network aggregation by hand. Call `affiliate_build_brand_snapshot({ brand })` once. It pulls every network the brand is bound to, normalises the result into the four windows (`yesterday`, `last7d`, `last30d`, `ytd`), and returns, per window: per-currency totals, a per-programme breakdown, and a count-honest `byNetwork` health block. Read those figures directly for the headline, the windows, and the commission status split.

Two things this buys you:

- **Accuracy.** The snapshot sources the commission status split (`pending` / `confirmed` = approved+paid / `declined` = reversed) from transactions, which carry an exact per-transaction status. The per-publisher performance report collapses its multi-status columns into one value (see issue #282), so a status split read from it is lossy. Prefer the snapshot's split.
- **Honesty.** `snapshot.byNetwork` lists one entry per *bound* network with `state` (`ok` / `degraded` / `failed`) and the verbatim error envelope on failure. Surface it exactly: never total four networks and present as five. When a network is `failed`, say "totals exclude <network>".

Use the snapshot for the headline, windows, and status split below. Keep the per-network `get_programme_performance` calls in Step 3 for the two things the snapshot does not carry: the **per-publisher** Top-10 (the snapshot's breakdown is per-programme), and **custom windows** the four fixed windows do not cover ("Q1", "last month", named dates). For those custom windows, fall back to Step 3 entirely.

## Step 2 — pick the windows

Default period: the last 30 days, ending today. Honour explicit user windows ("Q1", "last month", named dates). When the requested period is one of the four snapshot windows, take its figures from Step 1c rather than recomputing.

Compute a comparison window of the same length immediately prior. Express all dates as ISO `YYYY-MM-DD`. Surface both windows in the final report so the user can confirm.

## Step 3 — fetch per-publisher performance per binding

For each `(brand, network)` binding from step 1, call the network's performance tool twice — current window and comparison window. Tool names follow `affiliate_<network>_get_programme_performance`:

- Impact advertiser: `affiliate_impact-advertiser_get_programme_performance({ brand, from, to })`

Pass `brand` exactly as it came back from `affiliate_resolve_brand`. The chassis resolves it to the right `networkBrandId` before the call goes out.

Each call returns `ProgrammePerformanceRow[]` with: `date`, `publisherId`, `publisherName`, `clicks`, `conversions`, `grossSale`, `commission`, `currency`, `status`. Roll up rows by `publisherId` for the headline; keep the status field for the status split.

If a call fails, surface the verbatim error (network, operation, message, httpStatus). Do not silently treat a failure as zero. Continue with the remaining bindings and flag the gap clearly at the top of the report.

## Step 4 — present the report

When a plan is recorded (Step 1b), **open with a verdict against the plan**: lead with whether the brand is on track, behind, or ahead of its KPI targets, and the **pace to target**. When a target has a period, project the current run-rate to the end of that period and compare to the target ("GBP 280k of the GBP 400k quarterly target with 38% of the quarter left, slightly behind pace"). When a target has no period, compare the current-window total to the target and say that no period was recorded. State each comparison in the target's own currency and period; never blend currencies or invent an FX rate. If a target's metric is unsupported on a bound network, say so for that network and leave it out of the verdict rather than guess. With no plan recorded, skip the verdict and lead with the windows.

Then output in this order:

1. **Windows**: current `from YYYY-MM-DD to YYYY-MM-DD` and comparison `from YYYY-MM-DD to YYYY-MM-DD` (each with day count).
2. **Headline per network**: total `grossSale`, total `commission`, total `conversions`, total `clicks`. Show the comparison-window figure and the delta in both absolute currency and percent. Where a KPI target covers one of these, annotate it against the target (for example "GBP 92k this week, on pace for the GBP 400k quarter"). If a brand-network binding produced rows in more than one currency, list each currency separately; do not invent an FX rate.
3. **Status split**: per network, sum `grossSale` and `commission` by `status` (`pending` / `approved` / `reversed`). Compute reversal rate and approval rate and, where a `reversal_rate` or `approval_rate` KPI target is set, flag a breach with the actual number ("reversals 11% this month, over the 8% limit"). Call out a status that has flipped to >50% reversed compared to the comparison window.
4. **Top 10 publishers** by current-period `grossSale` (descending). For each: publisher name, conversions, gross sale, commission, and the same per-publisher delta vs. the comparison window.
5. **Partner mix vs strategy** (only when the strategy names partner preferences): compare the top contributors against the preferred and deprioritised partner types in `Strategy.md` only when the available rows or publisher names make the partner type evident. If partner type is not available, say so rather than guessing. Flag visible tension plainly ("Strategy prefers premium content and avoids coupon/incentive, but a coupon partner drove 60% of revenue this period"). This is an observation, not an instruction to change anything.
6. **Anomalies**: anything that looks broken — a publisher with zero clicks but historical clicks, a programme with 100% reversed status this window, a publisher that contributed >25% of last period's revenue and 0% this period.
7. **Failures (if any)**: per-network verbatim error from the envelope.

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

- Window: by default, the most recent complete week, Monday to Sunday, ending before today. Comparison: the prior complete week. If the user explicitly asks for "this week", "this week so far", or "this week vs last", use Monday through today and compare it with the same Monday-through-weekday span of the prior week; label both as partial windows.
- Output: keep it short enough to paste into an email: a one-line plain-language verdict (lead with the direction of travel), a small headline table per network, and the top three risers and top three fallers by gross sale week-on-week. Add a short "watch items" line only if something needs a heads-up. Skip the full status split and the full top-10 table; point the user at the full report if they want them.
- On a schedule the default already does the right thing: each Monday it reports the week that just ended against the week before.
- Triggers: "Acme's weekly report", "How did Acme do this week vs last?".

### Month-close report

- Window: the most recent complete calendar month. Comparison: the prior calendar month.
- Output: the full report above (headline, status split, top 10) framed as the month-close, with the month-over-month delta as the headline comparison. Pair with `affiliate_<network>_list_transactions` for the status breakdown where the adapter supports it.
- Triggers: "Acme's month-end report", "Close out Acme for May".

### Quarterly Business Review (QBR)

- Window: the most recent complete calendar quarter (Q1 = Jan to Mar, Q2 = Apr to Jun, Q3 = Jul to Sep, Q4 = Oct to Dec); honour an explicit quarter. Comparison: the prior whole quarter for the headline, plus the same quarter last year only if the user asks for a year-on-year view.
- Extra fetch: call the performance tool once per calendar month of the quarter so you can show the month-by-month trend. Where the adapter supports it, call `affiliate_<network>_list_media_partners({ brand })` once for the current roster mix (`active` / `pending` / `inactive` / `unknown`). If the roster call is unsupported or fails, report that gap and omit roster-mix claims; do not treat performance rows as the full roster.
- Output: a presentation-ready narrative in this order: executive summary (three to five sentences covering the QoQ direction and the one or two things that moved the number); monthly trend table; partner mix and top contributors with each contributor's share of the total (flag any single partner above ~30% as a concentration risk); wins; risks and watch items; and two to four recommended actions for next quarter. Every recommendation must follow from the data shown; do not propose actions the figures do not support.
- Triggers: "Prepare Acme's QBR", "Build the Q2 review for Acme".

The daily, weekly, month-close, and QBR profiles map onto the snapshot windows
(`yesterday`, `last7d`, `last30d`, `ytd`): take the headline, windows, and status
split from `affiliate_build_brand_snapshot` (Step 1c) and use
`get_programme_performance` only for the per-publisher Top-10 and any custom
window. The comparison window and the month-by-month QBR trend are custom ranges
the snapshot does not carry, so fetch those from `get_programme_performance` as
Step 3 describes. Only the dates, comparison, supporting reads, and depth of the
written output change across profiles.
The currency, no-invented-figures, failure, and per-network rules apply to all
of them. So does the recorded plan: when `Strategy.md` names a reporting voice,
audience, cadence, or escalation threshold, shape the output to it: lead the
weekly note in the recorded voice for the named reader, and surface anything
that crosses a recorded escalation threshold ("flag any drop over 20%
immediately") at the top, whatever the profile.

## Constraints

- Strategy and KPIs are **advisory**: they frame the verdict and the narrative; they never authorise a write, change a limit, or override what the data shows.
- A KPI target on a metric a bound network cannot supply is reported as unsupported for that network and left out of its verdict: never zero-filled, never silently merged into a cross-network total.
- Malformed KPI lines (`kpi.parseErrors`) are reported verbatim and excluded from verdicts; never guess their meaning.
- Never invent figures. If a row is missing, say "no data" — don't backfill zeros.
- Currency: respect the per-row `currency`. If a single binding spans multiple currencies, output each currency separately.
- Don't normalise across networks. Per-network totals stay in their own currency.
- Pair with `affiliate_impact-advertiser_list_transactions({ brand, from, to })` when the user drills into "what makes up this number?".
- Use `affiliate_impact-advertiser_list_media_partners({ brand })` if the user asks "who else could be promoting us?" — that endpoint includes inactive partners that won't appear in the performance rollup.
