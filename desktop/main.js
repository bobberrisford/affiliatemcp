// @ts-check
/**
 * affiliate-mcp desktop — Electron main process.
 *
 * Scope (v1): a setup-only, launch-and-quit app. It runs the onboarding UI,
 * writes credentials + the Claude Desktop config, then the user quits. The MCP
 * server itself is NOT run here — Claude Desktop spawns it over stdio, exactly
 * as today (D9). This process only configures it.
 *
 * The IPC handlers below are the app's view of the core facade. Each one calls
 * into the BUILT core (`dist/core/facade.js` + `dist/shared/config.js`), loaded
 * once via dynamic import (the core is ESM; this file is CommonJS). There are
 * no mocks in the Electron path — if the build is missing we fail loudly.
 */
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

/* ------------------------------------------------------------------ */
/* Core loader — dynamic import of the BUILT ESM output, cached.       */
/* ------------------------------------------------------------------ */

/**
 * Resolve the directory that holds the built `dist/` tree.
 * - dev (`!app.isPackaged`): the repo's `dist/` one level up from `desktop/`.
 * - packaged: `dist/` is shipped as an extraResource under resourcesPath.
 */
function distDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'dist')
    : path.join(__dirname, '..', 'dist');
}

/** Absolute path to the bundled MCP server entrypoint (for the Claude config). */
function serverEntrypoint() {
  return path.join(distDir(), 'index.js');
}

/** @type {Promise<{ facade: any, config: any }> | null} */
let corePromise = null;

/**
 * Load the built core once and cache it. Throws a clear, actionable error if
 * the build output is missing — we never silently fall back to mock data here.
 */
function loadCore() {
  if (corePromise) return corePromise;
  corePromise = (async () => {
    const facadePath = path.join(distDir(), 'core', 'facade.js');
    const configPath = path.join(distDir(), 'shared', 'config.js');
    if (!fs.existsSync(facadePath) || !fs.existsSync(configPath)) {
      throw new Error(
        `affiliate-mcp core build not found at ${distDir()}. ` +
          'Run `npm run build` in the repo root first.',
      );
    }
    // pathToFileURL keeps Windows paths + spaces in the path valid for import().
    const { pathToFileURL } = require('node:url');
    const facade = await import(pathToFileURL(facadePath).href);
    const config = await import(pathToFileURL(configPath).href);
    return { facade, config };
  })().catch((err) => {
    // Reset so a later call can retry (e.g. after the user runs the build).
    corePromise = null;
    throw err;
  });
  return corePromise;
}

