// @ts-check
/**
 * affiliate-mcp desktop — Electron main process.
 *
 * Scope (v1): a free, setup-only, launch-and-quit app. It runs the onboarding
 * UI, writes credentials + the Claude Desktop config, then the user quits. The
 * MCP server itself is NOT run here — Claude Desktop spawns it over stdio,
 * exactly as today (D9). This process only configures it.
 *
 * The IPC handlers below are the app's view of the core facade. Each one calls
 * into the BUILT core, which esbuild bundles into a self-contained CommonJS
 * file (`build/core.cjs`) we require() once and cache. There are no mocks in
 * the Electron path — if the bundle is missing we fail loudly.
 */
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');

// Single-instance: a second launch hands off to the running instance, which
// focuses its window rather than starting a duplicate setup process.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Core loader — require the self-contained CJS bundle, cached.        */
/*                                                                     */
/* The packaged app ships NO node_modules and NO `"type":"module"`     */
/* marker, so it can't load the raw ESM `dist/` tree. Instead esbuild  */
/* bundles the core + server into standalone CommonJS files            */
/* (`core.cjs` / `server.cjs`) that we require() directly. The core    */
/* bundle is flat — every symbol main.js needs as `facade.*` and       */
/* `config.*` lives on the one object — so we return it for both.      */
/* ------------------------------------------------------------------ */

/**
 * Resolve an absolute path to a shipped bundle.
 * - dev (`!app.isPackaged`): `desktop/build/<file>` (written by `npm run bundle`).
 * - packaged: the bundle sits directly under resourcesPath (extraResources).
 * @param {string} file e.g. 'core.cjs' | 'server.cjs'
 */
function bundlePath(file) {
  return app.isPackaged
    ? path.join(process.resourcesPath, file)
    : path.join(__dirname, 'build', file);
}

/** Absolute path to the bundled MCP server entrypoint (for the Claude config). */
function serverEntrypoint() {
  return bundlePath('server.cjs');
}

/** @type {{ facade: any, config: any } | null} */
let core = null;

/**
 * Load the built core once and cache it. Throws a clear, actionable error if
 * the bundle is missing — we never silently fall back to mock data here.
 *
 * The bundle is plain CommonJS, so a synchronous require() is enough; both
 * `facade` and `config` point at the same flat module.
 */
function loadCore() {
  if (core) return core;
  const corePath = bundlePath('core.cjs');
  if (!fs.existsSync(corePath)) {
    throw new Error(
      `affiliate-mcp core build not found at ${corePath}. ` +
        'Run `npm run build` in the repo root then `npm run bundle` in desktop/.',
    );
  }
  const mod = require(corePath);
  core = { facade: mod, config: mod };
  return core;
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
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Electron boundary: this is a setup app that writes credentials/config and
  // restarts Claude. Lock the renderer in. It may never spawn its own windows
  // (the renderer's only outbound link goes through the openExternal IPC, which
  // allowlists hosts) and may never navigate away from the bundled file.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault();
  });
}

if (gotInstanceLock) {
  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

// Launch-and-quit: closing the window ends the app (no tray for v1).
app.on('window-all-closed', () => app.quit());

/* ------------------------------------------------------------------ */
/* IPC — the core facade surface, wired to the built core.             */
/* ------------------------------------------------------------------ */

/**
 * Only the app's own bundled renderer (loaded over `file:`) may call privileged
 * IPC. Anything else — a navigated-away frame, an injected sub-frame — is
 * rejected before the handler runs. We can't compare against a fixed file URL
 * (it varies by install path), so we require the `file:` scheme and the top
 * frame; navigation is independently denied in `createWindow`.
 * @param {Electron.IpcMainInvokeEvent} event
 */
function isTrustedSender(event) {
  const frame = event.senderFrame;
  if (!frame) return false;
  if (frame.parent) return false; // sub-frames are never trusted
  try {
    return new URL(frame.url).protocol === 'file:';
  } catch {
    return false;
  }
}

/**
 * Register an IPC handler that always returns a structured result. Thrown
 * errors become `{ ok: false, error }` so a failure surfaces in the renderer
 * rather than crashing the main process. Calls from any frame other than the
 * app's own top-level `file:` renderer are refused.
 */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedSender(event)) {
      return { ok: false, error: 'Refused: untrusted IPC sender.' };
    }
    try {
      return await fn(event, ...args);
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });
}

