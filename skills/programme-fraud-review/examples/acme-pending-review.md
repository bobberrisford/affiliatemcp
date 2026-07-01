# Example — "Check Acme's pending transactions for fraud before I validate"

Acme is bound to Awin (advertiser-side) via `brands.json`. Today is 2026-07-01,
so the default pending window is 2026-05-02 to 2026-06-30 (60 complete days), and
the baseline window is the prior 60 days, 2026-03-03 to 2026-05-01.

**User**: Check Acme's pending Awin transactions for anything dodgy before I
validate them.

**Assistant**: Reading Acme's pending queue from the Awin API, then scoring each
transaction and comparing publisher volumes against the prior 60 days. This is
read-only; I will not validate or decline anything.

Called `affiliate_resolve_brand` (filtered to `acme`) →

```
[{ brand: "acme", network: "awin-advertiser", networkBrandId: "100001" }]
```

Called:
- `affiliate_awin-advertiser_list_transactions({ brand: "acme", from: "2026-05-02", to: "2026-06-30", status: "pending" })`
- `affiliate_awin-advertiser_get_programme_performance({ brand: "acme", from: "2026-03-03", to: "2026-05-01" })`
- `affiliate_awin-advertiser_list_media_partners({ brand: "acme" })`
- `affiliate_awin-advertiser_list_transactions({ brand: "acme", from: "2026-03-03", to: "2026-05-01", status: "reversed" })`

## Acme — pending-transaction fraud review (Awin)

Windows: pending 2026-05-02 to 2026-06-30; baseline 2026-03-03 to 2026-05-01.

Coverage: all four pulls succeeded. Every signal below could be computed.

### Headline

- 214 pending transactions, £11,840 commission awaiting validation (GBP).
- 9 transactions fired at least one signal, £2,470 commission between them.

### Suspected (most signals first)

| Id | Publisher | Amount | Commission | Age | Signals | Recommendation |
| --- | --- | --- | --- | --- | --- | --- |
| 55231 | DealHubUK (id 88120) | £612.00 | £61.20 | 38d | Order-value outlier (median £74); click-to-convert 11s; publisher new (joined 2026-05-20) | Decline |
| 55240 | DealHubUK (id 88120) | £598.00 | £59.80 | 37d | Order-value outlier; click-to-convert 8s | Decline |
| 55198 | DealHubUK (id 88120) | £49.99 x14 | £69.86 | 40d | Duplicate cluster (14 identical £49.99, same landing URL); velocity spike (baseline 6 pending, now 71) | Hold |
| 55402 | CashbackCo (id 44010) | £310.00 | £31.00 | 12d | Risky history (reversal rate 27% last window) | Hold |
| 55411 | VoucherMate (id 51200) | £1,240.00 | £124.00 | 9d | Order-value outlier (17x median) | Hold |

### Clean

- 205 transactions, £9,370 commission, no signals fired. Eligible for routine
  validation.

### By publisher (suspected commission at stake)

| Publisher | Suspected txns | Suspected commission | Baseline reversal rate |
| --- | --- | --- | --- |
| DealHubUK (88120) | 16 | £190.86 | n/a (new partner) |
| VoucherMate (51200) | 1 | £124.00 | 6% |
| CashbackCo (44010) | 1 | £31.00 | 27% |

### What to do

- **Hold and query DealHubUK.** A brand-new partner is driving a velocity spike
  (6 pending in the baseline, 71 now), a cluster of 14 identical £49.99 orders on
  one landing URL, and two large orders that converted within seconds of the
  click. That combination is worth querying with the publisher and the network
  before any of it is validated. The two large sub-minute orders (55231, 55240)
  are the strongest decline candidates.
- **Hold CashbackCo 55402** given the 27% baseline reversal rate; investigate, do
  not auto-decline on history alone.
- **Sanity-check VoucherMate 55411**, a single large order that may simply be a
  genuine high-value basket.
- **Validate the clean set** (205 transactions) through your normal process.

This review is read-only: it flags and recommends, it does not validate or
decline. Carrying the decisions out happens in your Awin session, and a separate
human-gated flow will handle validate and decline once that is accepted.
