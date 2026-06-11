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
credentials beyond what it writes to the user's own machine. Its outbound calls
are: OS-level actions (opening network dashboards in the browser, restarting
Claude Desktop via `osascript`/`open`) and an **update check against GitHub
Releases on launch** (`electron-updater`, plus a fallback hit to the GitHub
Releases API if self-update can't run). The update feed is the only network call
the app itself makes; it carries no identifying payload. Nothing else is hosted;
nothing phones home.

---

## 2. Building the desktop `.dmg`

```sh
# 1) Build the bundled MCP server (root) — produces dist/
npm run build

# 2) Build the desktop app
cd desktop
npm install
npm run dist        # = prebuild:core (npm --prefix .. run build) + electron-builder --mac
```

- `npm run dist` rebuilds the core first, then runs electron-builder for **all
  mac targets** (`dmg` + `zip`).
- **Artefacts:** the installer `"desktop/dist/affiliate-mcp-<version>-<arch>.dmg"`,
  the **`zip` that `electron-updater` updates from**
  `"desktop/dist/affiliate-mcp-<version>-<arch>-mac.zip"`, and the update manifest
  `"desktop/dist/latest-mac.yml"` (version from `desktop/package.json`; arch is the
  build host's, arm64 on Apple Silicon).
- The `zip` and `latest-mac.yml` exist **for auto-update** (Squirrel.Mac downloads
  the zip; the yml is the feed). All three must be published together — see §4.
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
  `.dmg`** — electron-builder skips signing and notarisation (no crash). Fine for
  local testing; not shippable. See section 3.

---

## 3. Signing + notarising (macOS)

Both are electron-builder's own, gated purely on environment variables — there is
no custom `afterSign` hook. Signing is driven by the `CSC_*` vars; notarisation by
electron-builder's built-in notarisation (`"notarize": true` under `mac` in
`desktop/package.json`), which reads the `APPLE_*` vars — including the team id
from `APPLE_TEAM_ID` — and notarises + staples the `.app` via `notarytool`.

> Note: electron-builder 26 changed the schema — `mac.notarize` is now a **boolean**
> (the team id comes from the `APPLE_TEAM_ID` env var), not the `{ "teamId": … }`
> object that v24 used. Do not add a custom `afterSign` notarize hook; it conflicts
> with the built-in. Verified end-to-end on electron-builder 26 + Electron 42: the
> signed `.app` assesses as `Notarized Developer ID` and the notarised `.dmg`
> staples and validates (see §6).

**Signing** (read by electron-builder):

| Env var | Purpose |
|---|---|
| `CSC_LINK` | Path or base64 of the `.p12` signing certificate (a **Developer ID Application** cert) |
| `CSC_KEY_PASSWORD` | Password for that `.p12` |

With neither set, electron-builder skips signing and emits an unsigned app.

**Notarisation** (read by electron-builder's built-in `mac.notarize`):

| Env var | Purpose |
|---|---|
| `APPLE_ID` | Apple Developer account email |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that account |
| `APPLE_TEAM_ID` | Developer Team ID (`K5WQQYQWTR`) — supplies the team id for `mac.notarize: true` |

With the `APPLE_*` vars unset, notarisation is skipped and the `.dmg` is still
produced (just un-notarised). All set → the build notarises and **staples the
`.app`**.

**Staple the `.dmg` too.** electron-builder notarises/staples the `.app`, not the
`.dmg` container. After `npm run dist`, notarise + staple the disk image itself so
it verifies offline on first mount:

```sh
xcrun notarytool submit "dist/affiliate-mcp-<version>-<arch>.dmg" \
  --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" \
  --team-id "$APPLE_TEAM_ID" --wait
xcrun stapler staple   "dist/affiliate-mcp-<version>-<arch>.dmg"
xcrun stapler validate "dist/affiliate-mcp-<version>-<arch>.dmg"   # → "The validate action worked!"
```

Verify the result: `spctl -a -vvv -t exec "dist/mac-<arch>/affiliate-mcp.app"`
should report `accepted … source=Notarized Developer ID`. (Do **not** use
`spctl -t install` on the `.dmg` — that assessment is for `.pkg` installers and
always reports "no usable signature" for a disk image; use `stapler validate`.)

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

## 4. Distribution + publishing the update feed

- Ship the signed, notarised `.dmg` as a **direct download on GitHub Releases**
  (D5 / D7), **alongside the `-mac.zip` and `latest-mac.yml`** that drive
  auto-update.
- **Not** the Mac App Store — the app is incompatible with the MAS sandbox (it
  writes outside the container, spawns its own binary as the MCP server, and
  restarts Claude via `osascript`/`open`).

**Publishing (required for auto-update to work).** The app's update feed is the
GitHub Releases of `bobberrisford/affiliatemcp` (configured under `build.publish`
in `desktop/package.json`). Each release must carry `latest-mac.yml` + the
`-mac.zip` + the `.dmg`. Let electron-builder publish them in one pass:

```sh
# Release machine, with signing + notarisation env set (§3, §5) AND a GH token.
export GH_TOKEN=<personal-access-token with repo scope>
cd desktop
npm run prebuild:core && npm run bundle
electron-builder --mac --publish always   # builds dmg+zip, uploads them + latest-mac.yml
```

- `--publish always` uploads the artefacts and the generated `latest-mac.yml` to a
  GitHub Release (drafted against the current `desktop/package.json` version).
- After publishing, still notarise + staple the `.dmg` per §3.
- **Version bumps move forward only.** electron-updater never downgrades; bump
  `desktop/package.json` `version` before each release or the feed won't advertise
  the new build.
- If you build without `--publish` (e.g. local testing), no feed is written and
  installed apps simply won't see the release — expected.

**Failure fallback.** If a user's app can't self-update (download or signature
failure, or an offline feed), it does **not** fail silently: it shows a quiet
"new version → download" banner that opens this releases page. So a broken feed
degrades to manual download, never to a stranded user.

- **Out of scope for this release (Phase 2):** Homebrew Cask and a Windows build
  (NSIS + `electron-updater` Windows feed). macOS auto-update ships now.

---

## 5. Secrets / credentials checklist

The macOS signing/notarisation creds plus a GitHub token for publishing the
update feed — there is no backend.

| Name | Where it's set | What it's for |
|---|---|---|
| `CSC_LINK` | env (release machine) | Path/base64 of the `.p12` signing cert |
| `CSC_KEY_PASSWORD` | env (release machine) | Password for the `.p12` |
| `APPLE_ID` | env (release machine) | Apple Developer account email (notarisation) |
| `APPLE_APP_SPECIFIC_PASSWORD` | env (release machine) | App-specific password (notarisation) |
| `APPLE_TEAM_ID` | env (release machine) | Developer Team ID (notarisation) |
| `GH_TOKEN` | env (release machine) | GitHub PAT (repo scope) — lets `electron-builder --publish` upload the `.dmg`, `-mac.zip`, and `latest-mac.yml` to Releases |

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
