import type { ProgrammePerformanceRow, Transaction, TransactionStatus } from '../../src/shared/types.js';

let txnSeq = 0;

/** Build a `Transaction` with sensible defaults; override any field. */
export function makeTxn(overrides: Partial<Transaction> = {}): Transaction {
  txnSeq += 1;
  return {
    id: `txn-${txnSeq}`,
    network: 'awin',
    programmeId: 'prog-1',
    programmeName: 'Programme One',
    status: 'approved' as TransactionStatus,
    amount: 100,
    currency: 'GBP',
    commission: 10,
    dateConverted: '2026-06-15T12:00:00Z',
    ageDays: 15,
    rawNetworkData: {},
    ...overrides,
  };
}

/** Build a `ProgrammePerformanceRow` with sensible defaults; override any field. */
export function makePerf(overrides: Partial<ProgrammePerformanceRow> = {}): ProgrammePerformanceRow {
  return {
    date: '2026-06-15',
    publisherId: 'pub-1',
    publisherName: 'Publisher One',
    clicks: 100,
    conversions: 5,
    grossSale: 500,
    commission: 50,
    currency: 'GBP',
    status: 'approved',
    rawNetworkData: {},
    ...overrides,
  };
}
