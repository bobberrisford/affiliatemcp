/**
 * Brand Data Layer — normalisation.
 *
 * Pure projection of the canonical adapter outputs (`Transaction[]`,
 * `ProgrammePerformanceRow[]`) into the derived brand-data rows. This layer
 * never re-maps status (adapters already canonicalise it) and never converts
 * timezones (adapters already emit ISO instants); it only projects and, for
 * transactions, upserts by id.
 *
 * See `docs/decisions/2026-06-30-brand-data-layer.md`.
 */

import type {
  NetworkSlug,
  ProgrammePerformanceRow,
  Transaction,
  TransactionStatus,
} from '../shared/types.js';
import type { BrandClicksRow, BrandTxnRow, StatusBucket } from './model.js';

/**
 * The load-bearing status projection: canonical five-state enum onto the
 * brief's three-way split plus a residual. See `StatusBucket`.
 */
export function toStatusBucket(status: TransactionStatus): StatusBucket {
  switch (status) {
    case 'pending':
      return 'pending';
    case 'approved':
    case 'paid':
      return 'confirmed';
    case 'reversed':
      return 'declined';
    case 'other':
      return 'residual';
    default: {
      // Exhaustiveness guard: a new canonical status must be projected
      // deliberately, not silently dropped into a bucket.
      const _never: never = status;
      return _never;
    }
  }
}

/** Project one `Transaction` into a `BrandTxnRow`. */
export function projectTransaction(txn: Transaction, brandId: string): BrandTxnRow {
  const row: BrandTxnRow = {
    network: txn.network,
    brandId,
    programId: txn.programmeId,
    programName: txn.programmeName,
    txnId: txn.id,
    eventDate: txn.dateConverted,
    statusCanonical: txn.status,
    statusBucket: toStatusBucket(txn.status),
    saleAmount: txn.amount,
    commission: txn.commission,
    currency: txn.currency,
  };
  if (txn.statusRaw !== undefined) row.statusRaw = txn.statusRaw;
  return row;
}

/**
 * Project and upsert a batch of transactions by `id`. When the same `txnId`
 * appears more than once (networks resend with a mutated status across pulls),
 * the last occurrence wins, so a re-pulled "approved -> reversed" never
 * double-counts. Input order is otherwise preserved.
 */
export function normaliseTransactions(txns: Transaction[], brandId: string): BrandTxnRow[] {
  const byId = new Map<string, BrandTxnRow>();
  for (const txn of txns) {
    byId.set(txn.id, projectTransaction(txn, brandId));
  }
  return [...byId.values()];
}

/** Project one `ProgrammePerformanceRow` into a `BrandClicksRow`. */
export function projectPerformanceRow(
  row: ProgrammePerformanceRow,
  network: NetworkSlug,
  brandId: string,
): BrandClicksRow {
  return {
    network,
    brandId,
    partnerId: row.publisherId,
    partnerName: row.publisherName,
    date: row.date,
    clicks: row.clicks,
    conversions: row.conversions,
    grossSale: row.grossSale,
    commission: row.commission,
    currency: row.currency,
  };
}

/** Project a batch of performance rows into clicks rows (no dedupe; grain is per-row). */
export function normalisePerformance(
  rows: ProgrammePerformanceRow[],
  network: NetworkSlug,
  brandId: string,
): BrandClicksRow[] {
  return rows.map((r) => projectPerformanceRow(r, network, brandId));
}
