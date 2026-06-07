# affiliate-mcp desktop

The local-first **setup app**. Its one job (v1): get a non-technical user
connected to Claude Desktop **without a terminal**, then quit. It does not run
the MCP server — Claude Desktop spawns that over stdio, exactly as today. This
app only writes the credentials and the Claude config.

See [`docs/product/desktop-app-plan.md`](../docs/product/desktop-app-plan.md)
for the full plan, decisions, and the payments/licensing spec (§2A).

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
| `main.js` | Electron main. Creates the window, launch-and-quit lifecycle, and the **IPC handlers** that are the app's view of the core facade. **Currently stubbed** — wire each to `../src/core/facade`. |
| `preload.js` | `contextBridge` exposing a narrow `window.affiliate` API to the renderer. No other Node access. |
| `renderer/index.html` | Loads the design system (`/design-system`) then the app. |
| `renderer/app.css` | **App layout only** — window chrome + screen scaffolding. Re-defines no design-system component. |
| `renderer/app.js` | The screen state-machine (activate → welcome → networks → credentials → brands → connect → done). Uses `window.affiliate` or the browser mock. |

## Design system

Visuals come from the repo source-of-truth in
[`/design-system`](../design-system/) — `colors_and_type.css` (tokens) +
`components.css` (buttons, cards, terminals, status). The app consumes those
classes; it never hard-codes colours, spacing, or fonts. Run `npm run
lint:design` from the repo root to flag drift.

## How the core is loaded

`main.js` is CommonJS; the core is ESM. The handlers load the **built** core
once via dynamic `import()` and cache it:

- dev (`!app.isPackaged`): `../dist/core/facade.js` + `../dist/shared/config.js`.
- packaged: the same files under `process.resourcesPath/dist/…` (shipped via
  `extraResources`, see below).

If the build is missing the app throws a clear error — *"Run `npm run build` in
the repo root first."* — rather than silently using mock data. The mock facade
only exists in the renderer's browser-preview path (`app.js`), never in Electron.

## IPC handlers (all wired to the real core)

- `licence:read` → `config.readLicence()` — `{ email, issued }` or `null`.
- `licence:activate` → `config.verifyLicenceToken(key)`; on success writes the
  token verbatim to `<CONFIG_DIR>/licence` (dir 0700, file 0600).
- `licence:buy` → `POST {}` to `AFFILIATE_MCP_ISSUER_URL + '/checkout'`, then
  opens the returned Stripe URL. **If `AFFILIATE_MCP_ISSUER_URL` is unset it
  returns an error and opens nothing** — no placeholder URL.
- `clients:detect` / `networks:*` / `config:saveEnv` / `claude:saveBrands` →
  the matching `src/core/facade` functions.
- `claude:connect` → `facade.connectClaudeDesktop(...)` (bundled-runtime entry,
  below). `claude:restart` → quit + relaunch Claude Desktop (macOS).

## The bundled-runtime Claude config entry

To avoid shipping a second Node binary, the packaged app points Claude at the
app's **own Electron executable run in Node mode**. After `connectClaudeDesktop`
writes `{ command: <app exe>, args: [<bundled dist/index.js>] }`, `main.js`
patches the entry to add `env: { ELECTRON_RUN_AS_NODE: "1" }`, so the resulting
`claude_desktop_config.json` entry is:

```json
{
  "mcpServers": {
    "affiliate": {
      "command": "/Applications/affiliate-mcp.app/Contents/MacOS/affiliate-mcp",
      "args": ["/Applications/affiliate-mcp.app/Contents/Resources/dist/index.js"],
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

`npm run dist` first builds the core (`npm --prefix .. run build`) then runs
electron-builder. The built `dist/` (the MCP server) and `design-system/` ship
as `extraResources`.

**Signing + notarisation are gated on env vars** — absent them, `npm run dist`
produces an unsigned `.dmg` and the notarise hook logs a skip (no crash):

| Env var | Purpose |
|---|---|
| `CSC_LINK` | Path/URL to the `.p12` signing certificate (electron-builder). |
| `CSC_KEY_PASSWORD` | Password for that certificate. |
| `APPLE_ID` | Apple Developer account email (notarisation). |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that account. |
| `APPLE_TEAM_ID` | Developer Team ID. |

The hardened runtime + entitlements (`build/entitlements.mac.plist`) are wired
for a notarised Electron app (`allow-jit`, unsigned-executable-memory,
disable-library-validation, allow-dyld-environment-variables — the last is
needed because we set `ELECTRON_RUN_AS_NODE` on the spawned server).

## Runtime env vars the human must supply

- `AFFILIATE_MCP_ISSUER_URL` — base URL of the Stripe issuer Worker. **Required
  for the in-app "Buy" button** to do anything; unset = buy is disabled with a
  clear message. (The Worker is built/deployed separately, plan §2A.)

## v1 scope notes

- **mac first**, signed + notarised (Apple licence in hand).
- **Launch-and-quit** — no tray yet (may revisit).
- App name in the OS: **affiliate-mcp**.
- Launch credential-help content: **Awin, Impact, Partnerize, CJ**.
- Fonts load from the Google CDN today; self-host (`marketing/fonts/`) for a
  fully offline build before release.
