import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PACKAGE_VERSION } from '../../src/shared/telemetry.js';
import {
  _readUpdateCheckStateForTests,
  applyUpdate,
  autoUpdateEnabled,
  checkForUpdate,
  type CommandRunner,
  compareVersions,
  fetchLatestVersion,
  formatUpdateNotice,
  REGISTRY_LATEST_URL,
  setAutoUpdate,
  updateCheckEnabled,
  updateInstructionForSurface,
} from '../../src/shared/update-check.js';

const NEWER = `${Number.parseInt(PACKAGE_VERSION.split('.')[0] ?? '0', 10) + 1}.0.0`;

interface FakeRegistry {
  fn: typeof fetch;
  calls: () => number;
  lastUrl: () => unknown;
  lastInit: () => RequestInit | undefined;
}

/** A `fetch` stand-in that records its call args and returns a fixed registry body. */
function fakeRegistry(version: string | null, ok = true): FakeRegistry {
  let count = 0;
  let url: unknown;
  let init: RequestInit | undefined;
  const fn = (async (u: unknown, i?: RequestInit) => {
    count += 1;
    url = u;
    init = i;
    return {
      ok,
      json: async () => (version === null ? {} : { version }),
    };
  }) as unknown as typeof fetch;
  return { fn, calls: () => count, lastUrl: () => url, lastInit: () => init };
}

const NOW = new Date('2026-06-30T10:00:00Z');

describe('compareVersions', () => {
  it('orders core versions numerically', () => {
    expect(compareVersions('0.12.0', '0.11.0')).toBe(1);
    expect(compareVersions('0.11.0', '0.12.0')).toBe(-1);
    expect(compareVersions('0.11.0', '0.11.0')).toBe(0);
    expect(compareVersions('1.0.0', '0.99.99')).toBe(1);
    expect(compareVersions('0.11.10', '0.11.9')).toBe(1);
  });

  it('treats a final release as newer than a prerelease of the same core', () => {
    expect(compareVersions('0.11.0', '0.11.0-beta.1')).toBe(1);
    expect(compareVersions('0.11.0-beta.1', '0.11.0')).toBe(-1);
  });

  it('returns 0 for unparseable input so no false update is claimed', () => {
    expect(compareVersions('not-a-version', '0.11.0')).toBe(0);
    expect(compareVersions('0.11.0', 'garbage')).toBe(0);
  });
});

describe('updateCheckEnabled', () => {
  const original = process.env['AFFILIATE_MCP_UPDATE_CHECK'];
  afterEach(() => {
    if (original === undefined) delete process.env['AFFILIATE_MCP_UPDATE_CHECK'];
    else process.env['AFFILIATE_MCP_UPDATE_CHECK'] = original;
  });

  it('defaults on and honours explicit opt-out values', () => {
    delete process.env['AFFILIATE_MCP_UPDATE_CHECK'];
    expect(updateCheckEnabled()).toBe(true);
    for (const off of ['0', 'false', 'no', 'off', 'OFF']) {
      process.env['AFFILIATE_MCP_UPDATE_CHECK'] = off;
      expect(updateCheckEnabled()).toBe(false);
    }
    process.env['AFFILIATE_MCP_UPDATE_CHECK'] = '1';
    expect(updateCheckEnabled()).toBe(true);
  });
});

describe('updateInstructionForSurface', () => {
  it('gives a re-install instruction for the desktop bundle and an npx hint otherwise', () => {
    expect(updateInstructionForSurface('mcpb')).toContain('.mcpb');
    expect(updateInstructionForSurface('desktop-bundle')).toContain('Extensions');
    expect(updateInstructionForSurface('npm')).toContain('npx -y affiliate-networks-mcp@latest');
    expect(updateInstructionForSurface('unknown')).toContain('@latest');
  });
});

describe('fetchLatestVersion', () => {
  it('returns the version on a good response and undefined otherwise', async () => {
    expect(await fetchLatestVersion(fakeRegistry('0.12.0').fn)).toBe('0.12.0');
    expect(await fetchLatestVersion(fakeRegistry(null).fn)).toBeUndefined();
    expect(await fetchLatestVersion(fakeRegistry('0.12.0', false).fn)).toBeUndefined();
    const thrower = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await fetchLatestVersion(thrower)).toBeUndefined();
  });

  it('issues an anonymous, header-only GET to the registry endpoint', async () => {
    const reg = fakeRegistry('0.12.0');
    await fetchLatestVersion(reg.fn);
    expect(reg.lastUrl()).toBe(REGISTRY_LATEST_URL);
    const init = reg.lastInit();
    // No method override means GET; no body and no auth/cookie headers — the
    // same shape npm itself uses, so nothing identifying is sent.
    expect(init?.method).toBeUndefined();
    expect(init?.body).toBeUndefined();
    expect(init?.headers).toEqual({ accept: 'application/json' });
  });
});

