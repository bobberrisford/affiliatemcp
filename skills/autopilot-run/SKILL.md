---
name: autopilot-run
description: |
  Use this skill for the scheduled, unattended agency autopilot run: fan out across the whole client book, judge each client's numbers against the targets they recorded, and report only what is NEW, WORSENING, or RESOLVED since the last run — not a fresh restatement of standing facts. Designed to be fired by a Claude Desktop scheduled task.
  Trigger on: "Run the autopilot", "Autopilot weekly run", "Run the scheduled agency check", "/autopilot-run".
---

# Operating instructions

You are running one unattended autopilot pass over an agency's book. The output
is a short, ranked digest of *changes* — the run remembers the last pass and
suppresses anything that has not moved. Be matter-of-fact, UK spelling.

The loop name is the single argument (default `weekly`). Use it for every store
call this run.

## Step 1 — load the context (book + intent + last run)

Call `affiliate_autopilot_load_context({ loop })`. The response is:

- `bindings` — `{ brand, network, networkBrandId }` rows (the book).
- `clients` — one entry per brand: `{ slug, strategyMd, kpiMd, thresholds }`. A
  brand with no intent recorded yet has empty prose and `thresholds: {}`.
- `lastState` — the previous run's snapshot, or `null` on the first run.

If `bindings` is empty, say "No brands registered — nothing to watch. Run
`affiliate-networks-mcp setup` or the `client-onboarding` skill." and stop.

## Step 2 — pick the windows

Default period: the last 7 days, ending today. Comparison window: the 7 days
immediately prior. ISO `YYYY-MM-DD`. Honour explicit overrides.

## Step 3 — fan out

For each `(brand, network)` binding, call the network's performance tool twice
(current and comparison window). Tool names follow
`affiliate_<network>_get_programme_performance({ brand, from, to })` — e.g.
`affiliate_impact-advertiser_get_programme_performance`. Issue in parallel.

If a binding fails, capture the verbatim error for the `Failures` section. A
failure is never an anomaly and never treated as zero.

## Step 4 — judge against intent (the anomaly rules)

Use the **same anomaly definitions as the `programme-anomaly-watch` skill**
(revenue drop, reversal spike, top-10 dropout, publisher silenced, dead
programme) — do not invent new ones. The difference here is the thresholds:

- For each client, prefer the values in its `thresholds` map
  (e.g. `revenue_drop_wow_pct`, `reversal_rate_max_pct`). Fall back to the
  anomaly-watch defaults only when a client has not set that threshold.
- Where a client has a target (e.g. `quarterly_revenue_target_gbp`), phrase the
  finding against it: "down 18% but still 6% ahead of the quarterly target",
  not a bare percentage.
- Use the client's `strategyMd` for voice and priorities: lead with what they
  care about, stay quiet about channels they have deprioritised, escalate what
  their strategy says to escalate.

## Step 5 — diff against the last run (the alert lifecycle)

For every finding, compare against `lastState` and assign one state:

- **`new`** — not present last run. Surface loudly.
- **`ongoing`** — present last run, no material change. Suppress to a single
  quiet footnote ("3 findings still open"), do NOT re-headline.
- **`worsened`** — present last run but crossed the next step threshold. Re-surface
  with both the previous and current figures.
- **`resolved`** — open last run, now back in band. One closing line, then drop.

If `lastState` is `null` (first run), every finding is `new` — say so once at the
top so the operator knows this run sets the baseline.

## Step 6 — render the digest

A single compact, ranked list ordered by revenue at risk. Headline only `new`,
`worsened`, and `resolved`; collapse `ongoing` to one footnote. Phone-readable —
aim under ~12 lines. For any brand with `thresholds: {}` that produced a
material move, add one line inviting capture: "no target set for <brand> — say
'set a target for <brand>' to record one." End with a `Failures` section listing
any per-binding errors verbatim.

## Step 7 — persist the snapshot

Call `affiliate_autopilot_save_state({ loop, state, digest })` where:

- `state` is the structured snapshot this run computed — at minimum, per-binding
  current-window metrics and the list of open findings with their assigned
  lifecycle state — so the next run can diff against it.
- `digest` is the rendered markdown from step 6.

Persisting is not optional: skip it and the next run cannot tell new from
ongoing.

## Constraints

- Never call something an anomaly without quoting both current and comparison figures.
- Respect each row's `currency`; never normalise across currencies.
- A failed binding means the absence of a finding for it is not safe — say so.
- This run is read-only. It reports and suggests; it never writes to a network.
