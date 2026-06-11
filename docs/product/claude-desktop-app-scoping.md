# Claude Desktop app — execution plan (2026-06-07)

> Status: design doc, pre-implementation.
> North star: **easy onboarding for non-technical users.** Every decision
> below is judged against one question — does it get a non-technical
> person from "downloaded" to "asked Claude a question and got an
> answer" with the fewest failure points?

## Verdict

**Go.** Ship a signed, notarised desktop app (**Electron**) that wraps
the existing setup wizard in a window, bundles its own Node runtime so
the user never installs anything, walks them through credentials one
network at a time with inline help + live verification, writes
`claude_desktop_config.json` pointing at the bundled server, and offers
a one-click "Restart Claude" at the end.

The app hosts nothing and stores nothing off-device. Credentials stay
in `~/.affiliate-mcp/.env` (mode 0600) exactly as today. Every
load-bearing privacy claim survives unchanged. This is the local-first
product with the terminal removed — not a new product.

Scope: a mac-first MVP is ~3–4 focused weeks. The long poles are code
signing/notarisation and per-network credential help content, **not**
the app shell.

## Why this beats the alternatives

| Option | Verdict | Why |
|---|---|---|
| **Electron app bundling Node (chosen)** | Ship it | The MCP server *is* Node. Electron ships the runtime, so "install Node" — the biggest onboarding blocker — disappears. Toolchain is all TS/JS; team velocity is highest. Reuses the existing wizard/install/detect code wholesale. |
| Tauri app + Node sidecar | Reject (for now) | Smaller binary (~5 MB vs ~100 MB), but you must ship Node as a sidecar binary and bridge Rust↔Node. The size win is real; the added toolchain + sidecar packaging complexity is not worth it for a v1 when the whole point is to ship the Node server unchanged. Revisit if binary size becomes a complaint. |
| Keep CLI, write a one-click installer (`.pkg`/`.exe`) that runs `npx … setup` | Reject | Cheaper, but still drops the user into a terminal wizard, still needs Node, still can't render screenshots/deep-links for credential help. Solves install, not onboarding. |
| claude.ai web connector | Out of scope | Remote transport, needs a hosted endpoint + OAuth — the custody/hosting business we explicitly decided against. Claude *Desktop* is the target. |

The cost we accept: a ~100 MB download and an Apple Developer account
($99/yr) + a Windows signing cert. Both are the price of "no scary
Gatekeeper/SmartScreen warning," which is non-negotiable for a
non-technical audience.

## The onboarding flow (the whole point)

1. **Download** `Affiliate MCP.dmg` (mac) — drag to Applications.
   Signed + notarised, so it opens with no warning.
2. **First launch — welcome.** "Which networks do you use?" Multi-select,
   rendered from the adapter registry (`getAdapters()`), each showing the
   `setupTimeEstimateMinutes` and an "approval required" badge from
   `meta`.
3. **Per network — a form, not a prompt.** For each `setupStep()`: render
   the author-written `description` as inline help, with a **"Where do I
   find this?"** deep-link button (opens the exact dashboard page) and a
   screenshot. User pastes the value; the app calls `validateOnEntry`
   live and shows ✓/✗ with the verbatim reason. At the end it calls
   `verifyAuth()` and shows **"Verified as `<identity>` ✓"**.
4. **Brands (multi-brand networks only).** Reuse `runBrandDiscovery` —
   render the discovered brands as a checklist with nickname fields.
5. **Connect to Claude.** App runs `detectClients()`. If Claude Desktop
   is present, it writes the config entry (bundled-runtime variant, see
   below) and shows ✓. If absent, it shows a **"Download Claude
   Desktop"** button and waits.
6. **Restart Claude.** One button quits and relaunches Claude Desktop
   (MCP servers only load on restart — this is the step users forget).
7. **Done screen** with three example questions and a "Copy" button:
   *"What did I earn across all networks last month?"*

**The hardest remaining step is #3 — finding the key in each network's
dashboard.** The terminal never helped with this; the GUI's entire
reason to exist is to make it easy. Budget real effort on the deep-links
+ screenshots; that is where onboarding succeeds or fails.

