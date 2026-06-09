# DEPLOY.md — affiliate-mcp release runbook

How to ship the **desktop setup app**. This is the human runbook (Rob). Every
credential you must supply and every step that is still a TODO is called out.
Paths are quoted because the repo lives at `"/Users/robertberrisford/affiate mcp"`
(there is a space).

The desktop app is **free and open source (MIT)**, like the rest of the project.
There is no paid tier, no licence to issue, and no payment backend.

---

## 1. Overview

Two artefacts ship, both MIT and both free:

| Artefact | What | Status |
|---|---|---|
| **MCP server / CLI** | `affiliate-networks-mcp` on npm — Claude Desktop spawns it over stdio | Unchanged; not part of this release |
| **Desktop `.dmg`** | The local-first, launch-and-quit **setup app** (Electron). Writes credentials + the Claude Desktop config, then quits. It does **not** run the MCP server | New |

**Trust posture.** Local-first, no telemetry. The desktop app holds no affiliate
credentials beyond what it writes to the user's own machine. The only outbound
calls it makes are OS-level: opening network dashboards in the browser and
restarting Claude Desktop via `osascript`/`open`. Nothing is hosted; nothing
phones home.

---

## 2. Building the desktop `.dmg`

```sh
# 1) Build the bundled MCP server (root) — produces dist/
npm run build

# 2) Build the desktop app
cd desktop
npm install
npm run dist        # = prebuild:core (npm --prefix .. run build) + electron-builder --mac dmg
```

- `npm run dist` rebuilds the core first, then runs electron-builder.
- **Artefact:** `"desktop/dist/affiliate-mcp-<version>-<arch>.dmg"` — e.g.
  `"desktop/dist/affiliate-mcp-0.1.0-arm64.dmg"` (version from `desktop/package.json`;
  arch is the build host's, arm64 on Apple Silicon).
- `npm run bundle` (run by `npm run dist`) esbuilds two self-contained CommonJS
  files into `desktop/build/`: `core.cjs` (the facade the UI drives) and
  `server.cjs` (the MCP server entrypoint). The packaged app ships **no
  `node_modules` and no `dist/` tree** — just these bundles.
- The build copies, as `extraResources`, directly under `Contents/Resources/`:
  - `build/core.cjs` → `Contents/Resources/core.cjs`
  - `build/server.cjs` → `Contents/Resources/server.cjs`
  - `../design-system` → `Contents/Resources/design-system/`
- **Bundled-runtime Claude config.** The packaged app does not ship a second Node
  binary. When the user clicks **Connect**, the app writes a `claude_desktop_config.json`
  entry that runs the app's **own Electron binary in Node mode** against the
  bundled `server.cjs`:
  ```json
  {
    "mcpServers": {
      "affiliate": {
        "command": "/Applications/affiliate-mcp.app/Contents/MacOS/affiliate-mcp",
        "args": ["/Applications/affiliate-mcp.app/Contents/Resources/server.cjs"],
        "env": { "ELECTRON_RUN_AS_NODE": "1" }
      }
    }
  }
  ```
  The whole entry — command, args, and `env` — is written in one atomic, backed-up
  pass by the core facade (`connectClaudeDesktop`); the app does not hand-patch the
  file afterwards. `ELECTRON_RUN_AS_NODE: "1"` makes the Electron binary behave as a
  plain Node runtime — no system Node, no `npx` round-trip. (In dev the app falls
  back to `npx affiliate-networks-mcp`.)
- **With no signing creds set, `npm run dist` produces an UNSIGNED, un-notarised
  `.dmg`** and the notarise hook logs a skip (no crash). Fine for local testing;
  not shippable. See section 3.

---

## 3. Signing + notarising (macOS)

electron-builder does the signing; `"desktop/build/notarize.js"` (the `afterSign`
hook) does the notarisation. Both are gated purely on environment variables.

**Signing** (read by electron-builder):

| Env var | Purpose |
|---|---|
| `CSC_LINK` | Path or base64 of the `.p12` signing certificate |
| `CSC_KEY_PASSWORD` | Password for that `.p12` |

With neither set, electron-builder skips signing and emits an unsigned app.

**Notarisation** (read by `notarize.js`):

| Env var | Purpose |
|---|---|
| `APPLE_ID` | Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that account |
| `APPLE_TEAM_ID` | Developer Team ID |

`notarize.js` only runs on `darwin`. If **any** of the three notarisation vars is
missing it logs a warning and returns without notarising (the `.dmg` is still
produced, just un-notarised). All three present → it notarises
`<app>.app` via `@electron/notarize`.

The hardened runtime is on (`build.mac.hardenedRuntime: true`) with
`"desktop/build/entitlements.mac.plist"` granting `allow-jit`,
`allow-unsigned-executable-memory`, `disable-library-validation`, and
`allow-dyld-environment-variables` (the last is required because we set
`ELECTRON_RUN_AS_NODE` on the spawned server process).

**Prerequisites / open question:**
- **D10** — the Apple Developer licence must be in hand before a signed/notarised
  build is possible.
- **Open:** signing identity is currently personal vs org. Migrate to the org
  signing identity **before launch** so the published app isn't tied to a personal
  account.

---

## 4. Distribution

- Ship the signed, notarised `.dmg` as a **direct download on GitHub Releases**
  (D5 / D7).
- **Not** the Mac App Store — the app is incompatible with the MAS sandbox (it
  writes outside the container, spawns its own binary as the MCP server, and
  restarts Claude via `osascript`/`open`).
- **Out of scope for this release (Phase 2):** Homebrew Cask, a Windows build, and
  `electron-updater` auto-updates. Releases are manual `.dmg` downloads for now.

---

## 5. Secrets / credentials checklist

Only the macOS signing/notarisation creds are needed — there is no backend.

| Name | Where it's set | What it's for |
|---|---|---|
| `CSC_LINK` | env (release machine) | Path/base64 of the `.p12` signing cert |
| `CSC_KEY_PASSWORD` | env (release machine) | Password for the `.p12` |
| `APPLE_ID` | env (release machine) | Apple Developer account email (notarisation) |
| `APPLE_APP_SPECIFIC_PASSWORD` | env (release machine) | App-specific password (notarisation) |
| `APPLE_TEAM_ID` | env (release machine) | Developer Team ID (notarisation) |

---

## 6. Verification before shipping

```sh
# Root: full gate (typecheck + lint + tests + build) — must be green
npm run verify

# Desktop: rebuild the core, esbuild the bundles, and load-smoke them. Catches
# the ESM/unbundled-dep breakage that would otherwise only surface in a packaged
# build. (CI runs this as the `desktop` job.)
npm --prefix desktop run verify:desktop

# Desktop E2E: launch the real Electron main process and drive it through the
# real preload bridge (detect / listNetworks / saveEnv / openExternal allowlist).
# Catches runtime-only IPC bugs the browser mock can't. macOS only (needs the
# Electron binary + a display). CI runs this as the `desktop-e2e` job on macOS.
npm --prefix desktop run test:e2e

# Root: design-system adherence lint on the renderer
npm run lint:design
```

- `npm run lint:design` runs `npx oxlint@latest`. **Caveat:** in a sandboxed
  environment oxlint can't download its binary — run it where oxlint can install
  (it ends with `|| true`, so a sandbox failure won't fail the script, but it also
  won't actually lint).
- **Manual smoke:** open the built `.dmg`, run the setup app end to end against a
  real network, confirm it writes `~/.affiliate-mcp/.env` and the Claude Desktop
  config entry, then confirm Claude can call an affiliate tool after the restart.
