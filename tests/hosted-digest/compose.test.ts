/**
 * Unit tests for digest composition (`src/hosted-digest/compose.ts`). Pure —
 * no network, no adapters — driven by hand-built `EarningsSummary` fixtures.
 */

import { describe, expect, it } from 'vitest';

import { composeEarningsDigest, composeUnpaidCommissionsDigest, type NetworkEarningsResult } from '../../src/hosted-digest/compose.js';
import type { EarningsSummary } from '../../src/shared/types.js';

function summary(overrides: Partial<EarningsSummary> = {}): EarningsSummary {
  return {
    network: 'cj',
    totalEarnings: 123.45,
    currency: 'GBP',
    byProgramme: [{ programmeId: 'p1', programmeName: 'Programme One', total: 123.45, currency: 'GBP', transactionCount: 4 }],
    byStatus: { pending: 10, approved: 20, reversed: 0, paid: 93.45, other: 0, currency: 'GBP' },
    periodFrom: '2026-07-07T00:00:00.000Z',
    periodTo: '2026-07-14T00:00:00.000Z',
    ...overrides,
  };
}

describe('composeEarningsDigest', () => {
  it('never contains an email address, a credential, or the word "undefined"', () => {
    const results: NetworkEarningsResult[] = [{ network: 'cj', ok: true, summary: summary() }];
    const digest = composeEarningsDigest(results, '2026-07-07 to 2026-07-14');
    expect(digest.body).not.toContain('undefined');
    expect(digest.body).not.toMatch(/[\w.]+@[\w.]+/);
  });

  it('sums totals across multiple networks sharing a currency', () => {
    const results: NetworkEarningsResult[] = [
      { network: 'cj', ok: true, summary: summary({ network: 'cj', totalEarnings: 100 }) },
      { network: 'awin', ok: true, summary: summary({ network: 'awin', totalEarnings: 50 }) },
    ];
    const digest = composeEarningsDigest(results, '2026-07-07 to 2026-07-14');
    expect(digest.body).toContain('GBP 150.00');
    expect(digest.body).toContain('cj: GBP 100.00');
    expect(digest.body).toContain('awin: GBP 50.00');
  });

  it('reports networks that could not be read, without silently dropping them', () => {
    const results: NetworkEarningsResult[] = [
      { network: 'cj', ok: true, summary: summary() },
      { network: 'impact', ok: false, message: 'Missing required credential IMPACT_ACCOUNT_SID.' },
    ];
    const digest = composeEarningsDigest(results, '2026-07-07 to 2026-07-14');
    expect(digest.body).toContain('Could not be read this run');
    expect(digest.body).toContain('impact: Missing required credential IMPACT_ACCOUNT_SID.');
  });

  it('says so plainly when every network failed', () => {
    const results: NetworkEarningsResult[] = [{ network: 'cj', ok: false, message: 'vault unavailable' }];
    const digest = composeEarningsDigest(results, '2026-07-07 to 2026-07-14');
    expect(digest.body).toContain('No networks could be read this run.');
  });

  it('includes the period label in both the subject and the body', () => {
    const digest = composeEarningsDigest([], '2026-07-07 to 2026-07-14');
    expect(digest.subject).toContain('2026-07-07 to 2026-07-14');
    expect(digest.body).toContain('2026-07-07 to 2026-07-14');
  });
});

describe('composeUnpaidCommissionsDigest', () => {
  it('reports pending-plus-approved as "unpaid" per network, with the oldest-unpaid age', () => {
    const results: NetworkEarningsResult[] = [
      {
        network: 'cj',
        ok: true,
        summary: summary({
          byStatus: { pending: 10, approved: 20, reversed: 0, paid: 0, other: 0, currency: 'GBP' },
          oldestUnpaidAgeDays: 95,
        }),
      },
    ];
    const digest = composeUnpaidCommissionsDigest(results, '2026-07-07 to 2026-07-14');
    expect(digest.body).toContain('cj: GBP 30.00 unpaid, oldest unpaid 95 day(s)');
  });

  it('says so plainly when nothing is unpaid anywhere', () => {
    const results: NetworkEarningsResult[] = [
      { network: 'cj', ok: true, summary: summary({ byStatus: { pending: 0, approved: 0, reversed: 0, paid: 200, other: 0, currency: 'GBP' } }) },
    ];
    const digest = composeUnpaidCommissionsDigest(results, '2026-07-07 to 2026-07-14');
    expect(digest.body).toContain('No pending or approved-but-unpaid commissions');
  });

  it('omits networks with nothing unpaid from the per-network breakdown', () => {
    const results: NetworkEarningsResult[] = [
      {
        network: 'cj',
        ok: true,
        summary: summary({ byStatus: { pending: 10, approved: 0, reversed: 0, paid: 0, other: 0, currency: 'GBP' } }),
      },
      {
        network: 'awin',
        ok: true,
        summary: summary({ network: 'awin', byStatus: { pending: 0, approved: 0, reversed: 0, paid: 500, other: 0, currency: 'GBP' } }),
      },
    ];
    const digest = composeUnpaidCommissionsDigest(results, '2026-07-07 to 2026-07-14');
    expect(digest.body).toContain('cj:');
    expect(digest.body).not.toContain('awin:');
  });

  it('reports a per-network read failure the same way the earnings digest does', () => {
    const results: NetworkEarningsResult[] = [{ network: 'rakuten', ok: false, message: 'network_unavailable: vault outage' }];
    const digest = composeUnpaidCommissionsDigest(results, '2026-07-07 to 2026-07-14');
    expect(digest.body).toContain('rakuten: network_unavailable: vault outage');
  });
});
