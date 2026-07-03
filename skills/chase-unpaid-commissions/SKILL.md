---
name: chase-unpaid-commissions
description: |
  Use this skill when a publisher wants to chase commissions that a network has validated (approved) but not yet paid, typically those sitting unpaid past a payment-term threshold such as 90 days. The skill pulls the matching transactions, groups them, and drafts a chase email with the unpaid sales attached.
  Trigger on: "chase my unpaid commissions", "which approved sales haven't been paid?", "draft a chase email for unpaid payments", "I've been validated but not paid in 90 days".
---

# Operating instructions

You are helping a publisher chase commissions that have been **validated
(approved) but not paid** and have aged past a payment-term threshold. The
output is a per-network draft chase email with the relevant unpaid sales
attached. You draft; the user sends. Never send anything yourself.

"Validated but not paid" means a transaction whose canonical `status` is
`approved` and which has no `datePaid`. `pending` is not yet validated and is
out of scope; `reversed` and `paid` are excluded.

## Step 1 — identify the configured networks

Use publisher networks the user named or confirmed they configured. If none are
known, ask which networks to include. Call `affiliate_list_networks` only to
confirm that this server has a registered adapter for each named network; it
does not prove that credentials are configured. When credential state is
uncertain, recommend `affiliate-networks-mcp doctor <slug>` or attempt the
requested operation and surface its verbatim error.

Only publisher-side networks (`side === 'publisher'`) are in scope — chasing is
a publisher action. Skip any `side === 'advertiser'` entries and say so. Inspect
each publisher network's `knownLimitations`; where `listTransactions` is
explicitly unsupported, report the coverage gap instead of calling it or
claiming there is nothing to chase.

## Step 2 — agree the threshold

Default threshold: **90 days unpaid**. If the user named a different term
(60 days, "past the payment terms", a calendar date), honour it. State the
threshold you used in the output so the user can confirm it matches the
network's actual payment terms.

The age that matters is **days since validation**, measured from `dateApproved`.
If a transaction has no `dateApproved`, its `ageDays` field only proves days
since conversion. Keep it in a separate "validation date unavailable" review
list; do not claim it has exceeded the payment term or include it in a chase
total until the user verifies the validation date.

## Step 3 — optional pre-check

For each network slug `s`, call
`affiliate_<s>_get_earnings_summary({ from, to })` over a window wide enough to
cover every transaction that could be past the threshold. Read
`oldestUnpaidAgeDays`, remembering that it is measured from conversion and may
include both pending and approved rows:

- If the summary is confirmed complete and `oldestUnpaidAgeDays` is absent or
  below the threshold, skip the transaction pull and note "nothing past
  threshold".
- If completeness is unclear or `oldestUnpaidAgeDays` meets or exceeds the
  threshold, proceed to step 4.

Do not treat a failed summary call as "nothing to chase". Surface the verbatim
error and still attempt step 4.

## Step 4 — pull the unpaid, validated transactions

For each in-scope network, call:

```
affiliate_<s>_list_transactions({ status: "approved", minAgeDays: <threshold>, from: <iso>, to: <iso> })
```

`minAgeDays` is a coarse filter computed against `dateConverted`, so it is a
pre-filter, not the final answer. The tool returns a `Transaction[]`; upstream
pagination is the adapter's responsibility. Do not expect a cursor in the
response or silently assume a limited or truncated response is complete.

After the call, keep only the transactions where:

- `status === "approved"`, and
- `datePaid` is absent, and
- `dateApproved` is present, and
- days between `dateApproved` and today `>=` the threshold.

Put approved, apparently unpaid rows with no `dateApproved` in the separate
review list from step 2. If a call fails, surface the verbatim error (network,
operation, message, httpStatus) and continue with the remaining networks; flag
the gap at the top of the output. Never silently drop a network.

## Step 5 — group and total

For each network, group the surviving transactions by `programmeName`. Within
each programme, sum `commission` **per currency** — never apply FX. For each
group record: transaction count, total commission per currency, and the oldest
unpaid age in days.

If a network produced nothing past threshold, say so explicitly.

## Step 6 — draft one chase email per network

Networks pay publishers, so the default recipient is the network's publisher /
finance support, not the merchant. Draft **one email per network**. If a single
programme dominates and the user wants to go direct to the merchant, draft a
per-programme variant instead, but say which you chose and why.

Each draft has:

1. **Subject** — e.g. `Unpaid validated commissions — <Network> — <publisher id/name>`.
2. **Recipient** — leave a `[network publisher support / finance contact]`
   placeholder; you do not hold contact data. Include the network's `docsUrl`
   only when it is relevant; do not present it as a verified support channel.
3. **Body** — matter-of-fact, UK English, no chasing-language theatrics. State:
   the publisher account, the payment term being invoked, the number of
   transactions, the total per currency, and a request for a payment date or an
   explanation. Reference that the itemised sales are attached.
4. **Sales table** — inline in the body for readability:

   | Transaction ID | Programme | Converted | Validated | Days unpaid | Commission |
   | --- | --- | --- | --- | --- | --- |

5. **Attachment** — write the same rows to a CSV the user can attach, named
   `unpaid-commissions-<slug>-<YYYY-MM-DD>.csv`, with a header row and one row
   per transaction (`transaction_id,programme,date_converted,date_approved,days_unpaid,commission,currency`).
   If you cannot write files in this environment, render the CSV in a fenced
   block so the user can copy it into a file.

   Escape CSV fields correctly. Because the file may be opened in a spreadsheet,
   neutralise any text field beginning with `=`, `+`, `-`, or `@` so upstream
   programme names or ids cannot execute as formulas.

If an email tool is connected (for example a Gmail MCP with a draft action),
you may create a **draft** with the body above and attach the CSV — but only a
draft. Confirm with the user before creating it, and never send.

## Step 7 — summarise for the user

Above the drafts, give a short ledger: per network, transactions chased and
total per currency, plus rows needing validation-date review, networks skipped
(nothing past threshold), and networks that failed (verbatim error). Then
present the drafts and the attachment(s).

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

- Draft only. Sending a chase email is a write action with external
  consequences; it stays with the user.
- Never invent figures, dates, or transaction IDs. If a field is missing, leave
  it blank and note it — do not fill in zeros or guesses.
- Respect each transaction's `currency`. Sum per currency; never normalise or
  convert.
- Quote the verbatim upstream error on any failed call. Do not collapse a
  failure into "no unpaid commissions".
- The threshold is the user's payment term, not a universal rule. State it.
- Never describe a threshold as the network's contractual or standard payment
  term unless the user supplied or verified that term.
