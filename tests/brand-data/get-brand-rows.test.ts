import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateMetaTools } from '../../src/tools/generate.js';
import { saveRows } from '../../src/brand-data/store.js';
import type { BrandTxnRow } from '../../src/brand-data/model.js';

let configDir: string;
let original: string | undefined;

const row: BrandTxnRow = {
  network: 'awin-advertiser',
  brandId: 'acme',
  programId: 'p1',
  programName: 'P1',
  txnId: 't1',
  eventDate: '2026-06-29T10:00:00Z',
  statusCanonical: 'approved',
  statusBucket: 'confirmed',
  saleAmount: 100,
  commission: 10,
  currency: 'GBP',
};

const tool = () => generateMetaTools().find((t) => t.name === 'affiliate_get_brand_rows')!;

beforeEach(() => {
  original = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  configDir = mkdtempSync(path.join(tmpdir(), 'bd-rows-'));
  process.env['AFFILIATE_MCP_CONFIG_DIR'] = configDir;
});
afterEach(() => {
  if (original === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
  else process.env['AFFILIATE_MCP_CONFIG_DIR'] = original;
  rmSync(configDir, { recursive: true, force: true });
});

describe('affiliate_get_brand_rows', () => {
  it('returns structured rows from the store by default', async () => {
    saveRows('acme', { mode: 'rows', rowsTruncated: false, rows: [row] });
    const result = (await tool().handle({ brand: 'acme' })) as {
      format: string;
      rowCount: number;
      rows: unknown[];
    };
    expect(result.format).toBe('rows');
    expect(result.rowCount).toBe(1);
    expect(result.rows[0]).toMatchObject({ txnId: 't1', statusBucket: 'confirmed' });
  });

  it('returns CSV when asked', async () => {
    saveRows('acme', { mode: 'rows', rowsTruncated: false, rows: [row] });
    const result = (await tool().handle({ brand: 'acme', format: 'csv' })) as {
      format: string;
      csv: string;
    };
    expect(result.format).toBe('csv');
    expect(result.csv.split('\n')[0]).toContain('txnId');
    expect(result.csv).toContain('t1');
  });

  it('returns an empty set when no snapshot has been built', async () => {
    const result = (await tool().handle({ brand: 'acme' })) as { rowCount: number };
    expect(result.rowCount).toBe(0);
  });
});
