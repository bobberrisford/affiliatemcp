---
name: commission-audit
description: |
  Use this skill when a publisher wants a full "money you are owed" audit across every configured network: approved commissions still unpaid past a threshold, reversals with no stated reason, and pending transactions that have gone stale. It itemises the findings per network with per-currency totals and a count-honest coverage summary, then hands off to `chase-unpaid-commissions` for the chase drafts.
  Trigger on: "audit my commissions", "run a commission audit", "what am I owed across my networks?", "check every network for unpaid or reversed commissions", "how much money have my networks not paid me?".
---

# Operating instructions

You are running a read-only commission audit for a publisher across every
network they configured. The output is an itemised, per-network ledger of
money the networks' own records show as outstanding or unexplained, plus a
coverage summary that says exactly which networks were audited, skipped, or
failed. The audit finds and totals; it does not chase, dispute, or send
anything.

Three finding classes, defined in canonical `Transaction` fields:

1. **Approved but not paid** — `status === "approved"` and no `datePaid`,
   aged past the unpaid threshold measured from `dateApproved`.
2. **Reversed with no stated reason** — `status === "reversed"` and
   `reversalReason` absent or empty.
3. **Stale pending** — `status === "pending"` with `ageDays` at or past the
   stale threshold.

## Step 1 — identify the configured networks

Use publisher networks the user named or confirmed they configured. If none
are known, ask which networks to include. Call `affiliate_list_networks` only
to confirm that this server has a registered adapter for each named network;
it does not prove that credentials are configured. When credential state is
uncertain, recommend `affiliate-networks-mcp doctor <slug>` or attempt the
requested operation and surface its verbatim error.

Only publisher-side networks (`side === 'publisher'`) are in scope. Skip any
`side === 'advertiser'` entries and say so; the brand-side equivalent of this
audit is `programme-leakage-audit`. Inspect each publisher network's
`knownLimitations`; where `listTransactions` is explicitly unsupported, report
the coverage gap instead of calling it or claiming a clean bill.

## Step 2 — agree the thresholds

Two thresholds, both stated in the output:

