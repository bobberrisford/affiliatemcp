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
const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('node:path');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const {
  compareVersions,
  desktopReleaseFeed,
  desktopReleasePage,
  selectLatestDesktopRelease,
} = require('./update-channel');

process.env.AFFILIATE_MCP_SURFACE = 'desktop-bundle';

/** Mixed server + desktop releases; desktop tags are selected explicitly. */
const RELEASES_API = 'https://api.github.com/repos/bobberrisford/affiliatemcp/releases?per_page=100';

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
  return win;
}

/** The app's single window — held so update events can be pushed to it. */
let mainWindow = null;
/** @type {{ tag: string, version: string } | null} */
let latestDesktopRelease = null;

if (gotInstanceLock) {
  app.whenReady().then(() => {
    mainWindow = createWindow();
    // Check for updates once the window exists so we can surface progress to it.
    // The download runs in the background while the user does setup; install
    // happens on quit (electron-updater default). Never blocks the UI.
    initAutoUpdates();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });
}

// Launch-and-quit: closing the window ends the app (no tray for v1).
app.on('window-all-closed', () => app.quit());

/* ------------------------------------------------------------------ */
/* Auto-update — electron-updater (Squirrel.Mac) + GitHub Releases.    */
/*                                                                     */
/* The app is launch-and-quit, so the ideal shape is check-on-launch / */
/* download-in-background / install-on-quit. electron-updater does all */
/* three by default (autoDownload + autoInstallOnAppQuit). We kick off  */
/* the check and relay its events to the renderer, which shows the      */
/* state as click-to-update buttons in the main UI ("restart & install" */
/* when ready) plus a user-triggered "check for updates" (update:check).*/
/*                                                                     */
/* Security: only updates whose signature + notarisation Squirrel.Mac  */
/* validates are installed (built in for Developer-ID apps), the feed  */
/* is HTTPS GitHub Releases, and version comparison only moves forward */
/* — no silent downgrade. See the auto-update decision doc.            */
/* ------------------------------------------------------------------ */

/**
 * Push an update-status message to the renderer. The shape is a small tagged
 * union the renderer switches on; see `renderer/app.js` (`onUpdateStatus`).
 * @param {{ state: string, [k: string]: unknown }} payload
 */
function sendUpdateStatus(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('update:status', payload);
  }
}

/**
 * Wire electron-updater and start the launch-time check.
 *
 * Only runs in the packaged, signed app — `autoUpdater` has no valid feed in
 * `electron .` dev and would throw. On any updater failure (download, signature,
 * unreachable feed) we fall back to a lightweight GitHub Releases version check
 * so the worst case is a "new version available → download" button, never a
 * silent dead end. The renderer's own "check for updates" button re-triggers
 * this same flow via the `update:check` IPC below.
 */
function initAutoUpdates() {
  if (!app.isPackaged) return; // dev build: no signed feed to check against.

  autoUpdater.autoDownload = true; // background download while the user sets up.
  autoUpdater.autoInstallOnAppQuit = true; // install-on-quit; no forced restart.

  autoUpdater.on('checking-for-update', () => {
    sendUpdateStatus({ state: 'checking' });
  });
  autoUpdater.on('update-available', (info) => {
    sendUpdateStatus({ state: 'downloading', version: info?.version });
  });
  autoUpdater.on('update-not-available', () => {
    sendUpdateStatus({ state: 'current' });
  });
  autoUpdater.on('download-progress', (p) => {
    sendUpdateStatus({ state: 'downloading', percent: Math.round(p?.percent ?? 0) });
  });
  autoUpdater.on('update-downloaded', (info) => {
    // Ready to install. We don't force it — the user finishes setup, and the
    // update installs when they quit. The UI offers an immediate restart button.
    sendUpdateStatus({ state: 'ready', version: info?.version });
  });
  autoUpdater.on('error', () => {
    // Squirrel/feed failure. Degrade to the manual-download button rather than
    // failing silently. We swallow the error here because it's been handled.
    void checkManualFallback();
  });

  void checkForDesktopUpdates();
}

/**
 * Find the latest `desktop-v*` release and use that release's asset directory as
 * the feed. This repository also publishes independently-versioned MCP server
 * releases (`v*`), so the GitHub provider's repository-wide `/releases/latest`
 * endpoint is not a valid desktop update channel.
 */
