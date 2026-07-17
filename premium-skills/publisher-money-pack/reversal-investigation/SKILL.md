---
name: reversal-investigation
description: |
  Use this skill when a publisher wants to understand why their own commissions are being reversed or declined across configured networks: which programmes and reasons account for the losses, whether the rate is worsening, and a factual evidence pack they can raise with a network's publisher support. No free skill covers this on the publisher side today.
  Trigger on: "Why are my commissions being reversed?", "Investigate my declines this quarter", "Build me a case to raise with [network] about reversals", "Which programme is costing me the most in reversed commission?".
---

# Premium scope note

This is net new: the free tier has a reversal/decline report
(`programme-reversal-report`), but that is advertiser-side, investigating
why a brand's own conversions are being declined. This skill is the
publisher-side mirror: investigating a publisher's own reversed commissions
across the networks they earn from.

This skill is read-only. It surfaces the problem and builds an evidence pack
the publisher can send to a network's publisher support team; it cannot
approve, reopen, or dispute a transaction. Say so if the user expects an
in-tool action.

## Assumptions and requirements

- Publisher-side networks only.
- Requires `listTransactions` support and reversal-reason coverage on the
  networks in scope; both vary by adapter. Check `knownLimitations` first
  and report any gap rather than guessing.
- Credentials for networks in scope are configured; recommend
  `affiliate-networks-mcp doctor <slug>` when credential state is uncertain.
- This produces a written case; it does not send it. The publisher decides
  whether and how to raise it with the network.

## Step 1 — identify networks and confirm coverage

Use publisher networks the user named or confirmed configured. Call
`affiliate_list_networks` to confirm a registered adapter exists per named
network. Check each network's metadata for `listTransactions` support and
note any gap. Recommend `affiliate-networks-mcp doctor <slug>` when
credential state is uncertain rather than assuming.

## Step 2 — pick the window

Default period: the last 90 days, ending today. Honour an explicit window
("this quarter", "last month", named dates). Compute a same-length prior
window for a trend comparison. Express all dates as ISO `YYYY-MM-DD` and
state them at the top.

## Step 3 — pull reversed and total transactions

For each in-scope network `s`, call:

```
affiliate_<s>_list_transactions({ status: "reversed", from, to })
```

for example `affiliate_cj_list_transactions({ status: "reversed", from, to })`
or `affiliate_awin_list_transactions({ status: "reversed", from, to })`. To
compute a reversal rate, also pull the full set for the same window
(`affiliate_<s>_list_transactions({ from, to })`) and derive the rate as
reversed commission over total commission. If a network does not accept a
`status` filter, pull the window once and filter reversed rows client-side.

Do not compute a rate from a limited, paginated, or otherwise incomplete
pull. If completeness is unclear, report the reversed figures only and mark
the rate unavailable, rather than guessing a denominator. If a call fails,
surface the verbatim error and continue with the remaining networks,
flagging the gap at the top.

## Step 4 — group and trend

Group reversed transactions by `programmeName` and by `reversalReason`
(labelling missing reasons "unspecified" rather than guessing). For each
group, record: transaction count, total commission at stake, and share of
all reversed commission in the window. Compare the current window's overall
reversal rate against the prior window's to say whether it is rising,
falling, or stable, per network.

## Step 5 — build the evidence pack

For the programmes or reasons driving the largest reversed commission,
assemble a factual case file per network:

1. **Summary**: window, reversal rate now vs. prior window, total commission
   at stake.
2. **By programme**: count, commission at stake, share of total reversals.
3. **By reason**: count, commission at stake, share of total reversals,
   "unspecified" called out separately.
4. **Notable individual cases**: the largest reversals by commission (id,
   programme, amount, reason, date converted, date reversed if available),
   since a few large reversals can dominate the total.
5. **Pattern observations, stated as observations, not conclusions**: for
   example "62% of this programme's reversals cluster within 3 days of
   conversion" or "one programme accounts for 70% of reversed commission
   this window". Never infer a cause (fraud, tracking failure, duplicate
   firing, genuine returns) from a reason label or pattern alone; state what
   the data shows and let the publisher or the network draw the conclusion.
6. **Draft enquiry** to the network's publisher support: a matter-of-fact
   request for clarification on the named programme(s)/reason(s), citing
   the transaction ids and figures above, requesting an explanation or
   review. Leave `[network publisher support contact]` as a placeholder;
   include the network's `docsUrl` only when relevant, not as a verified
   support channel.

## Step 6 — summarise for the user

Above the case files, give a short ledger: networks investigated, overall
reversal rate now vs. prior window per network, networks skipped (no
reversals in window), and networks that failed (verbatim error). Then
present each network's case file.

## Constraints

- Never invent a reversal reason. Where a network gives none, say
  "unspecified".
- Never infer a specific cause (fraud, tracking failure, duplicate order,
  genuine return) from a reason label or a timing pattern alone; report the
  pattern and let the reader draw the conclusion.
- A reversal rate needs a confirmed-complete total, not just the reversed
  set; if completeness is unclear, report reversed figures only and mark the
  rate unavailable.
- Currency: respect each transaction's `currency`; sum per currency, never
  convert.
- This skill is read-only: it cannot approve, dispute, or reopen a
  transaction. Direct the user to the network's own dispute process for
  that, and never claim this skill submitted anything on their behalf.
- Draft-only enquiry text; the user decides whether and how to send it.
