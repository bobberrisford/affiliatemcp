# Website plan: onboarding non-technical users & communicating the mission

> Status: historical implementation plan. The static site now exists under
> [`site/`](../../site); use this document for original goals and rationale,
> not as a statement of current repository state.

## 1. Why a website

The README is excellent for people who already live on GitHub. It is the wrong
front door for the audience we most want to reach.

A publisher earning commissions, or a brand/agency running programmes, is not
going to read a 700-line README full of `npx` commands, JSON config snippets,
and a 70-row network table. They bounce. We lose exactly the person the
[manifesto](./manifesto.md) says this project is for: people who **"do not need
to understand the internals"** and who **"do not need to know what an API is."**

The website's job is to convert that person from *"what is this?"* to
*"this is for me, and I can do it"* — and to state the mission plainly enough
that a non-technical reader, a network operator, and a journalist all walk away
able to repeat it.

### Primary audience (lead with this)

**Non-technical publishers and brands/agencies.** They feel the pain
(dashboards everywhere, copy-paste into spreadsheets, leaving the AI chat to go
pull a CSV) but they are intimidated by terminals. The whole site is tuned so
this person reaches "I'm set up and asking my first question" with the least
possible fear.

### Secondary audiences (clear, separate paths — not the main flow)

- **Network operators** who should adopt and own their adapter.
- **Developers / contributors** who add adapters, skills, and fixes.

These get prominent but distinct entry points so they never dilute the
non-technical homepage.

## 2. Goals & success measures

| Goal | What it looks like | Signal we'd watch |
| --- | --- | --- |
| Communicate the mission in one screen | A visitor can paraphrase "chat with your affiliate data where you already work, your keys stay local" after the hero | Time on page, scroll depth past hero |
| De-risk the non-technical user | The word "terminal" never appears before the visitor has decided they want in | Click-through to "Get started" |
| Onboard without fear | A guided, copy-one-line-at-a-time setup page with screenshots and "what you'll see" | Reaches step 3 (connect to Claude) |
| Earn trust | Privacy ("your data, your machine"), MIT, open source, opt-in telemetry stated up front | Outbound clicks to GitHub / PRIVACY |
| Route the other audiences | Networks and developers each find their path within one click | Clicks to /networks/adopt and /contribute |

Non-goals: this is **not** a SaaS signup, not a dashboard, not a docs
replacement. There is no account to create. The "product" is open-source
software the user runs locally. The site sends people to npm / GitHub / the
setup wizard — it never asks for credentials.

## 3. Positioning & messaging (the words)

Pulled and simplified from the README and manifesto so the whole site speaks
with one voice. UK English throughout ("programme"), per manifesto principle 8.

- **One-liner (hero):** *"Chat with your affiliate data — in the AI you already
  use."*
- **Sub-line:** *"Ask one question and get answers across every network and
  every brand. Your logins stay on your machine. Free and open source."*
- **The problem (one sentence):** *"Your affiliate data is scattered across
  network dashboards, exports, and spreadsheets — and none of it is where you
  actually do your thinking."*
- **The promise:** *"Bring the data into Claude or Codex today. Ask in plain
  English. No filters, no CSV exports, no code. ChatGPT support is planned
  separately."*
- **The trust line (repeated):** *"Bring your own keys. Runs locally. No hosted
  account. Optional telemetry is opt-in and aggregate-only."*
- **Reassurance for the nervous:** *"You do not need to know what an API is. You
  do not need to write code. If you can copy and paste one line, you can do
  this."*

Tone: confident, plain, honest. Mirror the manifesto's "honest network truth"
principle — never imply something works that doesn't. Avoid jargon
(MCP, stdio, adapter) above the fold; introduce it only where a curious reader
opts in.

## 4. Information architecture (sitemap)

```
/                      Home (mission + the two audiences + proof + CTA)
/get-started          Guided, non-technical onboarding (the core page)
/what-you-can-ask     Example prompts, publisher vs brand, by outcome
/networks             Searchable network list (from the README table)
/networks/adopt       For affiliate networks: adopt & own your adapter
/privacy              Plain-English "your data, your machine" (links PRIVACY.md)
/mission              The manifesto, retold for a general reader
/contribute           For developers: how to add adapters/skills (-> CONTRIBUTING)
/faq                  Objections: cost, safety, which AI, which networks, etc.
```

Global nav (kept tiny): **Get started · What you can ask · Networks · Mission**.
Plus a low-key footer row for the secondary audiences: *For networks · For
developers · Privacy · GitHub*.

Primary CTA everywhere: **"Get started"** → `/get-started`.
Secondary CTA: **"See what you can ask"** → `/what-you-can-ask`.

## 5. Page-by-page content plan

