# Example — onboarding a client from a pasted brief

A new agency client, Acme, already bound on Impact (advertiser-side). The
operator pastes the kickoff brief rather than answering questions.

**User**: Set up a strategy for Acme. Here's the brief we agreed:

> Acme — Q3 priorities. Grow to £400k/quarter affiliate revenue. Lean into
> premium content and cashback-free loyalty partners; we do not want coupon or
> incentive sites. Keep reversals under 8%. Brand safety: no gambling or adult
> adjacency. Report weekly to Jane (marketing manager), plain language.
> Anything down more than 20% week-on-week, flag it to us straight away.

**Assistant**: Checking which brands are registered…

Called `affiliate_resolve_brand` (no filter) → `acme` is bound on
`impact-advertiser`. Good, the strategy will key to that slug.

Called `affiliate_get_client_strategy({ brand: "acme" })` → nothing recorded
yet, so this is a fresh strategy.

Here's what I've pulled from the brief, in plain English:

- **Revenue target**: £400,000 per quarter.
- **Reversals**: keep under 8%.
- **Partners**: prefer premium content and loyalty partners; avoid coupon and
  incentive sites.
- **Brand safety**: no gambling or adult adjacency.
- **Reporting**: weekly, to Jane (marketing manager), plain language.
- **Escalate**: any week-on-week drop over 20%, immediately.

I have no conversion, EPC, or AOV target from the brief, so I've left those out
rather than guess. Save this for Acme?

**User**: Yes.

**Assistant**: Called `affiliate_set_client_strategy({ brand: "acme", strategyMarkdown, kpiMarkdown })`.

The KPI block I saved:

```kpi
# targets: metric: comparator value [unit] [per period]
version: 1
revenue: >= 400000 GBP per quarter
reversal_rate: <= 8%
```

Saved. Strategy and KPIs are recorded for `acme`. From now on, Acme's
performance reports will judge against the £400k quarterly target and flag
reversals over 8%, and the weekly report will lead with the direction of travel
for Jane. To change anything later, just tell me (for example "raise Acme's Q3
target to £450k").

---

### A later edit

**User**: Bump Acme's revenue target to £450k for Q3.

**Assistant**: Called `affiliate_get_client_strategy({ brand: "acme" })`,
rebuilt the KPI block from the parsed targets with revenue changed to
`>= 450000 GBP per quarter`, and left the reversal target unchanged. This will
replace `KPI.md` with a normalised block. New target: £450,000 per quarter.
Save?

**User**: Yes.

**Assistant**: Called `affiliate_set_client_strategy({ brand: "acme", kpiMarkdown })`.
Done — Acme's quarterly revenue target is now £450k.
