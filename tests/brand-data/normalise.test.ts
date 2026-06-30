import { describe, expect, it } from 'vitest';
import type { TransactionStatus } from '../../src/shared/types.js';
import {
  normalisePerformance,
  normaliseTransactions,
  projectTransaction,
  toStatusBucket,
} from '../../src/brand-data/normalise.js';
import { makePerf, makeTxn } from './fixtures.js';

describe('toStatusBucket', () => {
  it('projects the five canonical states onto the three-way split plus residual', () => {
    expect(toStatusBucket('pending')).toBe('pending');
    expect(toStatusBucket('approved')).toBe('confirmed');
    expect(toStatusBucket('paid')).toBe('confirmed');
    expect(toStatusBucket('reversed')).toBe('declined');
    expect(toStatusBucket('other')).toBe('residual');
  });
});

describe('projectTransaction', () => {
  it('maps canonical fields into the brand vocabulary and buckets the status', () => {
    const row = projectTransaction(
      makeTxn({
        id: 't1',
        programmeId: 'p9',
        programmeName: 'Nine',
        status: 'paid',
        amount: 200,
        commission: 20,
        currency: 'EUR',
        dateConverted: '2026-01-02T00:00:00Z',
      }),
      'acme',
    );
    expect(row).toMatchObject({
      brandId: 'acme',
      programId: 'p9',
      programName: 'Nine',
      txnId: 't1',
      eventDate: '2026-01-02T00:00:00Z',
      statusCanonical: 'paid',
      statusBucket: 'confirmed',
      saleAmount: 200,
      commission: 20,
      currency: 'EUR',
    });
  });

  it('carries statusRaw only when present', () => {
    expect(projectTransaction(makeTxn(), 'acme').statusRaw).toBeUndefined();
    expect(projectTransaction(makeTxn({ statusRaw: 'LOCKED' }), 'acme').statusRaw).toBe('LOCKED');
  });
});

describe('normaliseTransactions', () => {
  it('upserts by id so a resent transaction keeps the latest status', () => {
    const rows = normaliseTransactions(
      [
        makeTxn({ id: 'dup', status: 'approved', commission: 10 }),
        makeTxn({ id: 'other', status: 'pending', commission: 5 }),
        makeTxn({ id: 'dup', status: 'reversed' as TransactionStatus, commission: 10 }),
      ],
      'acme',
    );
    expect(rows).toHaveLength(2);
    const dup = rows.find((r) => r.txnId === 'dup');
    expect(dup?.statusBucket).toBe('declined');
  });
});

describe('normalisePerformance', () => {
  it('projects performance rows into per-partner clicks rows', () => {
    const rows = normalisePerformance(
      [makePerf({ publisherId: 'pub-7', publisherName: 'Seven', clicks: 42, conversions: 3 })],
      'awin',
      'acme',
    );
    expect(rows[0]).toMatchObject({
      network: 'awin',
      brandId: 'acme',
      partnerId: 'pub-7',
      partnerName: 'Seven',
      clicks: 42,
      conversions: 3,
    });
  });
});
