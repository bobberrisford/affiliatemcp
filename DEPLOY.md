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

**Trust posture.** Local-first. Optional anonymous usage telemetry is off by
default and follows `PRIVACY.md`. The desktop app holds no affiliate
credentials beyond what it writes to the user's own machine. Its outbound calls
are: OS-level actions (opening network dashboards in the browser, restarting
Claude Desktop via `osascript`/`open`) and an **update check against GitHub
Releases on launch** (`electron-updater`, plus a fallback hit to the GitHub
Releases API if self-update can't run). The update feed is the only network call
the app itself makes; it carries no identifying payload. Nothing else is hosted;
nothing phones home.

---

## 2. Building the desktop `.dmg`

**Primary path — the CI release pipeline.** Cutting a release is a
`workflow_dispatch` on the **Desktop Release** workflow
(`.github/workflows/desktop-release.yml`), which owns the whole flow: it bumps
`desktop/package.json` on `main`, builds the signed + notarised universal
`.dmg` + `.zip` on a GitHub macOS runner, staples the dmg, and publishes the
`.dmg` + `-mac.zip` + `latest-mac.yml` feed to a non-draft `desktop-v<version>`
release so in-app auto-update works. Trigger it with a forward-only version:

```sh
gh workflow run desktop-release.yml -f version=0.1.3   # must exceed the latest desktop-v*
```

See the decision record
[`docs/decisions/2026-07-01-desktop-signed-release-pipeline.md`](docs/decisions/2026-07-01-desktop-signed-release-pipeline.md).
`desktop-dmg.yml` remains the artifact-only **test** build (no release, no feed).

The manual local build below is the **fallback** when CI is unavailable.

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

**Publishing (required for auto-update to work).** Desktop releases share the
repository with independently-versioned MCP server releases, so the desktop
channel is isolated by the `desktop-v` tag prefix (configured under
`build.publish` in `desktop/package.json`). The app discovers only stable
`desktop-v*` releases and uses that exact release's asset directory as its feed.
Each desktop release must carry `latest-mac.yml` + the `-mac.zip` + the `.dmg`.
Let electron-builder publish them in one pass:

```sh
# Release machine, with signing + notarisation env set (§3, §5) AND a GH token.
export GH_TOKEN=<personal-access-token with repo scope>
cd desktop
npm run prebuild:core && npm run bundle
electron-builder --mac --publish always   # builds dmg+zip, uploads them + latest-mac.yml
```

- `--publish always` uploads the artefacts and generated `latest-mac.yml` to a
  draft `desktop-v<version>` GitHub Release. Server `v<version>` releases are a
  separate stream and must never be used as the desktop update feed.
- Notarise + staple the draft release's `.dmg` per §3, replace the uploaded
  `.dmg`, then publish the GitHub Release. Drafts are deliberately invisible to
  installed apps.
- **Version bumps move forward only.** electron-updater never downgrades; bump
  `desktop/package.json` `version` before each release or the feed won't advertise
  the new build.
- If you build without `--publish` (e.g. local testing), no feed is written and
  installed apps simply won't see the release — expected.

**Failure fallback.** If a user's app discovers a newer desktop release but
can't self-update (download or signature failure), it does **not** fail silently:
it shows a quiet "new version → download" banner that opens that exact
`desktop-v*` release. So a broken feed degrades to manual download, never to a
server release or a stranded user.

- **Out of scope for this release (Phase 2):** Homebrew Cask and a Windows build
  (NSIS + `electron-updater` Windows feed). macOS auto-update ships now.

---

## 5. Secrets / credentials checklist

The macOS signing/notarisation credentials plus a GitHub token for publishing
the update feed are listed below. The separate optional telemetry backend is
documented under `telemetry-cloudflare/`.

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

---

## 7. Org / IT team rollout (host-native)

For a central IT team that wants to deploy affiliate-mcp to a whole
organisation, **do not use the public Connectors Directory.** It accepts remote
HTTPS connectors only; a local stdio server has no resolvable config there and
surfaces as `ant.dir.ant.<hash>.affiliate-networks-mcp: No server configuration
found`. Use each host's org-admin surface instead. The server stays local and
each user supplies their own credentials on-device. See
`docs/decisions/2026-06-29-org-team-distribution.md`.

### Claude Desktop — Desktop Extensions allowlist

1. Build the `.mcpb` bundle (see `mcpb/README.md`).
2. In the Claude org admin settings, open the **Desktop Extensions allowlist**
   and upload the `.mcpb`, then enable it for the team.
3. Each user installs it from Claude Desktop → Settings → Connectors → Desktop,
   and fills the per-network credential fields the manifest prompts for (Awin,
   CJ, Impact, Partnerize; sensitive fields are stored by Claude Desktop's
   secret storage). Every other adapter still works through the user's own
   `~/.affiliate-mcp/.env`.

Nothing is hosted and no credential leaves the user's machine. **Open:** confirm
whether the allowlist requires a signed `.mcpb` (ties into the signing identity
question in §3) and record the answer here.

### Claude Code — managed settings

Distribute the private marketplace and let managed settings pin it. In the
org's managed `settings.json` (server-managed or MDM-delivered):

```json
{
  "extraKnownMarketplaces": {
    "affiliatemcp": {
      "source": { "source": "github", "repo": "bobberrisford/affiliatemcp" }
    }
  },
  "strictKnownMarketplaces": true
}
```

The plugin (`.claude-plugin/plugin.json`) already declares the stdio server, so
installing the plugin connects it. For an exclusive, fixed set where users may
not add other servers, deploy a `managed-mcp.json` instead (macOS:
`/Library/Application Support/ClaudeCode/managed-mcp.json`):

```json
{
  "mcpServers": {
    "affiliate": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "affiliate-networks-mcp"]
    }
  }
}
```

Credentials are still per-user (env vars or `~/.affiliate-mcp/.env` on each
machine); the managed config carries no secrets.

---

## 8. Cloudflare Workers deploy pipeline

The three Cloudflare Workers deploy from CI on merge to `main`, so there is no
per-deploy manual step. Each mirrors `deploy-pages.yml`: path-scoped, gated,
public config committed inline, account-specific values injected from Actions
variables, and secrets set once on the Worker (never in CI). See
`docs/decisions/2026-07-17-telemetry-and-containers-ci-deploy.md` and
`docs/decisions/2026-07-16-hosted-worker-ci-deploy.md`.

| Worker | Workflow | Fires on |
|---|---|---|
| `affiliate-mcp-hosted` | `deploy-hosted.yml` | push to `main` under `hosted/**` |
| `affiliate-mcp-telemetry` | `deploy-telemetry.yml` | push to `main` under `telemetry-cloudflare/**` |
| `affiliate-mcp-containers` (MCP transport + digest) | `deploy-containers.yml` | push under `containers/**`, `Dockerfile`, `src/hosted-transport/**`, `src/hosted-digest/**`; **and** after a successful `Publish` run (so adapter/`src` changes reach the hosted transport in lockstep with each npm release); manual dispatch |

Each also runs manually: `gh workflow run deploy-<name>.yml -f confirm=deploy`.
A containers deploy recycles the single pinned transport instance (brief
in-memory session drop; clients reconnect); its trigger scope keeps that rare.

### One-time setup (never per-deploy)

These are the only manual actions, done once. After them every deploy is
automatic.

1. **`CLOUDFLARE_API_TOKEN`** repo secret must carry, on top of Workers + KV +
   D1: **`Account → Containers → Edit`** and **`Account → Cloudchamber → Edit`**
   (both — Containers alone does not authorise the image push). One token serves
   all three deploy workflows.
2. **`CLOUDFLARE_ACCOUNT_ID`** repo secret (already set for `deploy-hosted`).
3. **Actions variables** (Settings → Secrets and variables → Actions →
   Variables), substituted into `containers/wrangler.toml` at deploy, with the
   workflow failing fast if either is unset:
   - `TRANSPORT_PUBLIC_URL` — the containers Worker's own custom domain, e.g.
     `https://mcp.agenticaffiliate.ai` (gates OAuth discovery).
   - `HOSTED_WORKER_ORIGIN` — the hosted Worker's origin, e.g.
     `https://hosted.agenticaffiliate.ai`.

Worker secrets (`VAULT_MASTER_KEY`, `SESSION_SIGNING_KEY`, `STRIPE_*`,
`RESEND_API_KEY`, `DIGEST_COMPOSE_SECRET`, telemetry's `GITHUB_TOKEN`) are set
once with `wrangler secret put` and are untouched by a code deploy.

D1 schema migrations are never part of a code deploy; run them deliberately with
`npm --prefix telemetry-cloudflare run db:migrate`.
