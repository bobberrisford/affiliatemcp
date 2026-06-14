# Example — "Review CashbackCo for Acme"

Acme is bound to Awin (advertiser-side) via `brands.json`. Today is 2026-06-14,
so the default window is 2026-03-17 to 2026-06-14 (90 days).

**User**: Review CashbackCo for Acme, I've got a call with them tomorrow.

**Assistant**: Pulling CashbackCo's last 90 days on Acme (2026-03-17 to 2026-06-14) against the prior 90 days (2025-12-17 to 2026-03-16)...

Called `affiliate_resolve_brand` (filtered to `acme`) →

```
[{ brand: "acme", network: "awin-advertiser", networkBrandId: "100001" }]
```

Called `affiliate_list_networks` → Awin advertiser has no click-coverage
limitation recorded, so click-derived metrics may be computed when the
denominator is non-zero.

Called `affiliate_awin-advertiser_list_media_partners({ brand: "acme" })` → matched **CashbackCo** → `publisherId: "557001"`, status `active`.

Called:
- `affiliate_awin-advertiser_get_programme_performance({ brand: "acme", from: "2026-03-17", to: "2026-06-14", publisherId: "557001" })`
- `affiliate_awin-advertiser_get_programme_performance({ brand: "acme", from: "2025-12-17", to: "2026-03-16", publisherId: "557001" })`

## CashbackCo — performance review (Acme, Awin)

Status: active. Current window 2026-03-17 to 2026-06-14 (90 days); comparison 2025-12-17 to 2026-03-16 (90 days).

| Metric | Current | Comparison | Delta |
| --- | --- | --- | --- |
| Clicks | 184,500 | 162,300 | +22,200 (+13.7%) |
| Conversions | 5,120 | 4,640 | +480 (+10.3%) |
| Gross sale | £171,800 | £150,200 | +£21,600 (+14.4%) |
| Commission | £17,180 | £15,020 | +£2,160 (+14.4%) |

### Derived metrics

| Metric | Current | Comparison |
| --- | --- | --- |
| Conversion rate | 2.78% | 2.86% |
| EPC | £0.93 | £0.93 |
| Average order value | £33.55 | £32.37 |
| Effective commission rate | 10.0% | 10.0% |

### Status split (current window)

| Status | Gross sale | Commission |
| --- | --- | --- |
| Approved | £142,600 | £14,260 |
| Pending | £24,100 | £2,410 |
| Reversed | £5,100 | £510 |

Reversal share 3.0%, in line with the comparison window (3.2%).

### Trend (monthly)

- Apr 2026: £58,200
- May 2026: £61,400
- Jun 2026 (to 14 June): £52,200 — partial month, not directly comparable with May.

### Talking points

- Revenue up 14% over the comparison period.
- AOV climbed £1.18 while conversion rate dipped slightly — they are sending higher-value, slightly less frequent buyers.
- EPC is flat at £0.93; ask whether their placement or traffic mix changed during the period.
- Reversals are stable and low; no quality concern to raise.

---

For every publisher at once, use `programme-performance-report`.
