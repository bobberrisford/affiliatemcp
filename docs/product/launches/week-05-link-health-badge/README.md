# Week 5 launch bundle — link-health badge

Part of the hosted PLG weekly launch calendar
(`docs/product/hosted-plg-workstream.md`). Prepared by the
`weekly-hosted-plg-launch` Monday routine for Rob to review and publish.

| | |
|---|---|
| **Week** | 5 |
| **Cohort** | Publishers / creators |
| **Feature** | Link-health badge |
| **Source skill** | `audit-affiliate-links` |
| **Delivery** | In-chat card (on-demand audit) |
| **Gating** | Free-first (audit + badge are free; scheduled whole-sitemap sweeps are the paid pull) |

## Contents

- `card.html` — the branded, self-contained 1080×1080 artifact.
- `card.png` — the shareable image for LinkedIn (2160×2160, retina).
- `post.md` — the LinkedIn launch post + first comment, with a pre-publish note.

## Hook

"Are any of my affiliate links dead?" — the audit checks every affiliate link in
a sitemap or document against its live programme and reports how many are broken,
so a publisher stops earning nothing from links that quietly went dead.

## Before publishing

Card figures and network breakdown are **illustrative sample data**. Replace with
real figures from a real audit and re-capture, or reframe as a product demo,
before posting. Publishing is Rob's decision.

## How to re-render the PNG

From the repo root (Playwright is a repo dependency):

```js
// __capture.mjs
import { chromium } from 'playwright';
const dir = 'docs/product/launches/week-05-link-health-badge';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1080 }, deviceScaleFactor: 2 });
await page.goto('file://' + process.cwd() + '/' + dir + '/card.html');
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(400);
await (await page.$('.frame')).screenshot({ path: dir + '/card.png' });
await browser.close();
```

Run with `node __capture.mjs`, then delete the temp script. The `.frame` element
must render at exactly 1080×1080 (guaranteed by `*{box-sizing:border-box}`).
