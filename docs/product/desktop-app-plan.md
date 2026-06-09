# affiliate-mcp Desktop — full plan, decisions, and roadmap (2026-06-07)

> **Superseded in part (2026-06-09):** the desktop app now ships **free and open
> source** — there is no licence, no Stripe issuer, and no activation gate. See
> [`../decisions/2026-06-09-desktop-app-free.md`](../decisions/2026-06-09-desktop-app-free.md).
> The paid-model sections below (§2A licence/Stripe, Phase 1b issuer, the £39
> pricing) are kept for historical context only and no longer reflect what ships.

> Status: planning. Builds on
> [`claude-desktop-app-scoping.md`](./claude-desktop-app-scoping.md).
> North star: **easy onboarding for non-technical users.**
> Hard constraint: **the open-source tool stays the core. Forever.**
>
> Mockups: [`./desktop-app-mockups/index.html`](./desktop-app-mockups/index.html)

This document covers three things the scoping doc didn't:

1. **The decisions we have to make now** — the one-way doors that shape
   everything downstream.
2. **The longer desktop roadmap** those decisions enable.
3. **How we keep open source at the core** while making it easy (and,
   later, optionally commercial).

---

## 1. Decisions we must make NOW (the one-way doors)

These are cheap to decide today and expensive-to-impossible to reverse
later. Every one is judged against the two constraints above.

### D1 — Framework: **Electron** ✅

The MCP server is Node. Electron ships the Node runtime, so "install
Node" — the biggest onboarding blocker — vanishes, and the existing
server runs unchanged. Tauri's smaller binary isn't worth a Rust↔Node
sidecar for v1. *Reversal cost: total rewrite. Decide now.*

### D2 — Repo & licence: **app lives in the open monorepo, MIT** ✅

This is **the** open-source decision. The desktop app is committed to
the same public repo as the CLI and adapters, under the same MIT
licence. The entire onboarding experience is open and auditable.

Why it's a one-way door: if you ship the app **closed**, you can never
credibly re-open it, and you've quietly contradicted *"no hosted
account, no telemetry, the maintainer never sees your data"* — because
nobody can verify a closed binary. Shipping it **open** means anyone can
read the code and confirm it phones home to nothing. For a brand whose
entire pitch is trust, the app must be as open as the server it wraps.

### D3 — The open-core boundary, drawn *before* there's anything to gate ✅

Decide the line now so you never retroactively close something that was
open (the single most trust-destroying move available to you):

- **Core (MIT, open, free, fully functional alone):** adapters, MCP
  server, CLI, **and the desktop app**. A user can do everything the
  product promises with zero paid anything.
- **Commercial (optional, additive, separate):** any future paid piece
  (e.g. hosted always-on monitoring) is a **remote service the open app
  can connect to** — never a feature switched off inside the open
  binary. The app must remain 100% useful with the commercial service
  absent.

The rule in one line: **we sell things that run on our infra, never
things that run on yours.** Local features are free forever.

> **Amendment (2026-06-07): one-off charge for the packaged app.** We
> charge a one-off "lifetime" fee for the *signed, prebuilt app*. The
> stack stays MIT (D2 unchanged) — we sell the convenience, not the
> code. **No trial: the app requires a valid licence to run.** We do not
> pursue legal protection; the buyer is the non-technical operator who
> won't use a terminal and can't/won't build from source. The D3 rule
> still bars a future "Pro local feature" — there is exactly one product,
> gated by licence. Full spec in §2A below.

### D4 — Telemetry: **none by default, forever** ✅

Zero analytics, zero crash reporting, zero usage tracking in the
shipped app. The *only* outbound call the app itself makes is an
anonymous version check against a static update feed (D5), and that is
disclosed in-app and in PRIVACY.md. No account, no identifiers. Adding
telemetry later is a one-way trust door — bake "no phone-home" into the
architecture now and state it on the welcome screen.

### D5 — Update channel: **GitHub Releases + `electron-updater`** ✅

