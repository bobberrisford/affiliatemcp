/**
 * Brand Data Layer — the pull layer.
 *
 * The only adapter-touching file in the module. Awin's advertiser performance
 * report (and others like it) aggregates per partner over the queried range and
 * does not return a daily series, so the orchestrator pulls performance once per
 * window range rather than bucketing a single pull by date. Each pull goes
 * through the shared `withCache` so a refresh reuses the same store the MCP
 * tools use.
 *
 * See `docs/decisions/2026-06-30-brand-data-layer.md`.
 */

import { buildAdapterCallContext } from '../shared/brand-resolver.js';
import { cacheKey, credentialHashFor, pickTtl, withCache } from '../shared/cache.js';
import { getAdapter } from '../shared/registry.js';
import type {
  NetworkSlug,
  ProgrammePerformanceRow,
  Transaction,
} from '../shared/types.js';
import { chunkDayRange } from './windows.js';

/**
 * Pull advertiser performance for one `(brand, network)` over an inclusive
 * `[from, to]` day range. Requires an advertiser-side adapter that implements
 * `getProgrammePerformance` (the clicks/commission source); throws a clear
 * error otherwise so the orchestrator can record the network as `failed`.
 */
export async function pullPerformanceRange(
  brand: string,
  network: NetworkSlug,
  from: string,
  to: string,
): Promise<ProgrammePerformanceRow[]> {
  const adapter = getAdapter(network);
  if (!adapter) {
    throw new Error(`No adapter registered for network "${network}".`);
  }
  const getProgrammePerformance = adapter.getProgrammePerformance;
  if (typeof getProgrammePerformance !== 'function') {
    throw new Error(
      `Adapter "${network}" does not implement getProgrammePerformance; advertiser-side ` +
        `performance is the clicks and commission source for the brand snapshot.`,
    );
  }

  const ctx = buildAdapterCallContext(brand, network);
  const args = { from, to };
  return withCache(
    cacheKey({
      network,
      operation: 'getProgrammePerformance',
      args: { ...args, brand },
      adapterVersion: adapter.meta.adapterVersion,
      credentialHash: credentialHashFor(network),
    }),
    pickTtl('getProgrammePerformance', args, new Date(), true),
    () => getProgrammePerformance.call(adapter, args, ctx),
  );
}

/**
 * Pull transactions for one `(brand, network)` over an inclusive `[from, to]`
 * day range, through the shared `withCache`. Transactions carry the accurate
 * per-transaction status (the advertiser performance report collapses its
 * multi-status columns into one value), so the commission split and conversion
 * counts come from here, not from performance.
 */
export async function pullTransactions(
  brand: string,
  network: NetworkSlug,
  from: string,
  to: string,
): Promise<Transaction[]> {
  const adapter = getAdapter(network);
  if (!adapter) {
    throw new Error(`No adapter registered for network "${network}".`);
  }
  const ctx = buildAdapterCallContext(brand, network);
  const adapterVersion = adapter.meta.adapterVersion;
  const credentialHash = credentialHashFor(network);

  // Chunk into <=31-day slices: Awin's transaction endpoints reject wider
  // ranges, and the advertiser adapter does not chunk internally.
  const out: Transaction[] = [];
  for (const slice of chunkDayRange(from, to)) {
    const args = { from: slice.from, to: slice.to };
    const rows = await withCache(
      cacheKey({
        network,
        operation: 'listTransactions',
        args: { ...args, brand },
        adapterVersion,
        credentialHash,
      }),
      pickTtl('listTransactions', args, new Date(), true),
      () => adapter.listTransactions(args, ctx),
    );
    // Append without spread: a slice can be tens of thousands of rows, and
    // `push(...rows)` would overflow the argument stack on large accounts.
    for (const row of rows) out.push(row);
  }
  return out;
}
