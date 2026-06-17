# affiliate-mcp — Design System

> Status: historical design brief. The implemented design-system source of
> truth is [`../../../design-system/README.md`](../../../design-system/README.md).
> Use this document for the original brand rationale, not component or token
> implementation details.

> **Tear up the dashboard.** A 2026 punk-rock brand system for an open-source,
> AI-native affiliate data tool. Built for stop-motion video, LinkedIn, docs,
> the CLI, and the open-source landing page.

This folder is a **design system**: brand voice, type, color, motifs, reusable
CSS, a brand mark, and high-fidelity HTML/JSX UI kits. Point a design agent (or
a human) at it to produce on-brand artifacts for **affiliate-mcp**.

---

## Sources

This system was built from the product's own source of truth — the open-source
repository. There is **no pre-existing visual brand** in the product (it's a
command-line / MCP tool whose only rendered artifact is a plain system-font
report table), so this brand identity was **created fresh** from the product's
ethos and voice.

- **GitHub:** https://github.com/bobberrisford/affiliatemcp
  - `README.md` — install flows, audiences, the network table, voice.
  - `docs/product/manifesto.md` — *Manifesto: AI-native affiliate data*. The
    soul of the brand.
  - `docs/product/ai-native-affiliate-data.md` — product principle & roadmap.
  - `package.json` — npm package `affiliate-networks-mcp`, MIT, v0.5.0.
  - `skills/`, `docs/networks/` — the workflow patterns and the dual
    publisher / advertiser story.

> Explore the repo further to build deeper or more accurate work — the docs are
> unusually rich on voice and product intent.

---

## What is affiliate-mcp?

**affiliate-mcp** (npm: `affiliate-networks-mcp`) is a free, **MIT-licensed,
open-source** Model Context Protocol server. It lets people **chat with their
own affiliate-network data** inside the AI workspace they already use — Claude,
Codex, and compatible local MCP clients. ChatGPT support is planned separately.

> *"What did I earn across all networks last month?"*
> *"Show me revenue across all my clients this week."*
> *"Any anomalies in the affiliate data?"*

The AI figures out which networks to call, fetches the data **live** from their
APIs, and answers — then turns it into a sheet, an email, a brief, whatever.

### The ethos (this is the brand)

- **Local-first. Bring your own keys.** Credentials live in
  `~/.affiliate-mcp/.env` on *your* machine, mode `0600`. No hosted account.
- **Privacy-first opt-in telemetry.** Runtime telemetry is off by default,
  aggregate-only, and never includes affiliate data, credentials, prompts,
  arguments, results, or error text. The networks see the same calls their own
  dashboard would make.
- **Anti-dashboard.** "Your dashboards can't keep up with how fast you can
  think." One conversation spans every network and brand.
- **Honest.** Adapters declare exactly what's supported, partial, experimental,
  or gated. No fake support, no empty arrays pretending to be data.
- **Free & open.** MIT. Community- and agent-friendly. Networks are invited to
  adopt their own adapter.

### Two audiences (always design for both)

| Side | Who | What they ask |
|---|---|---|
| **Publisher** | Creators / publishers earning commissions | *"What did I earn last month?"* · *"Audit the affiliate links in my sitemap."* |
| **Brand / Advertiser** | Brands & agencies running programmes | *"How is Acme performing this quarter?"* · *"Revenue across all my clients this week."* |

### Networks (real, from the repo)

Awin · CJ Affiliate · eBay Partner Network · Impact · Rakuten Advertising ·
Skimlinks · Partnerize · Tradedoubler · Sovrn Commerce · Everflow · mrge.
Awin, CJ and Impact ship **both** publisher and advertiser-side adapters.
Use these real names — never invent networks.

---

## CONTENT FUNDAMENTALS

How affiliate-mcp talks. Match this exactly when writing copy.

**Voice in three words:** direct, honest, anti-establishment. It's a builder who
shipped the thing they wanted and gave it away. Confident, a little dry, never
corporate, never hypey.

