# Example: a weekly autopilot run (second pass)

**Scheduled prompt:** `/autopilot-run weekly`

## What the skill does

1. `affiliate_autopilot_load_context({ loop: "weekly" })` returns three brands
   (`acme`, `globex`, `initech`), intent for `acme` and `globex`, and last
   week's snapshot.
2. Windows: current `2026-05-26 to 2026-06-01`, comparison `2026-05-19 to 2026-05-25`.
3. Fans out `affiliate_impact-advertiser_get_programme_performance` and
   `affiliate_cj-advertiser_get_programme_performance` twice per binding.
4. Judges: `acme` has `revenue_drop_wow_pct: 15`; `globex` uses the default 25%.
5. Diffs against last week's findings to assign lifecycle states.

## Rendered digest

```
Autopilot · weekly · 2026-05-26 → 06-01 (vs prior 7 days)

NEW      Acme · impact · revenue −19% (£8,400 → £6,800), past the 15% line you set · still 4% ahead of the quarterly target
WORSENED Globex · cj · reversal share 6% → 13% (was flagged at 6% last week)
RESOLVED Acme · impact · "DealSite" back in the top 10 (was dropped last week)

No target set for Initech — say "set a target for initech" to record one.

2 findings still open and unchanged (suppressed).

Failures: none.
```

## Then

`affiliate_autopilot_save_state({ loop: "weekly", state: {…per-binding metrics + open findings…}, digest: "<the markdown above>" })`
— so next week's run can tell new from ongoing.
