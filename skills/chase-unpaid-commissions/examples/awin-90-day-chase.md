# Example — "chase anything Awin validated but hasn't paid in 90 days"

A publisher with Awin and Impact configured. Today is 2026-06-14.

**User**: chase anything that's been validated but not paid in 90 days.

**Assistant**: Threshold = 90 days unpaid, measured from the validation date.
Discovering networks and checking for anything past term...

Called `affiliate_list_networks` → `awin` (publisher), `impact` (publisher).

Pre-check via `affiliate_<slug>_get_earnings_summary({ from: "2025-06-14", to: "2026-06-14" })`:

- Awin → `oldestUnpaidAgeDays: 138` — past threshold, pulling transactions.
- Impact → `oldestUnpaidAgeDays: 41` — nothing past 90 days, skipped.

Called `affiliate_awin_list_transactions({ status: "approved", minAgeDays: 90, from: "2025-06-14", to: "2026-06-14" })`,
which returned a complete transaction array. Kept the `approved` rows with no
`datePaid` and a known validation date 90+ days ago.

## Unpaid validated commissions — ledger

| Network | Transactions chased | Total | Oldest unpaid |
| --- | --- | --- | --- |
| Awin | 3 | £186.00 GBP | 138 days |
| Impact | — | — | skipped (nothing past 90 days) |

No failed calls.

## Draft email — Awin

**To:** `[Awin publisher support / finance contact]`
**Subject:** Unpaid validated commissions — Awin — publisher 123456

> Hello,
>
> Three commissions on my Awin account (publisher 123456) were validated more
> than the 90-day threshold I am using and remain unpaid.
> They total £186.00. The itemised sales are attached as a CSV.
>
> Could you confirm a payment date for these, or let me know if anything is
> outstanding on my side?
>
> | Transaction ID | Programme | Converted | Validated | Days unpaid | Commission |
> | --- | --- | --- | --- | --- | --- |
> | 88421003 | Riverside Coffee | 2026-01-08 | 2026-01-27 | 138 | £92.00 |
> | 88533117 | Acme Outdoor | 2026-02-02 | 2026-02-20 | 114 | £54.00 |
> | 88701992 | Quill Stationery | 2026-02-19 | 2026-03-09 | 97 | £40.00 |
>
> Thank you,
> [Your name]

## Attachment — `unpaid-commissions-awin-2026-06-14.csv`

```csv
transaction_id,programme,date_converted,date_approved,days_unpaid,commission,currency
88421003,Riverside Coffee,2026-01-08,2026-01-27,138,92.00,GBP
88533117,Acme Outdoor,2026-02-02,2026-02-20,114,54.00,GBP
88701992,Quill Stationery,2026-02-19,2026-03-09,97,40.00,GBP
```

Impact had nothing past the 90-day threshold, so no draft was produced for it.
This is a draft — review the recipient and figures, then send it yourself.