### `/` Home
1. **Hero** — one-liner + sub-line + two buttons (Get started / What you can
   ask). Background visual: a stylised chat bubble asking *"What did I earn
   across all networks last month?"* with an answer forming. No terminal imagery.
2. **The shift in one line** — the problem sentence, then the promise sentence.
3. **Pick your side** — two cards, mirroring the README's dual audience:
   - *You earn commissions (publisher)* → 3 example questions.
   - *You run programmes (brand / agency)* → 3 example questions.
   Each card → `/what-you-can-ask` anchored to that side.
4. **How it works, in 3 plain steps** — (1) Run a short setup, (2) it checks
   your logins, (3) ask questions in Claude/Codex. Each step one
   sentence, illustrated. Link to `/get-started`.
5. **Why people trust it** — four short proof tiles: *Your data, your machine* ·
   *Free & MIT open source* · *Opt-in telemetry* · *80+ adapters, both sides*.
   (Numbers sourced from the README badges — see §8 on keeping them fresh.)
6. **Catches what dashboards bury** — the README's strongest differentiator:
   stale transactions, dead links, reversal spikes, week-on-week drops.
7. **Mission teaser** — two lines from the manifesto + link to `/mission`.
8. **Footer CTA + the secondary-audience links.**

### `/get-started` (the most important page)
The non-technical onboarding spine. Design rules:
- **No terminal vocabulary until the visitor is committed.** Frame it as "a
  short setup you run once," then show exactly what to open
  (Terminal on Mac, PowerShell on Windows) *with a screenshot of each*.
- **Prerequisites stated honestly and minimally** (from README): Node.js 20+
  (with the download link), your existing network logins, ~5 minutes, and
  Claude Desktop / Claude Code / Codex installed.
- **One command at a time**, each in a copy-button block, each followed by a
  *"What you should see"* screenshot/description:
  1. `npx affiliate-networks-mcp setup` — the wizard, one network at a time.
  2. `npx affiliate-networks-mcp test` — the `ok` / `error` health lines.
  3. Connect to your AI — tabbed by client (Claude Desktop / Claude Code /
     Codex / Cowork), each tab the minimal path from the README.
- **"Stuck?" box** mapping the README's troubleshooting items to plain symptoms
  ("It returns nothing when I ask" → credentials missing → run setup again).
- **Reassurance footer:** what the tool can and can't touch, link to `/privacy`.

> Open question for design: whether to embed a 60–90s screen-recording of the
> wizard. Strongly recommended for the non-technical audience; flagged as a
> phase-2 asset so it doesn't block launch.

### `/what-you-can-ask`
Two clearly separated sections (Publisher / Brand) built directly from the
README's "What you can ask" list, each prompt shown as a chat bubble with a
one-line description of what comes back. Group by outcome: *Earnings*, *Health*,
*Setup help*, *Link audits* (publisher); *Single brand*, *Portfolio*,
*Anomalies* (brand). Reinforces value without any setup pressure.

