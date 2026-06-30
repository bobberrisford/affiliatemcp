/**
 * Brand Data Layer — the snapshot orchestrator.
 *
 * Pulls every network a brand is bound to, normalises and buckets the rows into
 * the four windows, computes per-currency totals and a per-programme breakdown,
 * and assembles a count-honest `BrandSnapshot`. Partial failure is surfaced, not
 * hidden: `byNetwork` carries one entry per *bound* network, and totals only
 * include networks that pulled successfully (brief §13).
 *
 * Clicks come from advertiser performance (the EPC denominator); commission,
 * its status split, conversions, and AOV come from transactions (brief §4).
 *
 * See `docs/decisions/2026-06-30-brand-data-layer.md`.
 */

import { listBrandsForNetwork, loadBrands } from '../shared/brands.js';
import type { NetworkSlug } from '../shared/types.js';
import { computeMetricsByCurrency } from './metrics.js';
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
import { pullForNetwork } from './pull.js';
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

function buildWindow(
  key: WindowKey,
  txnRows: BrandTxnRow[],
  clicksRows: BrandClicksRow[],
  asOf: string,
  timezone: string,
): WindowSnapshot {
  const bounds = windowBounds(asOf, timezone)[key];
  const totals = computeMetricsByCurrency(txnRows, clicksRows);

  // Per-programme breakdown from transactions; clicks are at the publisher
  // grain, so per-programme EPC is intentionally blank (null).
  const byProgramId = new Map<string, BrandTxnRow[]>();
  const programNames = new Map<string, string>();
  for (const row of txnRows) {
    const bucket = byProgramId.get(row.programId);
    if (bucket) bucket.push(row);
    else byProgramId.set(row.programId, [row]);
    programNames.set(row.programId, row.programName);
  }
  const byProgram: ProgramBreakdownRow[] = [];
  for (const [programId, rows] of byProgramId) {
    for (const metrics of computeMetricsByCurrency(rows, [])) {
      byProgram.push({ programId, programName: programNames.get(programId) ?? programId, metrics });
    }
  }

  return { window: key, from: bounds.from, to: bounds.to, totals, byProgram };
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

  const txnRows: BrandTxnRow[] = [];
  const clicksRows: BrandClicksRow[] = [];
  const byNetwork: NetworkHealth[] = [];

  for (const network of networks) {
    try {
      const { transactions, performance } = await pullForNetwork(brand, network, asOf, timezone);
      txnRows.push(...normaliseTransactions(transactions, brand));
      clicksRows.push(...normalisePerformance(performance, network, brand));
      // A successful pull with no performance rows is a valid empty result, not
      // a degradation; note it so the UI can explain blank clicks/EPC without
      // raising a false "needs attention" signal.
      const health: NetworkHealth = { network, state: 'ok' };
      if (performance.length === 0) {
        health.note = 'no advertiser performance rows in range; clicks and EPC blank';
      }
      byNetwork.push(health);
    } catch (err) {
      byNetwork.push({
        network,
        state: 'failed',
        error: (err as { envelope?: unknown }).envelope ?? (err as Error).message,
        note: `pull failed; totals exclude ${network}`,
      });
    }
  }

  const windowsTxn = bucketByWindow(txnRows, (r) => r.eventDate, asOf, timezone);
  const windowsClicks = bucketByWindow(clicksRows, (r) => r.date, asOf, timezone);

  const windows = {} as Record<WindowKey, WindowSnapshot>;
  for (const key of WINDOW_KEYS) {
    windows[key] = buildWindow(key, windowsTxn[key], windowsClicks[key], asOf, timezone);
  }

  const rows = capTxnRows(txnRows, undefined, timezone);

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
