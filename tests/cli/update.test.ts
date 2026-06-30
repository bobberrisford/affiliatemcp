import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PACKAGE_VERSION } from '../../src/shared/telemetry.js';
import { runUpdate } from '../../src/cli/update.js';
import { autoUpdateEnabled as isAutoUpdateEnabled } from '../../src/shared/update-check.js';

const NEWER = `${Number.parseInt(PACKAGE_VERSION.split('.')[0] ?? '0', 10) + 1}.0.0`;

describe('runUpdate', () => {
  let restoreEnv: Record<string, string | undefined>;

  beforeEach(() => {
    restoreEnv = {
      AFFILIATE_MCP_CONFIG_DIR: process.env['AFFILIATE_MCP_CONFIG_DIR'],
      AFFILIATE_MCP_UPDATE_CHECK: process.env['AFFILIATE_MCP_UPDATE_CHECK'],
      AFFILIATE_MCP_AUTO_UPDATE: process.env['AFFILIATE_MCP_AUTO_UPDATE'],
      AFFILIATE_MCP_SURFACE: process.env['AFFILIATE_MCP_SURFACE'],
    };
    process.env['AFFILIATE_MCP_CONFIG_DIR'] = mkdtempSync(path.join(tmpdir(), 'amcp-updcli-'));
    delete process.env['AFFILIATE_MCP_UPDATE_CHECK'];
    delete process.env['AFFILIATE_MCP_AUTO_UPDATE'];
    process.env['AFFILIATE_MCP_SURFACE'] = 'npm';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const [k, v] of Object.entries(restoreEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  function captureStderr(): () => string {
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    return () => spy.mock.calls.map((c) => String(c[0])).join('');
  }

  function stubFetch(version: string, ok = true): void {
    vi.stubGlobal(
      'fetch',
      (async () => ({ ok, json: async () => ({ version }) })) as unknown as typeof fetch,
    );
  }

  it('update check exits 1 and explains when the check is disabled', async () => {
    process.env['AFFILIATE_MCP_UPDATE_CHECK'] = '0';
    const out = captureStderr();
    expect(await runUpdate('check')).toBe(1);
    expect(out()).toContain('disabled');
  });

  it('update check reports up to date (exit 0) when the registry matches', async () => {
    stubFetch(PACKAGE_VERSION);
    const out = captureStderr();
    expect(await runUpdate('check')).toBe(0);
    expect(out()).toContain('up to date');
  });

  it('update check reports an available update with the upgrade path', async () => {
    stubFetch(NEWER);
    const out = captureStderr();
    expect(await runUpdate('check')).toBe(0);
    expect(out()).toContain(`${PACKAGE_VERSION} → ${NEWER}`);
  });

  it('update check exits 1 when the latest version cannot be determined', async () => {
    stubFetch('0.0.0', false);
    const out = captureStderr();
    expect(await runUpdate('check')).toBe(1);
    expect(out()).toContain('Could not determine');
  });

  it('bare update reports up to date without applying when current', async () => {
    stubFetch(PACKAGE_VERSION);
    const out = captureStderr();
    expect(await runUpdate()).toBe(0);
    expect(out()).toContain('up to date');
  });

  it('bare update on a host-managed surface prints the guided path, never npm', async () => {
    process.env['AFFILIATE_MCP_SURFACE'] = 'mcpb';
    stubFetch(NEWER);
    const out = captureStderr();
    expect(await runUpdate()).toBe(0);
    expect(out()).toContain('.mcpb');
  });

  it('enable/disable persist the auto-apply preference', async () => {
    const out = captureStderr();
    expect(await runUpdate('enable')).toBe(0);
    expect(isAutoUpdateEnabled()).toBe(true);
    expect(await runUpdate('disable')).toBe(0);
    expect(isAutoUpdateEnabled()).toBe(false);
    expect(out()).toContain('auto-apply');
  });

  it('rejects an unknown subcommand with exit 2', async () => {
    const out = captureStderr();
    expect(await runUpdate('frobnicate')).toBe(2);
    expect(out()).toContain('Unknown update subcommand');
  });
});
