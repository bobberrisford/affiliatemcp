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
 * A minimal advertiser-side adapter: transactions are the commission source,
 * performance the clicks source (queried per window range).
 */
function makeAdvAdapter(
  slug: string,
  opts: {
    txns?: Transaction[];
    perfFor?: (from: string, to: string) => ProgrammePerformanceRow[];
    failTxns?: boolean;
    omitPerf?: boolean;
    failPerf?: boolean;
  },
): NetworkAdapter {
  const adapter: Partial<NetworkAdapter> = {
    slug,
    name: slug,
    meta: { adapterVersion: '1.0.0' } as NetworkAdapter['meta'],
    listTransactions: async () => {
      if (opts.failTxns) {
        const err = new Error('txn 500') as Error & { envelope: unknown };
        err.envelope = { network: slug, operation: 'listTransactions', httpStatus: 500 };
        throw err;
      }
      return opts.txns ?? [];
    },
  };
  if (!opts.omitPerf) {
    adapter.getProgrammePerformance = async (query) => {
      if (opts.failPerf) throw new Error('perf 500');
      return opts.perfFor?.(query?.from ?? '', query?.to ?? '') ?? [];
    };
  }
  return adapter as NetworkAdapter;
}

function bindBrand(brand: string, networks: string[]): void {
  const brands = {
    version: 1,
    brands: {
      [brand]: networks.map((network) => ({ network, credentialId: 'default', networkBrandId: 'B1' })),
    },
  };
  mkdirSync(configDir, { recursive: true });
  writeFileSync(path.join(configDir, 'brands.json'), JSON.stringify(brands));
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
  it('takes commission/conversions from transactions and clicks from performance', async () => {
    bindBrand('acme', ['mock-adv']);
    registerAdapter(
      makeAdvAdapter('mock-adv', {
        txns: [
          makeTxn({ id: 'y', status: 'approved', commission: 10, amount: 100, dateConverted: '2026-06-29T10:00:00Z' }),
          makeTxn({ id: 'w', status: 'pending', commission: 5, amount: 50, dateConverted: '2026-06-26T10:00:00Z' }),
          makeTxn({ id: 'm', status: 'reversed', commission: 7, amount: 70, dateConverted: '2026-06-10T10:00:00Z' }),
        ],
        perfFor: () => [makePerf({ clicks: 100, status: 'reversed' })], // status here is ignored
      }),
    );

    const { snapshot } = await buildBrandSnapshot('acme', { asOf: ASOF, networks: ['mock-adv'] });

    expect(snapshot.byNetwork).toEqual([{ network: 'mock-adv', state: 'ok' }]);
    const win = snapshot.windows.last30d.totals.find((t) => t.currency === 'GBP');
    expect(win?.commission.confirmed).toBe(10);
    expect(win?.commission.pending).toBe(5);
    expect(win?.commission.declined).toBe(7);
    expect(win?.commission.totalTracked).toBe(15);
    expect(win?.conversions).toBe(2); // approved + pending; reversed excluded
    expect(win?.clicks).toBe(100); // from performance, not transactions
    expect(win?.epc).toBeCloseTo(0.15);
  });

  it('pulls transactions in <=31-day chunks over YTD and performance once per window', async () => {
    bindBrand('acme', ['mock-adv']);
    const txnRanges: Array<{ from: string; to: string }> = [];
    const perfRanges: Array<{ from: string; to: string }> = [];
    const adapter = makeAdvAdapter('mock-adv', { perfFor: (from, to) => { perfRanges.push({ from, to }); return []; } });
    adapter.listTransactions = async (q) => { txnRanges.push({ from: q?.from ?? '', to: q?.to ?? '' }); return []; };
    registerAdapter(adapter);

    await buildBrandSnapshot('acme', { asOf: ASOF, networks: ['mock-adv'] });

    // YTD (2026-01-01..2026-06-30) chunked into contiguous <=31-day slices.
    expect(txnRanges.length).toBeGreaterThan(1);
    expect(txnRanges[0]?.from).toBe('2026-01-01');
    expect(txnRanges[txnRanges.length - 1]?.to).toBe('2026-06-30');
    for (const slice of txnRanges) {
      const days = (Date.parse(slice.to) - Date.parse(slice.from)) / 86_400_000 + 1;
      expect(days).toBeLessThanOrEqual(31);
    }
    expect(perfRanges).toEqual([
      { from: '2026-06-29', to: '2026-06-29' },
      { from: '2026-06-24', to: '2026-06-30' },
      { from: '2026-06-01', to: '2026-06-30' },
      { from: '2026-01-01', to: '2026-06-30' },
    ]);
  });

  it('keeps commission and blanks clicks when performance is unavailable', async () => {
    bindBrand('acme', ['no-perf']);
    registerAdapter(
      makeAdvAdapter('no-perf', {
        txns: [makeTxn({ status: 'approved', commission: 12, dateConverted: '2026-06-29T10:00:00Z' })],
        omitPerf: true,
      }),
    );
    const { snapshot } = await buildBrandSnapshot('acme', { asOf: ASOF, networks: ['no-perf'] });
    const health = snapshot.byNetwork[0];
    expect(health?.state).toBe('ok');
    expect(health?.note).toMatch(/clicks unavailable/i);
    const win = snapshot.windows.last30d.totals.find((t) => t.currency === 'GBP');
    expect(win?.commission.confirmed).toBe(12); // commission survives
    expect(win?.clicks).toBe(0);
    expect(win?.epc).toBeNull(); // blank, not a misleading 0
  });

  it('is count-honest on a transaction-pull failure: one entry per bound network, totals exclude it', async () => {
    bindBrand('acme', ['good-adv', 'bad-adv']);
    registerAdapter(
      makeAdvAdapter('good-adv', {
        txns: [makeTxn({ status: 'approved', commission: 10, dateConverted: '2026-06-29T10:00:00Z' })],
        perfFor: () => [makePerf({ clicks: 100 })],
      }),
    );
    registerAdapter(makeAdvAdapter('bad-adv', { failTxns: true }));

    const { snapshot } = await buildBrandSnapshot('acme', { asOf: ASOF, networks: ['good-adv', 'bad-adv'] });

    expect(snapshot.byNetwork).toHaveLength(2);
    const bad = snapshot.byNetwork.find((n) => n.network === 'bad-adv');
    expect(bad?.state).toBe('failed');
    expect(bad?.error).toEqual({ network: 'bad-adv', operation: 'listTransactions', httpStatus: 500 });
    const win = snapshot.windows.ytd.totals.find((t) => t.currency === 'GBP');
    expect(win?.commission.confirmed).toBe(10);
  });

  it('handles a large transaction batch without overflowing the argument stack', async () => {
    // Regression: appending tens of thousands of rows via push(...rows) overflows
    // V8's argument limit; the live Awin demo returns ~84k rows per chunk. Use a
    // count comfortably above the limit to guard the loop-append fix.
    bindBrand('acme', ['mock-adv']);
    const big = Array.from({ length: 100_000 }, (_, i) =>
      makeTxn({ id: `b${i}`, status: 'approved', commission: 1, amount: 10, dateConverted: '2026-06-15T10:00:00Z' }),
    );
    registerAdapter(makeAdvAdapter('mock-adv', { txns: big, perfFor: () => [] }));

    const { snapshot } = await buildBrandSnapshot('acme', { asOf: ASOF, networks: ['mock-adv'] });
    const win = snapshot.windows.last30d.totals.find((t) => t.currency === 'GBP');
    expect(win?.commission.confirmed).toBe(100_000);
    expect(win?.conversions).toBe(100_000);
  });

  it('defaults to the brand\'s bound networks when none are specified', async () => {
    bindBrand('acme', ['mock-adv']);
    registerAdapter(makeAdvAdapter('mock-adv', { txns: [], perfFor: () => [] }));
    const { snapshot } = await buildBrandSnapshot('acme', { asOf: ASOF });
    expect(snapshot.byNetwork.map((n) => n.network)).toEqual(['mock-adv']);
  });
});
