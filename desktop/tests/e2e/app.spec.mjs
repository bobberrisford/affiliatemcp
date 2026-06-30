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

test('telemetry consent is explicit and persisted separately from credentials', async () => {
  const initial = await page.evaluate(() => window.affiliate.getTelemetryConsent());
  expect(initial.consent).toBe('unset');
  const enabled = await page.evaluate(() => window.affiliate.setTelemetryConsent(true));
  expect(enabled).toMatchObject({ ok: true, enabled: true });
  expect(existsSync(path.join(configDir, 'telemetry.json'))).toBe(true);
  expect(readFileSync(path.join(configDir, 'telemetry.json'), 'utf8')).not.toContain('E2E_SMOKE_KEY');
  const disabled = await page.evaluate(() => window.affiliate.setTelemetryConsent(false));
  expect(disabled).toMatchObject({ ok: true, enabled: false });
});

test('openExternal refuses non-allowlisted and non-https URLs', async () => {
  const offHost = await page.evaluate(() => window.affiliate.openExternal('https://evil.example.com/phish'));
  expect(offHost.ok).toBe(false);

  const notHttps = await page.evaluate(() => window.affiliate.openExternal('file:///etc/passwd'));
  expect(notHttps.ok).toBe(false);

  const garbage = await page.evaluate(() => window.affiliate.openExternal('not a url'));
  expect(garbage.ok).toBe(false);
});

test('preload exposes the auto-update bridge (subscribe + the two actions)', async () => {
  // The renderer's update banner depends on these three members existing on the
  // real bridge. We assert the contract only — invoking restartToUpdate would
  // quit the app and openUpdateDownload would open a browser. In dev the main
  // process never starts the updater (it's gated on app.isPackaged), so this is
  // purely the IPC surface, not a live update check.
  const surface = await page.evaluate(() => ({
    onUpdateStatus: typeof window.affiliate.onUpdateStatus,
    checkForUpdates: typeof window.affiliate.checkForUpdates,
    restartToUpdate: typeof window.affiliate.restartToUpdate,
    openUpdateDownload: typeof window.affiliate.openUpdateDownload,
  }));
  expect(surface.onUpdateStatus).toBe('function');
  expect(surface.checkForUpdates).toBe('function');
  expect(surface.restartToUpdate).toBe('function');
  expect(surface.openUpdateDownload).toBe('function');
});

test('the welcome update card round-trips a check (dev build reports up to date)', async () => {
  // The welcome screen shows a "check for updates" button. Clicking it round-trips
  // through the real update:check IPC. In the unpackaged e2e build there's no
  // signed feed, so main reports "current" and the card settles on "latest
  // version" with a "check again" button — it must NOT hang on "checking…".
  // This exercises the full button → IPC → onUpdateStatus → repaint loop.
  await page.waitForSelector('#update-card #u-check', { timeout: 5_000 });
  await page.click('#update-card #u-check');
  await page.waitForFunction(
    () => /latest version/i.test(document.getElementById('update-card')?.textContent || ''),
    null,
    { timeout: 5_000 },
  );
  const hasCheckAgain = await page.locator('#update-card #u-check').count();
  expect(hasCheckAgain).toBe(1);
});

test('discoverBrands returns an array for a multi-brand network with no list endpoint', async () => {
  // cj-advertiser is multi-brand but has no enumeration endpoint, so listBrands
  // throws NotImplementedError and the facade returns []. The brands screen
  // relies on this being a real array (not a thrown error turned into
  // { ok:false }) — otherwise its .forEach would throw a secondary error. This
  // guards the empty-multi-brand → manual-entry path.
  const brands = await page.evaluate(() => window.affiliate.discoverBrands('cj-advertiser'));
  expect(Array.isArray(brands)).toBe(true);
  expect(brands.length).toBe(0);
});

test('saveBrands skips invalid slugs and reports a short count (renderer cross-checks this)', async () => {
  // saveBrands silently skips slugs that fail the brand-slug rule and returns
  // the number actually written. The brands screen compares this count with the
  // submitted selection length and blocks advancement on a shortfall, so a user
  // can't finish with brands missing from brands.json.
  const res = await page.evaluate(() => window.affiliate.saveBrands('cj-advertiser', [
    { networkBrandId: '111', slug: 'good-brand' },
    { networkBrandId: '222', slug: 'Bad Slug!' },
  ]));
  expect(res.ok).toBe(true);
  expect(res.count).toBe(1);
});

test('saveBrands rejects duplicate nicknames instead of silently overwriting', async () => {
  // Two distinct brand IDs sharing the nickname "acme" would collide on the
  // (slug, network) key — the second overwriting the first while count reported
  // 2. The facade throws, which the IPC wrapper surfaces as { ok:false }.
  const res = await page.evaluate(() => window.affiliate.saveBrands('cj-advertiser', [
    { networkBrandId: '111', slug: 'acme' },
    { networkBrandId: '222', slug: 'acme' },
  ]));
  expect(res.ok).toBe(false);
  expect(String(res.error)).toMatch(/duplicate brand nickname/i);
});

test('cockpit:summary returns a structured summary over IPC (unconfigured here)', async () => {
  // The sandbox config dir has no credentials, so the real Awin adapter is
  // registered but unconfigured. computeCockpit must report that cleanly — a
  // structured summary with configured:false and a flags array — without a
  // single outbound network call (the configured check is credential-presence).
  const res = await page.evaluate(() => window.affiliate.cockpitSummary());
  expect(res.ok).toBe(true);
  expect(res.summary).toBeTruthy();
  expect(res.summary.configured).toBe(false);
  expect(Array.isArray(res.summary.flags)).toBe(true);
  expect(res.summary.flags.length).toBeGreaterThan(0);
});

test('locker:networks returns an array (empty in the unconfigured sandbox)', async () => {
  // The data-locker picker lists only networks with credentials present. The
  // sandbox config dir has none, so this is an empty array — never a thrown
  // error turned into { ok:false } (the renderer .filter()s it directly).
  const nets = await page.evaluate(() => window.affiliate.lockerNetworks());
  expect(Array.isArray(nets)).toBe(true);
  expect(nets.length).toBe(0);
});

test('locker:transactions surfaces a structured error for an unconfigured network', async () => {
  // No credentials in the sandbox, so the real Awin read can't authenticate.
  // The facade returns a structured DataResult with ok:false and a
  // NetworkErrorEnvelope — never faked into success, never an empty table.
  const res = await page.evaluate(() => window.affiliate.lockerTransactions('awin', { from: '2026-01-01', to: '2026-01-31' }));
  expect(res.ok).toBe(false);
  expect(res.error).toBeTruthy();
  expect(typeof res.error.type).toBe('string');
});

test('claude:openPrompt refuses empty and over-length prompts (no open side-effect)', async () => {
  // We assert only the refusal paths, which return before any shell.openExternal
  // — exactly as the openExternal test above avoids triggering a real open. The
  // happy path would launch Claude (or a browser fallback), so it isn't driven
  // here; the renderer builds the URL only in the main process regardless.
  const empty = await page.evaluate(() => window.affiliate.openClaudePrompt('   '));
  expect(empty.ok).toBe(false);

  const tooLong = await page.evaluate(() => window.affiliate.openClaudePrompt('x'.repeat(20_000)));
  expect(tooLong.ok).toBe(false);
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
