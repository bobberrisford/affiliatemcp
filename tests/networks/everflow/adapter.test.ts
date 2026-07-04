/**
 * Everflow affiliate adapter — unit tests.
 *
 * Pattern matched to `tests/networks/cj/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 *   - Fixtures live under `tests/fixtures/everflow/` and approximate the shape
 *     of real Everflow API responses. No real tokens, no real data.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { everflowAdapter, _internals } from '../../../src/networks/everflow/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'everflow');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

/**
 * Mint a fake `Response`. Everflow responses are JSON envelopes.
 */
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

beforeEach(() => {
  _resetBreakers();
  process.env['EVERFLOW_API_KEY'] = 'test-api-key-please-ignore';
  process.env['EVERFLOW_AFFILIATE_ID'] = '12345';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['EVERFLOW_API_KEY'];
  delete process.env['EVERFLOW_AFFILIATE_ID'];
});

// ---------------------------------------------------------------------------
// Transformation (status mapping + raw preservation)
// ---------------------------------------------------------------------------

describe('Everflow transformers (status normalisation, raw preservation)', () => {
  it('maps offer relationship statuses to canonical ProgrammeStatus', () => {
    // With a relationship status — relationship takes precedence.
    expect(_internals.mapProgrammeStatus({ relationship: { status: 'approved' } })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ relationship: { status: 'pending' } })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ relationship: { status: 'declined' } })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ relationship: { status: 'rejected' } })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ relationship: { status: 'paused' } })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ relationship: { status: 'never-seen-before' } })).toBe(
      'unknown',
    );
    // Without a relationship — fall back to offer_status.
    expect(_internals.mapProgrammeStatus({ offer_status: 'paused' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ offer_status: 'active' })).toBe('available');
    // visibility: 'public' + offer_status: 'active' and no relationship → 'available'.
    expect(_internals.mapProgrammeStatus({ visibility: 'public', offer_status: 'active' })).toBe(
      'available',
    );
  });

  it('maps conversion statuses to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ status: 'approved' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'pending' })).toBe('pending');
    // on_hold is Everflow's time-delayed approval feature — treated as pending.
    expect(_internals.mapTransactionStatus({ status: 'on_hold' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'rejected' })).toBe('reversed');
    // invalid conversions are confirmed Everflow status (e.g. duplicate click).
    expect(_internals.mapTransactionStatus({ status: 'invalid' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'reversed' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'declined' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'unknown_future_status' })).toBe('other');
    expect(_internals.mapTransactionStatus({})).toBe('other');
  });

  it('preserves the raw Everflow payload under rawNetworkData', () => {
    const conversions = (
      loadFixture('conversions.json') as {
        conversions: Record<string, unknown>[];
      }
    ).conversions;
    const raw = conversions[0] as Record<string, unknown>;
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('surfaces reversalReason from error_message on reversed transactions (§15.10)', () => {
    const conversions = (
      loadFixture('conversions.json') as {
        conversions: Record<string, unknown>[];
      }
    ).conversions;
    // Index 2 is the rejected conversion with an error_message.
    const rejected = conversions[2] as Record<string, unknown>;
    const out = _internals.toTransaction(rejected as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe(
      'Duplicate conversion — transaction already recorded for this order',
    );
  });

  it('computes ageDays from conversion_unix_timestamp against a fixed now', () => {
    const now = new Date('2026-05-28T12:00:00Z');
    // 2026-01-15T10:00:00Z = 1768471200 epoch seconds.
    // Jan 15 10:00Z → May 28 12:00Z = 133 days 2 hours → floors to 133.
    const age = _internals.computeAgeDays({ conversion_unix_timestamp: 1768471200 } as never, now);
    expect(age).toBe(133);
  });

  it('computes ageDays from legacy string conversion_date against a fixed now (fallback)', () => {
    const now = new Date('2026-05-28T12:00:00Z');
    // Fallback path: string "YYYY-MM-DD HH:mm:SS" format still parses correctly.
    const age = _internals.computeAgeDays({ conversion_date: '2026-01-15 10:00:00' } as never, now);
    expect(age).toBe(133);
  });

  it('returns 0 ageDays when neither timestamp field is present', () => {
    const now = new Date('2026-05-28T00:00:00Z');
    const age = _internals.computeAgeDays({} as never, now);
    expect(age).toBe(0);
  });

  it('maps currency_id string to programme currency (confirmed ISO string field)', () => {
    const prog = _internals.toProgramme({ network_offer_id: 1001, currency_id: 'GBP' });
    expect(prog.currency).toBe('GBP');
  });

  it('sets transaction currency from currency_id ISO string field', () => {
    const tx = _internals.toTransaction({
      conversion_id: 'test-123',
      conversion_unix_timestamp: 1768471200,
      currency_id: 'EUR',
      status: 'approved',
    } as never);
    expect(tx.currency).toBe('EUR');
  });

  it('uses dateConverted from conversion_unix_timestamp', () => {
    const tx = _internals.toTransaction({
      conversion_id: 'ts-test',
      conversion_unix_timestamp: 1768471200, // 2026-01-15T10:00:00.000Z
      status: 'pending',
    } as never);
    expect(tx.dateConverted).toBe('2026-01-15T10:00:00.000Z');
  });

  it('chunkDateRange splits correctly at 14 days', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-02-01T00:00:00Z'); // 31 days → 3 slices (14+14+3)
    const slices = _internals.chunkDateRange(from, to, 14);
    expect(slices.length).toBe(3);
    expect(slices[0]?.start.toISOString()).toBe(from.toISOString());
    // Last slice end should be the original to.
    expect(slices[slices.length - 1]?.end.toISOString()).toBe(to.toISOString());
  });

  it('formatEverflowDate produces YYYY-MM-DD HH:mm:SS format', () => {
    const d = new Date('2026-05-28T13:45:00Z');
    expect(_internals.formatEverflowDate(d)).toBe('2026-05-28 13:45:00');
  });
});