async function checkForDesktopUpdates() {
  try {
    const res = await fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) throw new Error(`GitHub releases request failed: ${res.status}`);
    const releases = await res.json();
    latestDesktopRelease = selectLatestDesktopRelease(Array.isArray(releases) ? releases : []);
    if (!latestDesktopRelease || !isNewer(latestDesktopRelease.version, app.getVersion())) {
      sendUpdateStatus({ state: 'current' });
      return;
    }

    autoUpdater.setFeedURL({
      provider: 'generic',
      url: desktopReleaseFeed(latestDesktopRelease.tag),
    });
    await autoUpdater.checkForUpdates();
  } catch {
    checkManualFallback();
  }
}

/**
 * Fallback after a desktop release was discovered but its update feed could not
 * be used. The download button opens that exact desktop release, never the
 * repository-wide latest release.
 */
function checkManualFallback() {
  if (latestDesktopRelease && isNewer(latestDesktopRelease.version, app.getVersion())) {
    sendUpdateStatus({ state: 'manual', version: latestDesktopRelease.version });
  } else {
    sendUpdateStatus({ state: 'unavailable' });
  }
}

function isNewer(a, b) {
  return compareVersions(a, b) > 0;
}

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

// ---- Deep-link into Claude with a pre-written prompt -----------------------

// `claude://claude.ai/new?q=…` opens Claude Desktop with the prompt pre-filled
// (the user reviews and sends it — it is never auto-submitted). This is a
// deliberate, narrow exception to the https-only `shell:openExternal` handler
// above: the MAIN process builds the whole URL from a fixed template and only
// the prompt TEXT crosses from the renderer, so no caller-supplied scheme or
// host is ever opened. Claude truncates `q` near 14k chars, so we refuse longer.
const CLAUDE_PROMPT_MAX = 14000;
handle('claude:openPrompt', async (_e, payload) => {
  const text = payload && typeof payload.text === 'string' ? payload.text.trim() : '';
  if (!text) {
    return { ok: false, error: 'No prompt text to open.' };
  }
  if (text.length > CLAUDE_PROMPT_MAX) {
    return { ok: false, error: 'That prompt is too long to open in Claude.' };
  }
  const q = encodeURIComponent(text);
  try {
    await shell.openExternal(`claude://claude.ai/new?q=${q}`);
    return { ok: true, target: 'desktop' };
  } catch {
    // Claude Desktop isn't installed or the scheme isn't registered — fall back
    // to the web app, which accepts the same `?q=` pre-fill.
    await shell.openExternal(`https://claude.ai/new?q=${q}`);
    return { ok: true, target: 'web' };
  }
});

// ---- Cockpit (daily attention flags) ---------------------------------------

// Compute the dashboard summary by calling the configured network's read
// operations directly through the bundled core. No model call, no tokens. We
// load credentials from the config dir first so the reads can authenticate.
handle('cockpit:summary', async () => {
  const { facade, config } = loadCore();
  config.loadConfig();
  const summary = await facade.computeCockpit();
  return { ok: true, summary };
});

// ---- Data locker (read-only: pull, view; export comes later) ---------------

// The locker pulls performance data through the SAME facade reads Claude's MCP
// server uses, so the desktop and Claude share one cache store and one error
// contract. Those reads already return a structured DataResult
// ({ ok:true, data } | { ok:false, error: NetworkErrorEnvelope }); we return it
// as-is. The app surfaces and exports this data — Claude interprets it.

handle('locker:networks', async () => {
  const { facade, config } = loadCore();
  config.loadConfig();
  return facade.listConfiguredNetworks();
});

handle('locker:earnings', async (_e, payload) => {
  const { facade, config } = loadCore();
  config.loadConfig();
  const { slug, query, brand } = payload || {};
  return facade.getEarnings(slug, query || {}, brand);
});

handle('locker:transactions', async (_e, payload) => {
  const { facade, config } = loadCore();
  config.loadConfig();
  const { slug, query, brand } = payload || {};
  return facade.listTransactions(slug, query || {}, brand);
});

