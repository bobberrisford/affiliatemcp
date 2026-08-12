# Week 8 launch bundle — publisher spotlight

Part of the hosted PLG weekly launch calendar
(`docs/product/hosted-plg-workstream.md`). Prepared by the
`weekly-hosted-plg-launch` Monday routine for Rob to review and publish.

| | |
|---|---|
| **Week** | 8 |
| **Cohort** | Agencies / advertisers |
| **Feature** | Publisher spotlight — top-partner card plus call talking points |
| **Source skill** | `publisher-performance-review` |
| **Delivery** | In-chat branded card + the written review |
| **Gating** | Free-first (the review and the card are free and unmetered) |

## Contents

- `card.html` — the branded, self-contained 1080×1080 artifact.
- `card.png` — the shareable image for LinkedIn (2160×2160, retina).
- `post.md` — the LinkedIn launch post + first comment, with a pre-publish note.

## Hook

"Prep me for the call with CashbackCo on Acme" — one partner, pulled across
every network the brand runs, 90 days against the prior 90, with the reversal
question the account manager should be walking in with rather than answering.

## Free-first gating

Nothing here sits behind payment. The partner review reads the operator's own
programme data through their own keys, and the card renders in chat. The paid
pull for agencies remains scale, seats, and unattended scheduled operation, per
the freemium decision (`docs/decisions/2026-07-18-hosted-freemium-metered-tier.md`).

## How to re-render

`card.html` is self-contained (inlined brand tokens, the mark SVG, and the
Google Fonts link), so it renders standalone in any browser. To re-capture the
PNG after editing, run a short Playwright script from the repository root so it
resolves `node_modules`:

```js
import { chromium } from 'playwright';
const dir = 'docs/product/launches/week-08-publisher-spotlight';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1080 }, deviceScaleFactor: 2 });
await page.goto(`file://${process.cwd()}/${dir}/card.html`, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.locator('.frame').screenshot({ path: `${dir}/card.png` });
await browser.close();
```

The `.frame` bounding box must be exactly 1080×1080 and the footer stamp must be
inside the capture.

## Before publishing

The partner, brand, and figures are **illustrative sample data**. Replace with
real (anonymised) figures and re-capture, or reframe as a product demo, before
posting. Publishing is Rob's decision.
