/**
 * Brand Data Layer — the snapshot orchestrator.
 *
 * For each network a brand is bound to:
 *   - pulls transactions once over the YTD range and buckets them by event date
 *     into the four windows — the accurate commission status split and
 *     conversion counts (brief §4) come from transactions, because the
 *     advertiser performance report collapses its multi-status columns;
 *   - pulls advertiser performance once per window range for the clicks (the EPC
 *     denominator) — that report is range-aggregated per partner with no daily
 *     series, so it is queried per window rather than bucketed by date.
 *
 * It then computes per-currency totals and a per-programme breakdown, and
 * assembles a count-honest `BrandSnapshot`: `byNetwork` carries one entry per
 * *bound* network, and totals only include networks that pulled successfully
 * (brief §13).
 *
 * See `docs/decisions/2026-06-30-brand-data-layer.md`.
 */

import { listBrandsForNetwork, loadBrands } from '../shared/brands.js';
import type { NetworkSlug } from '../shared/types.js';
import { computePerfMetricsByCurrency } from './metrics.js';
import {
  BRAND_DATA_SCHEMA_VERSION,
  DEFAULT_BRAND_TIMEZONE,
  WINDOW_KEYS,
  type BrandClicksRow,
  type BrandSnapshot,
  type BrandTxnRow,
  type NetworkHealth,
  type ProgramBreakdownRow,
  type WindowKey,
  type WindowSnapshot,
} from './model.js';
import { normalisePerformance, normaliseTransactions } from './normalise.js';
import { pullPerformanceRange, pullTransactions } from './pull.js';
import { capTxnRows, type RowsCapResult } from './rows-cap.js';
import { bucketByWindow, windowBounds } from './windows.js';

export interface SnapshotOptions {
  /** The "as of" instant; defaults to now. Pass it in for deterministic tests. */
  asOf?: string;
  timezone?: string;
  /** Restrict to a subset of the brand's bound networks (default: all bound). */
  networks?: NetworkSlug[];
}

/** A compact per-pull headline appended to history for trend (brief §9). */
export interface HistoryEntry {
  generatedAt: string;
  windows: Record<WindowKey, Array<{ currency: string; totalTracked: number; clicks: number }>>;
}

export interface SnapshotResult {
  snapshot: BrandSnapshot;
  /** Full or aggregated 30-day transaction rows, for the store + CSV/pivot. */
  rows: RowsCapResult;
  /** Compact headline for the history log. */
  history: HistoryEntry;
}

/** The networks a brand is bound to, in `brands.json` order. */
function boundNetworks(brand: string): NetworkSlug[] {
  const file = loadBrands();
  return (file.brands[brand] ?? []).map((b) => b.network);
}

/** Build one window's view from its performance rows: per-currency totals + per-partner breakdown. */
function buildWindow(
  key: WindowKey,
  from: string,
  to: string,
  clicksRows: BrandClicksRow[],
): WindowSnapshot {
  const totals = computePerfMetricsByCurrency(clicksRows);

  // Per-partner (publisher) breakdown from the performance rows. On the
  // advertiser side the report is per publisher, so this is the natural grain;
  // programId/programName carry the publisher identity.
  const byPartnerId = new Map<string, BrandClicksRow[]>();
  const partnerNames = new Map<string, string>();
  for (const row of clicksRows) {
    const bucket = byPartnerId.get(row.partnerId);
    if (bucket) bucket.push(row);
    else byPartnerId.set(row.partnerId, [row]);
    partnerNames.set(row.partnerId, row.partnerName);
  }
  const byProgram: ProgramBreakdownRow[] = [];
  for (const [partnerId, rows] of byPartnerId) {
    for (const metrics of computePerfMetricsByCurrency(rows)) {
      byProgram.push({ programId: partnerId, programName: partnerNames.get(partnerId) ?? partnerId, metrics });
    }
  }

  return { window: key, from, to, totals, byProgram };
}

