import { describe, expect, it } from 'vitest';
import { aggregateTxnRows, capTxnRows } from '../../src/brand-data/rows-cap.js';
import { normaliseTransactions } from '../../src/brand-data/normalise.js';
import { makeTxn } from './fixtures.js';

describe('capTxnRows', () => {
  it('keeps full rows when within the cap', () => {
    const rows = normaliseTransactions([makeTxn({ id: 'a' }), makeTxn({ id: 'b' })], 'acme');
    const result = capTxnRows(rows, 10);
    expect(result.mode).toBe('rows');
    expect(result.rowsTruncated).toBe(false);
    expect(result.rows).toHaveLength(2);
  });

  it('falls back to aggregates and flags truncation when over the cap', () => {
    const rows = normaliseTransactions(
      Array.from({ length: 5 }, (_, i) =>
        makeTxn({ id: `t${i}`, status: 'approved', commission: 2, amount: 20 }),
      ),
      'acme',
    );
    const result = capTxnRows(rows, 2);
    expect(result.mode).toBe('aggregated');
    expect(result.rowsTruncated).toBe(true);
    // All five share (day, programId, currency, statusBucket) -> one bucket.
    expect(result.rows).toHaveLength(1);
    if (result.mode === 'aggregated') {
      const [bucket] = result.rows;
      expect(bucket?.transactionCount).toBe(5);
      expect(bucket?.commission).toBe(10);
      expect(bucket?.saleAmount).toBe(100);
    }
  });
});

describe('aggregateTxnRows', () => {
  it('groups by day, programId, currency, and status bucket', () => {
    const rows = normaliseTransactions(
      [
        makeTxn({ id: '1', programmeId: 'p1', status: 'approved', commission: 1, dateConverted: '2026-06-10T09:00:00Z' }),
        makeTxn({ id: '2', programmeId: 'p1', status: 'approved', commission: 2, dateConverted: '2026-06-10T20:00:00Z' }),
        makeTxn({ id: '3', programmeId: 'p1', status: 'reversed', commission: 3, dateConverted: '2026-06-10T20:00:00Z' }),
        makeTxn({ id: '4', programmeId: 'p2', status: 'approved', commission: 4, dateConverted: '2026-06-10T20:00:00Z' }),
      ],
      'acme',
    );
    const agg = aggregateTxnRows(rows, 'Europe/London');
    // p1/confirmed (2 rows), p1/declined (1), p2/confirmed (1) => 3 buckets
    expect(agg).toHaveLength(3);
    const p1Confirmed = agg.find((a) => a.programId === 'p1' && a.statusBucket === 'confirmed');
    expect(p1Confirmed?.transactionCount).toBe(2);
    expect(p1Confirmed?.commission).toBe(3);
  });
});
