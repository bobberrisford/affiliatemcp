# affiliate-mcp — demo videos

A [Remotion](https://www.remotion.dev/) project that renders product videos for
`affiliate-mcp`. It uses the repo's own design-system tokens and fonts
(`design-system/colors_and_type.css`, `design-system/fonts/`), so the videos
stay on-brand with the site and launch cards.

Two compositions are registered:

- **`DemoVideo`** (~70s) — the full product overview, both the free local
  server and the hosted tier.
- **`HostedVideo`** (~60s, narrated) — a standalone video for the hosted
  product alone: the no-install, non-technical path, the commercial story, and
  the custody contract. It is voiceover-driven and captioned, with one idea per
  scene. Scenes live under `src/scenes/hosted/` and it reuses the shared
  `Pricing` scene.

## Voiceover and captions (HostedVideo)

`HostedVideo` is paced by its narration. The script is `src/vo/lines.json`
(one entry per scene, with separate `caption` and TTS `speak` text). Running
the generator synthesises one audio clip per scene into `public/vo/` and writes
`src/vo/manifest.json`; the composition reads that manifest to size each scene,
so pacing always matches the voice, and burns the `caption` text in as a
lower-third subtitle.

```bash
npm run vo        # regenerate the narration + manifest, then re-render
npm run render:hosted -- --browser-executable=<chrome>
```

The default voice is **espeak-ng** (offline, installed via
`apt-get install -y espeak-ng`). It is a synthetic placeholder and sounds like
one. **To use a premium voice** (e.g. ElevenLabs, or Azure/Piper on a machine
with open network), drop a same-named file per scene into `public/vo/` —
`public/vo/title.mp3`, `public/vo/why.mp3`, and so on — then run `npm run vo`.
The generator prefers an existing `.mp3` over regenerating the `.wav` and
re-measures durations, so the timing and captions stay in sync automatically.
The scene-by-scene copy to hand a voice artist is exactly the `speak` fields in
`src/vo/lines.json`.

## `HostedVideo` — the hosted-only cut

Eight scenes: hosted title, who it's for (the non-technical cohort and the
install walls hosted removes), the five-step email-to-answers onboarding, a
live report through the connector (*"Show my unpaid commissions on Awin from
the last 30 days"* running on the hosted server), scheduled automation that
lands in your inbox with the laptop shut, the custody "honest bits" (keys
encrypted and never given to Claude, export/hard-delete, four networks live),
pricing (Free / Solo / Pro), and a "get hosted" CTA. Render it with
`remotion render HostedVideo out/affiliate-mcp-hosted.mp4` plus the same
`--browser-executable` flag as below.

## `DemoVideo` — the full overview

Twelve scenes, cut together with fades:

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
7. **Packaged skills** — the publisher- and brand-side conversation patterns.
8. **Local-first** — keys stay on your machine, read-only by default; the free
   local server does everything, for every network.
9. **Hosted** — the no-install, no-terminal path for people who can't
   self-host: email sign-in, encrypted dashboard, connector in Claude, reports
   on a schedule. Keys are encrypted and never handed to Claude; four networks
   (Awin, CJ, Impact, Rakuten) are live today.
10. **Pricing** — where the product is monetised: Free (£0, 3 reports/week),
    Solo (£34/mo), Pro (£99/mo). Paid tiers add automation and assurance, never
    access to your own data; local stays free and complete.
11. **Get started** — the two ways in: self-host (`npx affiliate-networks-mcp
    setup`) or hosted (email sign-in).
12. **Outro** — wordmark, licence, repo link.

Pricing, tiers, custody claims, and the four-networks-live limit mirror the
accepted decision records under `docs/decisions/` and the live
`site/hosted.html`. All figures, brand names (Acme, Northwind, …), and
transactions in the demo are illustrative placeholders — no real account data.

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
