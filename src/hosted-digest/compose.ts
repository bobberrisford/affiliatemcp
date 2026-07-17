/**
 * Pure digest-composition helpers (workstream slice H6:
 * `docs/product/hosted-mvp-workstream.md`). No I/O — takes the already-fetched
 * `EarningsSummary` per network (or a per-network read failure) and produces
 * plain-text subject/body pairs. Kept separate from `run.ts` so composition
 * is testable without mocking `fetch`, adapters, or the vault.
 *
 * Two digest types, per the pricing decision
 * (`docs/decisions/2026-07-12-pricing-billing-and-licence.md`): Solo gets the
 * weekly earnings digest; Pro additionally gets the unpaid-commissions
 * digest. Both are composed from the SAME per-network `EarningsSummary`
 * reads (`byStatus`, `oldestUnpaidAgeDays`) — no separate transaction-level
 * fetch is needed for the unpaid digest, since `EarningsSummary` already
 * carries exactly the aggregate figures Principle 4.1's "the £42 from
 * January is still pending after 95 days" affordance needs.
 */

import type { EarningsSummary } from '../shared/types.js';

export type DigestType = 'earnings' | 'unpaid-commissions';

/** One network's earnings read: either a summary, or an honest note that this network could not
 * be read this run (never silently omitted — a partial digest says so). */
export type NetworkEarningsResult =
  | { network: string; ok: true; summary: EarningsSummary }
  | { network: string; ok: false; message: string };

function formatMoney(amount: number, currency: string): string {
  return `${currency} ${amount.toFixed(2)}`;
}

function sumStatusBucket(results: NetworkEarningsResult[], pick: (s: EarningsSummary) => number): number {
  return results.filter((r): r is Extract<NetworkEarningsResult, { ok: true }> => r.ok).reduce((acc, r) => acc + pick(r.summary), 0);
}

export interface ComposedDigest {
  subject: string;
  body: string;
}

/**
 * Weekly earnings digest (Solo and Pro). Totals every network's
 * `totalEarnings` (assumes a consistent currency across the caller's
 * networks — the same simplifying assumption `EarningsSummary` itself makes
 * per network; a genuinely multi-currency account sees each network's own
 * currency called out per line and no single blended total).
 */
export function composeEarningsDigest(results: NetworkEarningsResult[], periodLabel: string): ComposedDigest {
  const ok = results.filter((r): r is Extract<NetworkEarningsResult, { ok: true }> => r.ok);
  const failed = results.filter((r): r is Extract<NetworkEarningsResult, { ok: false }> => !r.ok);

  const lines: string[] = [];
  lines.push(`Your affiliate-mcp earnings digest — ${periodLabel}`);
  lines.push('');

  if (ok.length === 0) {
    lines.push('No networks could be read this run.');
  } else {
    const byCurrency = new Map<string, number>();
    for (const r of ok) {
      byCurrency.set(r.summary.currency, (byCurrency.get(r.summary.currency) ?? 0) + r.summary.totalEarnings);
    }
    for (const [currency, total] of byCurrency) {
      lines.push(`Total earnings: ${formatMoney(total, currency)}`);
    }
    lines.push('');
    lines.push('By network:');
    for (const r of ok) {
      const transactionCount = r.summary.byProgramme.reduce((acc, p) => acc + p.transactionCount, 0);
      lines.push(`  ${r.network}: ${formatMoney(r.summary.totalEarnings, r.summary.currency)} (${transactionCount} transaction(s))`);
    }
  }

  if (failed.length > 0) {
    lines.push('');
    lines.push('Could not be read this run:');
    for (const r of failed) {
      lines.push(`  ${r.network}: ${r.message}`);
    }
  }

  return { subject: `Your affiliate-mcp earnings digest — ${periodLabel}`, body: lines.join('\n') };
}

/**
 * Unpaid-commissions digest (Pro only). Surfaces each network's pending plus
 * approved-but-unpaid totals and the oldest unpaid age, per Principle 4.1's
 * "the £42 from January is still pending after 95 days" affordance
 * (`EarningsSummary.oldestUnpaidAgeDays`).
 */
export function composeUnpaidCommissionsDigest(results: NetworkEarningsResult[], periodLabel: string): ComposedDigest {
  const ok = results.filter((r): r is Extract<NetworkEarningsResult, { ok: true }> => r.ok);
  const failed = results.filter((r): r is Extract<NetworkEarningsResult, { ok: false }> => !r.ok);

  const lines: string[] = [];
  lines.push(`Your affiliate-mcp unpaid-commissions digest — ${periodLabel}`);
  lines.push('');

  const withUnpaid = ok.filter((r) => r.summary.byStatus.pending + r.summary.byStatus.approved > 0);
  if (withUnpaid.length === 0) {
    lines.push('No pending or approved-but-unpaid commissions on any connected network.');
  } else {
    const totalUnpaid = sumStatusBucket(withUnpaid, (s) => s.byStatus.pending + s.byStatus.approved);
    lines.push(`Total unpaid across ${withUnpaid.length} network(s): ${formatMoney(totalUnpaid, withUnpaid[0]?.summary.byStatus.currency ?? '')}`);
    lines.push('');
    for (const r of withUnpaid) {
      const unpaid = r.summary.byStatus.pending + r.summary.byStatus.approved;
      const age =
        typeof r.summary.oldestUnpaidAgeDays === 'number'
          ? `, oldest unpaid ${r.summary.oldestUnpaidAgeDays} day(s)`
          : '';
      lines.push(`  ${r.network}: ${formatMoney(unpaid, r.summary.byStatus.currency)} unpaid${age}`);
    }
  }

  if (failed.length > 0) {
    lines.push('');
    lines.push('Could not be read this run:');
    for (const r of failed) {
      lines.push(`  ${r.network}: ${r.message}`);
    }
  }

  return { subject: `Your affiliate-mcp unpaid-commissions digest — ${periodLabel}`, body: lines.join('\n') };
}
