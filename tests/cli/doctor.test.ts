/**
 * Tests for `affiliate-mcp doctor` — verbose diagnostic.
 *
 * Asserts that the JSON report includes environment info, the config path
 * (respecting AFFILIATE_MCP_CONFIG_DIR), the masked variable list (names
 * only, never values), and the per-network resilience config.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildReport, runDoctor } from '../../src/cli/doctor.js';
import { _clearRegistry, registerAdapter } from '../../src/shared/registry.js';
import { makeFakeAdapter } from './fakes.js';

let tmp: string;
let originalConfigDir: string | undefined;
let stdoutWrites: string[];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let stdoutSpy: any;

beforeEach(() => {
  _clearRegistry();
  tmp = mkdtempSync(path.join(tmpdir(), 'amcp-doctor-'));
  originalConfigDir = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  process.env['AFFILIATE_MCP_CONFIG_DIR'] = tmp;
  stdoutWrites = [];
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdoutWrites.push(typeof chunk === 'string' ? chunk : String(chunk));
    return true;
  });
});

afterEach(() => {
  stdoutSpy.mockRestore();
  if (originalConfigDir === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
  else process.env['AFFILIATE_MCP_CONFIG_DIR'] = originalConfigDir;
});

describe('buildReport — environment + config info', () => {
  it('includes Node version, platform, and the resolved config path', async () => {
    const report = await buildReport();
    expect(report.environment.nodeVersion).toBe(process.version);
    expect(report.environment.platform).toBe(process.platform);
    expect(report.config.path).toBe(path.join(tmp, '.env'));
    expect(report.config.present).toBe(false);
    expect(report.config.keys).toEqual([]);
  });

  it('lists config variable NAMES only — never values', async () => {
    mkdirSync(tmp, { recursive: true });
    writeFileSync(
      path.join(tmp, '.env'),
      'ALPHA_TOKEN=very-secret-do-not-print\nBETA_TOKEN=also-secret\n',
    );
    const report = await buildReport();
    expect(report.config.present).toBe(true);
    expect(report.config.keys.sort()).toEqual(['ALPHA_TOKEN', 'BETA_TOKEN']);
    const json = JSON.stringify(report);
    expect(json).not.toContain('very-secret-do-not-print');
    expect(json).not.toContain('also-secret');
  });

  it('includes per-network resilience config and claim status', async () => {
    registerAdapter(
      makeFakeAdapter({
        slug: 'alpha',
        name: 'Alpha',
        steps: [],
        capabilities: async () => ({
          network: 'alpha',
          generatedAt: new Date().toISOString(),
          operations: { verifyAuth: { supported: true, latencyMs: 10 } },
          knownLimitations: [],
        }),
      }),
    );
    const report = await buildReport();
    expect(report.adapters).toHaveLength(1);
    const adapter = report.adapters[0]!;
    expect(adapter.slug).toBe('alpha');
    expect(adapter.claimStatus).toBe('experimental');
    expect(adapter.resilience.default).toBeDefined();
    expect(typeof adapter.resilience.default.timeoutMs).toBe('number');
  });
});

describe('runDoctor — JSON output to stdout', () => {
  it('prints a parseable JSON document containing the diagnostic envelope', async () => {
    registerAdapter(
      makeFakeAdapter({
        slug: 'alpha',
        name: 'Alpha',
        steps: [],
        capabilities: async () => ({
          network: 'alpha',
          generatedAt: new Date().toISOString(),
          operations: { verifyAuth: { supported: true, latencyMs: 12 } },
          knownLimitations: [],
        }),
      }),
    );
    const code = await runDoctor();
    expect(code).toBe(0);

    const text = stdoutWrites.join('');
    const parsed = JSON.parse(text);
    expect(parsed.environment.nodeVersion).toBe(process.version);
    expect(parsed.config.path).toBe(path.join(tmp, '.env'));
    expect(parsed.diagnostic.results).toHaveLength(1);
    expect(parsed.diagnostic.results[0].network).toBe('alpha');
  });
});