function createWindow() {
  const win = new BrowserWindow({
    width: 920,
    height: 760,
    minWidth: 720,
    minHeight: 620,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0B0B0C',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Launch-and-quit: closing the window ends the app (no tray for v1).
app.on('window-all-closed', () => app.quit());

/* ------------------------------------------------------------------ */
/* IPC — the core facade surface, wired to the built core.             */
/* ------------------------------------------------------------------ */

/**
 * Register an IPC handler that always returns a structured result. Thrown
 * errors become `{ ok: false, error }` so a failure surfaces in the renderer
 * rather than crashing the main process.
 */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return await fn(event, ...args);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

// ---- Licence (offline verify; the only paid-feature gate, app-shell only) --

handle('licence:read', async () => {
  const { config } = await loadCore();
  const res = config.readLicence();
  if (res && res.valid) return { email: res.email, issued: res.issued };
  return null; // null = not activated (renderer shows the gate)
});

handle('licence:activate', async (_e, key) => {
  const { config } = await loadCore();
  const res = config.verifyLicenceToken(typeof key === 'string' ? key.trim() : '');
  if (!res.valid) return { ok: false, error: res.reason };
  // Persist verbatim, single line, mode 0600 (dir 0700) at <CONFIG_DIR>/licence.
  const override = process.env.AFFILIATE_MCP_CONFIG_DIR;
  const dir = override && override.trim() !== '' ? override : config.CONFIG_DIR;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, 'licence'), typeof key === 'string' ? key.trim() : '', {
    mode: 0o600,
  });
  return { ok: true, licence: { email: res.email, issued: res.issued } };
});

handle('licence:buy', async () => {
  // In-app buy → the issuer Worker's /checkout (Stripe Checkout Sessions, §2A).
  // The Worker is built/deployed separately; its URL is supplied at release via
  // AFFILIATE_MCP_ISSUER_URL. With no URL there is nothing real to open, so we
  // refuse rather than send the user to a placeholder. (HONESTY: no fake URL.)
  const issuer = process.env.AFFILIATE_MCP_ISSUER_URL;
  if (!issuer || issuer.trim() === '') {
    return { ok: false, error: 'Checkout is not configured yet (issuer URL unset).' };
  }
  const res = await fetch(issuer.replace(/\/$/, '') + '/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) {
    return { ok: false, error: `Checkout request failed (${res.status}).` };
  }
  const data = await res.json();
  if (!data || typeof data.url !== 'string') {
    return { ok: false, error: 'Checkout did not return a URL.' };
  }
  await shell.openExternal(data.url);
  return { ok: true };
});

// ---- Client detection ------------------------------------------------------

handle('clients:detect', async () => {
  const { facade } = await loadCore();
  const det = facade.detectClients();
  // Renderer reads only { desktop, desktopConfigPath }.
  return { desktop: det.desktop, desktopConfigPath: det.desktopConfigPath };
});

// ---- Networks --------------------------------------------------------------

handle('networks:list', async () => {
  const { facade } = await loadCore();
  return facade.listNetworks();
});

handle('networks:steps', async (_e, slug) => {
  const { facade } = await loadCore();
  return facade.setupSteps(slug);
});

handle('networks:validateField', async (_e, { slug, field, value }) => {
  const { facade } = await loadCore();
  return facade.validateField(slug, field, value);
});

handle('networks:verifyAuth', async (_e, { slug, values }) => {
  const { facade } = await loadCore();
  return facade.verifyAuth(slug, values || {});
});

handle('networks:discoverBrands', async (_e, slug) => {
  const { facade } = await loadCore();
  return facade.discoverBrands(slug);
});

// ---- Config + brands persistence ------------------------------------------

handle('config:saveEnv', async (_e, entries) => {
  const { facade } = await loadCore();
  return facade.saveEnv(entries || {});
});

handle('claude:saveBrands', async (_e, { network, selections }) => {
  const { facade } = await loadCore();
  return facade.saveBrands(network, selections || []);
});

// ---- Connect to Claude Desktop --------------------------------------------

handle('claude:connect', async () => {
  const { facade } = await loadCore();
  // Packaged: point Claude at the bundled server, run via THIS app's own
  // Electron binary in Node mode (ELECTRON_RUN_AS_NODE=1) so we don't ship a
  // second Node binary. The config entry's `command` is the app executable and
  // its single arg is the bundled dist/index.js. We pass the env through
  // `nodePath`/`serverPath`; addAffiliateEntry writes { command, args }. The
  // ELECTRON_RUN_AS_NODE flag is injected into the entry below.
  //
  // Dev: pass no paths so the facade falls back to `npx affiliate-networks-mcp`.
  if (!app.isPackaged) {
    return facade.connectClaudeDesktop();
  }
  const result = await facade.connectClaudeDesktop({
    nodePath: process.execPath, // the app's Electron executable
    serverPath: serverEntrypoint(), // bundled dist/index.js
  });
  // The facade builds { command: <appExe>, args: [<server>] } but cannot set an
  // env on the entry. Patch the written config so Electron runs as plain Node.
  // (resolveDesktopConfigPath is darwin/win only; result.path is empty on Linux.)
  if (result && result.path && fs.existsSync(result.path)) {
    try {
      const raw = JSON.parse(fs.readFileSync(result.path, 'utf8'));
      if (raw && raw.mcpServers && raw.mcpServers.affiliate) {
        raw.mcpServers.affiliate.env = {
          ...(raw.mcpServers.affiliate.env || {}),
          ELECTRON_RUN_AS_NODE: '1',
        };
        fs.writeFileSync(result.path, JSON.stringify(raw, null, 2) + '\n');
      }
    } catch {
      // Leave the entry as-written; a missing env only means slower/edge spawn.
    }
  }
  return result;
});

handle('claude:restart', async () => {
  // macOS: quit Claude (if running) then relaunch it. We use AppleScript to ask
  // it to quit cleanly, then `open -a` to relaunch. MCP servers only load on a
  // fresh launch — this is the step users forget.
  if (process.platform !== 'darwin') {
    // TODO(win): implement a Windows restart (taskkill + start) in Phase 2.
    return { ok: false, error: 'Restarting Claude is only supported on macOS in v1.' };
  }
  await new Promise((resolve) => {
    // `quit` is best-effort: if Claude isn't running, osascript errors harmlessly.
    execFile('osascript', ['-e', 'tell application "Claude" to quit'], () => resolve(undefined));
  });
  await new Promise((resolve, reject) => {
    execFile('open', ['-a', 'Claude'], (err) => (err ? reject(err) : resolve(undefined)));
  });
  return { ok: true };
});

handle('app:quit', async () => {
  app.quit();
  return { ok: true };
});
