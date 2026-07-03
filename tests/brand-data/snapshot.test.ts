import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _clearRegistry, registerAdapter } from '../../src/shared/registry.js';
import type {
  NetworkAdapter,
  ProgrammePerformanceRow,
  Transaction,
} from '../../src/shared/types.js';
import { buildBrandSnapshot } from '../../src/brand-data/snapshot.js';
import { makePerf, makeTxn } from './fixtures.js';

const ASOF = '2026-06-30T12:00:00Z';
let configDir: string;
let originalConfigDir: string | undefined;

/**
 * A minimal advertiser-side adapter. Performance (per window range) is the
 * metric source; transactions feed only the 30-day drill-down.
 */
function makeAdvAdapter(
  slug: string,
  opts: {
    perfFor?: (from: string, to: string) => ProgrammePerformanceRow[];
    txns?: Transaction[];
    omitPerf?: boolean;
    failPerf?: boolean;
    failTxns?: boolean;
  },
): NetworkAdapter {
  const adapter: Partial<NetworkAdapter> = {
    slug,
    name: slug,
    meta: { adapterVersion: '1.0.0' } as NetworkAdapter['meta'],
    listTransactions: async () => {
      if (opts.failTxns) throw new Error('txn 500');
      return opts.txns ?? [];
    },
  };
  if (!opts.omitPerf) {
    adapter.getProgrammePerformance = async (query) => {
      if (opts.failPerf) {
        const err = new Error('perf 500') as Error & { envelope: unknown };
        err.envelope = { network: slug, operation: 'getProgrammePerformance', httpStatus: 500 };
        throw err;
      }
      return opts.perfFor?.(query?.from ?? '', query?.to ?? '') ?? [];
    };
  }
  return adapter as NetworkAdapter;
}

/** Three per-status performance rows for a publisher, mirroring the #282 split. */
function statusRows(): ProgrammePerformanceRow[] {
  return [
    makePerf({ publisherId: 'p1', status: 'approved', clicks: 100, conversions: 5, grossSale: 500, commission: 10 }),
    makePerf({ publisherId: 'p1', status: 'pending', clicks: 0, conversions: 2, grossSale: 200, commission: 5 }),
    makePerf({ publisherId: 'p1', status: 'reversed', clicks: 0, conversions: 1, grossSale: 0, commission: 7 }),
  ];
}

function bindBrand(brand: string, networks: string[]): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    path.join(configDir, 'brands.json'),
    JSON.stringify({
      version: 1,
      brands: { [brand]: networks.map((network) => ({ network, credentialId: 'default', networkBrandId: 'B1' })) },
    }),
  );
}

beforeEach(() => {
  originalConfigDir = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  configDir = mkdtempSync(path.join(tmpdir(), 'bd-snap-'));
  process.env['AFFILIATE_MCP_CONFIG_DIR'] = configDir;
  _clearRegistry();
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
  else process.env['AFFILIATE_MCP_CONFIG_DIR'] = originalConfigDir;
  rmSync(configDir, { recursive: true, force: true });
  _clearRegistry();
});

