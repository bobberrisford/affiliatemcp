/**
 * Offer18 affiliate adapter — unit tests.
 *
 * Pattern matched to `tests/networks/everflow/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 *   - Fixtures live under `tests/networks/offer18/fixtures/` and approximate the
 *     shape of real Offer18 affiliate API responses. No real tokens, no real data.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { offer18Adapter, _internals } from '../../../src/networks/offer18/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'networks', 'offer18', 'fixtures');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(body: unknown, init: { status?: number; rawBody?: string } = {}): Response {
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

/**
 * Mock fetch for chunked report calls: return `body` on the FIRST request and
 * an empty report on every subsequent slice. Lets a wide date window be chunked
 * into several slices without duplicating the fixture rows across them.
 */
function mockFetchFirstThenEmpty(body: unknown): ReturnType<typeof vi.fn> {
  let first = true;
  const spy = vi.fn(async () => {
    if (first) {
      first = false;
      return fakeResponse(body);
    }
    return fakeResponse({ status: 200, data: [] });
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

function setCreds(): void {
  process.env['OFFER18_BASE_URL'] = 'https://api.offer18.example.com';
  process.env['OFFER18_API_KEY'] = 'test-api-key-please-ignore';
  process.env['OFFER18_SECRET_KEY'] = '999999';
  process.env['OFFER18_MID'] = '1234';
}

function clearCreds(): void {
  delete process.env['OFFER18_BASE_URL'];
  delete process.env['OFFER18_API_KEY'];
  delete process.env['OFFER18_SECRET_KEY'];
  delete process.env['OFFER18_MID'];
}

beforeEach(() => {
  _resetBreakers();
  setCreds();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearCreds();
});

// ---------------------------------------------------------------------------
// Transformers (status mapping + raw preservation)
// ---------------------------------------------------------------------------

describe('Offer18 transformers (status normalisation, raw preservation)', () => {
  it('maps offer status / authorisation to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ authorized: 1, status: 'active' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ authorized: '1' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'active' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ status: 'paused' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ status: 'rejected' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ status: 'never-seen-before' })).toBe('unknown');
  });

  it('maps report statuses to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ status: 'approved' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'confirmed' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'hold' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'rejected' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'cancelled' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'invalid' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'paid' })).toBe('paid');
    // status_type takes precedence over status.
    expect(_internals.mapTransactionStatus({ status: 'pending', status_type: 'approved' })).toBe(
      'approved',
    );
    expect(_internals.mapTransactionStatus({ status: 'weird_future_value' })).toBe('other');
    expect(_internals.mapTransactionStatus({})).toBe('other');
  });

  it('preserves the raw Offer18 payload under rawNetworkData', () => {
    const rows = (loadFixture('report.json') as { data: Record<string, unknown>[] }).data;
    const raw = rows[0] as Record<string, unknown>;
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('surfaces reversalReason from filter_log on reversed transactions (§15.10)', () => {
    const rows = (loadFixture('report.json') as { data: Record<string, unknown>[] }).data;
    const rejected = rows[2] as Record<string, unknown>;
    const out = _internals.toTransaction(rejected as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toContain('Duplicate conversion');
  });

  it('computes ageDays from date/time against a fixed now', () => {
    const now = new Date('2026-05-28T12:00:00Z');
    // 2026-01-15T10:00:00Z → 2026-05-28T12:00:00Z = 133 days 2 hours → floors to 133.
    const age = _internals.computeAgeDays({ date: '2026-01-15', time: '10:00:00' } as never, now);
    expect(age).toBe(133);
  });

  it('returns 0 ageDays when no date is present', () => {
    expect(_internals.computeAgeDays({} as never, new Date('2026-05-28T00:00:00Z'))).toBe(0);
  });

  it('builds an ISO datetime from date + time', () => {
    expect(_internals.rowToIso({ date: '2026-01-15', time: '10:00:00' } as never)).toBe(
      '2026-01-15T10:00:00.000Z',
    );
  });

  it('maps offer currency and CPS model to a percent commission rate', () => {
    const prog = _internals.toProgramme({
      offerid: 1003,
      currency: 'GBP',
      price: 10,
      model: 'CPS',
    });
    expect(prog.currency).toBe('GBP');
    expect(typeof prog.commissionRate).toBe('object');
    if (typeof prog.commissionRate === 'object' && prog.commissionRate) {
      expect(prog.commissionRate.type).toBe('percent');
      expect(prog.commissionRate.value).toBe(10);
    }
  });

  it('treats numeric strings as numbers for amounts', () => {
    const tx = _internals.toTransaction({
      tid: 't1',
      affiliate_price: '5.50',
      advertiser_price: '9.00',
      currency: 'EUR',
      status: 'approved',
      date: '2026-01-15',
    } as never);
    expect(tx.commission).toBeCloseTo(5.5, 2);
    expect(tx.amount).toBeCloseTo(9.0, 2);
    expect(tx.currency).toBe('EUR');
  });

  it('splits comma-joined categories', () => {
    expect(_internals.splitCategories({ category: 'Ecommerce, Books' } as never)).toEqual([
      'Ecommerce',
      'Books',
    ]);
  });

  it('chunkDateRange splits correctly at 31 days', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-03-01T00:00:00Z'); // 59 days → 2 slices (31 + 28)
    const slices = _internals.chunkDateRange(from, to, 31);
    expect(slices.length).toBe(2);
    expect(slices[slices.length - 1]?.end.toISOString()).toBe(to.toISOString());
  });

  it('formatOffer18Date produces YYYY-MM-DD', () => {
    expect(_internals.formatOffer18Date(new Date('2026-05-28T13:45:00Z'))).toBe('2026-05-28');
  });

  it('extractOffers reads both data and offers envelope shapes', () => {
    expect(_internals.extractOffers({ data: [{ offerid: 1 }] }).length).toBe(1);
    expect(_internals.extractOffers({ offers: [{ offerid: 2 }] }).length).toBe(1);
    expect(_internals.extractOffers([{ offerid: 3 }]).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Per-tenant base URL credential handling
// ---------------------------------------------------------------------------

describe('Offer18 per-tenant base URL', () => {
  it('throws a config_error envelope when OFFER18_BASE_URL is missing', async () => {
    delete process.env['OFFER18_BASE_URL'];
    await expect(offer18Adapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error envelope when OFFER18_BASE_URL is not a URL', async () => {
    process.env['OFFER18_BASE_URL'] = 'not-a-url';
    try {
      await offer18Adapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).envelope.type).toBe('config_error');
    }
  });

  it('addresses the configured tenant host', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    await offer18Adapter.listProgrammes();
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url.startsWith('https://api.offer18.example.com/api/af/offers')).toBe(true);
    expect(url).toContain('mid=1234');
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('Offer18.listProgrammes', () => {
  it('maps offer statuses correctly from the offers fixture', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const programmes = await offer18Adapter.listProgrammes();
    expect(programmes.length).toBe(3);
    expect(programmes.find((p) => p.id === '1001')?.status).toBe('joined');
    expect(programmes.find((p) => p.id === '1002')?.status).toBe('available');
    expect(programmes.find((p) => p.id === '1003')?.status).toBe('suspended');
  });

  it('filters by status client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const only = await offer18Adapter.listProgrammes({ status: 'joined' });
    expect(only.every((p) => p.status === 'joined')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('applies a search filter client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const results = await offer18Adapter.listProgrammes({ search: 'bookshop' });
    expect(results.length).toBe(1);
    expect(results[0]?.name).toBe('Atolls Bookshop');
  });

  it('preserves rawNetworkData on each programme', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const programmes = await offer18Adapter.listProgrammes();
    for (const p of programmes) expect(p.rawNetworkData).toBeDefined();
  });

  it('throws a NetworkError when credentials are missing', async () => {
    delete process.env['OFFER18_API_KEY'];
    await expect(offer18Adapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getProgramme
// ---------------------------------------------------------------------------

describe('Offer18.getProgramme', () => {
  it('returns a Programme from the filtered offers endpoint', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offer.json'))]);
    const prog = await offer18Adapter.getProgramme('1001');
    expect(prog.id).toBe('1001');
    expect(prog.name).toBe('Atolls Bookshop');
    expect(prog.network).toBe('offer18');
  });

  it('throws a config_error envelope for a non-numeric programmeId', async () => {
    await expect(offer18Adapter.getProgramme('not-a-number')).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error envelope for an empty programmeId', async () => {
    await expect(offer18Adapter.getProgramme('')).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a network_api_error envelope when the offer is not found', async () => {
    mockFetchQueue([fakeResponse({ status: 200, data: [] })]);
    try {
      await offer18Adapter.getProgramme('9999');
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).envelope.type).toBe('network_api_error');
    }
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('Offer18.listTransactions', () => {
  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockFetchFirstThenEmpty(loadFixture('report.json'));
    const aged = await offer18Adapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
      minAgeDays: 50,
    });
    for (const t of aged) expect(t.ageDays).toBeGreaterThanOrEqual(50);
    expect(aged.length).toBeGreaterThan(0);
  });

  it('includes reversed transactions with reason populated (§15.10)', async () => {
    mockFetchFirstThenEmpty(loadFixture('report.json'));
    const all = await offer18Adapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
    });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toContain('Duplicate conversion');
  });

  it('filters by status when caller passes status[]', async () => {
    mockFetchFirstThenEmpty(loadFixture('report.json'));
    const only = await offer18Adapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('chunks wide windows into ≤31-day slices (two calls for a 59-day window)', async () => {
    const spy = mockFetchQueue([
      fakeResponse(loadFixture('report.json')),
      fakeResponse({ status: 200, data: [] }),
    ]);
    await offer18Adapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-03-01T00:00:00Z',
    });
    expect(spy.mock.calls.length).toBe(2);
  });

  it('emits a NetworkError when credentials are missing (§15.4)', async () => {
    delete process.env['OFFER18_SECRET_KEY'];
    await expect(offer18Adapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('Offer18.getEarningsSummary', () => {
  it('derives the summary from listTransactions correctly', async () => {
    mockFetchFirstThenEmpty(loadFixture('report.json'));
    const summary = await offer18Adapter.getEarningsSummary({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
    });
    expect(summary.network).toBe('offer18');
    // 5.00 (approved) + 5.00 (pending) + 0.00 (rejected) = 10.00
    expect(summary.totalEarnings).toBeCloseTo(10.0, 2);
    expect(summary.byStatus.approved).toBeCloseTo(5.0, 2);
    expect(summary.byStatus.pending).toBeCloseTo(5.0, 2);
    expect(summary.byStatus.reversed).toBeCloseTo(0.0, 2);
    expect(summary.currency).toBe('GBP');
    expect(summary.byProgramme.length).toBeGreaterThan(0);
  });

  it('computes oldestUnpaidAgeDays from pending/approved transactions (§15.9)', async () => {
    mockFetchFirstThenEmpty(loadFixture('report.json'));
    const summary = await offer18Adapter.getEarningsSummary({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
    });
    expect(summary.oldestUnpaidAgeDays).toBeGreaterThan(30);
  });
});

// ---------------------------------------------------------------------------
// listClicks + generateTrackingLink — unsupported
// ---------------------------------------------------------------------------

describe('Offer18 unsupported operations', () => {
  it('listClicks throws NotImplementedError', async () => {
    await expect(offer18Adapter.listClicks()).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('generateTrackingLink throws NotImplementedError', async () => {
    await expect(
      offer18Adapter.generateTrackingLink({
        programmeId: '1001',
        destinationUrl: 'https://x.example.com',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('Offer18.verifyAuth', () => {
  it('returns ok:true with identity when offers responds 200', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const r = await offer18Adapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toContain('offer18');
  });

  it('surfaces a failure reason on 401 (§15.4)', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_key"}', { status: 401, rawBody: '{"error":"invalid_key"}' }),
    ]);
    const r = await offer18Adapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/401/);
  });

  it('returns ok:false (not a throw) when credentials are missing', async () => {
    clearCreds();
    const r = await offer18Adapter.verifyAuth();
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// admin ops
// ---------------------------------------------------------------------------

describe('Offer18 admin operations (not implemented at v0.1)', () => {
  it('listPublishers throws NotImplementedError', async () => {
    await expect(offer18Adapter.listPublishers()).rejects.toBeInstanceOf(NotImplementedError);
  });
  it('listPublisherSectors throws NotImplementedError', async () => {
    await expect(offer18Adapter.listPublisherSectors()).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim Offer18 response body on a 500', async () => {
    const body = '{"error":"upstream_error","trace":"o18-123"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await offer18Adapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('offer18');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream_error');
    }
  });

  it('classifies 401 as auth_error (§15.4)', async () => {
    mockFetchQueue([fakeResponse('Forbidden', { status: 401, rawBody: 'Forbidden' })]);
    try {
      await offer18Adapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('auth_error');
    }
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('Offer18.capabilitiesCheck', () => {
  it('reports operations with experimental claim status and records unsupported ops', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('offers.json')), // listProgrammes
      fakeResponse(loadFixture('report.json')), // listTransactions
      fakeResponse(loadFixture('report.json')), // getEarningsSummary → listTransactions
      fakeResponse(loadFixture('offers.json')), // verifyAuth
    ]);
    const caps = await offer18Adapter.capabilitiesCheck();
    expect(caps.network).toBe('offer18');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
