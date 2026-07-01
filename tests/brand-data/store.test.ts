import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BrandSnapshot } from '../../src/brand-data/model.js';
import type { RowsCapResult } from '../../src/brand-data/rows-cap.js';
import type { HistoryEntry } from '../../src/brand-data/snapshot.js';
import {
  appendHistory,
  loadHistory,
  loadRows,
  loadSnapshot,
  persistSnapshotResult,
  resolveBrandDataDir,
  saveRows,
  saveSnapshot,
} from '../../src/brand-data/store.js';

let configDir: string;
let originalConfigDir: string | undefined;

const snapshot: BrandSnapshot = {
  schemaVersion: 1,
  brandId: 'acme',
  generatedAt: '2026-06-30T12:00:00Z',
  timezone: 'Europe/London',
  windows: {} as BrandSnapshot['windows'],
  byNetwork: [{ network: 'mock-adv', state: 'ok' }],
  rowsTruncated: false,
};

beforeEach(() => {
  originalConfigDir = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  configDir = mkdtempSync(path.join(tmpdir(), 'bd-store-'));
  process.env['AFFILIATE_MCP_CONFIG_DIR'] = configDir;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
  else process.env['AFFILIATE_MCP_CONFIG_DIR'] = originalConfigDir;
  rmSync(configDir, { recursive: true, force: true });
});

describe('store paths', () => {
  it('resolves under the configured dir and rejects invalid slugs', () => {
    expect(resolveBrandDataDir('acme')).toBe(path.join(configDir, 'brand-data', 'acme'));
    expect(() => resolveBrandDataDir('Bad Slug')).toThrow(/invalid/i);
  });
});

describe('snapshot read/write', () => {
  it('round-trips a snapshot and returns null when absent', () => {
    expect(loadSnapshot('acme')).toBeNull();
    saveSnapshot('acme', snapshot);
    expect(loadSnapshot('acme')).toEqual(snapshot);
  });
});

describe('rows read/write', () => {
  it('round-trips full rows as jsonl and returns [] when absent', () => {
    expect(loadRows('acme')).toEqual([]);
    const rows: RowsCapResult = {
      mode: 'rows',
      rowsTruncated: false,
      rows: [
        {
          network: 'mock-adv',
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
        },
      ],
    };
    saveRows('acme', rows);
    expect(loadRows('acme')).toEqual(rows.rows);
  });

  it('writes an empty file for zero rows without error', () => {
    saveRows('acme', { mode: 'rows', rowsTruncated: false, rows: [] });
    expect(loadRows('acme')).toEqual([]);
  });
});

describe('history append', () => {
  it('appends entries oldest-first across calls', () => {
    expect(loadHistory('acme')).toEqual([]);
    const a: HistoryEntry = { generatedAt: '2026-06-29T12:00:00Z', windows: {} as HistoryEntry['windows'] };
    const b: HistoryEntry = { generatedAt: '2026-06-30T12:00:00Z', windows: {} as HistoryEntry['windows'] };
    appendHistory('acme', a);
    appendHistory('acme', b);
    expect(loadHistory('acme')).toEqual([a, b]);
  });
});

describe('persistSnapshotResult', () => {
  it('writes snapshot, rows, and one appended history headline', () => {
    const history: HistoryEntry = {
      generatedAt: '2026-06-30T12:00:00Z',
      windows: {} as HistoryEntry['windows'],
    };
    persistSnapshotResult('acme', {
      snapshot,
      rows: { mode: 'rows', rowsTruncated: false, rows: [] },
      history,
    });
    expect(loadSnapshot('acme')).toEqual(snapshot);
    expect(loadHistory('acme')).toEqual([history]);
  });
});
