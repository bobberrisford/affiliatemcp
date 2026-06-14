# Example — "Prepare Acme's QBR"

Acme is bound to Awin (advertiser-side) via `brands.json`. The most recent
complete quarter is Q1 2026 (2026-01-01 to 2026-03-31).

**User**: Prepare Acme's QBR.

**Assistant**: Building the Q1 2026 review (2026-01-01 to 2026-03-31) against Q4 2025 (2025-10-01 to 2025-12-31). Pulling month-by-month performance and the partner roster...

Called `affiliate_resolve_brand` (filtered to `acme`) →

```
[{ brand: "acme", network: "awin-advertiser", networkBrandId: "100001" }]
```

Called:
- `affiliate_awin-advertiser_get_programme_performance({ brand: "acme", from: "2026-01-01", to: "2026-01-31" })`
- `affiliate_awin-advertiser_get_programme_performance({ brand: "acme", from: "2026-02-01", to: "2026-02-28" })`
- `affiliate_awin-advertiser_get_programme_performance({ brand: "acme", from: "2026-03-01", to: "2026-03-31" })`
- `affiliate_awin-advertiser_get_programme_performance({ brand: "acme", from: "2025-10-01", to: "2025-12-31" })`
- `affiliate_awin-advertiser_list_media_partners({ brand: "acme" })`

## Acme — Q1 2026 Business Review (Awin)

Period: Q1 2026 (2026-01-01 to 2026-03-31) vs Q4 2025 (2025-10-01 to 2025-12-31).

### Executive summary

Q1 closed at £452,800 gross sale (£45,280 commission, 12,940 conversions), up
9.6% on Q4's £413,100. Growth was front-loaded: a strong January carried the
quarter while March softened. Two cashback partners drove most of the gain; the
voucher segment was flat. Roster health is steady, with three dormant partners
worth reactivating.

### Monthly trend

| Month | Gross sale | Commission | Conversions | Clicks |
| --- | --- | --- | --- | --- |
| Jan 2026 | £171,400 | £17,140 | 4,980 | 612,000 |
| Feb 2026 | £156,200 | £15,620 | 4,410 | 548,300 |
| Mar 2026 | £125,200 | £12,520 | 3,550 | 501,900 |

### Partner mix and top contributors

Roster: 38 active, 4 pending, 19 inactive.

| Partner | Q1 gross sale | Share |
| --- | --- | --- |
| CashbackCo | £142,600 | 31.5% |
| VoucherHub | £71,300 | 15.7% |
| TechReviews | £48,900 | 10.8% |
| LoyaltyApp | £33,100 | 7.3% |
| DealFinder | £28,400 | 6.3% |

CashbackCo is above 30% of revenue — a concentration risk worth noting.

### Wins

- CashbackCo grew 24% QoQ and was the single biggest contributor to the increase.
- TechReviews, onboarded in November, reached the top three in its first full quarter.

### Risks and watch items

- Revenue concentration: CashbackCo at 31.5%. A change to their placement would move the whole programme.
- March softness: gross sale fell 20% from January. Worth confirming it is seasonal, not tracking.
- Three previously active cashback partners recorded zero conversions all quarter.

### Recommended next quarter

- Reactivate the three dormant cashback partners; they converted in Q4.
- Diversify beyond CashbackCo to reduce concentration before peak season.
- Confirm March's drop is seasonal by checking April's first two weeks.

---

For an ad-hoc window without the quarter-over-quarter narrative, use
`programme-performance-report`. For the whole book at once, use
`agency-portfolio-rollup`.
