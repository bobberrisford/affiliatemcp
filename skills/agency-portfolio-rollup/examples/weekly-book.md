# Example — "How is the whole book doing this week?"

An agency with five brands across Impact (advertiser-side). One brand spans two currencies.

**User**: How is the whole book doing this week?

**Assistant**: This week = 2026-05-17 to 2026-05-23 (7 days). Comparison = 2026-05-10 to 2026-05-16 (7 days). Pulling per-binding performance...

Called `affiliate_resolve_brand` (no filter) → 5 brands × 1 network each = 5 bindings.

Called `affiliate_impact-advertiser_get_programme_performance({ brand, from, to })` for each binding × 2 windows (10 calls, in parallel).

## Portfolio — 2026-05-17 to 2026-05-23 (7 days)

Comparison: 2026-05-10 to 2026-05-16 (7 days). Per-currency totals; no FX conversion.

| Brand | Gross sale | Commission | Conversions | Delta |
| --- | --- | --- | --- | --- |
| Riverside Coffee | £42,180.00 | £4,218.00 | 942 | +£8,200 (+24.1%) |
| Northshore Gear | $38,440.00 | $3,844.00 | 612 | +$1,002 (+2.7%) |
| Tidewater Tools | £28,140.00 | £2,814.00 | 540 | -£2,100 (-6.9%) |
| Quill Stationery | £14,820.00 | £1,482.00 | 312 | -£4,210 (-22.1%) **(needs attention)** |
| Lighthouse Loyalty | £8,402.00 / $1,240.00 | £840.20 / $124.00 | 188 | -£1,820 (-17.8%) / +$202 (+19.4%) |

### Needs attention

- **Quill Stationery** is down 22.1% week-on-week (£14,820 vs £19,030).

### Portfolio totals

- £93,542.00 gross sale across GBP-denominated bindings (+0.6% vs. last week).
- $39,680.00 gross sale across USD-denominated bindings (+3.2% vs. last week).

### Failures

None this week.

### Notes

- To drill into a single brand, call `programme-performance-report` for that brand.
- Lighthouse Loyalty has GBP and USD rows on the same binding — keeping each currency separate, as the chassis returns per-row `currency`.
