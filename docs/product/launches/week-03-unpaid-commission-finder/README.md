# Week 3 launch bundle — unpaid-commission finder

Part of the hosted PLG weekly launch calendar
(`docs/product/hosted-plg-workstream.md`). Prepared by the
`weekly-hosted-plg-launch` Monday routine for Rob to review and publish.

| | |
|---|---|
| **Week** | 3 |
| **Cohort** | Publishers / creators |
| **Feature** | Unpaid-commission finder |
| **Source skill** | `chase-unpaid-commissions` |
| **Gating** | Free-first (finder + drafted chase are free/unmetered) |

## Contents

- `card.html` — the branded, self-contained 1080×1080 artifact (open in a browser
  to view or re-render).
- `card.png` — the shareable image for LinkedIn (2160×2160, retina).
- `post.md` — the LinkedIn launch post + first comment, with a pre-publish note.

## Hook

"What am I owed but haven't been paid?" — the finder surfaces approved-but-unpaid
commissions aged past 90 days across every connected network, totals them, and
drafts a per-network chase email (sending stays with the user).

## Before publishing

The card figures are **illustrative sample data**. Replace them with real numbers
(and re-run the capture) or reframe the post as a product demo before publishing,
per `marketing/VOICE.md`. Publishing is Rob's decision; this bundle only prepares
it.

## Re-rendering the card

Open `card.html` in a browser (it inlines its own fonts and brand tokens), or
screenshot the `.frame` element at 1080×1080 (deviceScaleFactor 2) with
Playwright, matching how the other weekly cards are captured.
