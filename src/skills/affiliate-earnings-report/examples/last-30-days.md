# Example — "what did I earn last month?"

A publisher with Awin and Impact configured.

**User**: what did I earn last month?

**Assistant**: Last month = 2026-04-01 to 2026-04-30 (30 days). Pulling earnings summaries...

Called `affiliate_list_networks` → `awin`, `impact`.

Called:
- `affiliate_awin_earnings_summary({ from: "2026-04-01", to: "2026-04-30" })` → £284.12 GBP
- `affiliate_impact_earnings_summary({ from: "2026-04-01", to: "2026-04-30" })` → $112.40 USD

## Earnings — 2026-04-01 to 2026-04-30 (30 days)

Totals are reported per currency; no FX conversion applied.

| Network | Total | Pending | Approved | Paid | Reversed | Oldest unpaid |
| --- | --- | --- | --- | --- | --- | --- |
| Awin | £284.12 | £42.00 | £180.12 | £62.00 | £0.00 | 95 days **ATTENTION** |
| Impact | $112.40 | $30.00 | $82.40 | $0.00 | $0.00 | 41 days |

### Top programmes

| # | Network | Programme | Total |
| --- | --- | --- | --- |
| 1 | Awin | Riverside Coffee | £140.00 |
| 2 | Awin | Acme Outdoor | £88.12 |
| 3 | Impact | Northshore Gear | $74.20 |
| 4 | Impact | Tidewater Tools | $38.20 |
| 5 | Awin | Quill Stationery | £56.00 |

### Notes

- Awin has a £42 commission pending for 95 days — likely worth checking with the merchant. The transaction id is visible via `affiliate_awin_list_transactions({ from: "2026-04-01", to: "2026-04-30", status: "pending" })`.
- No failures from either network.
