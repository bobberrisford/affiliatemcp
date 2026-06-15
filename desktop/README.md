# affiliate-mcp desktop

> **Compatibility fallback.** New Claude Desktop users should install the
> host-native `.mcpb` extension from the latest GitHub release. This Electron
> setup app and its DMG remain available for existing macOS users while the
> portable browser setup flow is built, but receive fixes rather than new
> product scope. It is not a primary onboarding track. See
> [`docs/decisions/2026-06-12-host-native-distribution.md`](../docs/decisions/2026-06-12-host-native-distribution.md).

The local-first **compatibility setup app**. Its one job (v1): get a
non-technical user connected to Claude Desktop **without a terminal**, then
quit. It does not run the MCP server; Claude Desktop spawns that over stdio,
exactly as today. This app only writes the credentials and the Claude config.

The app is **free and open source (MIT)** — no licence gate and no in-app
purchase. Optional anonymous usage telemetry is off by default and uses the
project's first-party telemetry backend; see [`PRIVACY.md`](../PRIVACY.md). See
[`docs/product/desktop-app-plan.md`](../docs/product/desktop-app-plan.md) for
the full plan and
[`docs/decisions/2026-06-09-desktop-app-free.md`](../docs/decisions/2026-06-09-desktop-app-free.md)
for the decision to drop the original paid/licence flow.

## Run it

```bash
cd desktop
npm install
npm start          # launches Electron
```

The renderer also runs in a plain browser (no Electron) — open
`renderer/index.html` via a static server. With no preload bridge it uses an
in-file **mock** of the facade, so you can click the whole flow.

## Layout

| File | Role |
|---|---|
| `main.js` | Electron main. Creates the (sandboxed) window, the launch-and-quit lifecycle, and the **IPC handlers** wired to the core facade. Every handler returns a structured result (`{ ok:false, error }` on a thrown error) and refuses calls from any frame other than the app's own top-level `file:` renderer. |
| `preload.js` | `contextBridge` exposing a narrow `window.affiliate` API to the sandboxed renderer. No other Node access. |
| `renderer/index.html` | Loads the design system (`/design-system`) then the app. |
| `renderer/app.css` | **App layout only** — window chrome + screen scaffolding. Re-defines no design-system component. |
| `renderer/app.js` | The screen state-machine (welcome → networks → credentials → brands → connect → done). Uses `window.affiliate` or the browser mock. |

## Design system

Visuals come from the repo source-of-truth in
[`/design-system`](../design-system/) — `colors_and_type.css` (tokens) +
`components.css` (buttons, cards, terminals, status). The app consumes those
classes; it never hard-codes colours, spacing, or fonts. Run `npm run
lint:design` from the repo root to flag drift.

## How the core is loaded

`main.js` is CommonJS; the core is ESM, so it can't `require` the raw `dist/`
tree directly. Instead `npm run bundle` (esbuild) flattens the built core into
two self-contained CJS bundles that `main.js` `require()`s once and caches:

- `build/core.cjs` — the facade the UI drives (`src/core/app-entry`).
- `build/server.cjs` — the MCP server entrypoint (`src/index`).

In dev they sit in `desktop/build/`; packaged they ship **flat** under
`Contents/Resources/` (via `extraResources`) — there is no `dist/` tree in the
app bundle. If `core.cjs` is missing, the app throws a clear error — *"Run
`npm run build` in the repo root then `npm run bundle` in desktop/."* — rather
than falling back to mock data. The mock facade exists only in the renderer's
browser-preview path (`app.js`), never in Electron.

## IPC handlers (all wired to the real core)

- `clients:detect` / `networks:*` (incl. `networks:discoverBrands`) /
  `config:saveEnv` / `claude:saveBrands` → the matching `core.cjs` facade
  functions.
- `claude:connect` → `facade.connectClaudeDesktop(...)` (bundled-runtime entry,
  below). `claude:restart` → quit, poll until Claude has fully exited, then
  relaunch Claude Desktop (macOS).
- `shell:openExternal` → opens a dashboard URL only if it is `https:` **and**
  its host appears in a shipped network setup step (an allowlist built from the
  core, so it stays correct as networks are added). Renderer-created windows
  (`setWindowOpenHandler`) and navigation away from the bundled file
  (`will-navigate`) are denied.

## The bundled-runtime Claude config entry

To avoid shipping a second Node binary, the packaged app points Claude at the
app's **own Electron executable run in Node mode**. `connectClaudeDesktop`
writes the complete entry — `command`, `args`, **and** `env` — in a single
atomic/backup pass (the app does **not** hand-patch the file afterwards, so a
failed write surfaces as an error instead of a half-written entry). The
resulting `claude_desktop_config.json` entry is:

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

`ELECTRON_RUN_AS_NODE=1` makes the Electron binary behave as a plain Node
runtime, so the bundled server runs with no system Node and no `npx` round-trip.
In **dev** (`!app.isPackaged`) no paths are passed, so it falls back to the
`npx affiliate-networks-mcp` default.

## Packaging (electron-builder)

`npm run dist` first builds the core (`npm --prefix .. run build`), bundles it
(`npm run bundle`), then runs electron-builder. The two bundles (`core.cjs`,
`server.cjs`) and `design-system/` ship as `extraResources`.

**Signing + notarisation are electron-builder's own, gated purely on env vars**
— there is no custom `afterSign` hook. Absent the creds, `npm run dist` produces
an unsigned, un-notarised `.dmg` (no crash). Notarisation uses electron-builder's
built-in notarisation (`"notarize": true` under `mac` in `package.json`), which
reads the `APPLE_*` vars — the team id comes from `APPLE_TEAM_ID`. See
[`DEPLOY.md`](../DEPLOY.md) §3 for the full release path, including stapling the
`.dmg`.

| Env var | Purpose |
|---|---|
| `CSC_LINK` | Path/base64 of the Developer ID Application `.p12` cert (signing). |
| `CSC_KEY_PASSWORD` | Password for that `.p12`. |
| `APPLE_ID` | Apple Developer account email (built-in notarisation). |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that account. |
| `APPLE_TEAM_ID` | Developer Team ID — supplies the team id for built-in notarisation (`mac.notarize: true`). |

The hardened runtime + entitlements (`build/entitlements.mac.plist`) are wired
for a notarised Electron app (`allow-jit`, unsigned-executable-memory,
disable-library-validation, allow-dyld-environment-variables — the last is
needed because we set `ELECTRON_RUN_AS_NODE` on the spawned server).

The setup flow opens straight at the welcome screen — no licence step.

## v1 scope notes

- **mac first**, signed + notarised (Apple licence in hand).
- **Launch-and-quit** — no tray yet (may revisit).
- App name in the OS: **affiliate-mcp**.
- Launch credential-help content: **Awin, Impact, Partnerize, CJ**.
- Fonts are **self-hosted** (`design-system/fonts/*.woff2`, loaded via
  `@font-face` in `colors_and_type.css`) — no Google Fonts CDN phone-home, so
  the app renders fully offline.
