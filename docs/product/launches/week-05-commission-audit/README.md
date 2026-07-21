# Week 5 launch bundle — commission audit

Part of the hosted PLG weekly launch calendar
(`docs/product/hosted-plg-workstream.md`). Prepared for Rob to review and
publish.

| | |
|---|---|
| **Week** | 5 |
| **Cohort** | Publishers / creators |
| **Feature** | Commission audit ("money you are owed") |
| **Source skill** | `commission-audit` |
| **Gating** | Free-first (audit + drafted chase are free/unmetered) |

## Contents

- `card.html` — the branded, self-contained 1080×1080 artifact (instance of
  the reusable template `design-system/cards/commission-audit-card.html`).
- `card.png` — the shareable image for LinkedIn (2160×2160, retina), rendered
  with the SAMPLE DATA watermark on.
- `post.md` — the LinkedIn launch post + first comment, with a pre-publish
  note.

## Hook

"Audit my commissions across every network." — the audit sweeps every
connected network for approved-but-unpaid commissions past a stated threshold,
reversals with no stated reason, and stale pending rows, itemised per network
and per currency with a count-honest coverage summary, then drafts the chase
emails (sending stays with the user).

## Before publishing

The card figures are **illustrative sample data** and the card is watermarked
SAMPLE DATA. Either re-render with real anonymised figures from a real account
(removing the watermark only then) and use first-person framing, or keep the
explicit demo framing in `post.md`. Publishing is Rob's decision; this bundle
only prepares it.

## Re-rendering the card

Edit the EDIT-marked regions in `card.html`, then screenshot the `.frame`
element at 1080×1080 with `deviceScaleFactor: 2` via Playwright (the exact
recipe is in the template's header comment).

## Next week

Week 6 agency candidate: the brand-side `programme-leakage-audit` (reversal
concentration including the unspecified share, plus the age-bucketed
validation queue).
