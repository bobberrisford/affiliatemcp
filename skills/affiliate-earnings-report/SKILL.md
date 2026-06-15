---
name: affiliate-earnings-report
description: |
  Use this skill when the user asks how much they have earned across their configured affiliate networks, or wants a consolidated period summary.
  Trigger on: "show my affiliate earnings", "what did I earn last month?", "earnings report", "how much have I made?".
---

# Operating instructions

You are producing a consolidated earnings report across all configured affiliate networks.

## Step 1 — identify the configured networks

Use networks the user named or confirmed they configured. If none are known,
ask which networks to include. Call `affiliate_list_networks` only to confirm
that this server has a registered adapter for each named network; it does not
prove that credentials are configured. When credential state is uncertain,
recommend `affiliate-networks-mcp doctor <slug>` or attempt the requested
operation and surface its verbatim error.

## Step 2 — pick a period

Default period: the last 30 days, ending today. If the user specified "last month" (calendar month), "Q1", "this year", or named dates, honour their choice. Express dates as ISO `YYYY-MM-DD`. Surface the chosen window in the final report so the user can confirm.

## Step 3 — fetch earnings per network

For each network slug `s` from step 1, call:

```
affiliate_<s>_get_earnings_summary({ from: <iso>, to: <iso> })
```

Each call returns an `EarningsSummary` with:

- `totalEarnings`, `currency`
- `byProgramme[]` — top programmes by total
- `byStatus` — `{ pending, approved, reversed, paid, other, currency }`
- `oldestUnpaidAgeDays` — call this out when present

If a call fails, surface the verbatim error (network, operation, message, httpStatus). Do not silently treat a failure as zero earnings. Continue with the remaining networks and flag the gap clearly at the top of the report.

## Step 4 — present the consolidated view

Output in this order:

1. **Window**: `from YYYY-MM-DD to YYYY-MM-DD` (and number of days).
2. **Total** across networks. If currencies differ, list per-currency totals — do not invent FX conversion.
3. **By network**: one row per network — total, by-status split, oldest-unpaid age days. Flag any network with `oldestUnpaidAgeDays > 90` as `ATTENTION`.
4. **Top programmes overall**: union of each network's `byProgramme[]`, sorted by total, top 10.
5. **Failures (if any)**: per-network verbatim error from the envelope.

Keep the table compact. Matter-of-fact tone, UK spelling.

## Stretch — anomaly detection

If the user asks for "this month vs last month", or hints at "is anything weird?", call `affiliate_<s>_get_earnings_summary` twice per network (current window and prior comparable window) and compare:

- A network that produced > £0 in the prior window and £0 in the current window — flag as a potential outage and recommend `affiliate-networks-mcp doctor <slug>`.
- A programme that contributed > 25% of a network's total in the prior window and 0% in the current window — flag as a potential programme drop.

Be precise. Do not call something an anomaly without quoting the prior and current figures.

## Constraints

- Never invent earnings figures. If the response is missing, say "no data" — don't fill in zeros.
- Currency: respect the per-network currency from the envelope. Don't normalise unless the user explicitly asks.
- Pair this with `affiliate_<slug>_list_transactions` when the user drills into "what makes up this number?".
