# Example — "Audit Acme's programme for leakage"

Acme is bound to Awin (advertiser-side) via `brands.json`. Today is
2026-07-20, so the default reversal window is 2026-06-20 to 2026-07-19 (30
complete days) and the validation-queue window is 2026-01-21 to 2026-07-19
(180 days).

**User**: Where is Acme's programme leaking money?

**Assistant**: Resolving Acme's bindings, then pulling reversed transactions
for the last 30 complete days and the pending validation queue over the last
180 days...

Called `affiliate_resolve_brand` (filtered to `acme`) →

```
[{ brand: "acme", network: "awin-advertiser", networkBrandId: "100001" }]
```

Called:

- `affiliate_awin-advertiser_list_transactions({ brand: "acme", from: "2026-06-20", to: "2026-07-19", status: "reversed" })`
- `affiliate_awin-advertiser_list_transactions({ brand: "acme", from: "2026-06-20", to: "2026-07-19" })` (denominator)
- `affiliate_awin-advertiser_list_transactions({ brand: "acme", from: "2026-01-21", to: "2026-07-19", status: "pending" })`

## Acme — programme leakage audit (Awin)

Windows: reversals 2026-06-20 to 2026-07-19; validation queue 2026-01-21 to
2026-07-19. Age buckets: 0–30, 31–60, 61–90, 90+ days.

Coverage: Awin advertiser `listTransactions` supported; both reversal sets
confirmed complete, so the rate is available.

### Reversal concentration

118 reversed transactions, £2,840 commission at stake. Reversal rate this
window: 7.6% of commission (£2,840 of £37,400).

| Reason | Count | Commission | Share |
| --- | --- | --- | --- |
| Returned goods | 52 | £1,190 | 41.9% |
| **Unspecified** | **34** | **£1,160** | **40.8%** |
| Cancelled order | 24 | £370 | 13.0% |
| Out of policy | 8 | £120 | 4.2% |

40.8% of reversed commission carries no stated reason. That is the audit's
main finding: £1,160 was clawed back this month without the records saying
why. The records do not establish the cause — raise it with the network.

### Validation queue (pending, publisher-trust liability)

| Age | Count | Commission |
| --- | --- | --- |
| 0–30 days | 210 | £4,320 |
| 31–60 days | 84 | £1,870 |
| 61–90 days | 31 | £790 |
| **90+ days** | **19** | **£560** |

Oldest pending transaction: 152 days. £560 across 19 transactions has sat
unvalidated for over 90 days — partners running their own unpaid-commission
checks will surface exactly these rows against the programme.

### What to raise

- Ask Awin why 40.8% of reversed commission is unspecified; request the
  breakdown behind those 34 reversals.
- Clear the 61–90 and 90+ validation buckets (£1,350 across 50 transactions)
  before partners start chasing.
- For the by-publisher decline pattern behind "returned goods", run
  `programme-reversal-report`.

This audit is read-only. Approving, disputing, or re-opening transactions
happens in the Awin dashboard.
