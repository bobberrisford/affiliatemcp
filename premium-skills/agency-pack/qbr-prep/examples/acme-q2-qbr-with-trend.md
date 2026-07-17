# Example — "Build the full QBR deck for Acme"

Acme is bound to Impact (advertiser-side). Today is 2026-07-12; the most
recent complete quarter is Q2 2026 (2026-04-01 to 2026-06-30). The operator
already ran the free `programme-performance-report` QBR profile this session
and has last quarter's recommended actions in hand.

**User**: Build the full QBR deck for Acme, with the multi-quarter trend and
a check on whether last quarter's actions actually happened.

**Assistant**: Using this session's Q2 QBR numbers from `programme-performance-report`.
Pulling the last five quarters' trend and checking Q1's recommended actions
against Q2's data...

Called:
- `affiliate_impact-advertiser_get_programme_performance({ brand: "acme", from: "2025-04-01", to: "2025-06-30" })`
- `affiliate_impact-advertiser_get_programme_performance({ brand: "acme", from: "2025-07-01", to: "2025-09-30" })`
- `affiliate_impact-advertiser_get_programme_performance({ brand: "acme", from: "2025-10-01", to: "2025-12-31" })`
- `affiliate_impact-advertiser_get_programme_performance({ brand: "acme", from: "2026-01-01", to: "2026-03-31" })`
- `affiliate_impact-advertiser_get_programme_performance({ brand: "acme", from: "2026-04-01", to: "2026-06-30" })`

## Acme — Q2 2026 Business Review (presentation outline)

### 1. Title

Acme Business Review — Q2 2026 (2026-04-01 to 2026-06-30)

### 2. Executive summary

Q2 closed at £498,200 gross sale, the fourth consecutive quarter of growth.
The multi-quarter trend shows steady compounding rather than one good
quarter. CashbackCo's concentration, flagged as a risk last quarter, has
eased slightly.

### 3. Multi-quarter trend

| Quarter | Gross sale | Commission | Conversions |
| --- | --- | --- | --- |
| Q2 2025 | £361,400 | £36,140 | 10,220 |
| Q3 2025 | £389,700 | £38,970 | 11,050 |
| Q4 2025 | £413,100 | £41,310 | 11,780 |
| Q1 2026 | £452,800 | £45,280 | 12,940 |
| Q2 2026 | £498,200 | £49,820 | 14,110 |

Shape: consistent quarter-on-quarter growth for four consecutive quarters,
averaging roughly 9% per quarter.

### 4. This quarter vs. last

Q2 2026 vs. Q1 2026: gross sale up 10.0% (£452,800 → £498,200).

### 5. Partner mix

(from this session's `programme-performance-report` run — unchanged)

### 6. Last quarter's commitments

| Q1 action | Verdict | Evidence |
| --- | --- | --- |
| "Diversify beyond CashbackCo to reduce concentration" | Partially delivered | CashbackCo's share fell from 31.5% to 27.8% of Q2 revenue |
| "Review reactivation of three inactive Q4 partners" | Not verifiable from data | No partner-status change data was supplied for this check |
| "Confirm March's drop was seasonal" | Delivered | April and May both recovered above January's level, consistent with a seasonal dip |

### 7. Wins and risks

(unchanged from this session's `programme-performance-report` run)

### 8. Recommended actions for next quarter

(unchanged from this session's `programme-performance-report` run, with a
note that the CashbackCo concentration risk is easing but not resolved)

### 9. Failures/gaps

None. All five quarters returned complete data.

---

This is the presentation layer over the free QBR profile. Numbers trace back
to the calls above; nothing here was estimated.
