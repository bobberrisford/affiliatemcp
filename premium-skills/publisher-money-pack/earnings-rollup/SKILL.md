---
name: earnings-rollup
description: |
  Use this skill when a publisher wants a multi-period earnings trend across their configured networks, how concentrated their earnings are in one or two programmes, and how long money typically takes to move from converted to approved to paid so they can forecast the next payout. This is the premium extension of the free `affiliate-earnings-report` skill, not a replacement for it.
  Trigger on: "Show my earnings trend over the last six months", "How concentrated is my income in one programme?", "How long does [network] usually take to pay me?", "Forecast when my pending commissions will land".
---

# Premium scope note

The free `affiliate-earnings-report` skill already produces the single-period
consolidated view: total earnings, by-network and by-programme breakdown, the
status split, and an unpaid-age flag. Run that skill first for a single
period's numbers; this premium skill does not repeat it.

This premium skill adds three things the free report does not do:

1. **Multi-period trend** (typically the last six months), so the user sees
   the earnings shape over time rather than one window.
2. **Concentration/diversification analysis**: what share of total earnings
   comes from the top one, three, and five programmes, with a plain
   diversification-risk flag when concentration is high.
3. **Payment-timing analysis**: per network, the typical time from
   `dateConverted` to `dateApproved` and from `dateApproved` to `datePaid`,
   computed from the transaction rows, used to give a rough forecast for
   when currently-pending or currently-approved commission is likely to be
   paid. This is a pattern observed in past data, not a promise from the
   network.

## Assumptions and requirements

- Publisher-side networks only.
- Credentials for networks in scope are configured; recommend
  `affiliate-networks-mcp doctor <slug>` when credential state is uncertain.
- Payment-timing analysis needs enough paid history to be meaningful (a
  handful of paid transactions per network at minimum). Where a network has
  too little paid history, state that rather than forecasting from one or
  two data points.
- This skill never invents a payment date. A forecast is stated as a range
  derived from past typical timing, not a guarantee.

## Step 1 — identify networks

Use publisher networks the user named or confirmed configured. Call
`affiliate_list_networks` only to confirm a registered adapter exists per
named network. Recommend `affiliate-networks-mcp doctor <slug>` when
credential state is uncertain rather than assuming.

## Step 2 — pull the multi-period trend

For each network `s`, call the earnings summary once per of the last six
complete months:

```
affiliate_<s>_get_earnings_summary({ from: <month-start>, to: <month-end> })
```

for example `affiliate_awin_get_earnings_summary({ from, to })` or
`affiliate_cj_get_earnings_summary({ from, to })`. Record `totalEarnings` per
network per month per currency. If a call fails for a given month, say so
for that month and continue; do not treat it as zero.

## Step 3 — concentration analysis

For the most recent complete month (or the period the user asked about),
use each network's `byProgramme[]` from Step 2's summary calls. Rank
programmes by `total` across all networks (per currency; do not blend
currencies). Compute the share of total earnings held by the top 1, top 3,
and top 5 programmes.

Flag as a diversification risk when the top programme alone exceeds roughly
40% of total earnings, or the top 3 exceed roughly 70%, in that currency's
total. State the actual percentages; never just say "concentrated" without
the number.

## Step 4 — payment-timing analysis

For each network, call:

```
affiliate_<s>_list_transactions({ status: "paid", from: <iso>, to: <iso> })
```

for example `affiliate_cj_list_transactions({ status: "paid", from, to })`,
over a window wide enough to gather a reasonable sample of paid
transactions (six to twelve months back is usually enough). For each row
with both `dateApproved` and `datePaid`, compute days from approval to
payment. For rows also carrying `dateConverted`, compute days from
conversion to approval. Report the median and the range (not just an
average, which one outlier can distort) per network.

If a network has fewer than roughly five paid transactions with the needed
dates in the window, state that the sample is too small for a reliable
figure rather than reporting a median from one or two rows.

Using the median approval-to-payment time, give a rough forecast window for
currently-approved-but-unpaid commission: "typically paid within N to M days
of approval; the GBP X approved on [date] would be expected to land by
roughly [date range]". Label this explicitly as a pattern from past data,
not a commitment from the network.

## Step 5 — present the report

Output in this order:

1. **Trend**: compact table, one row per network, one column per month,
   `totalEarnings` per currency, plus a one-line description of the shape
   (growing, flat, seasonal, declining).
2. **Concentration**: top 1/3/5 programme shares with actual percentages and
   the diversification-risk flag where it applies.
3. **Payment timing**: per network, median and range for
   conversion-to-approval and approval-to-payment, sample size, and the
   forecast window for currently pending/approved amounts.
4. **Failures/gaps (if any)**: per-network verbatim error or "sample too
   small" notes.

Matter-of-fact tone, UK spelling. Keep tables compact.

## Large accounts

Follow the free skill's large-account guidance: prefer
`get_earnings_summary` over raw transaction pulls where the question is a
total or a split, and page month-by-month with `offset` when a raw pull is
needed and a single window is too large. Respect `truncated: true` or
`result_too_large` by following the hint rather than treating a partial pull
as complete.

## Constraints

- Never invent a figure, a month's total, or a payment date. A gap or a too-
  small sample is stated, not filled or forecast anyway.
- Currency: respect each network's currency; never blend currencies in a
  trend, concentration ranking, or payment-timing figure.
- A payment-timing forecast is explicitly a pattern from past data, phrased
  as a range, never presented as a network commitment or a guarantee.
- This is a read-only report. Pair with the free `chase-unpaid-commissions`
  or premium `unpaid-commission-chaser` skill when the user wants to act on
  what is overdue.
