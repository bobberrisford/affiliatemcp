# Example — "Which clients are underperforming the book average, and is any
one publisher overexposed across our clients?"

Three registered brands: Acme and Quill (both Impact advertiser), Riverside
(Awin advertiser). Today is 2026-07-12.

**User**: Give me a benchmarked view of the book, not just this week — and
tell me if any one publisher shows up across multiple clients.

**Assistant**: Pulling six months of trend per client, computing the book's
growth benchmark, and cross-referencing each client's partner roster for
overlap...

Called, per brand, `affiliate_impact-advertiser_get_programme_performance`
and `affiliate_awin-advertiser_get_programme_performance` for each of the
last six calendar months, plus `affiliate_impact-advertiser_list_media_partners`
and `affiliate_awin-advertiser_list_media_partners` for the current roster.

## Coverage

- 3 brands included in the trend and benchmark.
- 0 brands too new to benchmark.
- 0 brands excluded from partner-concentration analysis.
- 0 failed calls.

## Monthly trend per client (GBP)

| Brand | Feb | Mar | Apr | May | Jun | Jul (MTD) |
| --- | --- | --- | --- | --- | --- | --- |
| Acme | 128,400 | 132,900 | 141,200 | 148,600 | 156,200 | 61,300 |
| Quill | 41,200 | 39,800 | 40,500 | 38,900 | 37,100 | 15,200 |
| Riverside | 22,100 | 23,400 | 24,800 | 26,700 | 28,900 | 12,100 |

## Peer benchmark (Jun vs. May growth)

| Brand | Growth | Book average | Book median | Comparison |
| --- | --- | --- | --- | --- |
| Acme | +5.1% | +2.0% | +5.1% | ahead of the book average |
| Quill | -4.6% | +2.0% | +5.1% | behind the book average |
| Riverside | +8.2% | +2.0% | +5.1% | ahead of the book average |

Quill is the one client trending against the book's overall direction and is
worth a closer look with the free `agency-portfolio-rollup`'s needs-attention
view or a per-brand `programme-performance-report`.

## Cross-client partner concentration

| Partner | Appears in | Combined commission | Share of book commission |
| --- | --- | --- | --- |
| CashbackCo | Acme, Riverside | £14,200 | 18.3% |
| VoucherHub | Acme, Quill | £6,900 | 8.9% |

CashbackCo is above the 15% concentration flag: it drives revenue for two of
the three clients in the book, so a tracking issue or policy change at
CashbackCo would affect both at once. Partner identity here is matched on
name across Impact and Awin rosters; treat it as a strong hint rather than a
confirmed cross-network identity.

## What this adds to the weekly rollup

This report adds the multi-month trend, the peer benchmark, and the
cross-client partner view. For this week's headline and per-brand needs-
attention list, run the free `agency-portfolio-rollup` skill.
