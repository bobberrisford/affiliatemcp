# Example — "Build me a case to raise with CJ about reversals"

A publisher with CJ configured. Today is 2026-07-12; the user asked about the
last 90 days (2026-04-13 to 2026-07-12) against the prior 90 days.

**User**: My CJ reversals feel high this quarter. Build me a case to raise
with them.

**Assistant**: Pulling reversed and total transactions for both windows to
compute the rate, then grouping by programme and reason...

Called `affiliate_cj_list_transactions({ status: "reversed", from: "2026-04-13", to: "2026-07-12" })`
and `affiliate_cj_list_transactions({ from: "2026-04-13", to: "2026-07-12" })`
for the current window; the same pair for the prior window
(2026-01-13 to 2026-04-12). Both calls returned complete arrays.

## CJ — reversal case file

### Summary

Window: 2026-04-13 to 2026-07-12. Reversal rate: 14.2% of commission, up
from 8.1% in the prior 90 days (2026-01-13 to 2026-04-12). Total reversed
commission this window: £212.40.

### By programme

| Programme | Count | Commission at stake | Share of reversals |
| --- | --- | --- | --- |
| Riverside Coffee | 9 | £148.60 | 70.0% |
| Acme Outdoor | 3 | £41.30 | 19.4% |
| Quill Stationery | 2 | £22.50 | 10.6% |

### By reason

| Reason | Count | Commission at stake | Share |
| --- | --- | --- | --- |
| Returned goods | 8 | £132.10 | 62.2% |
| Duplicate order | 3 | £52.80 | 24.9% |
| Unspecified | 3 | £27.50 | 12.9% |

### Notable individual cases

| Transaction ID | Programme | Amount | Reason | Converted | Reversed |
| --- | --- | --- | --- | --- | --- |
| CJ-9012 | Riverside Coffee | £38.40 | Returned goods | 2026-05-02 | 2026-05-14 |
| CJ-9188 | Riverside Coffee | £29.70 | Returned goods | 2026-05-19 | 2026-05-30 |

### Pattern observations

- Riverside Coffee accounts for 70% of reversed commission this window, up
  from 41% in the prior window.
- 8 of 9 Riverside Coffee reversals are labelled "returned goods" and
  cluster within 5–14 days of conversion. This is stated as an observation;
  it does not by itself indicate fraud, tracking failure, or genuine returns.

### Draft enquiry — CJ publisher support

**To:** `[CJ publisher support contact]`
**Subject:** Reversal rate enquiry — Riverside Coffee — publisher 44210

> Hello,
>
> My reversal rate on Riverside Coffee has risen from roughly 8% to 14% of
> commission over the last 90 days, concentrated in 9 transactions labelled
> "returned goods" (transaction IDs available on request, e.g. CJ-9012,
> CJ-9188). Could you confirm whether this reflects a genuine increase in
> product returns or something else on the programme side?
>
> Thank you,
> [Your name]

## Ledger

- 1 network investigated (CJ).
- Reversal rate: 14.2% now vs. 8.1% prior window, rising.
- 0 networks skipped, 0 failed.

---
This is a factual case file, not a dispute. CJ's own support process
determines any resolution; this skill does not submit or dispute anything.