## How Claude launches the server with no Node installed

Today the config entry is `{ command: "npx", args:
["affiliate-networks-mcp"] }` — which requires system Node and a network
round-trip on every launch. The app changes this to point at its own
bundled runtime:

- **mac:** `command: "/Applications/Affiliate
  MCP.app/Contents/Resources/node"`, `args: ["…/Resources/app/server.js"]`
- **win:** the equivalent under the install dir.

This removes the Node dependency entirely and makes server start-up
instant and offline. `addAffiliateEntry`'s merge/backup/atomic-write
logic is unchanged — only `AFFILIATE_ENTRY_VALUE` becomes a function of
the install path.

## Architecture: app and server stay separate

The app does **not** run the MCP server in-process. Claude Desktop spawns
the server itself (via the config entry) over stdio, exactly as today.
The app's three jobs are:

1. **Onboarding GUI** — drives `setupSteps()` / `validateOnEntry` /
   `verifyAuth` / brand discovery and writes `~/.affiliate-mcp/.env`.
2. **Connector** — writes `claude_desktop_config.json`.
3. **Tray/menu-bar status** — "3 networks connected ✓", re-verify,
   add/rotate keys, open config.

App and server share **one copy of the adapter/core code** via import
(monorepo), so adapters remain the single source of truth. They don't
talk at runtime.

## The seam that makes this cheap: the `Prompter` interface already exists

`runSetup` takes an injectable `Prompter` (`text` / `password` / `menu`
/ `confirm` / `selectMany`). In principle the GUI could implement a
`Prompter` that resolves over IPC. **But** the wizard's control flow is
linear and terminal-shaped; a form UI wants random access. So the
cleaner move is a thin programmatic **core facade** the renderer calls,
reusing the adapter primitives directly rather than replaying the CLI
control flow:

```
core.listAdapters()
core.setupSteps(slug)
core.validateField(slug, field, value)   // wraps validateOnEntry
core.verifyAuth(slug)
core.discoverBrands(slug)
core.writeEnv(entries)                    // wraps wizard/envfile
core.connectClaudeDesktop()               // wraps addAffiliateEntry
core.detectClients()
```

Almost all of this exists; it needs a small non-CLI wrapper so the app
never shells out.

## Required code changes

| Area | New / Edit | Notes |
|---|---|---|
| `desktop/` (new workspace) | **New** | Electron main + preload + renderer. ~main process supervises IPC; renderer is the wizard UI. |
| `src/core/facade.ts` | **New** | Programmatic, prompter-free API over the existing adapter/setup/install primitives (the list above). The one real refactor. |
| `src/cli/install/claude-desktop.ts` | Edit | Make `AFFILIATE_ENTRY_VALUE` a function of the bundled-runtime path; keep all merge/backup/atomic logic. |
| `desktop/` renderer screens | **New** | Welcome / network picker / per-network form / brand picker / connect / restart / done. |
| Credential help content | **New** | Per-network deep-link URL + screenshot. Start with the top ~8 networks by usage; fall back to `description` text for the rest. **Long pole.** |
| Build/sign pipeline | **New** | `electron-builder`, Apple notarisation, Windows signing, `electron-updater` for auto-update. |
| Tray/status | **New** | Menu-bar item: network health, add/rotate, restart Claude. |
| Tests | **New** | Core-facade unit tests (reuse existing adapter test doubles); a smoke test that drives the wizard end-to-end against mock adapters. |

## Credential storage

**Unchanged for MVP:** `~/.affiliate-mcp/.env`, mode 0600. The server
already reads it; PRIVACY.md already describes it; it's tested. Do not
change the storage model and the desktop app in the same release.

**v2 hardening (optional):** OS keychain (macOS Keychain / Windows
Credential Manager). Better, but the server would need a keychain reader
and it muddies the "delete one file to remove everything" story. Defer.

## Lifecycle and failure modes

