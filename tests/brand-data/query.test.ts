import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BrandDataQuerySchema,
  evaluateBrandDataQuery,
  isoWeek,
} from '../../src/brand-data/query.js';
import type { BrandSnapshot, BrandTxnRow, WindowSnapshot } from '../../src/brand-data/model.js';
import type { AggregatedTxnRow } from '../../src/brand-data/rows-cap.js';
import { generateMetaTools } from '../../src/tools/generate.js';
import { saveRows, saveSnapshot } from '../../src/brand-data/store.js';

let seq = 0;
function makeRow(overrides: Partial<BrandTxnRow> = {}): BrandTxnRow {
  seq += 1;
  return {
    network: 'awin-advertiser',
    brandId: 'acme',
    programId: 'p1',
    programName: 'Programme One',
    txnId: `t${seq}`,
    eventDate: '2026-06-15T12:00:00Z',
    statusCanonical: 'approved',
    statusBucket: 'confirmed',
    saleAmount: 100,
    commission: 10,
    currency: 'GBP',
    ...overrides,
  };
}

function makeWindow(from: string, to: string): WindowSnapshot {
  return { window: 'last30d', from, to, totals: [], byProgram: [] };
}

function makeSnapshot(from = '2026-06-04', to = '2026-07-03'): BrandSnapshot {
  return {
    schemaVersion: 1,
    brandId: 'acme',
    generatedAt: '2026-07-03T09:00:00Z',
    timezone: 'Europe/London',
    windows: {
      yesterday: { ...makeWindow('2026-07-02', '2026-07-02'), window: 'yesterday' },
      last7d: { ...makeWindow('2026-06-27', '2026-07-03'), window: 'last7d' },
      last30d: makeWindow(from, to),
      ytd: { ...makeWindow('2026-01-01', '2026-07-03'), window: 'ytd' },
    },
    byNetwork: [],
    rowsTruncated: false,
  };
}

function query(input: Record<string, unknown>) {
  return BrandDataQuerySchema.parse({ brand: 'acme', ...input });
}

describe('isoWeek', () => {
  it('computes ISO weeks, including year-boundary weeks', () => {
    expect(isoWeek('2026-01-01')).toBe('2026-W01'); // a Thursday
    expect(isoWeek('2026-06-15')).toBe('2026-W25');
    expect(isoWeek('2027-01-01')).toBe('2026-W53'); // Friday; belongs to 2026's last week
  });
});