// ---- Open external dashboard links (allowlisted) ---------------------------

/** @type {Set<string> | null} */
let externalHostsCache = null;

/**
 * The set of hostnames the renderer is allowed to open externally: every
 * `deepLink` host across every registered network's setup steps. Built from the
 * core (not a hand-maintained list) so it stays correct as networks are added,
 * and cached after first use. A network whose steps fail to load is skipped.
 */
function allowedExternalHosts() {
  if (externalHostsCache) return externalHostsCache;
  const { facade } = loadCore();
  const hosts = new Set();
  for (const net of facade.listNetworks()) {
    let steps;
    try {
      steps = facade.setupSteps(net.slug);
    } catch {
      continue;
    }
    for (const step of steps) {
      if (!step.deepLink) continue;
      try {
        hosts.add(new URL(step.deepLink).hostname.toLowerCase());
      } catch {
        // Ignore a malformed deepLink — it simply isn't allowlisted.
      }
    }
  }
  externalHostsCache = hosts;
  return hosts;
}

// Renderer dashboard links route through here instead of `window.open`. We
// permit only `https:` URLs whose host is one a shipped network setup step
// points at; everything else is refused with a structured error.
handle('shell:openExternal', async (_e, url) => {
  if (typeof url !== 'string') {
    return { ok: false, error: 'No URL to open.' };
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: 'That is not a valid URL.' };
  }
  if (parsed.protocol !== 'https:') {
    return { ok: false, error: 'Only https links can be opened.' };
  }
  if (!allowedExternalHosts().has(parsed.hostname.toLowerCase())) {
    return { ok: false, error: `Refused to open a non-allowlisted host: ${parsed.hostname}` };
  }
  await shell.openExternal(parsed.toString());
  return { ok: true };
});

// ---- Client detection ------------------------------------------------------

handle('clients:detect', async () => {
  const { facade } = await loadCore();
  // detectClients is async — it probes the filesystem and may shell out. Without
  // the await, `det` is a Promise and `det.desktop` is undefined, so the UI would
  // always report Claude Desktop as absent even when it is installed.
  const det = await facade.detectClients();
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
  // second Node binary. The config entry's `command` is the app executable, its
  // single arg is the bundled server.cjs, and `env` flips Electron into plain
  // Node mode. Without that env Claude would launch the GUI instead of the MCP
  // server — so it is part of the entry, written in ONE atomic/backup pass by
  // the facade (no second hand-patch of the file afterwards).
  //
  // Dev: pass no paths so the facade falls back to `npx affiliate-networks-mcp`.
  if (!app.isPackaged) {
    const devResult = await facade.connectClaudeDesktop();
    return assertConnected(devResult);
  }
  const result = await facade.connectClaudeDesktop({
    nodePath: process.execPath, // the app's Electron executable
    serverPath: serverEntrypoint(), // bundled server.cjs
    env: { ELECTRON_RUN_AS_NODE: '1' }, // run the bundled server as plain Node
  });
  return assertConnected(result);
});

/**
 * Treat a facade `DesktopEditResult` as a connect outcome the UI can trust.
 * The facade returns `{ action: 'absent' }` (no config written) on platforms
 * Claude Desktop doesn't support; everything else means the entry was written.
 * A genuine write failure throws inside the facade and is caught by `handle`,
 * so it never reaches here as a success.
 * @param {{ path?: string, action?: string, backupPath?: string }} result
 */
function assertConnected(result) {
  if (!result || result.action === 'absent') {
    return {
      ok: false,
      error:
        'Could not write the Claude Desktop config. Claude Desktop was not found, ' +
        'or this platform is unsupported.',
    };
  }
  return { ok: true, ...result };
}

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
