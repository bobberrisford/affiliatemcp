# Example - weekly note judged against the client's plan

Acme on Impact (advertiser-side), with a strategy and KPIs recorded via the
client-onboarding skill. Shows how the report changes when a plan exists.

**User**: How did Acme do this week?

**Assistant**: Resolving the brand and loading its plan...

Called `affiliate_resolve_brand` -> `acme` on `impact-advertiser`.

Called `affiliate_get_client_strategy({ brand: "acme" })` -> targets: revenue >= GBP 400,000/quarter, reversals <= 8%/month; strategy: premium content preferred, no coupon/incentive, weekly report to Jane, escalate any drop > 20%.

Called `affiliate_impact-advertiser_get_programme_performance({ brand, from, to })` for this week (2026-06-08 to 2026-06-14) and last week (2026-06-01 to 2026-06-07).

## Acme - week of 2026-06-08 (for Jane)

**Verdict: behind plan, despite a better week.** Quarter-to-date revenue is GBP 268k of the GBP 400k Q2 target with about 18% of the quarter left. On current run-rate Acme lands around GBP 325k, about 19% short. This week itself was solid.

| Metric | This week | Last week | Delta |
| --- | --- | --- | --- |
| Gross sale | GBP 94,200 | GBP 88,400 | +GBP 5,800 (+6.6%) |
| Commission | GBP 9,420 | GBP 8,840 | +GBP 580 (+6.6%) |
| Conversions | 1,040 | 980 | +60 (+6.1%) |

**Health**: reversals 6.2% this month, within the 8% limit.

**Partner mix vs strategy**: top contributor this week was a coupon partner at 31% of revenue. Strategy deprioritises coupon/incentive, so this is worth a look, though it is not breaching anything. (Observation only.)

**Watch**: nothing crossed the 20% escalation threshold this week.

---

### Contrast - the same week with no plan recorded

Without a recorded strategy the report would lead with the bare delta ("Gross
sale GBP 94,200, +6.6% week-on-week") and add: "No strategy is recorded for Acme.
I can set one up so future reports judge against its targets." No verdict, no
pace-to-target, no partner-mix tension surfaced.
