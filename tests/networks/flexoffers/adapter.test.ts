/**
 * FlexOffers adapter — unit tests.
 *
 * Pattern-matched to `tests/networks/skimlinks/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - Circuit breakers are reset in `beforeEach` so no test bleeds state.
 *   - Fake credentials are injected via `process.env` (obvious non-secret values).
 *   - Fixtures live under `tests/fixtures/flexoffers/`.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 *
 * FlexOffers uses a single static API key (no token exchange), so — unlike the
 * OAuth networks — data ops issue exactly one fetch (the data call). There is no
 * token cache to reset.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { flexoffersAdapter, _internals } from '../../../src/networks/flexoffers/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'flexoffers');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(
  body: unknown,
  init: { status?: number; rawBody?: string } = {},
): Response {
  const status = init.status ?? 200;
  const text = init.rawBody ?? (typeof body === 'string' ? body : JSON.stringify(body));
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetchQueue(responses: Response[]): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => {
    const r = responses.shift();
    if (!r) throw new Error('mock fetch queue exhausted');
    return r;
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

const WIDE_WINDOW = { from: '2024-01-01T00:00:00Z', to: '2026-06-04T00:00:00Z' };

beforeEach(() => {
  _resetBreakers();
  process.env['FLEXOFFERS_API_KEY'] = 'test-api-key-please-ignore';
  process.env['FLEXOFFERS_ACCOUNT_ID'] = '123456';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['FLEXOFFERS_API_KEY'];
  delete process.env['FLEXOFFERS_ACCOUNT_ID'];
});

// ---------------------------------------------------------------------------
// Transformer unit tests (status normalisation + raw preservation + ageDays)
// ---------------------------------------------------------------------------

describe('FlexOffers transformers (status normalisation, raw preservation)', () => {
  it('maps FlexOffers status strings to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'approved' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'bonus' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'paid' })).toBe('paid');
    // canceled / non-commissionable → reversed (the sale will not pay out).
    expect(_internals.mapTransactionStatus({ status: 'canceled' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'cancelled' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'non-commissionable' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'non commissionable' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'something-new' })).toBe('other');
    expect(_internals.mapTransactionStatus({})).toBe('other');
  });

  it('maps FlexOffers programme statuses to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ status: 'active' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'approved' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ status: 'declined' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ status: 'open' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ status: 'inactive' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'mystery' })).toBe('unknown');
    expect(_internals.mapProgrammeStatus({})).toBe('unknown');
  });

  it('preserves raw FlexOffers payload in rawNetworkData', () => {
    const rows = (loadFixture('sales.json') as { sales: unknown[] }).sales;
    const raw = rows[0] as Record<string, unknown>;
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('surfaces reversalReason from adjustmentType on reversed transactions (§15.10)', () => {
    const rows = (loadFixture('sales.json') as { sales: unknown[] }).sales;
    // Fixture index 2 is the canceled sale.
    const canceled = rows[2] as Record<string, unknown>;
    const out = _internals.toTransaction(canceled as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Customer cancelled the order');
  });

  it('computes ageDays from postedDate (preferred), then saleDate', () => {
    const now = new Date('2026-06-04T00:00:00Z');
    // postedDate = 2026-05-20 → 15 days
    const age1 = _internals.computeAgeDays(
      { postedDate: '2026-05-20T00:00:00Z', saleDate: '2026-05-01T00:00:00Z' },
      now,
    );
    expect(age1).toBe(15);
    // No postedDate → falls back to saleDate = 2026-05-25 → 10 days
    const age2 = _internals.computeAgeDays({ saleDate: '2026-05-25T00:00:00Z' }, now);
    expect(age2).toBe(10);
    // No date at all → 0
    expect(_internals.computeAgeDays({}, now)).toBe(0);
  });

  it('reads currency per row and never hardcodes', () => {
    const out = _internals.toTransaction({ status: 'pending', currency: 'eur', saleAmount: 10 });
    expect(out.currency).toBe('EUR');
    // Missing currency falls back to USD (US aggregator) but only as a default.
    const out2 = _internals.toTransaction({ status: 'pending', saleAmount: 10 });
    expect(out2.currency).toBe('USD');
  });

  it('normalises string and number amounts', () => {
    expect(_internals.toAmount(5.5)).toBe(5.5);
    expect(_internals.toAmount('12.75')).toBe(12.75);
    expect(_internals.toAmount(undefined)).toBe(0);
    expect(_internals.toAmount('not-a-number')).toBe(0);
  });

  it('extracts rows from several candidate response envelope keys', () => {
    expect(_internals.extractRows({ sales: [{ saleId: '1' }] })).toHaveLength(1);
    expect(_internals.extractRows({ data: [{ saleId: '1' }] })).toHaveLength(1);
    expect(_internals.extractRows({ results: [{ saleId: '1' }] })).toHaveLength(1);
    expect(_internals.extractRows([{ saleId: '1' }])).toHaveLength(1);
    expect(_internals.extractRows({})).toHaveLength(0);
  });

  it('maps a single canonical status to the FlexOffers query value', () => {
    expect(_internals.mapCanonicalToFlexOffersStatus(['pending'])).toBe('pending');
    expect(_internals.mapCanonicalToFlexOffersStatus(['approved'])).toBe('approved');
    expect(_internals.mapCanonicalToFlexOffersStatus(['reversed'])).toBe('canceled');
    // paid / other have no single upstream value → client-side filter.
    expect(_internals.mapCanonicalToFlexOffersStatus(['paid'])).toBeUndefined();
    expect(_internals.mapCanonicalToFlexOffersStatus(['other'])).toBeUndefined();
    // multiple statuses → client-side filter.
    expect(_internals.mapCanonicalToFlexOffersStatus(['pending', 'approved'])).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listTransactions — filters, age, reversed visibility (§15.9, §15.10)
// ---------------------------------------------------------------------------

describe('FlexoffersAdapter.listTransactions', () => {
  it('returns all rows in the window', async () => {
    mockFetchQueue([fakeResponse(loadFixture('sales.json'))]);
    const all = await flexoffersAdapter.listTransactions(WIDE_WINDOW);
    expect(all).toHaveLength(4);
    expect(all.every((t) => t.network === 'flexoffers')).toBe(true);
  });

  it('includes reversed transactions with reason (§15.10)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('sales.json'))]);
    const all = await flexoffersAdapter.listTransactions(WIDE_WINDOW);
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed).toHaveLength(1);
    expect(reversed[0]?.reversalReason).toBe('Customer cancelled the order');
  });

  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('sales.json'))]);
    const aged = await flexoffersAdapter.listTransactions({ ...WIDE_WINDOW, minAgeDays: 365 });
    expect(aged.length).toBeGreaterThan(0);
    for (const t of aged) {
      expect(t.ageDays).toBeGreaterThanOrEqual(365);
    }
  });

  it('filters by canonical status[]', async () => {
    mockFetchQueue([fakeResponse(loadFixture('sales.json'))]);
    const only = await flexoffersAdapter.listTransactions({ ...WIDE_WINDOW, status: ['reversed'] });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only).toHaveLength(1);
  });

  it('filters paid client-side even though it has no server-side filter value', async () => {
    mockFetchQueue([fakeResponse(loadFixture('sales.json'))]);
    const paid = await flexoffersAdapter.listTransactions({ ...WIDE_WINDOW, status: ['paid'] });
    expect(paid.every((t) => t.status === 'paid')).toBe(true);
    expect(paid).toHaveLength(1);
  });

  it('filters by programmeId client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('sales.json'))]);
    const onlyProg = await flexoffersAdapter.listTransactions({
      ...WIDE_WINDOW,
      programmeId: '5002',
    });
    expect(onlyProg.length).toBe(2);
    expect(onlyProg.every((t) => t.programmeId === '5002')).toBe(true);
  });

  it('respects limit after all other filters are applied', async () => {
    mockFetchQueue([fakeResponse(loadFixture('sales.json'))]);
    const limited = await flexoffersAdapter.listTransactions({ ...WIDE_WINDOW, limit: 2 });
    expect(limited.length).toBe(2);
  });

  it('emits a NetworkError when FLEXOFFERS_API_KEY is missing', async () => {
    delete process.env['FLEXOFFERS_API_KEY'];
    await expect(flexoffersAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes / getProgramme — not implemented
// ---------------------------------------------------------------------------

describe('FlexoffersAdapter.listProgrammes / getProgramme', () => {
  it('listProgrammes throws NotImplementedError', async () => {
    await expect(flexoffersAdapter.listProgrammes()).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await flexoffersAdapter.listProgrammes();
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('programme');
    }
  });

  it('getProgramme throws NotImplementedError', async () => {
    await expect(flexoffersAdapter.getProgramme('5001')).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });
});

// ---------------------------------------------------------------------------
// listClicks — not exposed
// ---------------------------------------------------------------------------

describe('FlexoffersAdapter.listClicks', () => {
  it('throws NotImplementedError with a FlexOffers-specific reason', async () => {
    await expect(flexoffersAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await flexoffersAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click-level data');
    }
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — deterministic URL construction
// ---------------------------------------------------------------------------

describe('FlexoffersAdapter.generateTrackingLink', () => {
  it('constructs the track.flexlinkspro.com deeplink with URL-encoded destination', async () => {
    const link = await flexoffersAdapter.generateTrackingLink({
      programmeId: '5001',
      destinationUrl: 'https://www.exampleoutdoors.test/product?q=test value&page=1',
    });
    expect(link.trackingUrl).toMatch(/^https:\/\/track\.flexlinkspro\.com\//);
    // foid={accountId}.{advertiserId} — account 123456, advertiser 5001 (see beforeEach)
    expect(link.trackingUrl).toContain('foid=123456.5001');
    expect(link.trackingUrl).toContain(
      'url=https%3A%2F%2Fwww.exampleoutdoors.test%2Fproduct%3Fq%3Dtest%20value%26page%3D1',
    );
    expect(link.network).toBe('flexoffers');
    expect(link.programmeId).toBe('5001');
  });

  it('is deterministic — same inputs always produce the same URL', async () => {
    const link1 = await flexoffersAdapter.generateTrackingLink({
      programmeId: '5001',
      destinationUrl: 'https://example.test/page',
    });
    const link2 = await flexoffersAdapter.generateTrackingLink({
      programmeId: '5001',
      destinationUrl: 'https://example.test/page',
    });
    expect(link1.trackingUrl).toBe(link2.trackingUrl);
  });

  it('throws config_error when destinationUrl is empty', async () => {
    await expect(
      flexoffersAdapter.generateTrackingLink({ programmeId: '5001', destinationUrl: '' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws config_error when programmeId is empty', async () => {
    await expect(
      flexoffersAdapter.generateTrackingLink({
        programmeId: '',
        destinationUrl: 'https://example.test/',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws NetworkError when FLEXOFFERS_ACCOUNT_ID is missing', async () => {
    delete process.env['FLEXOFFERS_ACCOUNT_ID'];
    await expect(
      flexoffersAdapter.generateTrackingLink({
        programmeId: '5001',
        destinationUrl: 'https://example.test/',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth — happy + failure paths
// ---------------------------------------------------------------------------

describe('FlexoffersAdapter.verifyAuth', () => {
  it('returns ok:true and identity when the probe call succeeds', async () => {
    mockFetchQueue([fakeResponse(loadFixture('sales_empty.json'))]);
    const r = await flexoffersAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('flexoffers/account:123456');
    }
  });

  it('returns ok:false (does not throw) on a 401 (§15.4)', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_api_key"}', {
        status: 401,
        rawBody: '{"error":"invalid_api_key"}',
      }),
    ]);
    const r = await flexoffersAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/HTTP 401|401|invalid_api_key|auth/i);
    }
  });

  it('returns ok:false when FLEXOFFERS_API_KEY is missing (no fetch)', async () => {
    delete process.env['FLEXOFFERS_API_KEY'];
    await expect(flexoffersAdapter.verifyAuth()).resolves.toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('FlexoffersAdapter.validateCredential', () => {
  it('validates FLEXOFFERS_API_KEY via a live probe call', async () => {
    mockFetchQueue([fakeResponse(loadFixture('sales_empty.json'))]);
    const r = await flexoffersAdapter.validateCredential(
      'FLEXOFFERS_API_KEY',
      'test-api-key-please-ignore',
    );
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with hint when FLEXOFFERS_API_KEY is wrong', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_api_key"}', {
        status: 401,
        rawBody: '{"error":"invalid_api_key"}',
      }),
    ]);
    const r = await flexoffersAdapter.validateCredential('FLEXOFFERS_API_KEY', 'bad-key');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('rejects an empty FLEXOFFERS_API_KEY without a call', async () => {
    const r = await flexoffersAdapter.validateCredential('FLEXOFFERS_API_KEY', '');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('accepts a positive integer FLEXOFFERS_ACCOUNT_ID', async () => {
    const r = await flexoffersAdapter.validateCredential('FLEXOFFERS_ACCOUNT_ID', '123456');
    expect(r.ok).toBe(true);
  });

  it('rejects a non-numeric FLEXOFFERS_ACCOUNT_ID', async () => {
    const r1 = await flexoffersAdapter.validateCredential('FLEXOFFERS_ACCOUNT_ID', 'abc');
    expect(r1.ok).toBe(false);
    const r2 = await flexoffersAdapter.validateCredential('FLEXOFFERS_ACCOUNT_ID', '0');
    expect(r2.ok).toBe(false);
  });

  it('returns ok:false for unknown credential fields', async () => {
    const r = await flexoffersAdapter.validateCredential('FLEXOFFERS_UNKNOWN', 'value');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary — derived from listTransactions
// ---------------------------------------------------------------------------

describe('FlexoffersAdapter.getEarningsSummary', () => {
  it('aggregates commissions correctly from fixture data', async () => {
    mockFetchQueue([fakeResponse(loadFixture('sales.json'))]);
    const summary = await flexoffersAdapter.getEarningsSummary(WIDE_WINDOW);
    expect(summary.network).toBe('flexoffers');
    expect(summary.currency).toBe('USD');
    expect(summary.totalEarnings).toBeCloseTo(9.6 + 19.24 + 4.5 + 6.8, 2);
    expect(summary.byStatus.pending).toBeCloseTo(9.6, 2);
    expect(summary.byStatus.approved).toBeCloseTo(19.24, 2);
    expect(summary.byStatus.reversed).toBeCloseTo(4.5, 2);
    expect(summary.byStatus.paid).toBeCloseTo(6.8, 2);
    expect(summary.byProgramme).toHaveLength(2);
  });

  it('sets oldestUnpaidAgeDays from the longest-pending unpaid transaction (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('sales.json'))]);
    const summary = await flexoffersAdapter.getEarningsSummary(WIDE_WINDOW);
    // FO-90002 was posted 2024-02-05 and is still approved-but-unpaid — oldest.
    expect(summary.oldestUnpaidAgeDays).toBeDefined();
    expect(summary.oldestUnpaidAgeDays ?? 0).toBeGreaterThan(365);
  });

  it('returns an empty summary when no sales match the window', async () => {
    mockFetchQueue([fakeResponse(loadFixture('sales_empty.json'))]);
    const summary = await flexoffersAdapter.getEarningsSummary({});
    expect(summary.totalEarnings).toBe(0);
    expect(summary.byProgramme).toHaveLength(0);
    expect(summary.oldestUnpaidAgeDays).toBeUndefined();
    expect(summary.currency).toBe('USD');
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim response body on a 500', async () => {
    const body = '{"error":"upstream exploded","trace":"xyz"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await flexoffersAdapter.listTransactions({});
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('flexoffers');
      expect(env.operation).toBe('listTransactions');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream exploded');
    }
  });

  it('classifies a 401 on the data endpoint as auth_error', async () => {
    mockFetchQueue([fakeResponse('Forbidden', { status: 401, rawBody: 'Forbidden' })]);
    try {
      await flexoffersAdapter.listTransactions({});
      throw new Error('expected to throw');
    } catch (err) {
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('auth_error');
    }
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('FlexoffersAdapter.capabilitiesCheck', () => {
  it('records listProgrammes, getProgramme, listClicks as not supported', async () => {
    // capabilitiesCheck probes: verifyAuth (1 fetch), listTransactions (1 fetch),
    // getEarningsSummary → listTransactions (1 fetch). generateTrackingLink: no fetch.
    mockFetchQueue([
      fakeResponse(loadFixture('sales_empty.json')), // verifyAuth probe
      fakeResponse(loadFixture('sales_empty.json')), // listTransactions
      fakeResponse(loadFixture('sales_empty.json')), // getEarningsSummary
    ]);
    const caps = await flexoffersAdapter.capabilitiesCheck();
    expect(caps.network).toBe('flexoffers');
    expect(caps.operations['listProgrammes']?.supported).toBe(false);
    expect(caps.operations['getProgramme']?.supported).toBe(false);
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(true);
    expect(caps.operations['verifyAuth']?.supported).toBe(true);
    expect(caps.operations['listTransactions']?.supported).toBe(true);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
