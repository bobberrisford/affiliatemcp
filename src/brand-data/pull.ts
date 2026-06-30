/**
 * Brand Data Layer — the pull layer.
 *
 * The only adapter-touching file in the module. Pulls one bound network's
 * transactions (last 30 days) and advertiser performance (1 January -> today),
 * each through the shared `withCache` so a refresh reuses the same store the MCP
 * tools use. Per the brief's pull strategy (§8):
 *   - transactions, row-level, last 30 days -> commission/status split for the
 *     yesterday/7d/30d windows and the CSV/pivot grain;
 *   - daily advertiser performance, YTD -> the clicks (EPC denominator) for all
 *     four windows.
 *
 * See `docs/decisions/2026-06-30-brand-data-layer.md`.
 */

import { buildAdapterCallContext } from '../shared/brand-resolver.js';
import { cacheKey, credentialHashFor, pickTtl, withCache } from '../shared/cache.js';
import { getAdapter } from '../shared/registry.js';
import type { NetworkSlug, ProgrammePerformanceRow, Transaction } from '../shared/types.js';
import { DEFAULT_BRAND_TIMEZONE } from './model.js';
import { addDays, dayInZone, startOfYear } from './windows.js';

export interface PullResult {
  transactions: Transaction[];
  performance: ProgrammePerformanceRow[];
}

export interface PullRanges {
  /** Inclusive `YYYY-MM-DD` start of the 30-day transaction window. */
  txnFrom: string;
  /** Inclusive `YYYY-MM-DD` start of the YTD performance window. */
  perfFrom: string;
  /** Inclusive `YYYY-MM-DD` end (today in the canonical timezone). */
  to: string;
}

/** The date ranges to request, anchored on `asOf` in the canonical timezone. */
export function pullRanges(asOf: string, timezone: string = DEFAULT_BRAND_TIMEZONE): PullRanges {
  const today = dayInZone(asOf, timezone);
  return { txnFrom: addDays(today, -29), perfFrom: startOfYear(today), to: today };
}

/**
 * Pull transactions and advertiser performance for one bound `(brand, network)`.
 * Requires an advertiser-side adapter that implements `getProgrammePerformance`
 * (the clicks source); throws a clear error otherwise so the orchestrator can
 * record the network as `failed` rather than silently drop it.
 */
export async function pullForNetwork(
  brand: string,
  network: NetworkSlug,
  asOf: string,
  timezone: string = DEFAULT_BRAND_TIMEZONE,
): Promise<PullResult> {
  const adapter = getAdapter(network);
  if (!adapter) {
    throw new Error(`No adapter registered for network "${network}".`);
  }
  const getProgrammePerformance = adapter.getProgrammePerformance;
  if (typeof getProgrammePerformance !== 'function') {
    throw new Error(
      `Adapter "${network}" does not implement getProgrammePerformance; advertiser-side ` +
        `performance is the clicks source for the brand snapshot.`,
    );
  }

  const ctx = buildAdapterCallContext(brand, network);
  const ranges = pullRanges(asOf, timezone);
  const adapterVersion = adapter.meta.adapterVersion;
  const credentialHash = credentialHashFor(network);
  const now = new Date();

  const txnArgs = { from: ranges.txnFrom, to: ranges.to };
  const transactions = await withCache(
    cacheKey({ network, operation: 'listTransactions', args: { ...txnArgs, brand }, adapterVersion, credentialHash }),
    pickTtl('listTransactions', txnArgs, now, true),
    () => adapter.listTransactions(txnArgs, ctx),
  );

  const perfArgs = { from: ranges.perfFrom, to: ranges.to };
  const performance = await withCache(
    cacheKey({ network, operation: 'getProgrammePerformance', args: { ...perfArgs, brand }, adapterVersion, credentialHash }),
    pickTtl('getProgrammePerformance', perfArgs, now, true),
    () => getProgrammePerformance.call(adapter, perfArgs, ctx),
  );

  return { transactions, performance };
}