- **Person.** Speaks to *you* ("you can ask…", "your data, your machine").
  First person singular for the origin story only ("none of the networks had
  shipped one, so **I** built one"). Never "we, the team" marketing-speak.
- **Casing.** Brand name and product nouns are **lowercase**: `affiliate-mcp`,
  `affiliate-networks-mcp`. Headlines in the brand run **lowercase** for punk
  flatness. Body sentences use normal sentence case. Commands and code are
  verbatim monospace.
- **Spelling: UK English, always.** "programme" (not program), "optimise",
  "licence" (the file is `LICENCE`), "behaviour". This is a hard rule from the
  manifesto.
- **Honesty as a feature.** Say what doesn't work. "Supported ops 6/7 just means
  the network itself doesn't expose that data." "experimental until exercised
  against real accounts." Status words are part of the vocabulary:
  `partial`, `experimental`, `gated`, `read-only`, `verified`.
- **Plain English over jargon.** "You do **not** need to know what an API is."
  Workflows, not endpoint trivia. Explain, don't posture.
- **Concrete > abstract.** Always reach for the real example query, the real
  network name, the real file path (`~/.affiliate-mcp/.env`), the real command
  (`npx affiliate-networks-mcp setup`).
- **No emoji.** The repo uses none in prose. Don't add them. Personality comes
  from typography, color and motifs — not emoji.
- **Punk headline voice (brand layer, on top of the repo's plain voice).** Short,
  blunt, imperative, a bit confrontational. The product copy is calm and honest;
  the *marketing* layer is loud. Examples written in-brand:
  - "tear up the dashboard."
  - "your data. your machine. your terms."
  - "affiliate data, jailbroken."
  - "one question. every network. every brand."
  - "no hosted account. opt-in telemetry. no asking permission."
  - "free. open. yours."

**Numbers & data.** When showing affiliate data, keep it real and specific:
currencies with symbols, statuses spelled out (pending / approved / paid /
reversed), "unpaid >90 days" style flags. Never fabricate precise stats as
decoration — every number should mean something (see the no-data-slop rule).

---

## VISUAL FOUNDATIONS

The look: **2026 punk rock** — gig-poster / zine / risograph energy crossed with
the crisp monospace of a terminal. DIY, high-contrast, a little defiant. It is
the visual opposite of a glossy SaaS dashboard, which is exactly the point.

### Color
- **Ink** `#0B0B0C` and **White** `#FFFFFF` are the constant. Most surfaces are
  one on the other — pure, high-contrast, no off-white. Panels use a faint cool
  gray `#F2F3F7`.
- **Riso Blue** `#2B2BFF` is the **primary** accent and the heart of the brand —
  highlighter swipes, the wordmark tab, the mark, buttons, links, "paid/up". It
  is dark, so it always carries **white** text. Use it like spray paint: small
  area, maximum voltage.
- **Hot pink** `#FF2E88` is the **secondary** accent — alerts, "down" / reversed,
  the counter-shout (white text). **Riso bright** `#5A78FF` is the on-dark
  variant for glyphs, prompts and code that must stay legible on ink.
- **No green, ever.** Status "up/paid" reads as riso blue, "down" as pink,
  "pending" as amber `#E8A317`.
- Two accents per composition, max. The accents are flat, full-strength,
  deliberate — never gradients.
- Imagery vibe: high-contrast, slightly blown-out, **photocopied** — black-and-
  white with one spot of riso blue (or pink) stamped on top, bold halftone dots,
  grain. Cool-neutral, never warm-glossy.

### Type
- **Display — Bricolage Grotesque (700/800), lowercase.** Loud, characterful,
  modern grotesque. Headlines and posters. Tight tracking (-0.02 to -0.03em).
- **Body/UI — Space Grotesk (400/500/700).** Clean workhorse grotesque.
- **Mono — JetBrains Mono (400/700).** The connective tissue: commands, code,
  data tables, and **uppercase wide-tracked labels** (`NO TELEMETRY`,
  `MIT LICENCE`, `v0.5.0`). The terminal *is* the product, so mono is core, not
  decoration.
- All three are **open-source Google Fonts** — deliberately, to match the
  project's free-and-open ethos. Loaded via Google Fonts CDN in
  `colors_and_type.css`. ⚠️ **If you want self-hosted/offline fonts or have
  licensed alternatives, send them and I'll swap them in.**

### Shape, depth & borders
- **Hard corners.** Radii are mostly `0–6px`. Sharp = punk. Pills only for tags.
- **Solid offset shadows, no blur** (`4px 4px 0 #0B0B0C`) — neo-brutalist,
  sticker-on-a-wall depth. No soft drop shadows, no glassmorphism.
- **Heavy ink rules** (2–4px) and **dashed "cut-out" borders** for the zine feel.
- Cards = paper, 2px ink border, hard offset shadow. Not rounded-and-floaty.

### Texture & motif
- **Halftone dot fields** and fine **grain** overlays (pure CSS, in the
  foundations file) give the photocopy texture. Use at low opacity.
- **Stickers / stamps / chips:** mono labels in ink or riso-blue blocks, occasionally
  rotated a few degrees (`.stamp`, `.chip`) like a rubber stamp or a sticker
  slapped on.
- **Highlighter swipes** (`.hl`) behind key words — riso blue with white text, like a marker.
- **Redaction bars** (`.redact`) — black bars, nodding to "your data stays
  private / telemetry is opt-in".
- **Terminal blocks** everywhere: prompt `>`, block cursor `▮`, command lines.
  The brand mark itself is a prompt.

### Motion (for stop-motion & video)
- **Snappy, mechanical, a little janky** — in the spirit of stop-motion. Hard
  cuts, quick pops, slight rotations, elements that "stamp" or "slap" into
  place rather than easing softly.
- Easing: prefer `steps()` and fast `cubic-bezier(.2,.8,.2,1)` pops over slow
  fades. Things can overshoot slightly (bounce/stamp), then settle.
- Highlighter swipes wipe in left-to-right. Stamps rotate-and-scale in.
- Avoid: long elegant fades, infinite ambient gradients, parallax drift. Energy
  over polish.

### Hover / press states
- **Hover:** the riso-blue underline/highlight fills up; offset shadow can grow
  (`6px 6px`) or the element nudges toward its shadow. Borders thicken.
- **Press:** element shifts *into* its shadow (translate `2px,2px`, shadow to
  `2px 2px`) — a physical "stamp down". Optionally invert ink↔paper.
- No opacity-only hovers; punk states are physical and chunky.

### Layout
- Strong grids, but break them on purpose — rotate a sticker, let a headline run
  oversized to the edge, overlap a stamp. Generous ink/paper negative space, then
  one loud focal element.
- Fixed, blunt headers (mono nav). Footers carry the "free · open · MIT" stamps.

---

## ICONOGRAPHY

The product ships **no icon set** (it's a CLI). So the system selects one:

- **Lucide** (https://lucide.dev) — crisp, consistent 2px-stroke monoline icons,
  MIT-licensed, CDN-available. The clean monoline contrasts nicely with the raw
  punk textures and reads well at small sizes in LinkedIn/video. ⚠️ **This is a
  selected substitute, not from the product** — flag for review; happy to swap
  for Phosphor, Heroicons, or a hand-roughened set if you prefer more grit.
  - Load: `<script src="https://unpkg.com/lucide@latest"></script>` then
    `lucide.createIcons()`, or use individual SVGs.
  - Use ink or, sparingly, riso blue. Keep stroke at 2px to match the rule weight.
- **The brand mark IS an icon system of one:** the terminal prompt `>▮`
  (`assets/mark.svg`, `assets/mark-glyph.svg`). Use it as favicon, app glyph,
  bullet, and loading cursor.
- **Mono glyphs as icons:** `>`, `$`, `▮`, `//`, `[ ]`, `✶`, arrows `↑↓→`.
  Drawn from JetBrains Mono, these double as punk iconography for terminal,
  money, cut, and trend-up/down.
- **No emoji.** Ever. Status uses color + word (`● pending`, `● paid`) not emoji.
- **Network logos:** the real networks (Awin, CJ, Impact…) have their own marks.
  This system represents them as **mono wordmark chips** (`.chip`) — name in
  JetBrains Mono on an ink tile — to stay brand-consistent and avoid shipping
  third-party trademarks. Swap in official logos only with permission.

---

## INDEX — what's in this folder

> Manifest of the root + where to find things. (Updated as the system grows.)

**Foundations**
- `colors_and_type.css` — all color + type + motif CSS variables and utility
  classes. Import this first in any artifact.
- `assets/mark.svg` — brand mark (white prompt on a riso-blue tile).
- `assets/mark-glyph.svg` — mark in `currentColor` (mono, any background).
- `assets/` — favicon and any added brand assets.

**Preview cards** (`preview/`) — small specimen cards that populate the Design
System tab: palette, type, spacing/shadow, components, logo.

**UI kits** (`ui_kits/`)
- `landing/` — the open-source project landing page (hero, network wall, install
  / terminal block, dual-audience, footer).
- `terminal/` — the CLI experience: setup wizard, `test`, `doctor`, and the
  "chat with your data" answer.
- `social/` — LinkedIn & stop-motion templates (square + portrait + 16:9 frames:
  quote card, stat card, command card, before/after, network grid).

**Skill**
- `SKILL.md` — makes this folder usable as a downloadable Agent Skill.

---

*MIT, like the product. Built from the open-source repo. Free · open · yours.*
