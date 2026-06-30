/**
 * Brand Data Layer — derived domain model.
 *
 * These shapes are NOT the adapter contract. `src/shared/types.ts` is the
 * contract 80+ adapters implement and is frozen; the brand-data row is a
 * *derived* shape produced by the normaliser in `normalise.ts`, which consumes
 * the existing `Transaction[]` and `ProgrammePerformanceRow[]`. No field is
 * added to `Transaction`, `ProgrammePerformanceRow`, `EarningsSummary`, or
 * `TransactionStatus` to serve this consumer.
 *
 * See `docs/decisions/2026-06-30-brand-data-layer.md`.
 */

import type { NetworkSlug, TransactionStatus } from '../shared/types.js';

/** Bumped when the persisted snapshot/rows shape changes incompatibly. */
export const BRAND_DATA_SCHEMA_VERSION = 1 as const;

/** Default canonical brand timezone; windows are midnight-to-midnight here. */
export const DEFAULT_BRAND_TIMEZONE = 'Europe/London';

/** Default cap on stored 30-day rows before the aggregate fallback (brief D3). */
export const ROWS_CAP = 10_000;

/**
 * The brief's three-way commission split, as a *presentation projection* of the
 * canonical five-state `TransactionStatus`, plus a `residual` for states that
 * map to none of the three. Never a type change to `TransactionStatus`.
 *
 *   pending  -> pending
 *   approved -> confirmed
 *   paid     -> confirmed (settled; tracked via `statusCanonical === 'paid'`)
 *   reversed -> declined
 *   other    -> residual (surfaced, never dropped, never miscounted as one of the three)
 *
 * "Total tracked" commission = pending + confirmed (which includes paid).
 * Declined and residual never enter totals.
 */
export type StatusBucket = 'pending' | 'confirmed' | 'declined' | 'residual';

/** The four time windows, all bucketed by event date in the canonical timezone. */
export type WindowKey = 'yesterday' | 'last7d' | 'last30d' | 'ytd';

export const WINDOW_KEYS: readonly WindowKey[] = ['yesterday', 'last7d', 'last30d', 'ytd'];

/**
 * A transaction projected into the brand-data vocabulary. Derived from
 * `Transaction`; `txnId` is the upsert key (status mutates across pulls).
 */
export interface BrandTxnRow {
  network: NetworkSlug;
  brandId: string;
  /** The merchant/programme dimension — `Transaction.programmeId`. */
  programId: string;
  programName: string;
  /** Upsert key — `Transaction.id`. */
  txnId: string;
  /** The bucketing date — `Transaction.dateConverted` (ISO). */
  eventDate: string;
  statusCanonical: TransactionStatus;
  statusBucket: StatusBucket;
  /** Verbatim upstream status token, when the adapter supplied one. */
  statusRaw?: string;
  saleAmount: number;
  commission: number;
  currency: string;
  /** Best-effort; captured if cheap, never a pivot in v1 (brief D5). */
  subId?: string;
}

/**
 * A per-partner, per-day clicks/conversions row. Derived from
 * `ProgrammePerformanceRow` (which carries counts); the publisher-side `Click`
 * type is individual events with no count and is not the clicks source.
 *
 * On the advertiser side wired first, `partnerId`/`partnerName` is the publisher.
 */
export interface BrandClicksRow {
  network: NetworkSlug;
  brandId: string;
  partnerId: string;
  partnerName: string;
  /** The bucketing date — `ProgrammePerformanceRow.date` (ISO `YYYY-MM-DD`). */
  date: string;
  clicks: number;
  conversions: number;
  grossSale: number;
  commission: number;
  currency: string;
}

/**
 * Commission split for a window, in one currency. `totalTracked` is the only
 * headline figure; `declined` and `residual` are surfaced but never summed in.
 */
export interface CommissionSplit {
  pending: number;
  /** Approved + paid. */
  confirmed: number;
  declined: number;
  /** Canonical `other` — surfaced, never in totals. */
  residual: number;
  /** Subset of `confirmed` whose canonical status is `paid`. */
  settled: number;
  /** pending + confirmed. */
  totalTracked: number;
}

/**
 * Computed metrics for one window in one currency. Ratios are `null` (blank)
 * when their denominator is zero — e.g. EPC is blank when no click data is
 * available — rather than a misleading `0`.
 */
export interface WindowMetrics {
  currency: string;
  clicks: number;
  /** Excludes declined (brief D2). */
  conversions: number;
  /** Shown separately, never folded into `conversions`. */
  declinedConversions: number;
  saleTotal: number;
  commission: CommissionSplit;
  /** totalTracked / clicks (headline, brief D1); `null` when clicks = 0. */
  epc: number | null;
  /** confirmed / clicks (secondary); `null` when clicks = 0. */
  confirmedEpc: number | null;
  /** conversions / clicks; `null` when clicks = 0. */
  conversionRate: number | null;
  /** saleTotal / conversions; `null` when conversions = 0. */
  aov: number | null;
}

/** Health of one *bound* network in a snapshot — count-honest (brief §13). */
export interface NetworkHealth {
  network: NetworkSlug;
  state: 'ok' | 'degraded' | 'failed';
  /** Verbatim upstream envelope when `failed`. */
  error?: unknown;
  /** Free-text note, e.g. "clicks unavailable; EPC blank". */
  note?: string;
}
