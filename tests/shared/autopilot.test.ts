/**
 * Tests for `src/shared/autopilot.ts`.
 *
 * Covers:
 *   - path resolution honours AFFILIATE_MCP_CONFIG_DIR on every call
 *   - threshold parsing from the fenced marker block (numbers, strings, comments)
 *   - first-run defaults (no state, brands appear in clients with empty intent)
 *   - save/load state round-trip + atomic write + mode 0600
 *   - save/load client intent round-trip
 *   - loadAutopilotContext stitches book + intent + last state together
 *   - id validation rejects path-traversal attempts
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { saveBrands } from '../../src/shared/brands.js';
import {
  loadAutopilotContext,
  loadAutopilotState,
  loadClientIntent,
  parseKpiThresholds,
  resolveStateFile,
  saveAutopilotState,
  saveClientIntent,
} from '../../src/shared/autopilot.js';

let tmp: string;
let original: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'amcp-autopilot-'));
  original = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  process.env['AFFILIATE_MCP_CONFIG_DIR'] = tmp;
});

afterEach(() => {
  if (original === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
  else process.env['AFFILIATE_MCP_CONFIG_DIR'] = original;
});

describe('resolveStateFile', () => {
  it('honours AFFILIATE_MCP_CONFIG_DIR on every call', () => {
    expect(resolveStateFile('weekly')).toBe(path.join(tmp, 'autopilot', 'weekly', 'state.json'));
  });

  it('rejects path-traversal loop names', () => {
    expect(() => resolveStateFile('../escape')).toThrow(/Invalid loop/);
    expect(() => resolveStateFile('a/b')).toThrow(/Invalid loop/);
  });
});

describe('parseKpiThresholds', () => {
  it('returns {} when there is no marker block', () => {
    expect(parseKpiThresholds('# Acme KPIs\n\nGrow revenue.')).toEqual({});
  });

  it('parses numbers and strings, ignoring comments and prose', () => {
    const md = [
      '# Acme KPIs',
      '',
      'Some prose the model reads.',
      '',
      '```',
      '# affiliate-mcp:thresholds',
      '# the line above is the marker',
      'revenue_drop_wow_pct: 15',
      'reversal_rate_max_pct: 8   # ceiling',
      'reporting_voice: "concise"',
      '```',
      '',
      'more prose, ignored',
    ].join('\n');
    expect(parseKpiThresholds(md)).toEqual({
      revenue_drop_wow_pct: 15,
      reversal_rate_max_pct: 8,
      reporting_voice: 'concise',
    });
  });

  it('stops at a blank line within the block', () => {
    const md = ['# affiliate-mcp:thresholds', 'a: 1', '', 'b: 2'].join('\n');
    expect(parseKpiThresholds(md)).toEqual({ a: 1 });
  });
});

describe('loadClientIntent', () => {
  it('returns empty prose and no thresholds when files are absent', () => {
    expect(loadClientIntent('acme')).toEqual({
      slug: 'acme',
      strategyMd: '',
      kpiMd: '',
      thresholds: {},
    });
  });

  it('reads back what saveClientIntent wrote', () => {
    saveClientIntent('acme', {
      strategyMd: 'Grow content partners.',
      kpiMd: '# affiliate-mcp:thresholds\nrevenue_drop_wow_pct: 20',
    });
    const intent = loadClientIntent('acme');
    expect(intent.strategyMd).toMatch(/content partners/);
    expect(intent.thresholds).toEqual({ revenue_drop_wow_pct: 20 });
  });

  it('updates only the file that is passed', () => {
    saveClientIntent('acme', { strategyMd: 'v1', kpiMd: 'k1' });
    saveClientIntent('acme', { strategyMd: 'v2' });
    const intent = loadClientIntent('acme');
    expect(intent.strategyMd.trim()).toBe('v2');
    expect(intent.kpiMd.trim()).toBe('k1');
  });
});

describe('saveAutopilotState + loadAutopilotState', () => {
  it('returns null before the first run', () => {
    expect(loadAutopilotState('weekly')).toBeNull();
  });

  it('round-trips the snapshot payload verbatim', () => {
    const data = { 'acme|impact-advertiser': { grossSale: 4200, findings: [{ id: 'drop', state: 'new' }] } };
    saveAutopilotState('weekly', data, '# Digest\n\nAll quiet.');
    const loaded = loadAutopilotState('weekly');
    expect(loaded?.version).toBe(1);
    expect(loaded?.loop).toBe('weekly');
    expect(loaded?.data).toEqual(data);
    expect(typeof loaded?.updatedAt).toBe('string');
  });

  it('writes state.json with mode 0600 and leaves no .tmp behind', () => {
    saveAutopilotState('weekly', { ok: true });
    const file = resolveStateFile('weekly');
    expect(statSync(file).mode & 0o077).toBe(0);
    expect(existsSync(`${file}.tmp`)).toBe(false);
  });

  it('writes the digest only when provided', () => {
    saveAutopilotState('weekly', { ok: true });
    expect(existsSync(path.join(tmp, 'autopilot', 'weekly', 'digest.md'))).toBe(false);
    saveAutopilotState('weekly', { ok: true }, 'hello');
    expect(existsSync(path.join(tmp, 'autopilot', 'weekly', 'digest.md'))).toBe(true);
  });

  it('throws on malformed state JSON rather than silently resetting', () => {
    saveAutopilotState('weekly', { ok: true }); // creates the dir + a good file
    writeFileSync(resolveStateFile('weekly'), '{ not json');
    expect(() => loadAutopilotState('weekly')).toThrow(/not valid JSON/);
  });
});

describe('loadAutopilotContext', () => {
  it('stitches the book, intent, and last state together', () => {
    saveBrands({
      version: 1,
      brands: {
        acme: [{ network: 'impact-advertiser', credentialId: 'default', networkBrandId: 'IA-1' }],
        globex: [{ network: 'cj-advertiser', credentialId: 'default', networkBrandId: 'CJ-9' }],
      },
    });
    saveClientIntent('acme', { kpiMd: '# affiliate-mcp:thresholds\nrevenue_drop_wow_pct: 15' });
    saveAutopilotState('weekly', { prev: true });

    const ctx = loadAutopilotContext('weekly');
    expect(ctx.bindings).toHaveLength(2);
    expect(ctx.clients.map((c) => c.slug)).toEqual(['acme', 'globex']);
    // Brand with no intent file still appears (so the digest can prompt for targets).
    expect(ctx.clients.find((c) => c.slug === 'globex')?.thresholds).toEqual({});
    expect(ctx.clients.find((c) => c.slug === 'acme')?.thresholds).toEqual({
      revenue_drop_wow_pct: 15,
    });
    expect((ctx.lastState?.data as { prev: boolean }).prev).toBe(true);
  });

  it('returns an empty book and null state on a clean install', () => {
    const ctx = loadAutopilotContext('weekly');
    expect(ctx.bindings).toEqual([]);
    expect(ctx.clients).toEqual([]);
    expect(ctx.lastState).toBeNull();
  });
});