/**
 * Build a brand snapshot across the brand's bound networks. Never throws on a
 * single network's failure — that network is recorded as `failed` with its
 * error and excluded from totals.
 */
export async function buildBrandSnapshot(
  brand: string,
  options: SnapshotOptions = {},
): Promise<SnapshotResult> {
  const timezone = options.timezone ?? DEFAULT_BRAND_TIMEZONE;
  const asOf = options.asOf ?? new Date().toISOString();
  const networks = options.networks ?? boundNetworks(brand);
  const bounds = windowBounds(asOf, timezone);

  const allTxnRows: BrandTxnRow[] = [];
  const windowClicks: Record<WindowKey, BrandClicksRow[]> = {
    yesterday: [],
    last7d: [],
    last30d: [],
    ytd: [],
  };
  const byNetwork: NetworkHealth[] = [];

  for (const network of networks) {
    // Advertiser performance is the metric source: one report call per window
    // carries clicks, conversions, and the commission status split (accurate per
    // tier since #282), so there is no year-long row-level transaction pull. A
    // failure here means the network is genuinely unavailable: exclude it.
    const localClicks: Record<WindowKey, BrandClicksRow[]> = {
      yesterday: [],
      last7d: [],
      last30d: [],
      ytd: [],
    };
    let perfRowCount = 0;
    try {
      for (const key of WINDOW_KEYS) {
        const perf = await pullPerformanceRange(brand, network, bounds[key].from, bounds[key].to);
        localClicks[key].push(...normalisePerformance(perf, network, brand));
        perfRowCount += perf.length;
      }
    } catch (err) {
      byNetwork.push({
        network,
        state: 'failed',
        error: (err as { envelope?: unknown }).envelope ?? (err as Error).message,
        note: `performance pull failed; totals exclude ${network}`,
      });
      continue;
    }
    for (const key of WINDOW_KEYS) windowClicks[key].push(...localClicks[key]);

    const health: NetworkHealth = { network, state: 'ok' };
    if (perfRowCount === 0) {
      health.note = 'no advertiser performance rows in range';
    }

    // Transactions are pulled only for the last 30 days, and only to populate the
    // transaction-grain drill-down / CSV rows — never the totals. Best-effort: a
    // failure blanks the drill-down but leaves the totals intact.
    try {
      const txns = await pullTransactions(brand, network, bounds.last30d.from, bounds.last30d.to);
      // Append without spread: large accounts return tens of thousands of rows.
      for (const row of normaliseTransactions(txns, brand)) allTxnRows.push(row);
    } catch {
      health.note = health.note
        ? `${health.note}; transaction drill-down unavailable`
        : 'transaction drill-down unavailable';
    }
    byNetwork.push(health);
  }

  const windows = {} as Record<WindowKey, WindowSnapshot>;
  for (const key of WINDOW_KEYS) {
    windows[key] = buildWindow(key, bounds[key].from, bounds[key].to, windowClicks[key]);
  }

  // rows-30d carries the last-30-day transaction grain for CSV/pivot.
  const windowTxn = bucketByWindow(allTxnRows, (r) => r.eventDate, asOf, timezone);
  const rows = capTxnRows(windowTxn.last30d, undefined, timezone);

  const snapshot: BrandSnapshot = {
    schemaVersion: BRAND_DATA_SCHEMA_VERSION,
    brandId: brand,
    generatedAt: asOf,
    timezone,
    windows,
    byNetwork,
    rowsTruncated: rows.rowsTruncated,
  };

  const history: HistoryEntry = {
    generatedAt: asOf,
    windows: WINDOW_KEYS.reduce(
      (acc, key) => {
        acc[key] = windows[key].totals.map((m) => ({
          currency: m.currency,
          totalTracked: m.commission.totalTracked,
          clicks: m.clicks,
        }));
        return acc;
      },
      {} as HistoryEntry['windows'],
    ),
  };

  return { snapshot, rows, history };
}

// Re-exported for callers that want the bound-network list without a full pull.
export { boundNetworks, listBrandsForNetwork };
