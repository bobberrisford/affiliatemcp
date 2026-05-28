# Example — "How is Acme performing this quarter?"

Acme is bound to Impact (advertiser-side) via `brands.json`.

**User**: How is Acme performing this quarter?

**Assistant**: Q1 2026 = 2026-01-01 to 2026-03-31 (90 days). Comparison window = 2025-10-03 to 2025-12-31 (90 days). Resolving brand and pulling per-publisher performance...

Called `affiliate_resolve_brand` (filtered to `acme`) →

```
[{ brand: "acme", network: "impact-advertiser", networkBrandId: "IRAcme123" }]
```

Called:
- `affiliate_impact-advertiser_get_programme_performance({ brand: "acme", from: "2026-01-01", to: "2026-03-31" })`
- `affiliate_impact-advertiser_get_programme_performance({ brand: "acme", from: "2025-10-03", to: "2025-12-31" })`

## Acme — Impact (advertiser) — Q1 2026

Windows: current 2026-01-01 to 2026-03-31 (90 days); comparison 2025-10-03 to 2025-12-31 (90 days).

| Metric | Current | Comparison | Delta |
| --- | --- | --- | --- |
| Gross sale | £148,212.00 | £121,008.00 | +£27,204.00 (+22.5%) |
| Commission | £14,820.00 | £12,100.00 | +£2,720.00 (+22.5%) |
| Conversions | 4,212 | 3,440 | +772 (+22.4%) |
| Clicks | 162,440 | 151,002 | +11,438 (+7.6%) |

### Status split (current window)

| Status | Gross sale | Commission |
| --- | --- | --- |
| Approved | £128,440.00 | £12,840.00 |
| Pending | £18,212.00 | £1,820.00 |
| Reversed | £1,560.00 | £160.00 |

Reversal share is steady at ~1% — no flag.

### Top 10 publishers (by current gross sale)

| # | Publisher | Conversions | Gross sale | Commission | Delta |
| --- | --- | --- | --- | --- | --- |
| 1 | Riverside Reviews | 942 | £42,180.00 | £4,218.00 | +18.2% |
| 2 | Lighthouse Loyalty | 612 | £28,140.00 | £2,814.00 | +12.4% |
| ... | ... | ... | ... | ... | ... |

### Anomalies

None this window.

### Notes

- For transaction-level drill-down, pair with `affiliate_impact-advertiser_list_transactions({ brand: "acme", from: "2026-01-01", to: "2026-03-31" })`.
- For the full active partner roster (including those who didn't convert), pair with `affiliate_impact-advertiser_list_media_partners({ brand: "acme" })`.
