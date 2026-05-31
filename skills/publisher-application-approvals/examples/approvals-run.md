# Example — "Go through my pending Awin publisher applications"

An Awin account manager with three pending applications. Run mode `auto`, volume guard 10.

**User**: Go through my pending publisher applications on Awin and approve or reject them.

**Assistant**: I'll work the Awin pending-applications queue in your signed-in dashboard.
Mode: `auto` (auto-action clear-cut cases, escalate the rest), volume guard 10. I'll open
each applicant's website to judge it against the rubric and only click on clear-cut cases.
Confirm and I'll begin.

_(operator confirms)_

Opened the publisher applications queue. Three pending. Visited each applicant's site.

## Decisions — Awin — 2026-05-31

| Publisher | URL | Hard gates | Soft signals | Verdict | Action | Why |
| --- | --- | --- | --- | --- | --- | --- |
| The Trail Kitchen | thetrailkitchen.example | all pass | strong: fresh recipe content, UK audience, clear sources | approve | actioned & confirmed (left pending queue) | clean pass, content site with relevant audience |
| MaxCashRebatesNow | maxcashrebates.example | **fail**: incentivised/cashback method on a brand that disallows it; site is a thin link-farm | — | reject | actioned & confirmed | two hard gates failed (prohibited method + made-for-affiliate) |
| Lumen Reviews | lumen-reviews.example | all pass | mixed: real site but undated reviews, vague "social + email" traffic, low activity | escalate | escalated | hard gates pass but soft signals weak/uncertain — needs a human call |

**Summary:** 1 approved, 1 rejected, 1 escalated.

### Needs your decision

- **Lumen Reviews** (lumen-reviews.example) — Site is genuine and on-topic and clears every
  hard gate, but content is undated, posting cadence is unclear, and the declared traffic
  sources ("social + email") are vague. Not a clear-cut approve and not a hard-gate reject,
  so I did not action it. If you want me to apply a stricter freshness/traffic-disclosure
  gate going forward, tell me and I'll update `rubric.md`.

Want me to save this log to `~/affiliate-approvals/awin-2026-05-31.md`?

---

## Same queue, `recommend-only` mode

If the operator had chosen `recommend-only`, nothing would be clicked. The table's **Action**
column would read `recommended-approve` / `recommended-reject` / `escalated`, and the
summary would be "1 recommended-approve, 1 recommended-reject, 1 escalated" — leaving every
dashboard action for the operator to perform by hand.
