# Example — "Acme's weekly report"

Acme is bound to Awin (advertiser-side) via `brands.json`. Today is Monday
2026-06-15, so the most recent complete week is 2026-06-08 to 2026-06-14.

**User**: Acme's weekly report.

**Assistant**: Reporting week 2026-06-08 to 2026-06-14 (Mon–Sun) against the prior week 2026-06-01 to 2026-06-07. Resolving the brand and pulling per-publisher performance...

Called `affiliate_resolve_brand` (filtered to `acme`) →

```
[{ brand: "acme", network: "awin-advertiser", networkBrandId: "100001" }]
```

Called:
- `affiliate_awin-advertiser_get_programme_performance({ brand: "acme", from: "2026-06-08", to: "2026-06-14" })`
- `affiliate_awin-advertiser_get_programme_performance({ brand: "acme", from: "2026-06-01", to: "2026-06-07" })`

## Acme — weekly affiliate update

Week 2026-06-08 to 2026-06-14 vs prior week 2026-06-01 to 2026-06-07 (Awin).

Revenue up 12.4% week-on-week, driven mainly by two cashback partners; clicks broadly flat.

| Metric | This week | Last week | Delta |
| --- | --- | --- | --- |
| Gross sale | £38,420.00 | £34,180.00 | +£4,240.00 (+12.4%) |
| Commission | £3,842.00 | £3,418.00 | +£424.00 (+12.4%) |
| Conversions | 1,104 | 992 | +112 (+11.3%) |
| Clicks | 41,220 | 40,880 | +340 (+0.8%) |

### Top movers

**Gained**
- CashbackCo — £12,180 vs £8,940 (+£3,240)
- VoucherHub — £6,410 vs £5,020 (+£1,390)
- TechReviews — £3,980 vs £3,510 (+£470)

**Fell**
- DealFinder — £2,110 vs £3,260 (−£1,150)
- LoyaltyApp — £1,640 vs £2,180 (−£540)
- StudentPerks — £980 vs £1,300 (−£320)

### Watch items

- None this week.

---

If the client wants the full per-publisher rollup and status split, run the
`programme-performance-report` skill instead. To see the whole book at once, use
`agency-portfolio-rollup`.
