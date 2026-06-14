# Example — "Why are Acme's commissions being declined?"

Acme is bound to Awin (advertiser-side) via `brands.json`. Today is 2026-06-15,
so the default window is 2026-05-16 to 2026-06-15 (30 days).

**User**: Why are Acme's commissions being declined this month?

**Assistant**: Pulling Acme's reversed transactions for 2026-05-16 to 2026-06-15 and the full set so I can show the reversal rate...

Called `affiliate_resolve_brand` (filtered to `acme`) →

```
[{ brand: "acme", network: "awin-advertiser", networkBrandId: "100001" }]
```

Called:
- `affiliate_awin-advertiser_list_transactions({ brand: "acme", from: "2026-05-16", to: "2026-06-15", status: "reversed" })`
- `affiliate_awin-advertiser_list_transactions({ brand: "acme", from: "2026-05-16", to: "2026-06-15" })`

## Acme — reversal and decline report (Awin)

Window: 2026-05-16 to 2026-06-15.

### Headline

- 142 reversed transactions, £3,180 commission at stake.
- Reversal rate this window: 8.4% of commission (£3,180 of £37,900). Prior 30 days: 5.1%. Rising.

### By reason

| Reason | Count | Commission | Share |
| --- | --- | --- | --- |
| Returned goods | 71 | £1,520 | 47.8% |
| Duplicate order | 38 | £980 | 30.8% |
| Cancelled order | 22 | £510 | 16.0% |
| Unspecified | 11 | £170 | 5.3% |

### By publisher

| Publisher | Count | Commission | Reversal rate |
| --- | --- | --- | --- |
| DealFinder | 49 | £1,340 | 19.2% |
| CashbackCo | 33 | £620 | 3.0% |
| VoucherHub | 28 | £540 | 7.1% |
| TechReviews | 18 | £410 | 6.8% |

DealFinder's reversal rate (19.2%) is well above the programme average — worth a
direct conversation.

### Notable cases

- `TXN-99213` — DealFinder — £210 — duplicate order — 18 days old.
- `TXN-98870` — VoucherHub — £180 — returned goods — 24 days old.
- `TXN-99001` — DealFinder — £150 — duplicate order — 12 days old.

### What to do

- The "duplicate order" cluster is concentrated on DealFinder; raise it with them and with the network to confirm it is not a tracking-side double-fire.
- "Returned goods" is the largest bucket but spread across partners — likely genuine returns, not a tracking issue.
- Reversal rate rose from 5.1% to 8.4% month-on-month; flag for next week's check.

This report is read-only. To dispute or re-open any of these, use the Awin
dashboard.

---

For the full per-publisher performance picture (not just declines), use
`programme-performance-report`.