describe('checkForUpdate', () => {
  let restoreEnv: Record<string, string | undefined>;

  beforeEach(() => {
    restoreEnv = {
      AFFILIATE_MCP_CONFIG_DIR: process.env['AFFILIATE_MCP_CONFIG_DIR'],
      AFFILIATE_MCP_UPDATE_CHECK: process.env['AFFILIATE_MCP_UPDATE_CHECK'],
      AFFILIATE_MCP_SURFACE: process.env['AFFILIATE_MCP_SURFACE'],
    };
    process.env['AFFILIATE_MCP_CONFIG_DIR'] = mkdtempSync(path.join(tmpdir(), 'amcp-upd-'));
    delete process.env['AFFILIATE_MCP_UPDATE_CHECK'];
    process.env['AFFILIATE_MCP_SURFACE'] = 'npm';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(restoreEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('reports an available update from the registry and caches it for the day', async () => {
    const reg = fakeRegistry(NEWER);
    const first = await checkForUpdate({ now: NOW, fetchFn: reg.fn });
    expect(first).toMatchObject({ current: PACKAGE_VERSION, latest: NEWER, updateAvailable: true });
    expect(reg.calls()).toBe(1);
    expect(_readUpdateCheckStateForTests()).toMatchObject({ latestVersion: NEWER });

    // Same UTC day → served from cache, no second registry hit.
    const second = await checkForUpdate({ now: NOW, fetchFn: reg.fn });
    expect(second?.updateAvailable).toBe(true);
    expect(reg.calls()).toBe(1);
  });

  it('reports up to date when the registry matches the running version', async () => {
    const info = await checkForUpdate({ now: NOW, fetchFn: fakeRegistry(PACKAGE_VERSION).fn });
    expect(info).toMatchObject({ updateAvailable: false, latest: PACKAGE_VERSION });
  });

  it('re-fetches when force is set even within the same day', async () => {
    const reg = fakeRegistry(NEWER);
    await checkForUpdate({ now: NOW, fetchFn: reg.fn });
    await checkForUpdate({ now: NOW, fetchFn: reg.fn, force: true });
    expect(reg.calls()).toBe(2);
  });

  it('returns undefined when disabled', async () => {
    process.env['AFFILIATE_MCP_UPDATE_CHECK'] = '0';
    const reg = fakeRegistry(NEWER);
    expect(await checkForUpdate({ now: NOW, fetchFn: reg.fn })).toBeUndefined();
    expect(reg.calls()).toBe(0);
  });

  it('returns undefined when the registry is unreachable and nothing is cached', async () => {
    const reg = fakeRegistry(null, false);
    expect(await checkForUpdate({ now: NOW, fetchFn: reg.fn })).toBeUndefined();
  });

  it('falls back to the cached version when a later fetch fails', async () => {
    await checkForUpdate({ now: NOW, fetchFn: fakeRegistry(NEWER).fn });
    const nextDay = new Date('2026-07-01T10:00:00Z');
    const info = await checkForUpdate({ now: nextDay, fetchFn: fakeRegistry(null, false).fn });
    expect(info).toMatchObject({ latest: NEWER, updateAvailable: true });
  });
});

function fakeRunner(ok: boolean): { fn: CommandRunner; calls: () => string[][] } {
  const recorded: string[][] = [];
  const fn: CommandRunner = async (command, args) => {
    recorded.push([command, ...args]);
    return { ok, code: ok ? 0 : 1, stderr: ok ? '' : 'npm error: EACCES' };
  };
  return { fn, calls: () => recorded };
}

describe('auto-apply', () => {
  let restoreEnv: Record<string, string | undefined>;
  const SEED = new Date('2026-06-30T10:00:00Z');
  const SOAKED = new Date('2026-07-01T12:00:00Z'); // >24h later, different UTC day

  beforeEach(() => {
    restoreEnv = {
      AFFILIATE_MCP_CONFIG_DIR: process.env['AFFILIATE_MCP_CONFIG_DIR'],
      AFFILIATE_MCP_UPDATE_CHECK: process.env['AFFILIATE_MCP_UPDATE_CHECK'],
      AFFILIATE_MCP_AUTO_UPDATE: process.env['AFFILIATE_MCP_AUTO_UPDATE'],
      AFFILIATE_MCP_AUTO_UPDATE_MIN_AGE_HOURS: process.env['AFFILIATE_MCP_AUTO_UPDATE_MIN_AGE_HOURS'],
      AFFILIATE_MCP_SURFACE: process.env['AFFILIATE_MCP_SURFACE'],
    };
    process.env['AFFILIATE_MCP_CONFIG_DIR'] = mkdtempSync(path.join(tmpdir(), 'amcp-apply-'));
    delete process.env['AFFILIATE_MCP_UPDATE_CHECK'];
    delete process.env['AFFILIATE_MCP_AUTO_UPDATE'];
    delete process.env['AFFILIATE_MCP_AUTO_UPDATE_MIN_AGE_HOURS'];
    process.env['AFFILIATE_MCP_SURFACE'] = 'npm';
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(restoreEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** Seed the cache so a newer version has been "first seen" at SEED. */
  async function seed(): Promise<void> {
    await checkForUpdate({ now: SEED, fetchFn: fakeRegistry(NEWER).fn });
  }

  it('reads the opt-in from env then persisted state, defaulting off', () => {
    expect(autoUpdateEnabled()).toBe(false);
    setAutoUpdate(true);
    expect(autoUpdateEnabled()).toBe(true);
    process.env['AFFILIATE_MCP_AUTO_UPDATE'] = 'off'; // env overrides state
    expect(autoUpdateEnabled()).toBe(false);
  });

  it('applies via npm install -g once the release has soaked', async () => {
    await seed();
    const runner = fakeRunner(true);
    const result = await applyUpdate({ now: SOAKED, fetchFn: fakeRegistry(NEWER).fn, runner: runner.fn });
    expect(result).toMatchObject({ applied: true, reason: 'applied', latest: NEWER });
    expect(runner.calls()).toHaveLength(1);
    expect(runner.calls()[0]).toEqual([
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      'install',
      '-g',
      `affiliate-networks-mcp@${NEWER}`,
    ]);
  });

  it('holds back a release that has not soaked, without running npm', async () => {
    await seed();
    const runner = fakeRunner(true);
    // Same instant as seed → age 0h < 24h soak.
    const result = await applyUpdate({ now: SEED, fetchFn: fakeRegistry(NEWER).fn, runner: runner.fn });
    expect(result.reason).toBe('too_new');
    expect(result.applied).toBe(false);
    expect(runner.calls()).toHaveLength(0);
  });

  it('ignoreSoak applies immediately (explicit user action)', async () => {
    await seed();
    const runner = fakeRunner(true);
    const result = await applyUpdate({
      now: SEED,
      fetchFn: fakeRegistry(NEWER).fn,
      runner: runner.fn,
      ignoreSoak: true,
    });
    expect(result.applied).toBe(true);
    expect(runner.calls()).toHaveLength(1);
  });

  it('never self-applies on a host-managed surface', async () => {
    process.env['AFFILIATE_MCP_SURFACE'] = 'mcpb';
    await seed();
    const runner = fakeRunner(true);
    const result = await applyUpdate({
      now: SOAKED,
      fetchFn: fakeRegistry(NEWER).fn,
      runner: runner.fn,
      ignoreSoak: true,
    });
    expect(result.reason).toBe('host_managed');
    expect(runner.calls()).toHaveLength(0);
  });

  it('reports command_failed and keeps the current version when npm fails', async () => {
    await seed();
    const runner = fakeRunner(false);
    const result = await applyUpdate({
      now: SOAKED,
      fetchFn: fakeRegistry(NEWER).fn,
      runner: runner.fn,
      ignoreSoak: true,
    });
    expect(result).toMatchObject({ applied: false, reason: 'command_failed' });
    expect(result.detail).toContain('EACCES');
  });

  it('reports up_to_date and never runs npm when already current', async () => {
    const runner = fakeRunner(true);
    const result = await applyUpdate({
      now: SOAKED,
      fetchFn: fakeRegistry(PACKAGE_VERSION).fn,
      runner: runner.fn,
      ignoreSoak: true,
    });
    expect(result.reason).toBe('up_to_date');
    expect(runner.calls()).toHaveLength(0);
  });
});

describe('formatUpdateNotice', () => {
  it('names the version delta and the upgrade path', () => {
    const notice = formatUpdateNotice({
      current: '0.11.0',
      latest: '0.12.0',
      updateAvailable: true,
      surface: 'npm',
    });
    expect(notice).toContain('0.11.0 → 0.12.0');
    expect(notice).toContain('@latest');
  });
});
