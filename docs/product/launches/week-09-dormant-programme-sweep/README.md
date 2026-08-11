# Week 9 launch bundle — dormant programme sweep

The week-9 bundle from the hosted PLG weekly launch calendar
(`docs/product/hosted-plg-workstream.md`). Unlike weeks 5 and 8, every figure
came off live accounts on the day; nothing is illustrative and no sample-data
framing is used.

| | |
|---|---|
| **Week** | 9 |
| **Lead cohort** | Advertisers, brands, and agencies |
| **Feature** | Dormant programme sweep — partnerships on the books against partnerships producing |
| **Source skill** | `dormant-programme-sweep` (new, ships in this PR; both sides) |
| **Delivery** | In-chat branded card + written worklist |
| **Gating** | Free-first |
| **Proof** | Live Awin advertiser programme, swept 2026-08-11: 524 roster, 50 producing |

## Read this before publishing

The launch figures come from a **third party's** Awin advertiser programme,
reachable from the configured advertiser token. Every identifier is withheld,
but API access does not by itself confer the right to publish derived figures.
`post.md` sets out the three options and the recommendation. Nothing else in the
bundle depends on it.

## Contents

- `card-advertiser.html` / `.png` — the launch card (1080×1080 source, 2160×2160
  capture). Brand fonts local, mark inlined, no external fetches.
- `card.html` / `.png` — the publisher-side variant, held for a later week.
- `post.md` — three brand-side LinkedIn posts, first comments, proposed slots,
  the claims table, what is deliberately not claimed, and the permission call.
- The skill at `skills/dormant-programme-sweep/`, with a worked example per side.
- Three redirect pages under `site/go/`.

## Both sides of one feature

The gap between partnerships on the books and partnerships producing anything
opens on both sides of the market, for the same reason: adding is free and
nothing ever subtracts.

- **Publisher side** — joined programmes against what earned. Proof: a live Awin
  publisher account, 2,415 joined across 73 sectors, zero earning in 12 months.
- **Advertiser side** — the publisher roster against what produced. Proof: a
  live Awin advertiser programme, 524 on the roster, 50 producing, one publisher
  holding 39.8% of commission.

The brand side leads the launch. A publisher pruning their own joined list is
tidying; a brand finding that 90% of recruited partners produced nothing in a
year is a budget conversation and a concentration risk.

## What the sweep deliberately does not claim

It reports **production**, not **relationship**. Awin's advertiser API exposes
no relationship-status field, so "produced no sale in the window" cannot be
upgraded to "dormant partner" — the publisher may be active and quiet, lapsed,
or never activated. `partner-roster-audit` remains the skill that reads
relationship status, and it reads it from the operator's browser session
precisely because the API cannot supply it. This skill does not contradict that
record; it answers the weaker question the API *can* answer.

The sweep also found **8 publishers producing while absent from the roster
endpoint**, so the roster is reported as a lower bound and that group gets its
own line in every output, including when it is zero.

## Free-first gating

Nothing sits behind payment. The sweep reads the operator's own roster and
transactions through their own keys, and the card renders in chat. The paid pull
stays scale and unattended operation — a scheduled sweep that emails the delta —
per `docs/decisions/2026-07-18-hosted-freemium-metered-tier.md`.

## Scope and risk

Routine and decision-complete. One new user-facing skill covering both sides,
two worked examples, test registration, the launch bundle, and three static
redirects. No adapter, tool, contract, or runtime change: the skill composes
`list_programmes`, `get_earnings_summary`, `list_media_partners`, and
`list_transactions`, all already shipped. No new tool surface. Not the
cross-tenant benchmark work waiting on #403 — this is single-tenant throughout.

## Proof

- `npx vitest run` — full suite green.
- `npx tsc -p tsconfig.dev.json --noEmit` — clean.
- `npx eslint src scripts tests` — 0 errors.
- `npm run check:change -- --base origin/main` — passed.
- Both cards captured with Playwright; `.frame` bounding box logged at exactly
  1080×1080, PNGs written at 2160×2160, attribution inside the frame.

## How to re-render a card

```bash
node -e "const{chromium}=require('playwright');(async()=>{const d=process.cwd()+'/docs/product/launches/week-09-dormant-programme-sweep';const b=await chromium.launch();const p=await b.newPage({viewport:{width:1080,height:1080},deviceScaleFactor:2});await p.goto('file://'+d+'/card-advertiser.html');await p.waitForTimeout(900);console.log(await p.locator('.frame').boundingBox());await p.locator('.frame').screenshot({path:d+'/card-advertiser.png'});await b.close()})()"
```

## Waiting on Rob

- The permission call on the third-party figures, above.
- Review, then a go/no-go on publishing. Nothing is scheduled.
- Merge only if Rob asks for it.