// ---------------------------------------------------------------------------
// listTransactions — unpaid-age + reversed visibility (§15.9, §15.10)
// ---------------------------------------------------------------------------

describe('Everflow.listTransactions', () => {
  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);

    // The fixture has conversions from Jan and April 2026; with minAgeDays=50
    // (against now = 2026-05-28) the Jan conversion (133d) should qualify.
    const aged = await everflowAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
      minAgeDays: 50,
    });
    for (const t of aged) {
      expect(t.ageDays).toBeGreaterThanOrEqual(50);
    }
    expect(aged.length).toBeGreaterThan(0);
  });

  it('includes reversed transactions with reason populated (§15.10)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const all = await everflowAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
    });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toContain('Duplicate conversion');
  });

  it('filters by status when caller passes status[]', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const only = await everflowAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('emits an error envelope when the API key is missing (§15.4)', async () => {
    delete process.env['EVERFLOW_API_KEY'];
    await expect(everflowAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listClicks
// ---------------------------------------------------------------------------

describe('Everflow.listClicks', () => {
  it('returns click records with timestamp and programmeId', async () => {
    mockFetchQueue([fakeResponse(loadFixture('clicks.json'))]);
    const clicks = await everflowAdapter.listClicks({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-07T00:00:00Z',
    });
    expect(clicks.length).toBe(2);
    expect(clicks[0]?.network).toBe('everflow');
    expect(clicks[0]?.programmeId).toBe('1001');
    // Timestamp should be an ISO string derived from unix_timestamp.
    expect(clicks[0]?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('preserves rawNetworkData on each click', async () => {
    mockFetchQueue([fakeResponse(loadFixture('clicks.json'))]);
    const clicks = await everflowAdapter.listClicks({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-07T00:00:00Z',
    });
    expect(clicks[0]?.rawNetworkData).toBeDefined();
  });

  it('chunks date range to ≤14-day slices (two calls for 20-day window)', async () => {
    const spy = mockFetchQueue([
      fakeResponse(loadFixture('clicks.json')),
      fakeResponse({ clicks: [], page: 1, page_size: 50, total_count: 0 }),
    ]);
    await everflowAdapter.listClicks({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-21T00:00:00Z', // 20 days → 2 slices (14 + 6)
    });
    expect(spy.mock.calls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink
// ---------------------------------------------------------------------------

describe('Everflow.generateTrackingLink', () => {
  it('returns a TrackingLink with the URL from the API response', async () => {
    mockFetchQueue([fakeResponse(loadFixture('tracking-url.json'))]);
    const link = await everflowAdapter.generateTrackingLink({
      programmeId: '1001',
      destinationUrl: 'https://www.atolls-bookshop.example.com/products',
    });
    expect(link.network).toBe('everflow');
    expect(link.programmeId).toBe('1001');
    expect(link.trackingUrl).toContain('track.eflow.team');
  });

  it('throws a config_error envelope when programmeId is missing', async () => {
    await expect(
      everflowAdapter.generateTrackingLink({
        programmeId: '',
        destinationUrl: 'https://x.example.com',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error envelope when programmeId is non-numeric', async () => {
    await expect(
      everflowAdapter.generateTrackingLink({
        programmeId: 'not-a-number',
        destinationUrl: 'https://x.example.com',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('preserves rawNetworkData from the API response', async () => {
    mockFetchQueue([fakeResponse(loadFixture('tracking-url.json'))]);
    const link = await everflowAdapter.generateTrackingLink({
      programmeId: '1001',
      destinationUrl: 'https://www.atolls-bookshop.example.com',
    });
    expect(link.rawNetworkData).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// listProgrammes — status mapping, filters
// ---------------------------------------------------------------------------

describe('Everflow.listProgrammes', () => {
  it('maps offer statuses correctly from alloffers fixture', async () => {
    mockFetchQueue([fakeResponse(loadFixture('alloffers.json'))]);
    const programmes = await everflowAdapter.listProgrammes();
    expect(programmes.length).toBe(3);

    const joined = programmes.find((p) => p.id === '1001');
    const pending = programmes.find((p) => p.id === '1002');
    const declined = programmes.find((p) => p.id === '1003');

    expect(joined?.status).toBe('joined');
    expect(pending?.status).toBe('pending');
    expect(declined?.status).toBe('declined');
  });

  it('filters by status client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('alloffers.json'))]);
    const only = await everflowAdapter.listProgrammes({ status: 'joined' });
    expect(only.every((p) => p.status === 'joined')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('applies search filter client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('alloffers.json'))]);
    const results = await everflowAdapter.listProgrammes({ search: 'bookshop' });
    expect(results.length).toBe(1);
    expect(results[0]?.name).toBe('Atolls Bookshop');
  });

  it('preserves rawNetworkData on each programme', async () => {
    mockFetchQueue([fakeResponse(loadFixture('alloffers.json'))]);
    const programmes = await everflowAdapter.listProgrammes();
    for (const p of programmes) {
      expect(p.rawNetworkData).toBeDefined();
    }
  });

  it('throws a NetworkError when API key is missing', async () => {
    delete process.env['EVERFLOW_API_KEY'];
    await expect(everflowAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// Pagination (issue #316 — full pull on absent limit, MAX_PAGES backstop)
// ---------------------------------------------------------------------------

describe('Everflow pagination', () => {
  it('listProgrammes pulls every page when limit is absent', async () => {
    const spy = mockFetchQueue([
      fakeResponse(loadFixture('alloffers-page1.json')),
      fakeResponse(loadFixture('alloffers-page2.json')),
    ]);
    const programmes = await everflowAdapter.listProgrammes();
    expect(programmes.length).toBe(4);
    expect(spy.mock.calls.length).toBe(2);
    // The second request asks for page 2 with the standard page size.
    const secondUrl = String(spy.mock.calls[1]?.[0]);
    expect(secondUrl).toContain('page=2');
    expect(secondUrl).toContain(`page_size=${_internals.PAGE_SIZE}`);
    // Records from both pages survive the pull.
    expect(programmes.map((p) => p.id)).toEqual(['1001', '1002', '1003', '1004']);
  });

  it('listTransactions pulls every page when limit is absent', async () => {
    const spy = mockFetchQueue([
      fakeResponse(loadFixture('conversions-page1.json')),
      fakeResponse(loadFixture('conversions-page2.json')),
    ]);
    const txns = await everflowAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
    });
    expect(txns.length).toBe(3);
    expect(spy.mock.calls.length).toBe(2);
    const secondUrl = String(spy.mock.calls[1]?.[0]);
    expect(secondUrl).toContain('page=2');
    // The page-2 rejected conversion is present with its reason intact.
    const reversed = txns.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toContain('Duplicate conversion');
  });

  it('listProgrammes with limit present stops after the first satisfying page', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('alloffers-page1.json'))]);
    const programmes = await everflowAdapter.listProgrammes({ limit: 2 });
    expect(programmes.length).toBe(2);
    // One call only — page 2 exists (total_count 4) but the limit is satisfied.
    expect(spy.mock.calls.length).toBe(1);
    expect(String(spy.mock.calls[0]?.[0])).toContain('page_size=2');
  });

  it('listTransactions with limit present stops after the first satisfying page', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('conversions-page1.json'))]);
    const txns = await everflowAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
      limit: 2,
    });
    expect(txns.length).toBe(2);
    expect(spy.mock.calls.length).toBe(1);
    expect(String(spy.mock.calls[0]?.[0])).toContain('page_size=2');
  });

  it('stops at the MAX_PAGES backstop and logs a warning instead of looping forever', async () => {
    // A server that always advertises more rows than it has served: every page
    // is full and total_count never gets any closer.
    const offers = Array.from({ length: _internals.PAGE_SIZE }, (_, i) => ({
      network_offer_id: i + 1,
      name: `Offer ${i + 1}`,
      offer_status: 'active',
    }));
    const pages = Array.from({ length: _internals.MAX_PAGES + 5 }, (_, i) =>
      fakeResponse({ offers, page: i + 1, page_size: _internals.PAGE_SIZE, total_count: 999999 }),
    );
    const spy = mockFetchQueue(pages);
    const warnSpy = vi.spyOn(_internals.log, 'warn').mockImplementation(() => undefined);

    const programmes = await everflowAdapter.listProgrammes();

    expect(spy.mock.calls.length).toBe(_internals.MAX_PAGES);
    expect(programmes.length).toBe(_internals.MAX_PAGES * _internals.PAGE_SIZE);
    expect(warnSpy).toHaveBeenCalled();
  });

  it('fetchAllPages stops on a short page when total_count is absent', async () => {
    const fetchPage = vi.fn(async (page: number) => ({ items: page === 1 ? [1, 2] : [3] }));
    const out = await _internals.fetchAllPages({
      operation: 'test',
      pageSize: 2,
      fetchPage,
      extract: (envelope) => envelope.items,
      totalCount: () => undefined,
    });
    expect(out).toEqual([1, 2, 3]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// getProgramme
// ---------------------------------------------------------------------------

describe('Everflow.getProgramme', () => {
  it('returns a Programme from the single-offer endpoint', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offer.json'))]);
    const prog = await everflowAdapter.getProgramme('1001');
    expect(prog.id).toBe('1001');
    expect(prog.name).toBe('Atolls Bookshop');
    expect(prog.network).toBe('everflow');
  });

  it('throws a config_error envelope for non-numeric programmeId', async () => {
    await expect(everflowAdapter.getProgramme('not-a-number')).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error envelope for empty programmeId', async () => {
    await expect(everflowAdapter.getProgramme('')).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('Everflow.verifyAuth (happy path)', () => {
  it('returns ok:true with identity when alloffers responds 200', async () => {
    mockFetchQueue([fakeResponse(loadFixture('alloffers.json'))]);
    const r = await everflowAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('everflow');
    }
  });

  it('surfaces a NetworkErrorEnvelope shape on 401 (§15.4)', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_api_key"}', {
        status: 401,
        rawBody: '{"error":"invalid_api_key"}',
      }),
    ]);
    const r = await everflowAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/HTTP 401|401/);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('Everflow.getEarningsSummary', () => {
  it('derives the summary from listTransactions correctly', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const summary = await everflowAdapter.getEarningsSummary({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
    });
    expect(summary.network).toBe('everflow');
    // 5.00 (approved) + 5.00 (pending) + 0.00 (rejected) = 10.00
    expect(summary.totalEarnings).toBeCloseTo(10.0, 2);
    expect(summary.byStatus.approved).toBeCloseTo(5.0, 2);
    expect(summary.byStatus.pending).toBeCloseTo(5.0, 2);
    expect(summary.byStatus.reversed).toBeCloseTo(0.0, 2);
    expect(summary.byProgramme.length).toBeGreaterThan(0);
  });

  it('computes oldestUnpaidAgeDays from pending/approved transactions (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const summary = await everflowAdapter.getEarningsSummary({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
    });
    // Oldest unpaid is the Jan 15 approved conversion — older than the April 20 pending one.
    expect(summary.oldestUnpaidAgeDays).toBeGreaterThan(0);
    // The Jan conversion (approved) should be the oldest unpaid.
    // Exact value depends on `new Date()` at test runtime; assert it's > 30d.
    expect(summary.oldestUnpaidAgeDays).toBeGreaterThan(30);
  });
});

// ---------------------------------------------------------------------------
// admin ops
// ---------------------------------------------------------------------------

describe('Everflow admin operations (not implemented at v0.1)', () => {
  it('listPublishers throws NotImplementedError', async () => {
    await expect(everflowAdapter.listPublishers()).rejects.toBeInstanceOf(NotImplementedError);
  });
  it('listPublisherSectors throws NotImplementedError', async () => {
    await expect(everflowAdapter.listPublisherSectors()).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim Everflow response body on a 500', async () => {
    const body = '{"error":"upstream_error","trace":"efg123"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await everflowAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('everflow');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream_error');
    }
  });

  it('classifies 401 as auth_error (§15.4)', async () => {
    mockFetchQueue([fakeResponse('Forbidden', { status: 401, rawBody: 'Forbidden' })]);
    try {
      await everflowAdapter.listProgrammes();
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

describe('Everflow.capabilitiesCheck', () => {
  it('reports operations with experimental claim status', async () => {
    // Stub for listProgrammes, listTransactions, getEarningsSummary, verifyAuth, listClicks.
    mockFetchQueue([
      fakeResponse(loadFixture('alloffers.json')), // listProgrammes
      fakeResponse(loadFixture('conversions.json')), // listTransactions
      fakeResponse(loadFixture('conversions.json')), // getEarningsSummary → listTransactions
      fakeResponse(loadFixture('alloffers.json')), // verifyAuth
      fakeResponse(loadFixture('clicks.json')), // listClicks
    ]);
    const caps = await everflowAdapter.capabilitiesCheck();
    expect(caps.network).toBe('everflow');
    expect(caps.operations['generateTrackingLink']?.supported).toBe(true);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