- **Unpaid threshold** — default **90 days since validation**, measured from
  `dateApproved`. Honour a different user-supplied term (60 days, "past the
  payment terms", a calendar date). Never describe the threshold as the
  network's contractual or standard payment term unless the user supplied or
  verified that term; there is no machine-readable source of per-network
  payment terms in this server.
- **Stale-pending threshold** — default **60 days**, measured via `ageDays`.
  Pending durations legitimately vary by vertical (returns windows, seasonal
  validation), so frame stale pending as "worth asking about", not as money
  owed.

If a transaction has no `dateApproved`, its `ageDays` field only proves days
since conversion. Keep it in a separate "validation date unavailable" review
list; do not claim it has exceeded the payment term or include it in an audit
total until the user verifies the validation date.

## Step 3 — optional pre-check

For each network slug `s`, call
`affiliate_<s>_get_earnings_summary({ from, to })` over a window wide enough
to cover every transaction that could be past either threshold. Read
`byStatus` and `oldestUnpaidAgeDays`, remembering that `oldestUnpaidAgeDays`
is measured from conversion and may mix pending and approved rows:

- If the summary is confirmed complete and `oldestUnpaidAgeDays` is absent or
  below both thresholds, you may skip the approved and pending pulls for that
  network and note "nothing past threshold".
- The pre-check never skips the reversal pull: a summary carries no reversal
  reasons.

Do not treat a failed summary call as "nothing found". Surface the verbatim
error and still attempt step 4.

## Step 4 — pull and classify transactions

For each in-scope network, run up to three pulls:

1. **Approved but not paid**:

   ```
   affiliate_<s>_list_transactions({ status: "approved", minAgeDays: <unpaid threshold>, from: <iso>, to: <iso> })
   ```

   `minAgeDays` is a coarse filter computed against `dateConverted`, so it is
   a pre-filter, not the final answer. Keep only rows where
   `status === "approved"`, `datePaid` is absent, `dateApproved` is present,
   and days between `dateApproved` and today are at or past the threshold.
   Approved, apparently unpaid rows with no `dateApproved` go to the review
   list from step 2.

2. **Reversed with no stated reason**:

   ```
   affiliate_<s>_list_transactions({ status: "reversed", from: <iso>, to: <iso> })
   ```

   Keep rows where `reversalReason` is absent or empty. Report their count
   and per-currency commission as "reversed with no stated reason" — a data
   gap to query with the network, not an accusation. Where `knownLimitations`
   says the network never supplies reversal reasons, say the check is not
   meaningful there rather than reporting every reversal as unexplained.

3. **Stale pending**:

   ```
   affiliate_<s>_list_transactions({ status: "pending", minAgeDays: <stale threshold>, from: <iso>, to: <iso> })
   ```

   Keep rows where `status === "pending"` and `ageDays` is at or past the
   stale threshold. Report count, per-currency commission, and the oldest
   age.

If a network ignores a `status` filter, pull the window once and classify the
returned rows client-side; the finding classes are defined on row fields, not
on the request parameters. If a call fails, surface the verbatim error
(network, operation, message, httpStatus) and continue with the remaining
networks; flag the gap at the top of the output. Never silently drop a
network.

## Step 5 — totals and coverage

Per network and per finding class: transaction count, commission total **per
currency** (never apply FX), and the oldest age in days. Then a cross-network
"found" line per currency: approved-unpaid plus unexplained-reversal
commission, each also shown separately. Stale pending stays informational and
is never added to the "found" line — pending money is not yet owed.

Close with a coverage block: networks audited cleanly, networks with
review-list rows, networks skipped (operation unsupported), and networks that
failed (with the verbatim error). Counts must reconcile: every network from
step 1 appears in exactly one of those categories.

## Step 6 — handoffs and recap

- If any approved-unpaid rows exist, offer `chase-unpaid-commissions` to
  draft the per-network chase emails. Do not draft them here; the two skills
  use the same detection logic, so the chase totals will match.
- If the user wants a shareable recap image, hand the per-currency findings
  to the `affiliate-mcp-design` card kit
  (`design-system/cards/commission-audit-card.html`). Card figures must be
  the user's real anonymised data or explicitly labelled a sample; the
  template ships with its SAMPLE watermark on for that reason.
- End with a short plain-English recap, for example: "Found £1,940 approved
  and unpaid across 3 networks, £310 reversed with no stated reason, and 9
  pending transactions older than 60 days. One network failed and is listed
  above."

## Large accounts

On accounts where a pull runs to tens of thousands of rows, keep every tool
result within the client's size limit:

- Prefer summaries: `affiliate_<slug>_get_earnings_summary` answers totals
  and status splits without pulling transaction rows.
- When raw rows are needed, pull month-sized windows rather than the whole
  period in one call, and page with `offset` (using `limit` as the page size)
  when a window is still too big.
- If a result returns `truncated: true` or `result_too_large`, follow its
  hint: continue from the given `nextOffset` or narrow the window or filters.
  Never total a truncated pull as if it were complete.

## Constraints

- Read-only. This skill finds and totals; chase drafting lives in
  `chase-unpaid-commissions`, and disputing or re-opening a transaction
  happens in the network dashboard.
- Never invent figures, dates, transaction IDs, or reversal reasons. If a
  field is missing, leave it blank and note it — do not fill in zeros or
  guesses.
- Respect each transaction's `currency`. Sum per currency; never normalise or
  convert.
- Quote the verbatim upstream error on any failed call. A failure is never
  "nothing found".
- State both thresholds. Never present a threshold as the network's
  contractual payment term unless the user supplied or verified it.
- "No stated reason" describes the data, not the network's conduct. Keep the
  phrasing matter-of-fact: "approved 94 days ago, not yet marked paid", not
  an allegation.
- Card figures are real anonymised data or explicitly a sample; never render
  invented numbers as real.
