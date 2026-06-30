/**
 * Brand Data Layer — metric computation.
 *
 * Pure aggregation of normalised rows into the brief's metric definitions
 * (§4), in one currency. Ratios are `null` (render blank) when their
 * denominator is zero — this is how the "keep the full metric set, blank the
 * gaps" decision manifests: a network with no click data yields clicks = 0 and
 * EPC/conversion-rate blank, never a misleading `0`.
 *
 * Cross-network and cross-currency roll-up (and per-programme breakdown) is the
 * orchestrator's job (PR-2); these are the per-currency building blocks.
 *
 * See `docs/decisions/2026-06-30-brand-data-layer.md`.
 */

import type { BrandClicksRow, BrandTxnRow, CommissionSplit, WindowMetrics } from './model.js';

function ratio(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

/** Commission split across a set of transaction rows (assumed one currency). */
export function computeCommissionSplit(txnRows: BrandTxnRow[]): CommissionSplit {
  let pending = 0;
  let confirmed = 0;
  let declined = 0;
  let residual = 0;
  let settled = 0;
  for (const row of txnRows) {
    switch (row.statusBucket) {
      case 'pending':
        pending += row.commission;
        break;
      case 'confirmed':
        confirmed += row.commission;
        if (row.statusCanonical === 'paid') settled += row.commission;
        break;
      case 'declined':
        declined += row.commission;
        break;
      case 'residual':
        residual += row.commission;
        break;
    }
  }
  return { pending, confirmed, declined, residual, settled, totalTracked: pending + confirmed };
}

/**
 * Full window metrics from transaction rows (commission, conversions, AOV) and
 * clicks rows (clicks, and the clicks denominator for EPC/conversion-rate), all
 * in a single currency. Conversions exclude declined (brief D2); declined are
 * counted separately. EPC headline uses total-tracked commission (brief D1).
 */
export function computeWindowMetrics(
  txnRows: BrandTxnRow[],
  clicksRows: BrandClicksRow[],
  currency: string,
): WindowMetrics {
  const commission = computeCommissionSplit(txnRows);

  let conversions = 0;
  let declinedConversions = 0;
  let saleTotal = 0;
  for (const row of txnRows) {
    if (row.statusBucket === 'declined') {
      declinedConversions += 1;
      continue;
    }
    // residual is surfaced in the commission split but is not a counted
    // conversion; only pending + confirmed are conversions.
    if (row.statusBucket === 'pending' || row.statusBucket === 'confirmed') {
      conversions += 1;
      saleTotal += row.saleAmount;
    }
  }

  let clicks = 0;
  for (const row of clicksRows) clicks += row.clicks;

  return {
    currency,
    clicks,
    conversions,
    declinedConversions,
    saleTotal,
    commission,
    epc: ratio(commission.totalTracked, clicks),
    confirmedEpc: ratio(commission.confirmed, clicks),
    conversionRate: ratio(conversions, clicks),
    aov: ratio(saleTotal, conversions),
  };
}

/** Group rows by their `currency` field, preserving first-seen order. */
export function groupByCurrency<T extends { currency: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = out.get(row.currency);
    if (bucket) bucket.push(row);
    else out.set(row.currency, [row]);
  }
  return out;
}

/**
 * Per-currency window metrics for a window's rows. Transactions and clicks are
 * grouped by currency independently (they arrive at different grains), and any
 * currency seen in either feed gets an entry.
 */
export function computeMetricsByCurrency(
  txnRows: BrandTxnRow[],
  clicksRows: BrandClicksRow[],
): WindowMetrics[] {
  const txnByCcy = groupByCurrency(txnRows);
  const clicksByCcy = groupByCurrency(clicksRows);
  const currencies = new Set<string>([...txnByCcy.keys(), ...clicksByCcy.keys()]);
  return [...currencies].map((ccy) =>
    computeWindowMetrics(txnByCcy.get(ccy) ?? [], clicksByCcy.get(ccy) ?? [], ccy),
  );
}
