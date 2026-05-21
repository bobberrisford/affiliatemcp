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

describe('runDoctor — env-value leak regression (PRD §15.4, Polish Chunk 10)', () => {
  it('never embeds env VALUES in the JSON output for a fully-populated config', async () => {
    // Write a `.env` resembling a real fully-populated user file. Every value
    // is a long, distinctive sentinel string we can grep for in the rendered
    // JSON. If any of these appear, the doctor command is leaking secrets.
    mkdirSync(tmp, { recursive: true });
    const sentinels: Record<string, string> = {
      AWIN_API_TOKEN: 'sentinel-awin-token-DO-NOT-PRINT-AAA111',
      AWIN_PUBLISHER_ID: 'sentinel-awin-publisher-DO-NOT-PRINT-BBB222',
      CJ_API_TOKEN: 'sentinel-cj-token-DO-NOT-PRINT-CCC333',
      CJ_COMPANY_ID: 'sentinel-cj-company-DO-NOT-PRINT-DDD444',
      IMPACT_ACCOUNT_SID: 'sentinel-impact-sid-DO-NOT-PRINT-EEE555',
      IMPACT_AUTH_TOKEN: 'sentinel-impact-token-DO-NOT-PRINT-FFF666',
      RAKUTEN_CLIENT_ID: 'sentinel-rakuten-client-id-DO-NOT-PRINT-GGG777',
      RAKUTEN_CLIENT_SECRET: 'sentinel-rakuten-secret-DO-NOT-PRINT-HHH888',
      RAKUTEN_SID: 'sentinel-rakuten-sid-DO-NOT-PRINT-III999',
    };
    const envText = Object.entries(sentinels)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n';
    writeFileSync(path.join(tmp, '.env'), envText);

    // Also populate process.env so any code path that reads from the live
    // env (rather than the file) is exercised too.
    const originalProcessEnv: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(sentinels)) {
      originalProcessEnv[k] = process.env[k];
      process.env[k] = v;
    }

    try {
      const report = await buildReport();
      const json = JSON.stringify(report);

      // The KEY NAMES must appear (we explicitly publish them).
      for (const key of Object.keys(sentinels)) {
        expect(report.config.keys).toContain(key);
      }

      // The VALUES must NEVER appear.
      for (const value of Object.values(sentinels)) {
        expect(
          json.includes(value),
          `doctor JSON leaked credential VALUE for one of the sentinels (${value.slice(0, 30)}...)`,
        ).toBe(false);
      }
    } finally {
      for (const k of Object.keys(sentinels)) {
        if (originalProcessEnv[k] === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = originalProcessEnv[k];
        }
      }
    }
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
