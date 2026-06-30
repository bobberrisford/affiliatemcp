import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { PACKAGE_VERSION } from '../../src/shared/telemetry.js';
import { runUpdate } from '../../src/cli/update.js';

describe('runUpdate', () => {
  let restoreEnv: Record<string, string | undefined>;

  beforeEach(() => {
    restoreEnv = {
      AFFILIATE_MCP_CONFIG_DIR: process.env['AFFILIATE_MCP_CONFIG_DIR'],
      AFFILIATE_MCP_UPDATE_CHECK: process.env['AFFILIATE_MCP_UPDATE_CHECK'],
      AFFILIATE_MCP_REGISTRY_URL: process.env['AFFILIATE_MCP_REGISTRY_URL'],
    };
    process.env['AFFILIATE_MCP_CONFIG_DIR'] = mkdtempSync(path.join(tmpdir(), 'amcp-updcli-'));
    delete process.env['AFFILIATE_MCP_UPDATE_CHECK'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    for (const [k, v] of Object.entries(restoreEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  /** Spy on stderr and return a getter for everything written to it. */
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

  it('exits 1 and explains when the check is disabled', async () => {
    process.env['AFFILIATE_MCP_UPDATE_CHECK'] = '0';
    const out = captureStderr();
    expect(await runUpdate()).toBe(1);
    expect(out()).toContain('disabled');
  });

  it('reports up to date (exit 0) when the registry matches', async () => {
    stubFetch(PACKAGE_VERSION);
    const out = captureStderr();
    expect(await runUpdate()).toBe(0);
    expect(out()).toContain('up to date');
  });

  it('reports an available update (exit 0) with the upgrade path', async () => {
    const newer = `${Number.parseInt(PACKAGE_VERSION.split('.')[0] ?? '0', 10) + 1}.0.0`;
    stubFetch(newer);
    const out = captureStderr();
    expect(await runUpdate()).toBe(0);
    expect(out()).toContain(`${PACKAGE_VERSION} → ${newer}`);
  });

  it('exits 1 when the latest version cannot be determined', async () => {
    stubFetch('0.0.0', false);
    const out = captureStderr();
    expect(await runUpdate()).toBe(1);
    expect(out()).toContain('Could not determine');
  });
});