describe('evaluateBrandDataQuery — aggregate mode', () => {
  const rows = [
    makeRow({ eventDate: '2026-06-10T12:00:00Z', commission: 5, saleAmount: 50 }),
    makeRow({ eventDate: '2026-06-10T15:00:00Z', commission: 7, saleAmount: 70 }),
    makeRow({
      eventDate: '2026-06-20T12:00:00Z',
      programId: 'p2',
      programName: 'Programme Two',
      statusBucket: 'pending',
      statusCanonical: 'pending',
      commission: 3,
      saleAmount: 30,
    }),
    makeRow({
      eventDate: '2026-06-25T12:00:00Z',
      network: 'cj',
      currency: 'USD',
      commission: 11,
      saleAmount: 110,
    }),
  ];

  it('sums with no groupBy but never across currencies', () => {
    const result = evaluateBrandDataQuery(rows, makeSnapshot(), query({}));
    if (!('mode' in result) || result.mode !== 'aggregate') throw new Error('expected aggregate');
    expect(result.storeMode).toBe('rows');
    expect(result.matchedRowCount).toBe(4);
    // GBP and USD must stay separate groups.
    expect(result.groupCount).toBe(2);
    const gbp = result.groups.find((g) => g.key['currency'] === 'GBP');
    expect(gbp?.commission).toBe(15);
    expect(gbp?.saleAmount).toBe(150);
    expect(gbp?.transactionCount).toBe(3);
    const usd = result.groups.find((g) => g.key['currency'] === 'USD');
    expect(usd?.commission).toBe(11);
  });

  it('groups by requested dimensions plus implicit currency', () => {
    const result = evaluateBrandDataQuery(
      rows,
      makeSnapshot(),
      query({ groupBy: ['programId', 'statusBucket'] }),
    );
    if (!('mode' in result) || result.mode !== 'aggregate') throw new Error('expected aggregate');
    // (p1,confirmed,GBP), (p2,pending,GBP), (p1,confirmed,USD)
    expect(result.groupCount).toBe(3);
    const p1Gbp = result.groups.find(
      (g) => g.key['programId'] === 'p1' && g.key['currency'] === 'GBP',
    );
    expect(p1Gbp?.transactionCount).toBe(2);
    expect(p1Gbp?.commission).toBe(12);
  });

  it('supports month and week time dimensions', () => {
    const result = evaluateBrandDataQuery(rows, makeSnapshot(), query({ groupBy: ['month'] }));
    if (!('mode' in result) || result.mode !== 'aggregate') throw new Error('expected aggregate');
    expect(result.groups.every((g) => g.key['month'] === '2026-06')).toBe(true);

    const byWeek = evaluateBrandDataQuery(rows, makeSnapshot(), query({ groupBy: ['week'] }));
    if (!('mode' in byWeek) || byWeek.mode !== 'aggregate') throw new Error('expected aggregate');
    expect(byWeek.groups.some((g) => g.key['week'] === isoWeek('2026-06-10'))).toBe(true);
  });

  it('applies filters before grouping', () => {
    const result = evaluateBrandDataQuery(
      rows,
      makeSnapshot(),
      query({
        filters: { from: '2026-06-15', to: '2026-06-30', statusBucket: 'pending' },
      }),
    );
    if (!('mode' in result) || result.mode !== 'aggregate') throw new Error('expected aggregate');
    expect(result.matchedRowCount).toBe(1);
    expect(result.groups[0]?.commission).toBe(3);
  });

  it('orders by a metric and pages deterministically', () => {
    const result = evaluateBrandDataQuery(
      rows,
      makeSnapshot(),
      query({
        groupBy: ['programId'],
        orderBy: { field: 'commission', direction: 'desc' },
        limit: 2,
        offset: 0,
      }),
    );
    if (!('mode' in result) || result.mode !== 'aggregate') throw new Error('expected aggregate');
    expect(result.groupCount).toBe(3);
    expect(result.returnedCount).toBe(2);
    expect(result.groups[0]?.commission).toBe(12);
    expect(result.groups[1]?.commission).toBe(11);

    const nextPage = evaluateBrandDataQuery(
      rows,
      makeSnapshot(),
      query({
        groupBy: ['programId'],
        orderBy: { field: 'commission', direction: 'desc' },
        limit: 2,
        offset: 2,
      }),
    );
    if (!('mode' in nextPage) || nextPage.mode !== 'aggregate') throw new Error('expected aggregate');
    expect(nextPage.returnedCount).toBe(1);
    expect(nextPage.groups[0]?.commission).toBe(3);
  });

  it('returns only the requested metrics', () => {
    const result = evaluateBrandDataQuery(
      rows,
      makeSnapshot(),
      query({ metrics: ['commission'] }),
    );
    if (!('mode' in result) || result.mode !== 'aggregate') throw new Error('expected aggregate');
    expect(result.groups[0]?.commission).toBeDefined();
    expect(result.groups[0]?.saleAmount).toBeUndefined();
    expect(result.groups[0]?.transactionCount).toBeUndefined();
  });

  it('flags an explicit coverage mismatch instead of a silently partial answer', () => {
    const result = evaluateBrandDataQuery(
      rows,
      makeSnapshot('2026-06-04', '2026-07-03'),
      query({ filters: { from: '2026-01-01' } }),
    );
    if (!('mode' in result)) throw new Error('expected aggregate');
    expect(result.coverage).toEqual({
      from: '2026-06-04',
      to: '2026-07-03',
      generatedAt: '2026-07-03T09:00:00Z',
    });
    expect(result.coverageMismatch?.requestedFrom).toBe('2026-01-01');
    expect(result.coverageMismatch?.coveredFrom).toBe('2026-06-04');
    expect(result.coverageMismatch?.hint).toContain('30-day');
  });

  it('reports an empty store honestly', () => {
    const result = evaluateBrandDataQuery([], null, query({}));
    if (!('mode' in result) || result.mode !== 'aggregate') throw new Error('expected aggregate');
    expect(result.storeMode).toBe('empty');
    expect(result.matchedRowCount).toBe(0);
    expect(result.coverage).toBeNull();
    expect(result.hint).toContain('affiliate_build_brand_snapshot');
  });
});