Non-technical users won't `npm update`. Auto-update is required. The
update feed is **static file hosting** (GitHub Releases) — the only
server the app talks to, dumb by design, no account, no per-user state.
This keeps the "talks to nothing but the networks you configured (and a
version file)" story honest.

### D6 — Credential storage: **`~/.affiliate-mcp/.env` (0600) now;
keychain later; never cloud** ✅

Keep today's model for v1 (the server reads it, it's tested, PRIVACY.md
already describes it). Decide the *direction* now: storage is
**local-only, single-file, user-deletable**. OS keychain is a fine v2
hardening. Cloud sync is **off the table** — it's the hosting fork in
disguise and would break local-first.

### D7 — Distribution: **direct download + Homebrew Cask. NOT the Mac
App Store.** ✅

The Mac App Store sandbox would **block** the two things the app must
do: write `claude_desktop_config.json` (outside the sandbox) and let
Claude spawn a server process. So MAS is structurally incompatible with
the product. Ship a signed/notarised `.dmg` directly + a Homebrew Cask
(developer-friendly, on-brand). Windows: direct `.exe` + winget later.
Flag this early so nobody plans for an App Store launch.

### D8 — Network credential-help content is **open data in the repo** ✅

The long pole (per-network deep-link + screenshot + "where to find your
key") lives as **per-adapter metadata in the open repo**, contributed
the same way adapters are (see CONTRIBUTING). This turns the long pole
from "Rob screenshots 40 dashboards" into "the community and the
networks themselves fill it in" — and it scales onboarding quality
without a bottleneck.

### D9 — App ↔ server boundary: **separate processes** ✅

The app does not run the MCP server in-process. Claude spawns the server
over stdio (via the config entry) exactly as today. The app owns
onboarding, the config write, and tray status. Both share **one** copy
of the adapter core via the monorepo. Adapters stay the single source of
truth for CLI, app, and any future surface.

### D10 — Signing identity ✅ resolved

**An Apple Developer licence is in hand — mac signing/notarisation is
unblocked.** (Windows cert later, Phase 2.) One residual: if the licence
sits under a personal account and you'd want a project org owning it
long-term, migrate *before* launch — it's in the trust chain on every
machine and painful to change after.

---

## 2. The build plan (phased)

### Phase 0 — Foundations (the only refactor) · ~1 week
- `src/core/facade.ts`: a prompter-free programmatic API over the
  existing primitives (`listAdapters`, `setupSteps`, `validateField`,
  `verifyAuth`, `discoverBrands`, `writeEnv`, `connectClaudeDesktop`,
  `detectClients`). Almost all logic exists; this is a thin wrapper so
  the GUI never shells out.
- Make `AFFILIATE_ENTRY_VALUE` path-aware (bundled runtime, D9).
- Per-adapter help-content schema (D8) + populate the **launch four:
  Awin, Impact, Partnerize, CJ**.
- Apple Developer enrolment kicked off (D10) — it has lead time.
- Generate the **Ed25519 licence keypair** (§2A); embed the public key as
  a constant; private key into the issuer's secret store. Decide price.

### Phase 1 — mac MVP: paid setup app, OSS core · ~2–3 weeks
**Scope (v1): the app does one job — get a non-technical user set up
without a terminal, then quit.** No tray, no status monitoring, no
running supervisor. The MCP server still runs **locally** (Claude spawns
it); the app only configures it.
- Electron shell, bundled Node, signed + notarised (Apple licence in
  hand, D10).
- **Buy + licence gate as screen 0** (§2A): activate an existing key, or
  buy in-app (£39) → pay in browser → paste key. No valid licence → can't
  proceed. Offline verify only.
- Setup flow (see mockups): activate → welcome → network picker →
  per-network credential form with live verify → brand picker → connect
  to Claude → "restart Claude" → done, then **quit**.
- App name in the OS: **affiliate-mcp**.
- Ships as a `.dmg` on GitHub Releases. **This is the north-star
  release — stop here and learn.**
- The MCP server + CLI remain **free, local, and unlicensed** — the gate
  lives only in the app shell (§2A), so the open tool is untouched.
  Re-running setup later = relaunch the app (no tray for now; **may
  revisit**).

### Phase 1b — licence issuer (parallel to Phase 1) · ~4–5 days
- Stripe **Checkout Sessions** (in-app buy, £39) + Stripe Tax (§2A).
- One **Worker**: `POST /checkout` (create session → return URL),
  `POST /webhook` (verify Stripe sig → sign Ed25519 licence → KV → email
  + success page), `POST /resend` (email lookup).
- A one-field **"resend my licence"** page (+ optional `affiliate-mcp://`
  activate deep-link on the success page).
- Holds purchase records + the signing private key; **no affiliate data.**

### Phase 2 — reach & robustness · ~2–3 weeks
- `electron-updater` auto-update (D5).
- Windows build + signing.
- Homebrew Cask (D7).
- Credential help content for **all** networks (community-driven, D8).

### Phase 3 — deeper *local* value (still free, still OSS)
Everything here runs locally and reinforces the open core:
- A "your networks" health view (status, last-verified, unpaid >90 days
  flags) — the anti-dashboard, rendered.
- One-click local report export (CSV / the existing report).
- Link-audit surface for the audit skill.
- Scheduled runs **while the app is open** (no hosting — honest about
  the laptop constraint).

### Phase 4 — optional commercial layer (separate, additive)
Only if demand pulls it (see economics discussion). The hosted
always-on "watchtower" (scheduled monitoring + digests that run when the
laptop is off) as an **opt-in remote service** the open app connects to.
Funded custody, aimed at agencies/operators, never gating any local
feature. Out of scope until Phase 1–2 prove reach.

---

## 2A. Payments & licensing — spec

**Decided:** one-off **£39** "lifetime" fee for the signed prebuilt app,
**bought in-app**. Stack stays MIT (D2). **No trial — a valid licence is
required to run the app.**
No legal-protection effort. Buyer = non-technical operator who won't use
a terminal. Mockups:
[`./desktop-app-mockups/licence.html`](./desktop-app-mockups/licence.html).

### Gate placement
The licence is **screen 0** — first launch shows Activate *before*
onboarding. No licence, no app. Trade-off accepted: with no trial, the
buyer pays before seeing it run, so the **marketing site + a demo
video** carry the "show value" job a trial would otherwise do. That's a
content task, not an app task.

### Where the gate lives (and where it doesn't)
The gate is **only in the Electron app shell.** The MCP server and CLI
stay free, open, and unlicensed — anyone running `npx
affiliate-networks-mcp` is unaffected. We charge for the *app
convenience*, never for the tool. This keeps D2 and the OSS promise
literally true: the engine has no licence code in its runtime path.

### Licence token — offline-verifiable, no phone-home
The critical call: a one-off purchase must work **forever and offline**,
and D4 forbids telemetry. So the app **never** calls a server to
validate.

- Issuer signs a payload with an **Ed25519 private key** (server-only):

  ```
  { "lid": "amcp_3f9c…", "email": "buyer@acme.com",
    "product": "desktop", "issued": "2026-06-07", "v": 1 }
  ```

- Encoded key = `base64url(payload) . base64url(ed25519_sig)`.
- App verifies the signature **locally** with the **Ed25519 public key
  embedded in the binary**. Valid → store at `~/.affiliate-mcp/licence`,
  unlock. No network. Works if the issuer vanishes.
- **Bind to email only**, printed in the licence and shown in-app. **No
  hardware fingerprinting** — hostile to non-technical users (new laptop
  = lockout) and pointless besides. Accept casual sharing.

### Stripe flow — in-app buy (one-off → Checkout Sessions)
Buy happens **inside the app**, so use the **Checkout Sessions API**
(`mode: 'payment'`), not a Payment Link. £39 one-off. **Enable Stripe
Tax** (digital-goods VAT/sales tax). Never the Charges or Tokens API.

1. App "Buy" button → `POST /checkout` on the Worker → Worker creates a
   Checkout Session and returns its hosted URL.
2. App opens that URL in the system browser; user pays (card, Apple Pay).
3. **`checkout.session.completed`** webhook → Worker; verify the Stripe
   signature → sign the Ed25519 licence → store `{email → lid}` in KV →
   **email it** (Resend/Postmark) and show it on the success page.
4. User returns to the app and pastes the key → offline verify → unlock.
   (Optional polish: an `affiliate-mcp://activate?key=…` deep-link on the
   success page hands the key straight back to the app.)
5. **Resend** page: email → re-send licence from KV.

### The only backend: the licence issuer
A tiny Worker (Cloudflare/Vercel). Endpoints: `POST /checkout`,
`POST /webhook`, `POST /resend`. Holds **purchase records (KV) + the
signing private key (secret store)** — and **no affiliate credentials**,
so the no-custody stance holds. Stripe is the source of truth; KV mirrors
for resend.

### The one core change (`src/shared/config.ts`)
- Embed the Ed25519 **public** key as a constant.
- `readLicence()`: read `~/.affiliate-mcp/licence`, decode, verify
  signature, return `{ valid, email, issued }`.
- Verification only — **the gate/enforcement is the app's job**, not the
  server's. The server never checks a licence.

### Accepted limitations
- **No offline revocation** (can't revoke a signed key without a
  phone-home, which we've ruled out). Refunds/chargebacks leave the key
  working — fine for a low-price one-off.
- **No subscription, no customer portal** — one-off only.

---

## 3. How we keep open source at the core

Not a vibe — a set of enforced commitments:

1. **The app is MIT and in the public repo (D2).** The thing that
   onboards people is itself open.
2. **The free path is never crippled to upsell (D3).** Core does
   everything promised, standalone, forever. Commercial = our-infra-only.
3. **No telemetry, provably (D4).** Stated on the welcome screen, true
   in the code, verifiable because the code is open. "Open" is what
   makes "no phone-home" *credible* rather than a claim.
4. **Reproducible, signed builds.** Publish build instructions; let
   anyone rebuild the released binary. Trust through verifiability.
5. **Community contributes adapters *and* help content (D8)** through
   one low-friction path; the app surfaces community adapters
   automatically. Networks are invited to adopt their own adapter — the
   app is their shopfront.
6. **Single source of truth (D9).** App, CLI, and future surfaces all
   consume the same MIT adapter core. No proprietary fork of the engine.
7. **Honest funding.** If a Phase 4 commercial service ever funds the
   project, say so plainly; keep GitHub Sponsors open for the OSS. The
   punk-rock ethos survives money only if you're transparent about it.

The strategic point: **the open app is not a loss leader, it's the
reach engine.** It's free because reach is the goal (per the product
direction); it stays open because "open" is the proof behind every trust
claim the brand makes. Any money comes later, from running infra users
can't run themselves — and only if they ask.

---

## 4. Design

The app uses the affiliate-mcp design system verbatim — Riso Blue
`#2B2BFF` + ink, Bricolage Grotesque headlines (lowercase), Space
Grotesk body, JetBrains Mono for labels/keys/status. Hard corners,
solid offset shadows, mono status chips (`● verified`, `● pending`), no
emoji, UK spelling ("programme", "optimise"). It must look like the
*opposite* of a glossy SaaS onboarding — a zine-y, terminal-honest,
punk installer. See the mockups for the applied look across all six
onboarding screens.

The one screen that earns the product is the **per-network credential
form** — author-written help, a "where do I find this?" deep-link, and a
live `● verified as <identity>` stamp the instant the key checks out.
That moment is the whole north star.

---

## 5. Decisions resolved this pass (2026-06-07)

- **Scope:** v1 does one job — setup, then quit. No tray/monitoring.
- **Price:** £39 one-off.
- **Buy:** in-app, via Stripe Checkout Sessions (§2A).
- **App name in the OS:** `affiliate-mcp`.
- **Signing (D10):** Apple Developer licence in hand — mac unblocked.
- **Launch UX:** launch-and-quit (no tray) for now; **may revisit.**
- **Launch help content:** Awin, Impact, Partnerize, CJ.
- **MCP stays local** — unchanged; the app only configures it.

### Still open
- Signing **entity** — personal vs project org (migrate before launch if
  changing; D10).
- **Windows** build timing (Phase 2).
