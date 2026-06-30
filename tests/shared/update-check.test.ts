import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PACKAGE_VERSION } from '../../src/shared/telemetry.js';
import {
  _readUpdateCheckStateForTests,
  checkForUpdate,
  compareVersions,
  fetchLatestVersion,
  formatUpdateNotice,
  updateCheckEnabled,
  updateInstructionForSurface,
} from '../../src/shared/update-check.js';

const NEWER = `${Number.parseInt(PACKAGE_VERSION.split('.')[0] ?? '0', 10) + 1}.0.0`;

/** A `fetch` stand-in that records call count and returns a fixed registry body. */
function fakeRegistry(version: string | null, ok = true): { fn: typeof fetch; calls: () => number } {
  let count = 0;
  const fn = (async () => {
    count += 1;
    return {
      ok,
      json: async () => (version === null ? {} : { version }),
    };
  }) as unknown as typeof fetch;
  return { fn, calls: () => count };
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
