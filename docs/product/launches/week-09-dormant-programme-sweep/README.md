# Week 9 launch bundle — dormant programme sweep

The week-9 bundle from the hosted PLG weekly launch calendar
(`docs/product/hosted-plg-workstream.md`). Unlike weeks 5 and 8, every figure on
the card came off a live account on the day; nothing here is illustrative and no
sample-data framing is needed.

| | |
|---|---|
| **Week** | 9 |
| **Cohort** | Publishers / creators (alternating from week 8's agency slot) |
| **Feature** | Dormant programme sweep — joined inventory against what actually earned |
| **Source skill** | `dormant-programme-sweep` (new, shipped in this PR) |
| **Delivery** | In-chat branded card + the written worklist |
| **Gating** | Free-first |
| **Proof** | Live Awin publisher account, swept 2026-08-11: 2,415 joined, 0 earning |

## Contents

- `card.html` — self-contained 1080×1080 card. Brand fonts loaded from
  `design-system/fonts/`, mark inlined as SVG, no external fetches.
- `card.png` — 2160×2160 capture (deviceScaleFactor 2). `.frame` bounding box
  verified at exactly 1080×1080 and the attribution stamp sits inside it.
- `post.md` — three LinkedIn posts, first comments, proposed slots, the claims
  table, and the one framing call left for Rob.
- The skill itself at `skills/dormant-programme-sweep/`, with a worked example
  built from the same real run.
- Three redirect pages under `site/go/`.

## Hook

"How many programmes have I joined, and how many still pay?" Joined inventory
only ever grows; nothing prunes it, and no network dashboard shows the gap
between the list and the earning set. The sweep computes that gap and splits the
dormant remainder into reactivation candidates and drop candidates.

## Why this feature, this week

Weeks 5 and 8 are both open drafts blocked on the same thing: their cards carry
invented figures, so neither can be published without a re-render against real
data. Week 9 was chosen to be a feature whose proof exists on the account that
is already configured. Awin publisher is the only credential set in the local
env, so the feature had to be publisher-side, read-only, and answerable from
`list_programmes` plus `get_earnings_summary`. It is.

## Free-first gating

Nothing here sits behind payment. The sweep reads the operator's own joined list
and their own earnings through their own keys, and the card renders in chat. The
paid pull stays scale and unattended operation — a scheduled monthly sweep that
emails the delta — per
`docs/decisions/2026-07-18-hosted-freemium-metered-tier.md`.

## Scope and risk

Routine and decision-complete. One new user-facing skill, its example, its test
registration, the launch bundle, and three static redirect pages. No adapter,
tool, contract, or runtime change: the skill composes two operations that
already ship. No new tool surface is added, per the `NetworkAdapter` rule in
`AGENTS.md`. No decision gate applies — this is a single-tenant read, not the
aggregate benchmark work waiting on PR #403.

## Proof

- `npx vitest run tests/skills/skills-exist.test.ts` — 98 passed, including the
  new skill's frontmatter, trigger phrases, cited tool names, and example file.
- Card captured with Playwright; `.frame` bounding box logged at exactly
  1080×1080, PNG written at 2160×2160.
- Every claim on the card traced to its source in `post.md`.

## How to re-render the card

```bash
node -e "const{chromium}=require('playwright');(async()=>{const b=await chromium.launch();const p=await b.newPage({viewport:{width:1080,height:1080},deviceScaleFactor:2});await p.goto('file://'+process.cwd()+'/docs/product/launches/week-09-dormant-programme-sweep/card.html');await p.waitForTimeout(900);console.log(await p.locator('.frame').boundingBox());await p.locator('.frame').screenshot({path:'docs/product/launches/week-09-dormant-programme-sweep/card.png'});await b.close()})()"
```

## Waiting on Rob

- The framing call in `post.md`: whether the public "zero earning" stays, the
  sweep is re-run against an account with real revenue, or the zero comes off
  the card. Recommendation is to ship as written.
- Review, then a go/no-go on publishing. Nothing is scheduled; no campaign is in
  force for week 9, so the default applies and Rob queues.
- Merge only if Rob asks for it.
