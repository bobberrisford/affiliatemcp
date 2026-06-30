import { describe, expect, it } from 'vitest';
import {
  computeCommissionSplit,
  computeMetricsByCurrency,
  computeWindowMetrics,
  groupByCurrency,
} from '../../src/brand-data/metrics.js';
import { normaliseTransactions, normalisePerformance } from '../../src/brand-data/normalise.js';
import { makePerf, makeTxn } from './fixtures.js';

const txns = (statuses: Array<[import('../../src/shared/types.js').TransactionStatus, number]>) =>
  normaliseTransactions(
    statuses.map(([status, commission], i) =>
      makeTxn({ id: `t${i}`, status, commission, amount: commission * 10 }),
    ),
    'acme',
  );

describe('computeCommissionSplit', () => {
  it('splits by bucket, folds paid into confirmed, and tracks settled', () => {
    const split = computeCommissionSplit(
      txns([
        ['pending', 1],
        ['approved', 2],
        ['paid', 3],
        ['reversed', 4],
        ['other', 5],
      ]),
    );
    expect(split.pending).toBe(1);
    expect(split.confirmed).toBe(5); // approved 2 + paid 3
    expect(split.settled).toBe(3);
    expect(split.declined).toBe(4);
    expect(split.residual).toBe(5);
    expect(split.totalTracked).toBe(6); // pending 1 + confirmed 5; declined/residual excluded
  });
});

describe('computeWindowMetrics', () => {
  it('counts conversions excluding declined, and declined separately', () => {
    const m = computeWindowMetrics(
      txns([
        ['pending', 1],
        ['approved', 2],
        ['reversed', 4],
        ['other', 5],
      ]),
      [],
      'GBP',
    );
    expect(m.conversions).toBe(2); // pending + approved; residual & declined excluded
    expect(m.declinedConversions).toBe(1);
  });

  it('computes EPC on total-tracked and confirmed EPC separately', () => {
    const m = computeWindowMetrics(
      txns([
        ['pending', 10],
        ['approved', 30],
      ]),
      normalisePerformance([makePerf({ clicks: 100 })], 'awin', 'acme'),
      'GBP',
    );
    expect(m.clicks).toBe(100);
    expect(m.epc).toBeCloseTo(0.4); // (10 + 30) / 100
    expect(m.confirmedEpc).toBeCloseTo(0.3); // 30 / 100
  });

  it('blanks click-derived ratios when there is no click data', () => {
    const m = computeWindowMetrics(txns([['approved', 30]]), [], 'GBP');
    expect(m.clicks).toBe(0);
    expect(m.epc).toBeNull();
    expect(m.confirmedEpc).toBeNull();
    expect(m.conversionRate).toBeNull();
  });

  it('blanks AOV when there are no conversions', () => {
    const m = computeWindowMetrics(txns([['reversed', 5]]), [], 'GBP');
    expect(m.conversions).toBe(0);
    expect(m.aov).toBeNull();
  });

  it('computes AOV from sale total over conversions', () => {
    // two confirmed txns, amount = commission*10 => 20 and 30 => sale 50, conv 2
    const m = computeWindowMetrics(
      txns([
        ['approved', 2],
        ['approved', 3],
      ]),
      [],
      'GBP',
    );
    expect(m.saleTotal).toBe(50);
    expect(m.aov).toBeCloseTo(25);
  });
});

describe('groupByCurrency / computeMetricsByCurrency', () => {
  it('groups rows by currency preserving first-seen order', () => {
    const g = groupByCurrency([
      makeTxn({ currency: 'GBP' }),
      makeTxn({ currency: 'EUR' }),
      makeTxn({ currency: 'GBP' }),
    ]);
    expect([...g.keys()]).toEqual(['GBP', 'EUR']);
    expect(g.get('GBP')).toHaveLength(2);
  });

  it('produces one metrics entry per currency seen in either feed', () => {
    const txnRows = normaliseTransactions(
      [
        makeTxn({ id: 'a', status: 'approved', commission: 10, currency: 'GBP' }),
        makeTxn({ id: 'b', status: 'approved', commission: 20, currency: 'EUR' }),
      ],
      'acme',
    );
    const clicksRows = normalisePerformance(
      [makePerf({ clicks: 100, currency: 'USD' })],
      'awin',
      'acme',
    );
    const byCcy = computeMetricsByCurrency(txnRows, clicksRows);
    const currencies = byCcy.map((m) => m.currency).sort();
    expect(currencies).toEqual(['EUR', 'GBP', 'USD']);
    const usd = byCcy.find((m) => m.currency === 'USD');
    expect(usd?.clicks).toBe(100);
    expect(usd?.epc).toBe(0); // no tracked commission in USD, but clicks present -> 0, not null
  });
});
