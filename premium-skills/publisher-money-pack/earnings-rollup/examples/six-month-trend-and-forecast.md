# Example — "Show my earnings trend, how concentrated I am, and forecast my
next payout"

A publisher with Awin and CJ configured. Today is 2026-07-12.

**User**: Show my earnings trend over the last six months, how concentrated
my income is, and forecast when my pending commission from Awin will land.

**Assistant**: Pulling six months of earnings per network, ranking
programmes by share, and checking Awin's typical approval-to-payment timing...

Called `affiliate_awin_get_earnings_summary` and `affiliate_cj_get_earnings_summary`
once per month for Feb–Jul 2026, plus `affiliate_awin_list_transactions({ status: "paid", from: "2025-07-12", to: "2026-07-12" })`
for the payment-timing sample.

## Trend (GBP)

| Network | Feb | Mar | Apr | May | Jun | Jul (MTD) |
| --- | --- | --- | --- | --- | --- | --- |
| Awin | 210 | 240 | 265 | 258 | 302 | 118 |
| CJ | 340 | 355 | 310 | 298 | 285 | 96 |

Shape: Awin growing steadily; CJ gently declining over the period.

## Concentration (July, GBP)

Top programmes across both networks:

| Programme | Network | Total | Share |
| --- | --- | --- | --- |
| Riverside Coffee | Awin | 62.10 | 29.0% |
| Acme Outdoor | CJ | 48.30 | 22.6% |
| Quill Stationery | Awin | 31.40 | 14.7% |

Top 1 = 29.0%, top 3 = 66.3%. Below the 40%/70% flag thresholds, so no
diversification-risk flag this period.

## Payment timing — Awin

Sample: 14 paid transactions in the last 12 months, all carrying
`dateApproved` and `datePaid`.

- Conversion → approval: median 12 days (range 6–21 days).
- Approval → payment: median 34 days (range 28–45 days).

Currently approved, unpaid Awin commission: £96.00, approved 2026-06-20.
Based on the typical 28–45 day approval-to-payment window, expect payment
roughly between 2026-07-18 and 2026-08-04. This is a pattern from Awin's own
past payment history, not a commitment from Awin.

## Payment timing — CJ

Sample: 3 paid transactions in the last 12 months. Too small to report a
reliable median; no forecast given for CJ.

## Failures/gaps

None. Both networks returned complete data for the trend window.

---

For a chase on anything already past its payment term, use the free
`chase-unpaid-commissions` skill or the premium `unpaid-commission-chaser`
skill for multi-tier escalation.
