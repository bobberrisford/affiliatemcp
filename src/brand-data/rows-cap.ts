/**
 * Brand Data Layer — 30-day rows cap with aggregate fallback (brief D3).
 *
 * `rows-30d` powers the pivot and CSV at full grain, but the persisted store
 * has a size ceiling. When the row count exceeds the cap, collapse to
 * per-`(day, programId, currency, statusBucket)` aggregates: the pivot gets
 * coarser but the snapshot survives, and `rowsTruncated` flags it honestly.
 *
 * See `docs/decisions/2026-06-30-brand-data-layer.md`.
 */

import type { BrandTxnRow, StatusBucket } from './model.js';
import { DEFAULT_BRAND_TIMEZONE, ROWS_CAP } from './model.js';
import { dayInZone } from './windows.js';

/** One collapsed bucket when full rows exceed the cap. */
export interface AggregatedTxnRow {
  day: string; // YYYY-MM-DD in the canonical timezone
  programId: string;
  currency: string;
  statusBucket: StatusBucket;
  transactionCount: number;
  saleAmount: number;
  commission: number;
}

export type RowsCapResult =
  | { mode: 'rows'; rows: BrandTxnRow[]; rowsTruncated: false }
  | { mode: 'aggregated'; rows: AggregatedTxnRow[]; rowsTruncated: true };

/** Collapse transaction rows to per-(day, programId, currency, statusBucket) sums. */
export function aggregateTxnRows(
  rows: BrandTxnRow[],
  timezone: string = DEFAULT_BRAND_TIMEZONE,
): AggregatedTxnRow[] {
  const byKey = new Map<string, AggregatedTxnRow>();
  for (const row of rows) {
    const day = dayInZone(row.eventDate, timezone);
    const key = `${day}|${row.programId}|${row.currency}|${row.statusBucket}`;
    const existing = byKey.get(key);
    if (existing) {
      existing.transactionCount += 1;
      existing.saleAmount += row.saleAmount;
      existing.commission += row.commission;
    } else {
      byKey.set(key, {
        day,
        programId: row.programId,
        currency: row.currency,
        statusBucket: row.statusBucket,
        transactionCount: 1,
        saleAmount: row.saleAmount,
        commission: row.commission,
      });
    }
  }
  return [...byKey.values()];
}

/**
 * Keep full rows when within the cap; otherwise fall back to aggregates and set
 * `rowsTruncated`. The default cap is `ROWS_CAP` (~10k).
 */
export function capTxnRows(
  rows: BrandTxnRow[],
  cap: number = ROWS_CAP,
  timezone: string = DEFAULT_BRAND_TIMEZONE,
): RowsCapResult {
  if (rows.length <= cap) {
    return { mode: 'rows', rows, rowsTruncated: false };
  }
  return { mode: 'aggregated', rows: aggregateTxnRows(rows, timezone), rowsTruncated: true };
}