| Event | What the user sees | Recovery |
|---|---|---|
| Claude Desktop not installed | "Download Claude Desktop" button | App re-detects on focus; continues when present. |
| User edits/clears a key later | Tray shows the network as ✗ | "Re-verify" / "Edit" in tray re-runs `verifyAuth`. |
| Claude not restarted after connect | Tools don't appear in Claude | The explicit "Restart Claude" button; done-screen reminds them. |
| Network API down at setup | ✗ with verbatim reason | "Credentials saved; re-verify later" — same honesty rule as the CLI. |
| App update available | Auto-update prompt (v1.1) | `electron-updater` downloads + installs on relaunch. |
| Existing `claude_desktop_config.json` is malformed | Clear error + offer to back up & rewrite | Reuses `--force-overwrite` path (timestamped backup first). |

## What breaks about the local-first stance

**Nothing.** Credentials stay on-device in the same file. API calls
still originate from the user's machine. No account, no telemetry, no
hosted state. The app is a packaging-and-onboarding layer; the trust
story in PRIVACY.md and the manifesto is untouched. (Auto-update pings a
release server for a version check — disclose that one line, same as any
app.)

## Smallest credible MVP

**Ship this and stop:**

- **mac only**, signed + notarised, bundled Node runtime.
- Onboarding wizard for the **top ~8 networks** with rich credential
  help (deep-link + screenshot); remaining networks usable via their
  `description` text.
- Live `validateOnEntry` / `verifyAuth`; brand discovery for multi-brand
  networks.
- Writes `.env` + `claude_desktop_config.json`; "Restart Claude" button.
- Minimal tray: network status + "open config" + "re-verify".

**Punt to v1.1+:**

- Windows build + signing.
- `electron-updater` auto-update.
- Screenshots/deep-links for all ~40 networks.
- Keychain storage.
- Any **Pro / hosted-monitoring** hooks — explicitly out of scope here;
  that's a separate product decision (see the economics discussion) and
  must not creep into the free onboarding app.

## Prerequisites (start these now — they have lead time)

- **Apple Developer Program** ($99/yr) for signing + notarisation.
- **Windows code-signing certificate** (~$100–400/yr) — only when
  Windows ships.
- A place to host release artifacts + the update feed (GitHub Releases
  is fine and free).

## Recommendation: Go, mac-first

The app shell is small because the wizard, the config writer, and client
detection already exist and are tested. The genuine work is (1) the
one-time core facade, (2) signing/notarisation, and (3) per-network
credential help — and (3) is where the north star is actually won.
Resist scope creep into Windows, keychain, and Pro hooks for v1; each is
a clean follow-up.

**The single thing to get right:** step 3 of the flow. A non-technical
user does not fail at "install" or "connect" — they fail at "where is my
CJ API token." Every hour spent on deep-links and screenshots for that
step buys more successful onboardings than any other work in this plan.

## Relevant files for the implementer

- `src/cli/setup.ts` — the wizard control flow to mirror (not replay) in the GUI
- `src/cli/wizard/prompts.ts` — the `Prompter` seam; the GUI's alternative is the core facade
- `src/cli/wizard/envfile.ts` — `readEnv` / `mergeEnv` / `writeEnv` to reuse
- `src/cli/wizard/brand-discovery.ts` — brand picker logic to reuse
- `src/cli/install/claude-desktop.ts` — config writer; make the entry value path-aware
- `src/cli/install/detect.ts` — Claude Desktop detection
- `src/shared/config.ts` — `~/.affiliate-mcp/.env` location + 0600 model
- `src/shared/types.ts` — `SetupStep`, `NetworkAdapter`, `meta` fields the UI renders
- `src/cli/install/atomic-write.ts` — backup + atomic write the app inherits for free

## Sources

- [Electron — process model & packaging](https://www.electronjs.org/docs/latest/)
- [electron-builder — code signing & notarisation](https://www.electron.build/)
- [electron-updater — auto-update](https://www.electron.build/auto-update)
- [Tauri v2 — sidecar binaries](https://v2.tauri.app/) (evaluated, deferred)
- [Apple — notarising macOS software](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Model Context Protocol — clients & transports](https://modelcontextprotocol.io/)
- Internal: `docs/product/chatgpt-scoping.md` (tunnel approach, rejected for
  this audience), `docs/product/openai-parity.md`
