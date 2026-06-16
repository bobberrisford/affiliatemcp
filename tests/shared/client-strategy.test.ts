/**
 * Tests for `src/shared/client-strategy.ts`.
 *
 * Covers:
 *   - path resolution honouring AFFILIATE_MCP_CONFIG_DIR
 *   - load/save round-trip for Strategy.md and KPI.md
 *   - missing files are absent, not errors
 *   - atomic write + mode 0600
 *   - slug validation on write
 *   - KPI grammar: valid parse, missing/unsupported version, malformed lines,
 *     unknown metric, unit rules, comments, no/multiple blocks — all returned
 *     as errors, never thrown
 *   - orphan vs registered vs on-disk detection
 *   - listClientStrategies enumeration
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { saveBrands } from '../../src/shared/brands.js';
import {
  isOrphan,
  listClientStrategies,
  loadClientStrategy,
  loadKpi,
  loadStrategy,
  parseKpiBlock,
  resolveClientDir,
  resolveKpiFile,
  resolveStrategyFile,
  saveKpi,
  saveStrategy,
} from '../../src/shared/client-strategy.js';

let tmp: string;
let originalConfigDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'amcp-client-'));
  originalConfigDir = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  process.env['AFFILIATE_MCP_CONFIG_DIR'] = tmp;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
  else process.env['AFFILIATE_MCP_CONFIG_DIR'] = originalConfigDir;
});

const VALID_KPI = `# Acme targets

\`\`\`kpi
# targets: metric: comparator value [unit] [per period]
version: 1
revenue: >= 400000 GBP per quarter
conversions: >= 1200 per month
epc: >= 0.45 GBP
reversal_rate: <= 8% per month
\`\`\`
`;

describe('path resolution', () => {
  it('honours AFFILIATE_MCP_CONFIG_DIR on every call', () => {
    expect(resolveClientDir('acme')).toBe(path.join(tmp, 'clients', 'acme'));
    expect(resolveStrategyFile('acme')).toBe(path.join(tmp, 'clients', 'acme', 'Strategy.md'));
    expect(resolveKpiFile('acme')).toBe(path.join(tmp, 'clients', 'acme', 'KPI.md'));
  });
});

describe('load missing files', () => {
  it('treats a missing Strategy.md as absent, not an error', () => {
    expect(loadStrategy('acme')).toEqual({ present: false });
  });
  it('treats a missing KPI.md as absent, not an error', () => {
    expect(loadKpi('acme')).toEqual({ present: false });
  });
});

describe('save + load round-trip', () => {
  it('persists and reads back Strategy.md', () => {
    saveStrategy('acme', 'Premium partners preferred.');
    const s = loadStrategy('acme');
    expect(s.present).toBe(true);
    expect(s.markdown).toBe('Premium partners preferred.\n');
  });

  it('persists KPI.md and parses it on load', () => {
    saveKpi('acme', VALID_KPI);
    const k = loadKpi('acme');
    expect(k.present).toBe(true);
    expect(k.parsed?.version).toBe(1);
    expect(k.parsed?.errors).toEqual([]);
    expect(k.parsed?.targets).toHaveLength(4);
  });

  it('writes files with mode 0600', () => {
    saveStrategy('acme', 'x');
    const stat = statSync(resolveStrategyFile('acme'));
    expect(stat.mode & 0o077).toBe(0);
  });

  it('writes atomically — no .tmp sibling lingers', () => {
    saveKpi('acme', VALID_KPI);
    expect(existsSync(resolveKpiFile('acme'))).toBe(true);
    expect(existsSync(`${resolveKpiFile('acme')}.tmp`)).toBe(false);
  });

  it('appends a trailing newline', () => {
    saveStrategy('acme', 'no newline');
    expect(loadStrategy('acme').markdown?.endsWith('\n')).toBe(true);
  });

  it('rejects an invalid slug and writes nothing', () => {
    expect(() => saveStrategy('Bad Slug!', 'x')).toThrow(/invalid/i);
    expect(existsSync(path.join(tmp, 'clients', 'Bad Slug!'))).toBe(false);
  });

  it('rejects invalid slugs on read paths too', () => {
    expect(() => loadStrategy('../outside')).toThrow(/invalid/i);
    expect(() => loadKpi('../outside')).toThrow(/invalid/i);
    expect(() => isOrphan('../outside')).toThrow(/invalid/i);
  });
});

describe('parseKpiBlock — valid', () => {
  it('parses a well-formed block', () => {
    const r = parseKpiBlock(VALID_KPI);
    expect(r.version).toBe(1);
    expect(r.errors).toEqual([]);
    expect(r.targets).toContainEqual({
      metric: 'revenue',
      comparator: '>=',
      value: 400000,
      unit: 'GBP',
      period: 'quarter',
    });
    expect(r.targets).toContainEqual({
      metric: 'conversions',
      comparator: '>=',
      value: 1200,
      period: 'month',
    });
    expect(r.targets).toContainEqual({
      metric: 'epc',
      comparator: '>=',
      value: 0.45,
      unit: 'GBP',
    });
    expect(r.targets).toContainEqual({
      metric: 'reversal_rate',
      comparator: '<=',
      value: 8,
      unit: '%',
      period: 'month',
    });
  });

  it('uppercases currency units and ignores comments/blank lines', () => {
    const r = parseKpiBlock('```kpi\nversion: 1\n\n# a note\nrevenue: >= 100 gbp\n```');
    expect(r.errors).toEqual([]);
    expect(r.targets[0]?.unit).toBe('GBP');
  });
});

describe('parseKpiBlock — errors are returned, never thrown', () => {
  it('reports a missing fenced block', () => {
    const r = parseKpiBlock('Just prose, no block.');
    expect(r.targets).toEqual([]);
    expect(r.errors[0]?.reason).toMatch(/no fenced ```kpi block/);
  });

  it('reports multiple fenced blocks instead of silently ignoring extras', () => {
    const r = parseKpiBlock(
      '```kpi\nversion: 1\nrevenue: >= 100 GBP\n```\n\n```kpi\nversion: 1\nepc: >= 0.5 GBP\n```',
    );
    expect(r.targets).toEqual([]);
    expect(r.errors[0]?.reason).toMatch(/expected exactly one fenced ```kpi block/);
  });

  it('reports a missing version marker for the whole block', () => {
    const r = parseKpiBlock('```kpi\nrevenue: >= 100 GBP\n```');
    expect(r.targets).toEqual([]);
    expect(r.errors[0]?.reason).toMatch(/version: 1/);
  });

  it('reports an empty or comments-only block as missing the version marker', () => {
    const r = parseKpiBlock('```kpi\n# no targets yet\n\n```');
    expect(r.targets).toEqual([]);
    expect(r.errors[0]?.reason).toMatch(/version: 1/);
  });

  it('reports an unsupported version', () => {
    const r = parseKpiBlock('```kpi\nversion: 2\nrevenue: >= 100 GBP\n```');
    expect(r.version).toBe(2);
    expect(r.targets).toEqual([]);
    expect(r.errors[0]?.reason).toMatch(/unsupported kpi version 2/);
  });

  it('reports an unknown metric but keeps valid siblings', () => {
    const r = parseKpiBlock('```kpi\nversion: 1\nrevenue: >= 100 GBP\nmargin: >= 20%\n```');
    expect(r.targets).toHaveLength(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.reason).toMatch(/unknown metric "margin"/);
  });

  it('reports a malformed line', () => {
    const r = parseKpiBlock('```kpi\nversion: 1\nrevenue is high\n```');
    expect(r.errors[0]?.reason).toMatch(/malformed target line/);
  });

  it('rejects a rate metric with a non-% unit', () => {
    const r = parseKpiBlock('```kpi\nversion: 1\nreversal_rate: <= 8 GBP\n```');
    expect(r.errors[0]?.reason).toMatch(/unit must be %/);
  });

  it('rejects a monetary metric with a non-currency unit', () => {
    const r = parseKpiBlock('```kpi\nversion: 1\nrevenue: >= 100 %\n```');
    expect(r.errors[0]?.reason).toMatch(/3-letter currency/);
  });

  it('rejects a unit on a count metric', () => {
    const r = parseKpiBlock('```kpi\nversion: 1\nconversions: >= 100 GBP\n```');
    expect(r.errors[0]?.reason).toMatch(/takes no unit/);
  });

  it('reports an unknown period', () => {
    const r = parseKpiBlock('```kpi\nversion: 1\nrevenue: >= 100 GBP per fortnight\n```');
    expect(r.errors[0]?.reason).toMatch(/unknown period "fortnight"/);
  });

  it('carries a 1-based line number relative to the whole file', () => {
    const md = 'line one\nline two\n```kpi\nversion: 1\nbroken line here\n```';
    const r = parseKpiBlock(md);
    expect(r.errors[0]?.line).toBe(5);
  });
});

describe('isOrphan', () => {
  it('is false when no client dir exists', () => {
    expect(isOrphan('acme')).toBe(false);
  });

  it('is true when a client dir exists but no brand binding', () => {
    mkdirSync(resolveClientDir('acme'), { recursive: true });
    writeFileSync(resolveStrategyFile('acme'), 'x\n');
    expect(isOrphan('acme')).toBe(true);
  });

  it('is false when the slug is bound in brands.json', () => {
    mkdirSync(resolveClientDir('acme'), { recursive: true });
    saveBrands({
      version: 1,
      brands: {
        acme: [{ network: 'impact-advertiser', credentialId: 'default', networkBrandId: 'IA-1' }],
      },
    });
    expect(isOrphan('acme')).toBe(false);
  });
});

describe('loadClientStrategy', () => {
  it('combines strategy, kpi, and orphan state', () => {
    saveBrands({
      version: 1,
      brands: {
        acme: [{ network: 'impact-advertiser', credentialId: 'default', networkBrandId: 'IA-1' }],
      },
    });
    saveStrategy('acme', 'Premium partners.');
    saveKpi('acme', VALID_KPI);
    const c = loadClientStrategy('acme');
    expect(c.brand).toBe('acme');
    expect(c.orphan).toBe(false);
    expect(c.strategy.present).toBe(true);
    expect(c.kpi.parsed?.targets).toHaveLength(4);
  });

  it('reports a brand with no strategy as present:false, not an error', () => {
    const c = loadClientStrategy('newbrand');
    expect(c.strategy.present).toBe(false);
    expect(c.kpi.present).toBe(false);
    expect(c.orphan).toBe(false);
  });
});

describe('listClientStrategies', () => {
  it('covers registered brands and on-disk dirs, flagging gaps and orphans', () => {
    saveBrands({
      version: 1,
      brands: {
        acme: [{ network: 'impact-advertiser', credentialId: 'default', networkBrandId: 'IA-1' }],
        globex: [{ network: 'cj-advertiser', credentialId: 'default', networkBrandId: 'CJ-1' }],
      },
    });
    saveStrategy('acme', 'x'); // registered + has strategy
    // globex registered, no strategy (the gap)
    mkdirSync(resolveClientDir('leftover'), { recursive: true });
    writeFileSync(resolveStrategyFile('leftover'), 'x\n'); // orphan dir, not bound

    const rows = listClientStrategies();
    const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r]));

    expect(bySlug['acme']).toMatchObject({ registered: true, hasStrategy: true, orphan: false });
    expect(bySlug['globex']).toMatchObject({ registered: true, hasStrategy: false, orphan: false });
    expect(bySlug['leftover']).toMatchObject({ registered: false, hasStrategy: true, orphan: true });
  });

  it('returns [] when nothing is registered or on disk', () => {
    expect(listClientStrategies()).toEqual([]);
  });

  it('ignores on-disk dirs that are not valid brand slugs', () => {
    mkdirSync(path.join(tmp, 'clients', 'Bad Slug!'), { recursive: true });
    writeFileSync(path.join(tmp, 'clients', 'Bad Slug!', 'Strategy.md'), 'x\n');
    expect(listClientStrategies()).toEqual([]);
  });
});