### `/networks`
A searchable/filterable rendering of the README network table. Columns:
network, side (publisher/advertiser), setup time, approval required, supported
ops, notes, and claim status. Counts must come from generated metadata, not
hand-typed copy. Filter by side and "no approval needed." **Must reproduce the
honesty of the table** — show `experimental` status and the adoption caveat
prominently, per manifesto principles 5 & 6 ("honest network truth", "no fake
support"). Each row can link to its `docs/networks/<name>.md`.

### `/networks/adopt`
For network operators. Short, credible, action-oriented: why adopt (correctness,
ownership, your team knows the API best — from the manifesto), what adoption
means, and a direct link to the `adopt-a-network` GitHub issues label and
`CONTRIBUTING.md` "Adopting your network" section.

### `/privacy`
Plain-English retelling of `PRIVACY.md` and the manifesto's "what this project
will not do" list: keys live in `~/.affiliate-mcp/.env` on your machine, no
hosted account, optional aggregate-only telemetry is off by default, networks
see the same calls as your dashboard.
This page is a conversion tool, not legal boilerplate — link to the full
`PRIVACY.md` for completeness.

### `/mission`
The manifesto retold for a general reader: the problem, the mission ("make
affiliate network data available where affiliate work happens"), API-first /
browser-as-fallback, local-first, honest network truth. Link to the full
`docs/product/manifesto.md` for the canonical version.

### `/contribute`
Developer entry point. Brief, then hand off to `CONTRIBUTING.md`, `AGENTS.md`,
and the `contribute` skill. Mention the agent-friendly contribution model.

### `/faq`
Objection-handling for the non-technical visitor: *Is it free?* (yes, MIT) ·
*Is it safe / will it change my data?* (read-first, your keys, local) ·
*Which AI do I need?* · *Which networks?* · *Do I need to code?* (no) ·
*What if my network isn't listed / is experimental?* · *Who built this?*

## 6. Tech & hosting recommendation

**Recommendation: Astro + Tailwind, deployed to GitHub Pages via Actions.**

Rationale:
- **Astro** is built for content/marketing sites: ships zero JS by default (fast,
  good for non-technical users on any device), supports Markdown/MDX so we can
  pull copy straight from existing repo docs, and has a gentle component model.
- **Content reuse:** the network table and parts of the manifesto/README can be
  sourced from the repo so the site doesn't drift from the source of truth (see
  §8). Astro content collections fit this well.
- **GitHub Pages + Actions:** zero hosting cost, lives beside the code, one more
  workflow next to the existing `ci.yml` / `publish.yml`. Custom domain optional.
- **No backend needed** — there is no signup and the website itself does not
  collect affiliate data. A static site keeps the privacy story clean and
  honest.

Alternatives considered:
- **Plain HTML + Tailwind** — lowest dependency, fine for a one-pager, but
  awkward once we have 9 pages and want to reuse repo content.
- **Docusaurus / VitePress** — great for docs, but docs-shaped, not
  marketing/onboarding-shaped; would fight us on the hero/landing experience.
- **Next.js static export** — capable but heavier than needed for a no-backend
  marketing site.

Proposed location: a `website/` (or `site/`) directory in this repo, or a
dedicated `gh-pages` deploy. Decide at build kickoff; co-locating in `website/`
keeps content-sync simplest.

> Decision needed before build: custom domain (e.g. a project domain) vs.
> `bobberrisford.github.io/affiliatemcp`. Affects base path config and the npm
> `homepage` field.

## 7. Design & accessibility notes

- **Mobile-first**, fast, no heavy frameworks — the non-technical user may be on
  a phone reading about it before sitting down to install.
- **Show, don't tell:** chat-bubble mockups of real prompts beat feature lists.
  Screenshots of the wizard output on `/get-started`.
- **Accessibility:** semantic headings, alt text on every screenshot, copy
  buttons keyboard-reachable, AA contrast. Important because the audience skews
  non-technical and varied.
- **UK English** everywhere (manifesto principle 8).
- **Honesty in the UI:** experimental/community-built status must be visible, not
  buried — the design must not over-promise.

## 8. Keeping the site honest & in sync (important)

The README already auto-generates its network table (note the
`<!-- AFFILIATE_MCP_NETWORK_TABLE_START -->` marker) and carries version/network
count badges. The site must not hand-copy these or it will rot and start lying —
which directly violates the "honest network truth" principle.

Plan: a small build step (script under `scripts/`, run in the Pages workflow)
that sources the network list and counts from the same data the README uses, so
`/networks` and the homepage proof tiles are always current. Treat this as part
of the build, not a manual update.

## 9. Phased delivery

**Phase 0 — content & sign-off (no code).** Finalise copy in this doc's voice,
confirm audience priority (done: non-technical lead), pick hosting/domain. Get
the mission one-liner approved — it anchors everything.

**Phase 1 — MVP launch (highest value).**
- `/` Home, `/get-started`, `/what-you-can-ask`.
- Astro + Tailwind scaffold, GitHub Pages workflow.
- Static screenshots of the setup wizard.
- Network table sync script.
This alone delivers the core goal: a non-technical front door with a guided
onboarding path.

**Phase 2 — depth & the other audiences.**
- `/networks` (searchable), `/networks/adopt`, `/mission`, `/privacy`,
  `/contribute`, `/faq`.
- Optional: embedded setup screen-recording.

**Phase 3 — polish & growth.**
- Custom domain + meta/OG tags for sharing.
- Light analytics *only if* privacy-respecting and consistent with the
  no-telemetry stance (or skip entirely).
- Per-network landing pages generated from `docs/networks/*` for SEO ("connect
  Awin to Claude", etc.).

## 10. Open questions / decisions for the owner

1. **Hosting & domain:** GitHub Pages subpath vs. custom domain?
2. **Repo location:** `website/` in this repo (easiest content sync) vs. separate
   repo?
3. **Branding:** is there a name/logo/colour for the project beyond
   "affiliate-mcp", or should the site define a light visual identity?
4. **Screen-recording:** in scope for Phase 1, or Phase 2?
5. **Mission one-liner:** approve the proposed hero copy in §3, or iterate?

## 11. Source material this plan draws on

- `docs/product/manifesto.md` — mission, principles, audiences, "will not do".
- `README.md` — dual-audience framing, getting-started commands, "what you can
  ask", network table, privacy/trust lines.
- `docs/product/ai-native-affiliate-data.md` — product principle, roadmap.
- `PRIVACY.md` — for the `/privacy` page.
- `CONTRIBUTING.md` / `AGENTS.md` / `contribute` skill — for `/contribute` and
  `/networks/adopt`.
