/**
 * Brand Data Layer — the local query engine behind `affiliate_query_brand_data`.
 *
 * Answers analytical questions (filters, group-bys, sums, top-N) over the
 * persisted `rows-30d` store, so an assistant can use ALL of a large account's
 * data without the data ever passing through a tool result. The query surface
 * is a constrained, Zod-validated JSON DSL, not SQL: the supported Node floor
 * (>=20) has no built-in SQLite, a native driver is an unjustified dependency,
 * and plain in-memory evaluation handles the store's byte cap comfortably. If
 * a future dataset outgrows this, SQLite can replace the evaluator behind the
 * same DSL without a contract change.
 *
 * Honesty rules (decision 2026-07-03 §5):
 *   - sums never cross currencies: aggregate results always group by currency;
 *   - a date filter outside the store's coverage window returns an explicit
 *     `coverageMismatch`, never a silently partial answer;
 *   - when the store fell back to aggregated mode, dimensions that no longer
 *     exist (network, programName, statusCanonical, row grain) return an
 *     explicit `unsupported` result rather than empty or invented values.
 *
 * See `docs/decisions/2026-07-03-tool-result-size-budget.md`.
 */

import { z } from 'zod';
import type { BrandSnapshot } from './model.js';
import { DEFAULT_BRAND_TIMEZONE } from './model.js';
import type { AggregatedTxnRow } from './rows-cap.js';
import type { BrandTxnRow } from './model.js';
import { dayInZone } from './windows.js';

// ---------------------------------------------------------------------------
// DSL schema
// ---------------------------------------------------------------------------

export const QUERY_GROUP_KEYS = [
  'day',
  'week',
  'month',
  'network',
  'programId',
  'programName',
  'currency',
  'statusBucket',
  'statusCanonical',
] as const;
export type QueryGroupKey = (typeof QUERY_GROUP_KEYS)[number];

export const QUERY_METRICS = ['transactionCount', 'saleAmount', 'commission'] as const;
export type QueryMetric = (typeof QUERY_METRICS)[number];

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const oneOrMany = z.union([z.string().min(1), z.array(z.string().min(1)).nonempty()]);

const STATUS_BUCKETS = ['pending', 'confirmed', 'declined', 'residual'] as const;

const FiltersSchema = z
  .object({
    /** Inclusive day bounds (`YYYY-MM-DD`) in the snapshot's canonical timezone. */
    from: z.string().regex(DAY_RE, 'Use YYYY-MM-DD').optional(),
    to: z.string().regex(DAY_RE, 'Use YYYY-MM-DD').optional(),
    network: oneOrMany.optional(),
    programId: oneOrMany.optional(),
    statusBucket: z
      .union([z.enum(STATUS_BUCKETS), z.array(z.enum(STATUS_BUCKETS)).nonempty()])
      .optional(),
    statusCanonical: oneOrMany.optional(),
    currency: oneOrMany.optional(),
  })
  .strict();

export const BrandDataQuerySchema = z
  .object({
    brand: z.string().min(1),
    /** `aggregate` (default) groups and sums; `rows` returns matching raw rows. */
    mode: z.enum(['aggregate', 'rows']).optional(),
    filters: FiltersSchema.optional(),
    /** Aggregate mode only. `currency` is always added: sums never cross currencies. */
    groupBy: z.array(z.enum(QUERY_GROUP_KEYS)).max(4).optional(),
    /** Metrics to return in aggregate mode. Defaults to all three. */
    metrics: z.array(z.enum(QUERY_METRICS)).nonempty().optional(),
    orderBy: z
      .object({
        field: z.enum([...QUERY_GROUP_KEYS, ...QUERY_METRICS]),
        direction: z.enum(['asc', 'desc']).optional(),
      })
      .strict()
      .optional(),
    limit: z.number().int().positive().max(1000).optional(),
    offset: z.number().int().nonnegative().optional(),
  })
  .strict();

export type BrandDataQuery = z.infer<typeof BrandDataQuerySchema>;

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface QueryCoverage {
  /** Inclusive day bounds the store covers (the snapshot's rolling 30-day window). */
  from: string;
  to: string;
  /** The pull instant the figures should be read against. */
  generatedAt: string;
}

export interface CoverageMismatch {
  requestedFrom?: string;
  requestedTo?: string;
  coveredFrom: string;
  coveredTo: string;
  hint: string;
}

