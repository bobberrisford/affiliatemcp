# affiliate-mcp — demo video

A [Remotion](https://www.remotion.dev/) project that renders a ~65-second
product demo of `affiliate-mcp`. It uses the repo's own design-system tokens
and fonts (`design-system/colors_and_type.css`, `design-system/fonts/`), so the
video stays on-brand with the site and launch cards.

## What it shows

Ten scenes, cut together with fades:

1. **Title** — wordmark, tagline, the three promises (free & open source,
   local-first, bring your own keys).
2. **The problem** — affiliate networks have two sides (publishers, brands),
   and neither ships an AI-workspace integration.
3. **How it works** — one local MCP server between your chat and every network.
4. **The breadth** — 86 adapters across 72 network families.
5. **Publisher demo** — *"What did I earn across all my networks last month?"*
   fans out across networks, returns totals by network and by status, and flags
   transactions pending past 90 days.
6. **Brand / agency demo** — *"Any anomalies across my clients this week?"*
   surfaces revenue drops, reversal spikes, top-10 dropouts, and dead
   programmes.
7. **Local-first** — keys stay on your machine, read-only by default.
8. **Packaged skills** — the publisher- and brand-side conversation patterns.
9. **Get started** — `npx affiliate-networks-mcp setup`, and the clients it
   works with.
10. **Outro** — wordmark, licence, repo link.

All figures, brand names (Acme, Northwind, …), and transactions are
illustrative placeholders — no real account data.

## Develop

```bash
cd video
npm install
npm run dev          # opens Remotion Studio to preview/scrub
```

## Render

Remotion renders with headless Chrome. On a machine with a normal Chrome
install, `npm run render` is enough. In this repo's container the pre-installed
headless shell is passed explicitly:

```bash
npm run render -- \
  --browser-executable=/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell
```

Output lands at `video/out/affiliate-mcp-demo.mp4` (1920×1080, 30fps). The
`out/` directory is git-ignored.

## Editing content

- Copy, figures, and timings live in the scene files under `src/scenes/`.
- Per-scene durations and ordering are in `src/DemoVideo.tsx` (`SCENES`).
- Brand tokens are in `src/theme.ts`, mirrored from the design system.
- The network list is in `src/data.ts`.