// Save the already-pulled data the renderer hands us to a user-chosen local
// file. The renderer builds the CSV/JSON string (it has the rows); the main
// process owns the save dialog and the write — a renderer cannot touch the
// filesystem. Local only: nothing leaves the machine, and the user picks the
// path. The renderer never receives a path it didn't choose.
handle('locker:export', async (_e, payload) => {
  const content = payload && typeof payload.content === 'string' ? payload.content : '';
  if (!content) {
    return { ok: false, error: 'Nothing to export.' };
  }
  const suggestedName =
    payload && typeof payload.suggestedName === 'string' && payload.suggestedName.trim()
      ? payload.suggestedName.trim()
      : 'affiliate-export.csv';
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const { canceled, filePath } = await dialog.showSaveDialog(win, { defaultPath: suggestedName });
  if (canceled || !filePath) {
    return { ok: false, canceled: true };
  }
  fs.writeFileSync(filePath, content, 'utf8');
  return { ok: true, path: filePath };
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

handle('telemetry:getConsent', async () => {
  const { facade } = await loadCore();
  return { ok: true, consent: facade.getTelemetryConsent() };
});

handle('telemetry:setConsent', async (_e, enabled) => {
  const { facade } = await loadCore();
  return facade.saveTelemetryConsent(enabled === true);
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
    const connected = assertConnected(devResult);
    if (connected.ok) facade.recordDesktopInstallComplete();
    return connected;
  }
  const result = await facade.connectClaudeDesktop({
    nodePath: process.execPath, // the app's Electron executable
    serverPath: serverEntrypoint(), // bundled server.cjs
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      AFFILIATE_MCP_SURFACE: 'desktop-bundle',
    }, // run the bundled server as plain Node
  });
  const connected = assertConnected(result);
  if (connected.ok) facade.recordDesktopInstallComplete();
  return connected;
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

/** Run an AppleScript snippet; resolve with its trimmed stdout ('' on error). */
function osascript(script) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], (err, stdout) => {
      resolve(err ? '' : String(stdout || '').trim());
    });
  });
}

/**
 * Is Claude Desktop currently running? Uses AppleScript's `is running`, which —
 * unlike `tell application "Claude" to …` — does NOT launch the app as a
 * side-effect, so polling it is safe.
 */
async function claudeIsRunning() {
  return (await osascript('application "Claude" is running')) === 'true';
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

handle('claude:restart', async () => {
  // macOS: quit Claude (if running), wait for it to ACTUALLY exit, then relaunch.
  // MCP servers only load on a fresh launch — this is the step users forget.
  //
  // The previous version fired `open -a Claude` immediately after asking Claude
  // to quit. The quit is asynchronous, so `open` raced the shutdown: it either
  // no-op'd on the still-alive app or got torn down by the in-progress quit,
  // leaving Claude closed instead of restarted. We now poll until it has fully
  // exited before relaunching.
  if (process.platform !== 'darwin') {
    // TODO(win): implement a Windows restart (taskkill + start) in Phase 2.
    return { ok: false, error: 'Restarting Claude is only supported on macOS in v1.' };
  }

  const wasRunning = await claudeIsRunning();
  if (wasRunning) {
    await osascript('tell application "Claude" to quit');
    // Wait up to ~12s for a clean exit, polling so we relaunch the instant it's
    // gone rather than guessing a fixed delay.
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline && (await claudeIsRunning())) {
      await sleep(250);
    }
    if (await claudeIsRunning()) {
      // Still up (e.g. an unsaved-changes prompt blocked the quit). Don't fire
      // `open` into a half-quit app — tell the user to finish the restart.
      return {
        ok: false,
        error: 'Claude didn’t finish quitting. Quit it manually, then reopen it to load the tools.',
      };
    }
  }

  const launchErr = await new Promise((resolve) => {
    execFile('open', ['-a', 'Claude'], (err) => resolve(err));
  });
  if (launchErr) {
    return { ok: false, error: 'Couldn’t relaunch Claude. Open it yourself to load the new tools.' };
  }
  return { ok: true };
});

handle('app:quit', async () => {
  app.quit();
  return { ok: true };
});

// ---- Auto-update actions ---------------------------------------------------

// User-triggered "check for updates". Re-runs the same flow as the launch check;
// progress comes back over `update:status` events, not this return value. In dev
// (no signed feed) we report "up to date" so the button settles instead of
// hanging on "checking…".
handle('update:check', async () => {
  if (!app.isPackaged) {
    sendUpdateStatus({ state: 'current' });
    return { ok: true, dev: true };
  }
  sendUpdateStatus({ state: 'checking' });
  void checkForDesktopUpdates();
  return { ok: true };
});

// Install the already-downloaded update now. electron-updater quits the app and
// relaunches into the new version. Only meaningful after an `update-downloaded`
// event (state: 'ready'); a no-op otherwise.
handle('update:restart', async () => {
  autoUpdater.quitAndInstall();
  return { ok: true };
});

// Manual-fallback affordance: open the exact discovered desktop release so the
// user can grab the new .dmg by hand. The renderer cannot influence the tag or
// URL; both are selected and validated in the main process.
handle('update:openDownload', async () => {
  if (!latestDesktopRelease) {
    return { ok: false, error: 'No desktop update release is available.' };
  }
  await shell.openExternal(desktopReleasePage(latestDesktopRelease.tag));
  return { ok: true };
});
