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

## Deployment plan

Three surfaces ship on different mechanisms, and only one is automatic. The
posts should not run ahead of the release, or the first-comment link lands on a
version that does not contain the skill.

### Stage 1 — merge this PR

On merge to `main`:

- **`site/go/*.html` deploy automatically** via GitHub Pages. No version gate,
  no action. This is the only automatic surface here.
- **npm does not publish.** `.github/workflows/publish.yml` runs on push to
  `main` but is version-gated: it queries npm for the current
  `package.json` version and skips when that version already exists. `main` is
  on **0.20.0**, which is already published, so merging this PR ships nothing to
  npm users.

### Stage 2 — the release PR (this is what actually deploys the skill)

A separate, small PR bumping **0.20.0 → 0.21.0**. Per `RELEASING.md` there are
**seven** version touch-points, and missing any one fails CI:

1. `package.json`
2. `.claude-plugin/plugin.json` (must equal `package.json`)
3. `package-lock.json` root `version`
4. `package-lock.json` `packages[""].version` — both lockfile fields are
   rewritten by re-running `npm install` after bumping `package.json`
5. `src/shared/telemetry.ts` `PACKAGE_VERSION`
6. `server.json` top-level `version` (MCP Registry listing)
7. `server.json` `packages[0].version`

Plus one thing that is easy to miss: because `PACKAGE_VERSION` lives under
`src/shared/`, the `check:change` guardrail blocks the diff unless it also
touches a test under `tests/shared/` or `tests/integration/`. Bump it alongside
a real edit to `tests/shared/telemetry.test.ts`, keeping the version-sync
assertions meaningful.

Leave `desktop/package.json` alone — the desktop app ships on its own
`desktop-v*` stream.

On merge, `publish.yml` runs typecheck, lint, the full test suite, `build`,
`build:mcpb`, `npm publish`, then creates the `v0.21.0` GitHub release and
attaches both the versioned and stable-named `.mcpb`.

### Stage 3 — verify the artifact, not the working tree

`RELEASING.md` is explicit that the tests read `skills/` off disk, so a green
suite does not prove the published tarball contains the skill. After publish:

```bash
npm view affiliate-networks-mcp@0.21.0 version
npm pack affiliate-networks-mcp@0.21.0 --dry-run 2>&1 | grep dormant-programme-sweep
curl -sSI https://agenticaffiliate.ai/go/publisher-sweep | head -1
curl -sSI https://agenticaffiliate.ai/go/off-roster | head -1
curl -sSI https://agenticaffiliate.ai/go/two-numbers | head -1
```

The `npm pack` line is the one that matters: it proves a user installing 0.21.0
actually receives `skills/dormant-programme-sweep/`.

### Who gets the skill, and who does not

- **npm, the Claude plugin, the `.mcpb` desktop bundle** — yes, from 0.21.0.
- **The hosted connector — no.** `src/prompts/generate.ts` is a hand-maintained
  prompt list, independent of `skills/`; the hosted transport serves tools and
  prompts, not skills. A hosted user can still ask "how many of our publishers
  actually sell anything?" and Claude will reach for
  `list_media_partners` and `list_transactions` directly, so the posts' CTA is
  not broken — but they get the tools, not the skill's guardrails. Closing that
  gap (a prompt mirroring the sweep) is a public-surface change and belongs in
  its own PR, not this one.
- **The MCP Registry listing** is republished manually until the
  `MCP_REGISTRY_KEY` secret exists.

## Waiting on Rob

- Review, then merge this PR (stage 1) if he wants it.
- Authorise the release PR (stage 2). Nothing reaches users without it.
- Queue the posts. Nothing is scheduled: no campaign is named for week 9, so
  campaign mode leaves the default in force.

The permission question on the third-party figures is **settled** — Rob's call,
2026-08-11: publishable as long as the advertiser is not named. Every
identifier is withheld from the card, the posts, and the worked example, and a
`git grep` over the branch confirms no brand name or account ID appears
anywhere.
