# Example — "Anything weird in the affiliate data this week?"

The agency runs this every Monday morning via Claude's scheduler.

**User**: Anomaly check.

**Assistant**: This week = 2026-05-17 to 2026-05-23. Comparison = 2026-05-10 to 2026-05-16. Walking the book...

Called `affiliate_resolve_brand` → 5 bindings. Called `affiliate_impact-advertiser_get_programme_performance` for each × 2 windows in parallel.

## Anomalies — 2026-05-17 to 2026-05-23 vs prior week

- **Quill Stationery · impact-advertiser · revenue drop · -£4,210 (-22.1%)** · top loss from Riverside Reviews (-£3,800)
- **Northshore Gear · impact-advertiser · top-10 dropout** · Coastline Coupons fell from #4 (last week) to #14 (this week)
- **Tidewater Tools · impact-advertiser · publisher silenced · -£1,612 lost** · Lantern Loyalty went from 88 conversions to 0
- **Lighthouse Loyalty · impact-advertiser · dead programme · 0 clicks this week (3,420 last week)** · likely tracking break, recommend `affiliate_impact-advertiser_verify_auth({ brand: "lighthouse-loyalty" })` and a manual link check

### Failures

None this week.

### Notes

- Severity ordered by absolute revenue at risk.
- For per-publisher detail behind any anomaly, invoke `programme-performance-report` for the relevant brand.
