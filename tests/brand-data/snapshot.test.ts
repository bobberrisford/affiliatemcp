import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

/** A minimal advertiser-side adapter that returns canned data (or throws). */
function makeAdvAdapter(
  slug: string,
  opts: {
    txns?: Transaction[];
    perf?: ProgrammePerformanceRow[];
    failPerf?: boolean;
    omitPerf?: boolean;
  },
): NetworkAdapter {
  const adapter: Partial<NetworkAdapter> = {
    slug,
    name: slug,
    meta: { adapterVersion: '1.0.0' } as NetworkAdapter['meta'],
    listTransactions: async () => opts.txns ?? [],
  };
  if (!opts.omitPerf) {
    adapter.getProgrammePerformance = async () => {
      if (opts.failPerf) {
        const err = new Error('upstream 500') as Error & { envelope: unknown };
        err.envelope = { network: slug, operation: 'getProgrammePerformance', httpStatus: 500 };
        throw err;
      }
      return opts.perf ?? [];
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
  it('buckets transactions and clicks into the four windows with a healthy network', async () => {
    bindBrand('acme', ['mock-adv']);
    registerAdapter(
      makeAdvAdapter('mock-adv', {
        txns: [
          makeTxn({ id: 'y', status: 'approved', commission: 10, amount: 100, dateConverted: '2026-06-29T10:00:00Z' }),
          makeTxn({ id: 'w', status: 'pending', commission: 5, amount: 50, dateConverted: '2026-06-26T10:00:00Z' }),
          makeTxn({ id: 'm', status: 'reversed', commission: 7, amount: 70, dateConverted: '2026-06-10T10:00:00Z' }),
          makeTxn({ id: 'yr', status: 'approved', commission: 3, amount: 30, dateConverted: '2026-02-01T10:00:00Z' }),
        ],
        perf: [
          makePerf({ date: '2026-06-29', clicks: 100 }),
          makePerf({ date: '2026-06-26', clicks: 50 }),
          makePerf({ date: '2026-02-01', clicks: 200 }),
        ],
      }),
    );

    const { snapshot } = await buildBrandSnapshot('acme', { asOf: ASOF, networks: ['mock-adv'] });

    expect(snapshot.byNetwork).toEqual([{ network: 'mock-adv', state: 'ok' }]);
    expect(snapshot.rowsTruncated).toBe(false);

    // Yesterday: only the 29th transaction (confirmed 10) and 100 clicks.
    const yesterday = snapshot.windows.yesterday.totals.find((t) => t.currency === 'GBP');
    expect(yesterday?.commission.confirmed).toBe(10);
    expect(yesterday?.commission.totalTracked).toBe(10);
    expect(yesterday?.clicks).toBe(100);
    expect(yesterday?.epc).toBeCloseTo(0.1);

    // YTD: all four transactions; declined (7) excluded from totals.
    const ytd = snapshot.windows.ytd.totals.find((t) => t.currency === 'GBP');
    expect(ytd?.commission.totalTracked).toBe(18); // 10 + 5 + 3
    expect(ytd?.commission.declined).toBe(7);
    expect(ytd?.clicks).toBe(350);
  });

  it('is count-honest on partial failure: one entry per bound network, totals exclude the failure', async () => {
    bindBrand('acme', ['good-adv', 'bad-adv']);
    registerAdapter(
      makeAdvAdapter('good-adv', {
        txns: [makeTxn({ id: 'g', status: 'approved', commission: 10, dateConverted: '2026-06-29T10:00:00Z' })],
        perf: [makePerf({ date: '2026-06-29', clicks: 100 })],
      }),
    );
    registerAdapter(makeAdvAdapter('bad-adv', { failPerf: true }));

    const { snapshot } = await buildBrandSnapshot('acme', {
      asOf: ASOF,
      networks: ['good-adv', 'bad-adv'],
    });

    expect(snapshot.byNetwork).toHaveLength(2); // never collapses to the 1 that worked
    const bad = snapshot.byNetwork.find((n) => n.network === 'bad-adv');
    expect(bad?.state).toBe('failed');
    expect(bad?.error).toEqual({ network: 'bad-adv', operation: 'getProgrammePerformance', httpStatus: 500 });
    // Totals reflect only the good network.
    const ytd = snapshot.windows.ytd.totals.find((t) => t.currency === 'GBP');
    expect(ytd?.commission.confirmed).toBe(10);
  });

  it('records a network without programme performance as failed, not silently dropped', async () => {
    bindBrand('acme', ['no-perf']);
    registerAdapter(makeAdvAdapter('no-perf', { omitPerf: true }));

    const { snapshot } = await buildBrandSnapshot('acme', { asOf: ASOF, networks: ['no-perf'] });
    expect(snapshot.byNetwork[0]?.state).toBe('failed');
  });

  it('defaults to the brand\'s bound networks when none are specified', async () => {
    bindBrand('acme', ['mock-adv']);
    registerAdapter(makeAdvAdapter('mock-adv', { txns: [], perf: [] }));
    const { snapshot } = await buildBrandSnapshot('acme', { asOf: ASOF });
    expect(snapshot.byNetwork.map((n) => n.network)).toEqual(['mock-adv']);
  });
});