export interface AggregateGroup {
  key: Partial<Record<QueryGroupKey, string>>;
  transactionCount?: number;
  saleAmount?: number;
  commission?: number;
}

export type BrandDataQueryResult =
  | {
      brand: string;
      mode: 'aggregate';
      storeMode: 'rows' | 'aggregated' | 'empty';
      coverage: QueryCoverage | null;
      coverageMismatch?: CoverageMismatch;
      matchedRowCount: number;
      groupCount: number;
      returnedCount: number;
      offset: number;
      groups: AggregateGroup[];
      hint?: string;
    }
  | {
      brand: string;
      mode: 'rows';
      storeMode: 'rows' | 'empty';
      coverage: QueryCoverage | null;
      coverageMismatch?: CoverageMismatch;
      matchedRowCount: number;
      returnedCount: number;
      offset: number;
      rows: BrandTxnRow[];
      hint?: string;
    }
  | {
      brand: string;
      storeMode: 'aggregated';
      unsupported: {
        reason: string;
        dimensions?: string[];
      };
      hint: string;
    };

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/** Dimensions that survive the aggregate store fallback. */
const AGGREGATED_STORE_DIMENSIONS: ReadonlySet<string> = new Set([
  'day',
  'week',
  'month',
  'programId',
  'currency',
  'statusBucket',
]);

const DEFAULT_LIMIT = 100;

interface EvalRow {
  day: string;
  network?: string;
  programId: string;
  programName?: string;
  currency: string;
  statusBucket: string;
  statusCanonical?: string;
  transactionCount: number;
  saleAmount: number;
  commission: number;
  full?: BrandTxnRow;
}

