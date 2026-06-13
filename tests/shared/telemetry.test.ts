import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  _readTelemetryStateForTests,
  flushTelemetry,
  recordTelemetry,
  setTelemetryConsent,
  telemetryConsent,
  telemetryFilePath,
  telemetryOutcomeFromErrorType,
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
