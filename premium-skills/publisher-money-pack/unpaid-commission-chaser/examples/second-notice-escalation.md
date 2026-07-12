# Example — "I sent a chase two weeks ago and heard nothing, escalate it"

A publisher with CJ and Awin configured. The free `chase-unpaid-commissions`
skill already sent a first-touch chase to CJ two weeks ago (2026-06-28) for
transaction `CJ-5521`. Today is 2026-07-12.

**User**: I chased CJ two weeks ago about transaction CJ-5521 and heard
nothing. Escalate it, and reconcile my unpaid numbers while you're at it.

**Assistant**: Reconciling CJ's summary against the transaction detail, then
building a second-notice draft for CJ-5521, plus a fresh aging breakdown
across both networks...

Called `affiliate_cj_get_earnings_summary({ from: "2026-01-13", to: "2026-07-12" })`
→ `oldestUnpaidAgeDays: 162`.
Called `affiliate_cj_list_transactions({ status: "approved", from: "2026-01-13", to: "2026-07-12" })`
→ transaction-derived oldest unpaid age: 165 days (CJ-5521, approved
2026-01-29).
Called `affiliate_awin_get_earnings_summary({ from: "2026-01-13", to: "2026-07-12" })`
→ `oldestUnpaidAgeDays: 38` (below the 90-day threshold).

## Reconciliation

| Network | Summary oldest unpaid | Transaction-derived oldest unpaid | Result |
| --- | --- | --- | --- |
| CJ | 162 days | 165 days | consistent (small rounding difference) |
| Awin | 38 days | — (below threshold, not pulled) | not applicable this run |

## Aging breakdown — CJ (90-day threshold)

| Tier | Transactions | Total commission |
| --- | --- | --- |
| Just past term (90–119 days) | 1 | £34.00 |
| Well past term (120–149 days) | 0 | — |
| Significantly overdue (150+ days) | 1 | £58.00 (CJ-5521) |

Awin had nothing past the 90-day threshold this run.

## Draft — second notice, CJ (CJ-5521)

**To:** `[CJ publisher support / finance contact]`
**Subject:** Second notice — unpaid validated commission — CJ — publisher 44210

> Hello,
>
> Following up on my message of 2026-06-28 about transaction CJ-5521
> (£58.00, validated 2026-01-29, now 165 days unpaid), which has had no
> response. This commission is well past the 90-day term I raised it under.
>
> Could you confirm a specific payment date, or let me know what is
> outstanding on my side?
>
> | Transaction ID | Programme | Converted | Validated | Days unpaid | Commission |
> | --- | --- | --- | --- | --- | --- |
> | CJ-5521 | Riverside Coffee | 2026-01-10 | 2026-01-29 | 165 | £58.00 |
>
> Thank you,
> [Your name]

## Draft — first-touch, CJ (remaining just-past-term row)

**Subject:** Unpaid validated commissions — CJ — publisher 44210

> One further commission (£34.00) was validated more than 90 days ago and
> remains unpaid. Itemised below.
>
> | Transaction ID | Programme | Converted | Validated | Days unpaid | Commission |
> | --- | --- | --- | --- | --- | --- |
> | CJ-6034 | Acme Outdoor | 2026-02-18 | 2026-03-14 | 120 | £34.00 |

---

Both drafts are for the same network but different tiers: the second notice
for CJ-5521 (already chased once, per your confirmation) and a first-touch
draft for the newly-surfaced CJ-6034. Review and send yourself; nothing here
was sent automatically.
