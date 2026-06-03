# Example: recording a new client's intent

**Operator:** "Set up Acme — they want growth this quarter, content partners
matter most, and flag me if revenue drops more than 15% in a week."

## What the skill does

1. `affiliate_resolve_brand()` confirms `acme` is bound to `impact-advertiser`.
2. `affiliate_autopilot_load_context({ loop: "weekly" })` shows `acme` has no
   intent yet (empty prose, `thresholds: {}`).
3. Seeds a target from last quarter's numbers: "Acme did ~£310k last quarter —
   set the quarterly target at £320k?" Operator: "make it £400k."
4. Drafts the files and shows them:

`strategy.md`
```
# Acme — affiliate strategy

Objective this quarter: growth. Content partners are the priority; cashback is
deprioritised. Escalate immediately on any trademark-bidding breach.
Reporting: concise, weekly.
```

`kpi.md`
```
# Acme — KPIs

Targets and the alert thresholds the autopilot loop checks.

# affiliate-mcp:thresholds
revenue_drop_wow_pct: 15
reversal_rate_max_pct: 8
quarterly_revenue_target_gbp: 400000
# example: minimum_approval_rate_pct: 90
```

5. Confirms, then `affiliate_autopilot_save_intent({ slug: "acme", strategy, kpi })`.

## Later edit

**Operator:** "Add a reversal alert above 10% for Acme."
→ loads current `kpi.md`, changes `reversal_rate_max_pct` to `10`, re-saves via
`affiliate_autopilot_save_intent({ slug: "acme", kpi })` (kpi only).