describe('evaluateBrandDataQuery — rows mode', () => {
  const rows = [
    makeRow({ eventDate: '2026-06-20T12:00:00Z', commission: 3 }),
    makeRow({ eventDate: '2026-06-10T12:00:00Z', commission: 5 }),
    makeRow({ eventDate: '2026-06-15T12:00:00Z', commission: 7, statusBucket: 'pending' }),
  ];

  it('returns matching rows sorted by day with paging counts', () => {
    const result = evaluateBrandDataQuery(rows, makeSnapshot(), query({ mode: 'rows', limit: 2 }));
    if (!('mode' in result) || result.mode !== 'rows') throw new Error('expected rows');
    expect(result.matchedRowCount).toBe(3);
    expect(result.returnedCount).toBe(2);
    expect(result.rows[0]?.eventDate).toBe('2026-06-10T12:00:00Z');
    expect(result.rows[1]?.eventDate).toBe('2026-06-15T12:00:00Z');
  });

  it('filters rows and returns the full persisted shape', () => {
    const result = evaluateBrandDataQuery(
      rows,
      makeSnapshot(),
      query({ mode: 'rows', filters: { statusBucket: 'pending' } }),
    );
    if (!('mode' in result) || result.mode !== 'rows') throw new Error('expected rows');
    expect(result.matchedRowCount).toBe(1);
    expect(result.rows[0]).toMatchObject({ commission: 7, statusBucket: 'pending' });
  });
});

describe('evaluateBrandDataQuery — aggregated store fallback', () => {
  const aggregated: AggregatedTxnRow[] = [
    {
      day: '2026-06-10',
      programId: 'p1',
      currency: 'GBP',
      statusBucket: 'confirmed',
      transactionCount: 40,
      saleAmount: 4000,
      commission: 400,
    },
    {
      day: '2026-06-11',
      programId: 'p1',
      currency: 'GBP',
      statusBucket: 'pending',
      transactionCount: 10,
      saleAmount: 1000,
      commission: 100,
    },
  ];

  it('answers aggregate queries over the surviving dimensions', () => {
    const result = evaluateBrandDataQuery(
      aggregated,
      makeSnapshot(),
      query({ groupBy: ['statusBucket'] }),
    );
    if (!('mode' in result) || result.mode !== 'aggregate') throw new Error('expected aggregate');
    expect(result.storeMode).toBe('aggregated');
    const confirmed = result.groups.find((g) => g.key['statusBucket'] === 'confirmed');
    expect(confirmed?.transactionCount).toBe(40);
    expect(confirmed?.commission).toBe(400);
  });

  it('refuses collapsed dimensions explicitly', () => {
    const result = evaluateBrandDataQuery(
      aggregated,
      makeSnapshot(),
      query({ groupBy: ['network'] }),
    );
    if (!('unsupported' in result)) throw new Error('expected unsupported');
    expect(result.storeMode).toBe('aggregated');
    expect(result.unsupported.dimensions).toEqual(['network']);
    expect(result.hint).toContain('statusBucket');
  });

  it('refuses rows mode explicitly', () => {
    const result = evaluateBrandDataQuery(aggregated, makeSnapshot(), query({ mode: 'rows' }));
    if (!('unsupported' in result)) throw new Error('expected unsupported');
    expect(result.unsupported.reason).toContain('aggregated');
  });
});

describe('affiliate_query_brand_data tool', () => {
  let configDir: string;
  let original: string | undefined;

  beforeEach(() => {
    original = process.env['AFFILIATE_MCP_CONFIG_DIR'];
    configDir = mkdtempSync(path.join(tmpdir(), 'bd-query-'));
    process.env['AFFILIATE_MCP_CONFIG_DIR'] = configDir;
  });
  afterEach(() => {
    if (original === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
    else process.env['AFFILIATE_MCP_CONFIG_DIR'] = original;
    rmSync(configDir, { recursive: true, force: true });
  });

  it('is registered and queries the persisted store', async () => {
    const tool = generateMetaTools().find((t) => t.name === 'affiliate_query_brand_data');
    expect(tool).toBeDefined();
    expect(tool?.annotations?.readOnlyHint).toBe(true);

    saveSnapshot('acme', makeSnapshot());
    saveRows('acme', {
      mode: 'rows',
      rowsTruncated: false,
      rows: [makeRow({ commission: 21 }), makeRow({ commission: 4 })],
    });
    const result = (await tool?.handle({
      brand: 'acme',
      groupBy: ['programId'],
    })) as { mode: string; groups: Array<{ commission?: number }> };
    expect(result.mode).toBe('aggregate');
    expect(result.groups[0]?.commission).toBe(25);
  });

  it('rejects malformed queries at the schema boundary', () => {
    expect(() => BrandDataQuerySchema.parse({ brand: 'acme', groupBy: ['nope'] })).toThrow();
    expect(() =>
      BrandDataQuerySchema.parse({ brand: 'acme', filters: { from: 'June 1st' } }),
    ).toThrow();
    expect(() => BrandDataQuerySchema.parse({ brand: 'acme', limit: 100_000 })).toThrow();
  });
});
