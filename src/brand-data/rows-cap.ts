/**
 * Brand Data Layer — 30-day rows cap with aggregate fallback (brief D3).
 *
 * `rows-30d` powers the pivot, CSV, and the query tool at full grain, but the
 * persisted store has a size ceiling. The cap is measured in serialised JSONL
 * bytes (what the store actually writes), not row count: a row-count cap
 * collapsed exactly the large accounts whose row grain the query tool needs
 * (decision 2026-07-03). When the serialised size exceeds the cap, collapse to
 * per-`(day, programId, currency, statusBucket)` aggregates: the pivot gets
 * coarser but the snapshot survives, and `rowsTruncated` flags it honestly.
 *
 * See `docs/decisions/2026-06-30-brand-data-layer.md` and
 * `docs/decisions/2026-07-03-tool-result-size-budget.md`.
 */

import type { BrandTxnRow, StatusBucket } from './model.js';
import { DEFAULT_BRAND_TIMEZONE, ROWS_BYTES_CAP } from './model.js';
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
 * The bytes the store's JSONL writer will produce for these rows: one compact
 * JSON document plus a newline per row. Stops counting once `capBytes` is
 * exceeded so a very large pull does not serialise every row twice.
 */
export function serialisedRowsBytes(rows: BrandTxnRow[], capBytes: number = Infinity): number {
  let total = 0;
  for (const row of rows) {
    total += Buffer.byteLength(JSON.stringify(row), 'utf8') + 1;
    if (total > capBytes) return total;
  }
  return total;
}

/**
 * Keep full rows while their serialised JSONL size is within the byte cap;
 * otherwise fall back to aggregates and set `rowsTruncated`. The default cap
 * is `ROWS_BYTES_CAP` (~50 MB).
 */
export function capTxnRows(
  rows: BrandTxnRow[],
  capBytes: number = ROWS_BYTES_CAP,
  timezone: string = DEFAULT_BRAND_TIMEZONE,
): RowsCapResult {
  if (serialisedRowsBytes(rows, capBytes) <= capBytes) {
    return { mode: 'rows', rows, rowsTruncated: false };
  }
  return { mode: 'aggregated', rows: aggregateTxnRows(rows, timezone), rowsTruncated: true };
}