describe('buildBrandSnapshot', () => {
  it('computes commission, conversions, and clicks from the performance report', async () => {
    bindBrand('acme', ['mock-adv']);
    registerAdapter(makeAdvAdapter('mock-adv', { perfFor: () => statusRows() }));

    const { snapshot } = await buildBrandSnapshot('acme', { asOf: ASOF, networks: ['mock-adv'] });

    expect(snapshot.byNetwork).toEqual([{ network: 'mock-adv', state: 'ok' }]);
    const win = snapshot.windows.last30d.totals.find((t) => t.currency === 'GBP');
    expect(win?.commission.confirmed).toBe(10);
    expect(win?.commission.pending).toBe(5);
    expect(win?.commission.declined).toBe(7);
    expect(win?.commission.totalTracked).toBe(15);
    expect(win?.conversions).toBe(7); // approved 5 + pending 2; reversed excluded
    expect(win?.declinedConversions).toBe(1);
    expect(win?.clicks).toBe(100);
    expect(win?.epc).toBeCloseTo(0.15);
  });

  it('pulls performance once per window and transactions only for the last 30 days', async () => {
    bindBrand('acme', ['mock-adv']);
    const perfRanges: Array<{ from: string; to: string }> = [];
    const txnRanges: Array<{ from: string; to: string }> = [];
    const adapter = makeAdvAdapter('mock-adv', {
      perfFor: (from, to) => {
        perfRanges.push({ from, to });
        return [];
      },
    });
    adapter.listTransactions = async (q) => {
      txnRanges.push({ from: q?.from ?? '', to: q?.to ?? '' });
      return [];
    };
    registerAdapter(adapter);

    await buildBrandSnapshot('acme', { asOf: ASOF, networks: ['mock-adv'] });

    expect(perfRanges).toEqual([
      { from: '2026-06-29', to: '2026-06-29' },
      { from: '2026-06-24', to: '2026-06-30' },
      { from: '2026-06-01', to: '2026-06-30' },
      { from: '2026-01-01', to: '2026-06-30' },
    ]);
    // No year-long transaction pull: transactions are last-30-days only.
    expect(txnRanges).toEqual([{ from: '2026-06-01', to: '2026-06-30' }]);
  });

  it('blanks EPC when a publisher has commission but zero clicks', async () => {
    bindBrand('acme', ['mock-adv']);
    registerAdapter(
      makeAdvAdapter('mock-adv', {
        perfFor: () => [makePerf({ status: 'approved', clicks: 0, conversions: 1, grossSale: 50, commission: 10 })],
      }),
    );
    const { snapshot } = await buildBrandSnapshot('acme', { asOf: ASOF, networks: ['mock-adv'] });
    const win = snapshot.windows.last30d.totals.find((t) => t.currency === 'GBP');
    expect(win?.commission.confirmed).toBe(10);
    expect(win?.clicks).toBe(0);
    expect(win?.epc).toBeNull();
  });

  it('records a network as failed when the performance report is unavailable', async () => {
    bindBrand('acme', ['no-perf']);
    registerAdapter(makeAdvAdapter('no-perf', { omitPerf: true }));
    const { snapshot } = await buildBrandSnapshot('acme', { asOf: ASOF, networks: ['no-perf'] });
    expect(snapshot.byNetwork[0]?.state).toBe('failed');
  });

  it('is count-honest on a performance-pull failure: one entry per bound network, totals exclude it', async () => {
    bindBrand('acme', ['good-adv', 'bad-adv']);
    registerAdapter(makeAdvAdapter('good-adv', { perfFor: () => statusRows() }));
    registerAdapter(makeAdvAdapter('bad-adv', { failPerf: true }));

    const { snapshot } = await buildBrandSnapshot('acme', { asOf: ASOF, networks: ['good-adv', 'bad-adv'] });

    expect(snapshot.byNetwork).toHaveLength(2);
    const bad = snapshot.byNetwork.find((n) => n.network === 'bad-adv');
    expect(bad?.state).toBe('failed');
    expect(bad?.error).toEqual({ network: 'bad-adv', operation: 'getProgrammePerformance', httpStatus: 500 });
    const win = snapshot.windows.ytd.totals.find((t) => t.currency === 'GBP');
    expect(win?.commission.confirmed).toBe(10);
  });

  it('keeps totals when the transaction drill-down pull fails (best-effort)', async () => {
    bindBrand('acme', ['mock-adv']);
    registerAdapter(makeAdvAdapter('mock-adv', { perfFor: () => statusRows(), failTxns: true }));
    const { snapshot, rows } = await buildBrandSnapshot('acme', { asOf: ASOF, networks: ['mock-adv'] });
    expect(snapshot.byNetwork[0]?.state).toBe('ok');
    expect(snapshot.byNetwork[0]?.note).toMatch(/drill-down unavailable/i);
    expect(snapshot.windows.last30d.totals.find((t) => t.currency === 'GBP')?.commission.confirmed).toBe(10);
    expect(rows.rows).toHaveLength(0);
  });

  it('handles a large 30-day transaction batch for the drill-down without overflowing', async () => {
    // Regression: appending tens of thousands of rows via push(...rows) overflows
    // V8's argument limit; the live Awin demo returns ~84k rows in a 30-day pull.
    bindBrand('acme', ['mock-adv']);
    const big = Array.from({ length: 100_000 }, (_, i) =>
      makeTxn({ id: `b${i}`, status: 'approved', dateConverted: '2026-06-15T10:00:00Z' }),
    );
    registerAdapter(makeAdvAdapter('mock-adv', { perfFor: () => statusRows(), txns: big }));

    const { snapshot, rows } = await buildBrandSnapshot('acme', { asOf: ASOF, networks: ['mock-adv'] });
    expect(snapshot.byNetwork[0]?.state).toBe('ok');
    // Under the byte cap (decision 2026-07-03) 100k compact rows fit within
    // ~50 MB, so a large account keeps full row grain for the query tool
    // instead of collapsing at a 10k row count.
    expect(rows.rowsTruncated).toBe(false);
    expect(rows.rows).toHaveLength(100_000);
  });

  it('defaults to the brand\'s bound networks when none are specified', async () => {
    bindBrand('acme', ['mock-adv']);
    registerAdapter(makeAdvAdapter('mock-adv', { perfFor: () => [] }));
    const { snapshot } = await buildBrandSnapshot('acme', { asOf: ASOF });
    expect(snapshot.byNetwork.map((n) => n.network)).toEqual(['mock-adv']);
  });
});
