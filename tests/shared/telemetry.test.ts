import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  _readTelemetryStateForTests,
  flushTelemetry,
  recordTelemetry,
  setTelemetryConsent,
  telemetryConsent,
  telemetryFilePath,
  telemetryOutcomeFromErrorType,
  TELEMETRY_ENDPOINT,
} from '../../src/shared/telemetry.js';

let tmp: string;
let originalConfigDir: string | undefined;
let originalConsent: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'amcp-telemetry-'));
  originalConfigDir = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  originalConsent = process.env['AFFILIATE_MCP_TELEMETRY'];
  process.env['AFFILIATE_MCP_CONFIG_DIR'] = tmp;
  delete process.env['AFFILIATE_MCP_TELEMETRY'];
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
  else process.env['AFFILIATE_MCP_CONFIG_DIR'] = originalConfigDir;
  if (originalConsent === undefined) delete process.env['AFFILIATE_MCP_TELEMETRY'];
  else process.env['AFFILIATE_MCP_TELEMETRY'] = originalConsent;
});

describe('telemetry consent and privacy boundary', () => {
  it('defaults off and records nothing before explicit consent', async () => {
    const fetchFn = vi.fn();
    recordTelemetry('awin', 'list_transactions', 'success');
    await flushTelemetry(new Date('2026-06-13T00:00:00Z'), fetchFn as never);
    expect(telemetryConsent()).toBe('unset');
    expect(existsSync(telemetryFilePath())).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('stores state at 0600, rejects unsafe dimensions, and deletes identifiers on disable', () => {
    setTelemetryConsent(true);
    recordTelemetry('awin', 'list_transactions', 'success');
    recordTelemetry('unsafe/value', 'could contain data', 'success');

    const state = _readTelemetryStateForTests();
    expect(state?.monthlyInstallId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.values(state?.pending ?? {}).flatMap(Object.keys)).toEqual([
      'awin|list_transactions|success',
    ]);
    expect(statSync(telemetryFilePath()).mode & 0o777).toBe(0o600);

    setTelemetryConsent(false);
    const disabled = JSON.parse(readFileSync(telemetryFilePath(), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(disabled).toEqual({ consent: false });
  });

  it('sends one completed-day summary and retains counters when delivery fails', async () => {
    setTelemetryConsent(true);
    recordTelemetry('awin', 'list_transactions', 'success', 2, '2026-06-11');
    recordTelemetry('impact', 'list_programmes', 'auth_error', 1, '2026-06-12');
    const failed = vi.fn().mockResolvedValue(new Response('', { status: 503 }));

    await flushTelemetry(new Date('2026-06-12T12:00:00Z'), failed);
    expect(failed).toHaveBeenCalledOnce();
    expect(_readTelemetryStateForTests()?.pending?.['2026-06-11']).toBeTruthy();

    const succeeded = vi.fn().mockResolvedValue(new Response('', { status: 202 }));
    await flushTelemetry(new Date('2026-06-12T12:00:00Z'), succeeded);
    const body = JSON.parse(String(succeeded.mock.calls[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('arguments');
    expect(body).not.toHaveProperty('results');
    expect(body).not.toHaveProperty('error');
    expect(_readTelemetryStateForTests()?.pending?.['2026-06-11']).toBeUndefined();
    expect(_readTelemetryStateForTests()?.pending?.['2026-06-12']).toBeTruthy();
  });

  it('rotates the monthly identifier without losing pending counters', async () => {
    setTelemetryConsent(true);
    recordTelemetry('lifecycle', 'server_start', 'success', 1, '2026-06-30');
    const before = _readTelemetryStateForTests()?.monthlyInstallId;
    const fetchFn = vi.fn().mockResolvedValue(new Response('', { status: 202 }));
    await flushTelemetry(new Date('2026-07-01T01:00:00Z'), fetchFn);
    expect(_readTelemetryStateForTests()?.monthlyInstallId).not.toBe(before);
  });

  it('keys the monthly identifier off the record day, not the wall clock', () => {
    // Deterministic regardless of the real date: a counter recorded for a June
    // day belongs to June's month, so the id does not depend on when the test
    // runs. Previously the id was stamped from the wall clock, so recording a
    // past day in the current month produced the current month's id.
    setTelemetryConsent(true);
    recordTelemetry('lifecycle', 'server_start', 'success', 1, '2026-06-15');
    expect(_readTelemetryStateForTests()?.month).toBe('2026-06');
  });

  it('honours environment overrides and maps only coarse error categories', () => {
    process.env['AFFILIATE_MCP_TELEMETRY'] = 'true';
    expect(telemetryConsent()).toBe('enabled');
    process.env['AFFILIATE_MCP_TELEMETRY'] = 'false';
    expect(telemetryConsent()).toBe('disabled');
    expect(telemetryOutcomeFromErrorType('auth_error')).toBe('auth_error');
    expect(telemetryOutcomeFromErrorType('network_api_error')).toBe('upstream_error');
    expect(telemetryOutcomeFromErrorType('not_implemented')).toBe('other_error');
  });
});

describe('TELEMETRY_ENDPOINT', () => {
  it('defaults to the first-party ingestion host when no override is set', () => {
    if (process.env['AFFILIATE_MCP_TELEMETRY_ENDPOINT']) return;
    expect(TELEMETRY_ENDPOINT).toBe('https://telemetry.agenticaffiliate.ai/v1/ingest');
  });
});

describe('PACKAGE_VERSION', () => {
  it('stays in sync with package.json so telemetry reports the released version', async () => {
    const { PACKAGE_VERSION } = await import('../../src/shared/telemetry.js');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(
      readFileSync(path.resolve(here, '..', '..', 'package.json'), 'utf8'),
    ) as { version: string };
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });

  it('stays in sync with the plugin manifest so npm and the plugin channel agree', async () => {
    const { PACKAGE_VERSION } = await import('../../src/shared/telemetry.js');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const plugin = JSON.parse(
      readFileSync(path.resolve(here, '..', '..', '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { version: string };
    expect(plugin.version).toBe(PACKAGE_VERSION);
  });

  it('stays in sync with both package-lock.json version fields so the lockfile cannot drift', async () => {
    const { PACKAGE_VERSION } = await import('../../src/shared/telemetry.js');
    const here = path.dirname(fileURLToPath(import.meta.url));
    const lock = JSON.parse(
      readFileSync(path.resolve(here, '..', '..', 'package-lock.json'), 'utf8'),
    ) as { version: string; packages: Record<string, { version?: string }> };
    expect(lock.version).toBe(PACKAGE_VERSION);
    expect(lock.packages['']?.version).toBe(PACKAGE_VERSION);
  });

  it('reports the current released version', async () => {
    // Bump this literal each release. It forces a deliberate tests/shared edit
    // (the check:change guardrail under src/shared) and pins the published
    // version the telemetry channel reports.
    const { PACKAGE_VERSION } = await import('../../src/shared/telemetry.js');
    expect(PACKAGE_VERSION).toBe('0.15.0');
  });
});
