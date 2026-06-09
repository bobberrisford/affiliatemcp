// End-to-end smoke for the desktop app's REAL main process, driven through the
// REAL preload bridge (window.affiliate.*). This is the layer the renderer's
// in-file mock cannot stand in for: IPC await/return-shape, the facade wired
// into the bundled core, and the openExternal allowlist. The detect test below
// is the regression guard for the un-awaited detectClients() bug (it returned a
// Promise, so the UI always showed Claude Desktop as "absent").
//
// Safety: HOME and AFFILIATE_MCP_CONFIG_DIR are pointed at throwaway temp dirs
// so nothing here can touch the developer's real ~/.affiliate-mcp or Claude
// config. We deliberately do NOT exercise connect/restart — connect resolves
// the Claude config via os.homedir() (not the sandboxable env) and restart
// drives a live app; both are covered by the facade unit tests instead.

import { test, expect, _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let app;
let page;
let home;
let configDir;
let userDataDir;

test.beforeAll(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'amcp-e2e-home-'));
  configDir = mkdtempSync(path.join(tmpdir(), 'amcp-e2e-cfg-'));
  userDataDir = mkdtempSync(path.join(tmpdir(), 'amcp-e2e-userdata-'));
  app = await electron.launch({
    // A dedicated --user-data-dir keys the single-instance lock to this run, so
    // the test is always the primary instance even when an installed/dev copy
    // of the app is already running (otherwise main.js's lock check quits it).
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: desktopDir,
    env: {
      ...process.env,
      HOME: home,
      AFFILIATE_MCP_CONFIG_DIR: configDir,
    },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  // The preload bridge must be present — otherwise every test below would be
  // silently exercising the browser mock instead of real IPC.
  await page.waitForFunction(() => Boolean(window.affiliate), null, { timeout: 15_000 });
});

test.afterAll(async () => {
  await app?.close();
  if (home) rmSync(home, { recursive: true, force: true });
  if (configDir) rmSync(configDir, { recursive: true, force: true });
  if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
});

test('detectClients resolves to a real state string (regression: un-awaited handler)', async () => {
  const det = await page.evaluate(() => window.affiliate.detectClients());
  // The bug returned a Promise from the handler, so det.desktop was undefined.
  expect(det).toBeTruthy();
  expect(typeof det.desktop).toBe('string');
  expect(['present', 'absent', 'notSupported']).toContain(det.desktop);
});

test('listNetworks returns real adapters over IPC', async () => {
  const nets = await page.evaluate(() => window.affiliate.listNetworks());
  expect(Array.isArray(nets)).toBe(true);
  expect(nets.length).toBeGreaterThan(0);
  expect(nets[0]).toHaveProperty('slug');
  expect(nets[0]).toHaveProperty('name');
  expect(['publisher', 'brand']).toContain(nets[0].side);
});

test('setupSteps returns fields for a known network', async () => {
  const steps = await page.evaluate(() => window.affiliate.setupSteps('awin'));
  expect(Array.isArray(steps)).toBe(true);
  expect(steps.length).toBeGreaterThan(0);
  expect(steps[0]).toHaveProperty('field');
  expect(steps[0]).toHaveProperty('label');
});

test('saveEnv writes to the sandboxed config dir and returns ok', async () => {
  const res = await page.evaluate(() => window.affiliate.saveEnv({ E2E_SMOKE_KEY: 'e2e-value' }));
  expect(res.ok).toBe(true);
  expect(typeof res.path).toBe('string');
  // The write must land inside our throwaway config dir, never the real one.
  expect(res.path.startsWith(configDir)).toBe(true);
  expect(existsSync(res.path)).toBe(true);
  expect(readFileSync(res.path, 'utf8')).toContain('E2E_SMOKE_KEY');
});

test('openExternal refuses non-allowlisted and non-https URLs', async () => {
  const offHost = await page.evaluate(() => window.affiliate.openExternal('https://evil.example.com/phish'));
  expect(offHost.ok).toBe(false);

  const notHttps = await page.evaluate(() => window.affiliate.openExternal('file:///etc/passwd'));
  expect(notHttps.ok).toBe(false);

  const garbage = await page.evaluate(() => window.affiliate.openExternal('not a url'));
  expect(garbage.ok).toBe(false);
});

test('UI renders real network tiles from IPC (welcome → picker)', async () => {
  // Drive the actual UI, not the mock: the picker must populate from the real
  // listNetworks IPC call.
  const expected = await page.evaluate(() => window.affiliate.listNetworks().then((n) => n.length));
  await page.click('#start');
  await page.waitForSelector('.net', { timeout: 15_000 });
  const tiles = await page.locator('.net').count();
  expect(tiles).toBe(expected);
});
