---
name: unpaid-commission-chaser
description: |
  Use this skill when a publisher wants a running, escalating chase across every configured network: aging tiers instead of a single email, a reconciliation check between the summary total and the transaction-level detail, and an escalation letter for a chase that already went unanswered. This is the premium extension of the free `chase-unpaid-commissions` skill, not a replacement for it.
  Trigger on: "Escalate the chase on my unpaid commissions", "I sent a chase two weeks ago and heard nothing, escalate it", "Reconcile my unpaid summary against the actual transactions", "Give me an aging breakdown of what's unpaid across networks".
---

# Premium scope note

The free `chase-unpaid-commissions` skill already does the core job: pull
validated-but-unpaid transactions past a threshold, group and total them, and
draft one first-touch chase email per network. Run that skill first if no
chase has been sent yet for the period in question.

This premium skill adds three things the free skill does not do:

1. **Aging tiers with escalating tone**, not a single threshold. It buckets
   unpaid, validated commissions into "just past term", "well past term",
   and "significantly overdue" and drafts a firmer letter for the oldest
   tier, rather than one email regardless of how overdue a row is.
2. **Reconciliation**: it cross-checks each network's
   `get_earnings_summary.oldestUnpaidAgeDays` against the actual transaction
   pull, so a mismatch between the summary and the detail (a sign the
   summary or the pull is incomplete) is surfaced rather than silently
   trusted.
3. **A second-notice/escalation draft** for rows the user says were already
   chased once with no response, distinct in tone from a first-touch
   request.

## Assumptions and requirements

- Publisher-side networks only (`side === 'publisher'`); this skill does not
  cover advertiser-side commission liability.
- Credentials for the networks in scope are configured; recommend
  `affiliate-networks-mcp doctor <slug>` when credential state is uncertain.
- The user supplies which rows (or which network/programme) were already
  chased and when, since no tool in this server records chase history. If
  the user cannot say, treat everything past threshold as first-touch.
- Draft only. This skill never sends anything; the user sends.

## Step 1 — identify networks and confirm scope

Use publisher networks the user named or confirmed configured. Call
`affiliate_list_networks` only to confirm a registered adapter exists per
named network; it does not confirm credentials. Skip any `side ===
'advertiser'` entries. Inspect `knownLimitations` for each network; where
`listTransactions` is unsupported, report the gap and exclude that network
from the transaction-level pull (it can still appear in the reconciliation
step, flagged as unavailable).

## Step 2 — reconcile summary against detail

For each in-scope network `s`, call
`affiliate_<s>_get_earnings_summary({ from, to })` over a window wide
enough to cover the oldest unpaid row, for example
`affiliate_cj_get_earnings_summary({ from, to })` or
`affiliate_awin_get_earnings_summary({ from, to })`. Note
`oldestUnpaidAgeDays` (measured from conversion, so may include pending as
well as approved rows).

Then, in Step 3, pull the transaction-level detail for the same window and
compute the same "oldest unpaid, approved, no `datePaid`" age directly from
the rows. Compare the two:

- If the summary's `oldestUnpaidAgeDays` and the transaction-derived figure
  roughly agree, note the reconciliation as consistent.
- If they diverge materially, say so plainly and prefer the transaction-level
  figure for the chase itself, since it is row-level and auditable; flag the
  summary as possibly stale or scoped differently.
- If either call fails, surface the verbatim error and continue with what
  succeeded.

## Step 3 — pull and bucket the unpaid, validated rows

For each in-scope network, call:

```
affiliate_<s>_list_transactions({ status: "approved", from: <iso>, to: <iso> })
```

for example `affiliate_cj_list_transactions({ status: "approved", from, to })`.
Keep rows where `datePaid` is absent and `dateApproved` is present. Compute
days since `dateApproved` and bucket:

- **Just past term**: threshold to threshold+30 days.
- **Well past term**: threshold+30 to threshold+60 days.
- **Significantly overdue**: threshold+60 days or more.

Default threshold: 90 days, or the user's stated term. Rows with no
`dateApproved` go to a separate "validation date unavailable" list, as in
the free skill; never include them in a bucket or a total until verified.

## Step 4 — draft by tier

For each network with rows in the "just past term" or "well past term"
buckets, draft a first-touch chase per the free skill's format (subject,
recipient placeholder, body, sales table, CSV attachment), but group the
table by tier so the recipient can see the aging spread.

For rows the user confirms were already chased once (naming the network,
programme, or specific transactions, and roughly when), draft a **second
notice**: same factual content, firmer opening line referencing the date of
the first chase and the lack of response, and a request for a specific
payment date rather than a general explanation. Never claim a first chase
was sent if the user has not confirmed it.

Use the free skill's CSV escaping rule verbatim: neutralise any field
beginning with `=`, `+`, `-`, or `@` before it reaches a spreadsheet.

## Step 5 — summarise for the user

Give a ledger per network: reconciliation result (consistent / diverged /
one side failed), rows per aging tier, rows in the validation-date-unavailable
list, and which drafts are first-touch vs. second-notice. Then present the
drafts and attachments.

## Constraints

- Never invent a chase history. A row is only "already chased" when the user
  says so.
- Never invent figures, dates, or transaction ids.
- Respect each transaction's `currency`; sum per currency, never convert.
- Quote verbatim upstream errors; never collapse a failure into "nothing
  unpaid".
- Draft only, always. Sending is the user's action.
- If an email tool is connected (for example a Gmail MCP with a draft
  action), only create a draft after explicit user confirmation, and never
  send.