/** ISO-8601 week (`YYYY-Www`) of a `YYYY-MM-DD` day. Weeks belong to the year of their Thursday. */
export function isoWeek(day: string): string {
  const parts = day.split('-');
  const date = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  const weekday = (date.getUTCDay() + 6) % 7; // Monday = 0
  date.setUTCDate(date.getUTCDate() - weekday + 3); // the Thursday of this week
  const isoYear = date.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstWeekday = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstWeekday + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

function isAggregatedRow(row: unknown): row is AggregatedTxnRow {
  return (
    typeof row === 'object' &&
    row !== null &&
    'day' in row &&
    'transactionCount' in row &&
    !('txnId' in row)
  );
}

function isFullRow(row: unknown): row is BrandTxnRow {
  return typeof row === 'object' && row !== null && 'txnId' in row && 'eventDate' in row;
}

function toEvalRow(row: BrandTxnRow | AggregatedTxnRow, timezone: string): EvalRow {
  if (isAggregatedRow(row)) {
    return {
      day: row.day,
      programId: row.programId,
      currency: row.currency,
      statusBucket: row.statusBucket,
      transactionCount: row.transactionCount,
      saleAmount: row.saleAmount,
      commission: row.commission,
    };
  }
  return {
    day: dayInZone(row.eventDate, timezone),
    network: row.network,
    programId: row.programId,
    programName: row.programName,
    currency: row.currency,
    statusBucket: row.statusBucket,
    statusCanonical: row.statusCanonical,
    transactionCount: 1,
    saleAmount: row.saleAmount,
    commission: row.commission,
    full: row,
  };
}

function dimensionValue(row: EvalRow, key: QueryGroupKey): string | undefined {
  switch (key) {
    case 'day':
      return row.day;
    case 'week':
      return row.day === '' ? undefined : isoWeek(row.day);
    case 'month':
      return row.day === '' ? undefined : row.day.slice(0, 7);
    case 'network':
      return row.network;
    case 'programId':
      return row.programId;
    case 'programName':
      return row.programName;
    case 'currency':
      return row.currency;
    case 'statusBucket':
      return row.statusBucket;
    case 'statusCanonical':
      return row.statusCanonical;
  }
}

function toSet(value: string | string[] | undefined): Set<string> | undefined {
  if (value === undefined) return undefined;
  return new Set(Array.isArray(value) ? value : [value]);
}

/** The dimensions a query touches, for the aggregated-store availability check. */
function requestedDimensions(query: BrandDataQuery): string[] {
  const dims = new Set<string>();
  for (const key of query.groupBy ?? []) dims.add(key);
  const f = query.filters;
  if (f?.network !== undefined) dims.add('network');
  if (f?.programId !== undefined) dims.add('programId');
  if (f?.statusBucket !== undefined) dims.add('statusBucket');
  if (f?.statusCanonical !== undefined) dims.add('statusCanonical');
  if (f?.currency !== undefined) dims.add('currency');
  const orderField = query.orderBy?.field;
  if (orderField !== undefined && (QUERY_GROUP_KEYS as readonly string[]).includes(orderField)) {
    dims.add(orderField);
  }
  return [...dims];
}

function coverageFromSnapshot(snapshot: BrandSnapshot | null): QueryCoverage | null {
  const window = snapshot?.windows?.last30d;
  if (!snapshot || !window) return null;
  return { from: window.from, to: window.to, generatedAt: snapshot.generatedAt };
}

function detectCoverageMismatch(
  coverage: QueryCoverage | null,
  filters: BrandDataQuery['filters'],
): CoverageMismatch | undefined {
  if (!coverage) return undefined;
  const from = filters?.from;
  const to = filters?.to;
  const before = from !== undefined && from < coverage.from;
  const after = to !== undefined && to > coverage.to;
  if (!before && !after) return undefined;
  return {
    ...(from !== undefined ? { requestedFrom: from } : {}),
    ...(to !== undefined ? { requestedTo: to } : {}),
    coveredFrom: coverage.from,
    coveredTo: coverage.to,
    hint:
      'The requested range extends beyond the persisted rolling 30-day window; figures below cover only the persisted window. Rebuild the snapshot for fresher data, or use the per-network list/summary tools for history outside it.',
  };
}

function compareValues(a: string | number | undefined, b: string | number | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/**
 * Evaluate a validated query over the stored rows. Pure: the caller loads the
 * store and snapshot; nothing here touches the filesystem or the clock.
 */
export function evaluateBrandDataQuery(
  stored: unknown[],
  snapshot: BrandSnapshot | null,
  query: BrandDataQuery,
): BrandDataQueryResult {
  const mode = query.mode ?? 'aggregate';
  const timezone = snapshot?.timezone ?? DEFAULT_BRAND_TIMEZONE;
  const coverage = coverageFromSnapshot(snapshot);
  const limit = query.limit ?? DEFAULT_LIMIT;
  const offset = query.offset ?? 0;

  const storeIsAggregated = stored.length > 0 && isAggregatedRow(stored[0]);

  if (storeIsAggregated) {
    // Row grain no longer exists; only the aggregate dimensions survive.
    if (mode === 'rows') {
      return {
        brand: query.brand,
        storeMode: 'aggregated',
        unsupported: {
          reason:
            'The persisted store fell back to aggregated mode (rowsTruncated), so transaction-grain rows are not available for this brand.',
        },
        hint: 'Use mode "aggregate" with the day, week, month, programId, currency, or statusBucket dimensions, or narrow the pull so the store stays within its byte cap.',
      };
    }
    const missing = requestedDimensions(query).filter(
      (d) => !AGGREGATED_STORE_DIMENSIONS.has(d),
    );
    if (missing.length > 0) {
      return {
        brand: query.brand,
        storeMode: 'aggregated',
        unsupported: {
          reason:
            'The persisted store fell back to aggregated mode (rowsTruncated); the requested dimensions were collapsed away.',
          dimensions: missing,
        },
        hint: `Available dimensions in aggregated mode: ${[...AGGREGATED_STORE_DIMENSIONS].join(', ')}.`,
      };
    }
  }

  const evalRows: EvalRow[] = [];
  for (const raw of stored) {
    if (isFullRow(raw) || isAggregatedRow(raw)) evalRows.push(toEvalRow(raw, timezone));
  }

  const f = query.filters;
  const networkSet = toSet(f?.network);
  const programSet = toSet(f?.programId);
  const bucketSet = toSet(f?.statusBucket as string | string[] | undefined);
  const canonicalSet = toSet(f?.statusCanonical);
  const currencySet = toSet(f?.currency);

  const matched = evalRows.filter((row) => {
    if (f?.from !== undefined && row.day < f.from) return false;
    if (f?.to !== undefined && row.day > f.to) return false;
    if (networkSet && (row.network === undefined || !networkSet.has(row.network))) return false;
    if (programSet && !programSet.has(row.programId)) return false;
    if (bucketSet && !bucketSet.has(row.statusBucket)) return false;
    if (canonicalSet && (row.statusCanonical === undefined || !canonicalSet.has(row.statusCanonical)))
      return false;
    if (currencySet && !currencySet.has(row.currency)) return false;
    return true;
  });

  const coverageMismatch = detectCoverageMismatch(coverage, f);
  const storeMode: 'rows' | 'aggregated' | 'empty' =
    stored.length === 0 ? 'empty' : storeIsAggregated ? 'aggregated' : 'rows';
  const emptyHint =
    storeMode === 'empty'
      ? 'No rows are persisted for this brand. Run affiliate_build_brand_snapshot first.'
      : undefined;

  if (mode === 'rows') {
    const direction = query.orderBy?.direction === 'desc' ? -1 : 1;
    const orderField = query.orderBy?.field;
    const sorted = [...matched].sort((a, b) => {
      const cmp = orderField
        ? compareValues(sortValue(a, orderField), sortValue(b, orderField))
        : compareValues(a.day, b.day) || compareValues(a.full?.txnId, b.full?.txnId);
      return cmp * direction;
    });
    const page = sorted.slice(offset, offset + limit);
    return {
      brand: query.brand,
      mode: 'rows',
      storeMode: storeMode === 'aggregated' ? 'rows' : storeMode, // unreachable: aggregated returned above
      coverage,
      ...(coverageMismatch ? { coverageMismatch } : {}),
      matchedRowCount: matched.length,
      returnedCount: page.length,
      offset,
      rows: page.map((r) => r.full).filter((r): r is BrandTxnRow => r !== undefined),
      ...(emptyHint ? { hint: emptyHint } : {}),
    };
  }

  // Aggregate mode. Currency is always a grouping dimension: sums that cross
  // currencies are meaningless and the no-FX rule forbids converting them.
  const groupKeys: QueryGroupKey[] = [...(query.groupBy ?? [])];
  if (!groupKeys.includes('currency')) groupKeys.push('currency');
  const metrics: QueryMetric[] = query.metrics ?? [...QUERY_METRICS];

  const groups = new Map<string, AggregateGroup & Record<QueryMetric, number>>();
  for (const row of matched) {
    const keyEntries = groupKeys.map((k) => [k, dimensionValue(row, k) ?? ''] as const);
    // JSON-encode the key tuple: free-form values (programme names) can
    // contain any delimiter, so a plain joined string would let distinct
    // tuples collide into one group.
    const mapKey = JSON.stringify(keyEntries.map(([, v]) => v));
    let group = groups.get(mapKey);
    if (!group) {
      group = {
        key: Object.fromEntries(keyEntries),
        transactionCount: 0,
        saleAmount: 0,
        commission: 0,
      };
      groups.set(mapKey, group);
    }
    group.transactionCount += row.transactionCount;
    group.saleAmount += row.saleAmount;
    group.commission += row.commission;
  }

  const orderField = query.orderBy?.field;
  const direction = query.orderBy?.direction === 'desc' ? -1 : 1;
  const allGroups = [...groups.values()].sort((a, b) => {
    if (orderField && (QUERY_METRICS as readonly string[]).includes(orderField)) {
      return (a[orderField as QueryMetric] - b[orderField as QueryMetric]) * direction;
    }
    if (orderField) {
      return (
        compareValues(a.key[orderField as QueryGroupKey], b.key[orderField as QueryGroupKey]) *
        direction
      );
    }
    // Deterministic default: the group key, ascending.
    return compareValues(
      JSON.stringify(Object.values(a.key)),
      JSON.stringify(Object.values(b.key)),
    );
  });

  const page = allGroups.slice(offset, offset + limit).map((g) => ({
    key: g.key,
    ...(metrics.includes('transactionCount') ? { transactionCount: g.transactionCount } : {}),
    ...(metrics.includes('saleAmount') ? { saleAmount: g.saleAmount } : {}),
    ...(metrics.includes('commission') ? { commission: g.commission } : {}),
  }));

  return {
    brand: query.brand,
    mode: 'aggregate',
    storeMode,
    coverage,
    ...(coverageMismatch ? { coverageMismatch } : {}),
    matchedRowCount: matched.length,
    groupCount: allGroups.length,
    returnedCount: page.length,
    offset,
    groups: page,
    ...(emptyHint ? { hint: emptyHint } : {}),
  };
}

function sortValue(row: EvalRow, field: QueryGroupKey | QueryMetric): string | number | undefined {
  if ((QUERY_METRICS as readonly string[]).includes(field)) {
    return row[field as QueryMetric];
  }
  return dimensionValue(row, field as QueryGroupKey);
}
