/**
 * Scaleo affiliate adapter — unit tests.
 *
 * Pattern matched to `tests/networks/everflow/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 *   - Fixtures live under `tests/networks/scaleo/fixtures/` and approximate the
 *     shape of real Scaleo API responses. No real tokens, no real data.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { scaleoAdapter, _internals } from '../../../src/networks/scaleo/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'networks', 'scaleo', 'fixtures');

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

const EMPTY = { data: [], meta: { total: 0 } };

/**
 * listTransactions / getEarningsSummary chunk wide windows into ≤90-day slices.
 * A Jan→May window spans two slices, so we queue the conversions fixture for the
 * first slice and an empty page for the second.
 */
function mockTwoChunkConversions(): void {
  mockFetchQueue([fakeResponse(loadFixture('conversions.json')), fakeResponse(EMPTY)]);
}

beforeEach(() => {
  _resetBreakers();
  process.env['SCALEO_BASE_URL'] = 'https://sandbox.scaletrk.com';
  process.env['SCALEO_API_KEY'] = 'test-api-key-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['SCALEO_BASE_URL'];
  delete process.env['SCALEO_API_KEY'];
});

// ---------------------------------------------------------------------------
// Transformation (status mapping + raw preservation)
// ---------------------------------------------------------------------------

describe('Scaleo transformers (status normalisation, raw preservation)', () => {
  it('maps offer approval statuses to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ approval_status: 'approved' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ approval_status: 'pending' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ approval_status: 'rejected' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ approval_status: 'paused' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ approval_status: 'never-seen' })).toBe('unknown');
    // No approval relationship — fall back to offer status.
    expect(_internals.mapProgrammeStatus({ status: 'active' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ status: 'paused' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({})).toBe('unknown');
  });

  it('maps conversion statuses to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ status: 'approved' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'success' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'pending' })).toBe('pending');
    // hold is Scaleo's delayed-approval bucket — treated as pending.
    expect(_internals.mapTransactionStatus({ status: 'hold' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'declined' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'rejected' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'trash' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'paid' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ status: 'future_status' })).toBe('other');
    expect(_internals.mapTransactionStatus({})).toBe('other');
  });

  it('coerces string amounts to numbers', () => {
    expect(_internals.asNumber('12.5')).toBe(12.5);
    expect(_internals.asNumber(7)).toBe(7);
    expect(_internals.asNumber('not-a-number')).toBe(0);
    expect(_internals.asNumber(undefined)).toBe(0);
  });

  it('preserves the raw Scaleo payload under rawNetworkData', () => {
    const rows = (loadFixture('conversions.json') as { data: Record<string, unknown>[] }).data;
    const raw = rows[0] as Record<string, unknown>;
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('surfaces reversalReason from decline_reason on reversed transactions (§15.10)', () => {
    const rows = (loadFixture('conversions.json') as { data: Record<string, unknown>[] }).data;
    const declined = rows[2] as Record<string, unknown>;
    const out = _internals.toTransaction(declined as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Duplicate conversion for this order');
  });

  it('computes ageDays from conversion_date against a fixed now', () => {
    const now = new Date('2026-05-28T12:00:00Z');
    // 2026-01-15 10:00:00Z → 2026-05-28 12:00:00Z = 133 days 2 hours → floors to 133.
    const age = _internals.computeAgeDays({ conversion_date: '2026-01-15 10:00:00' } as never, now);
    expect(age).toBe(133);
  });

  it('returns 0 ageDays when no date field is present', () => {
    const now = new Date('2026-05-28T00:00:00Z');
    expect(_internals.computeAgeDays({} as never, now)).toBe(0);
  });

  it('maps currency and payout-type to a structured commission rate', () => {
    const prog = _internals.toProgramme({ id: 1, currency: 'GBP', payout: 5.5, payout_type: 'CPA' });
    expect(prog.currency).toBe('GBP');
    expect(typeof prog.commissionRate).toBe('object');
    expect((prog.commissionRate as { type: string }).type).toBe('flat');
    const rev = _internals.toProgramme({ id: 2, payout: 20, payout_type: 'RevShare' });
    expect((rev.commissionRate as { type: string }).type).toBe('percent');
  });

  it('extractRows reads data / offers / conversions / clicks / bare array', () => {
    expect(_internals.extractRows({ data: [1, 2] } as never)).toEqual([1, 2]);
    expect(_internals.extractRows({ offers: [3] } as never)).toEqual([3]);
    expect(_internals.extractRows([4, 5] as never)).toEqual([4, 5]);
    expect(_internals.extractRows(undefined)).toEqual([]);
  });

  it('chunkDateRange splits correctly at 90 days', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-07-01T00:00:00Z'); // 181 days → 3 slices (90+90+1)
    const slices = _internals.chunkDateRange(from, to, 90);
    expect(slices.length).toBe(3);
    expect(slices[0]?.start.toISOString()).toBe(from.toISOString());
    expect(slices[slices.length - 1]?.end.toISOString()).toBe(to.toISOString());
  });

  it('formatScaleoDate produces YYYY-MM-DD HH:mm:SS format', () => {
    const d = new Date('2026-05-28T13:45:00Z');
    expect(_internals.formatScaleoDate(d)).toBe('2026-05-28 13:45:00');
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('Scaleo.listProgrammes', () => {
  it('maps offer statuses correctly from the offers fixture', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const programmes = await scaleoAdapter.listProgrammes();
    expect(programmes.length).toBe(3);
    expect(programmes.find((p) => p.id === '1001')?.status).toBe('joined');
    expect(programmes.find((p) => p.id === '1002')?.status).toBe('pending');
    expect(programmes.find((p) => p.id === '1003')?.status).toBe('declined');
  });

  it('filters by status client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const only = await scaleoAdapter.listProgrammes({ status: 'joined' });
    expect(only.every((p) => p.status === 'joined')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('applies search filter client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const results = await scaleoAdapter.listProgrammes({ search: 'bookshop' });
    expect(results.length).toBe(1);
    expect(results[0]?.name).toBe('Atolls Bookshop');
  });

  it('sends the api-key as a query parameter against the per-tenant base URL', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    await scaleoAdapter.listProgrammes();
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain('https://sandbox.scaletrk.com/api/v2/affiliate/offers');
    expect(url).toContain('api-key=test-api-key-please-ignore');
  });

  it('preserves rawNetworkData on each programme', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const programmes = await scaleoAdapter.listProgrammes();
    for (const p of programmes) expect(p.rawNetworkData).toBeDefined();
  });

  it('throws a config_error when the base URL is missing (§15.4)', async () => {
    delete process.env['SCALEO_BASE_URL'];
    await expect(scaleoAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error when the base URL is not a valid URL', async () => {
    process.env['SCALEO_BASE_URL'] = 'not a url';
    await expect(scaleoAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a NetworkError when the API key is missing', async () => {
    delete process.env['SCALEO_API_KEY'];
    await expect(scaleoAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getProgramme
// ---------------------------------------------------------------------------

describe('Scaleo.getProgramme', () => {
  it('returns a Programme from the single-offer endpoint', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offer.json'))]);
    const prog = await scaleoAdapter.getProgramme('1001');
    expect(prog.id).toBe('1001');
    expect(prog.name).toBe('Atolls Bookshop');
    expect(prog.network).toBe('scaleo');
  });

  it('throws a config_error envelope for non-numeric programmeId', async () => {
    await expect(scaleoAdapter.getProgramme('abc')).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error envelope for empty programmeId', async () => {
    await expect(scaleoAdapter.getProgramme('')).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listTransactions — unpaid-age + reversed visibility (§15.9, §15.10)
// ---------------------------------------------------------------------------

describe('Scaleo.listTransactions', () => {
  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockTwoChunkConversions();
    const aged = await scaleoAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
      minAgeDays: 50,
    });
    for (const t of aged) expect(t.ageDays).toBeGreaterThanOrEqual(50);
    expect(aged.length).toBeGreaterThan(0);
  });

  it('includes reversed transactions with reason populated (§15.10)', async () => {
    mockTwoChunkConversions();
    const all = await scaleoAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
    });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toContain('Duplicate conversion');
  });

  it('filters by status when caller passes status[]', async () => {
    mockTwoChunkConversions();
    const only = await scaleoAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('uses commission from payout and amount from the order value', async () => {
    mockTwoChunkConversions();
    const all = await scaleoAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
    });
    const approved = all.find((t) => t.status === 'approved');
    expect(approved?.commission).toBeCloseTo(5.0, 2);
    expect(approved?.amount).toBeCloseTo(40.0, 2);
    expect(approved?.currency).toBe('GBP');
  });

  it('emits an error envelope when the API key is missing (§15.4)', async () => {
    delete process.env['SCALEO_API_KEY'];
    await expect(scaleoAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('Scaleo.getEarningsSummary', () => {
  it('derives the summary from listTransactions correctly', async () => {
    mockTwoChunkConversions();
    const summary = await scaleoAdapter.getEarningsSummary({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
    });
    expect(summary.network).toBe('scaleo');
    // 5.00 (approved) + 5.00 (pending) + 0.00 (declined) = 10.00
    expect(summary.totalEarnings).toBeCloseTo(10.0, 2);
    expect(summary.byStatus.approved).toBeCloseTo(5.0, 2);
    expect(summary.byStatus.pending).toBeCloseTo(5.0, 2);
    expect(summary.byStatus.reversed).toBeCloseTo(0.0, 2);
    expect(summary.byProgramme.length).toBeGreaterThan(0);
  });

  it('computes oldestUnpaidAgeDays from pending/approved transactions (§15.9)', async () => {
    mockTwoChunkConversions();
    const summary = await scaleoAdapter.getEarningsSummary({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
    });
    expect(summary.oldestUnpaidAgeDays).toBeGreaterThan(30);
  });
});

// ---------------------------------------------------------------------------
// listClicks
// ---------------------------------------------------------------------------

describe('Scaleo.listClicks', () => {
  it('returns click records with timestamp and programmeId', async () => {
    mockFetchQueue([fakeResponse(loadFixture('clicks.json'))]);
    const clicks = await scaleoAdapter.listClicks({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-07T00:00:00Z',
    });
    expect(clicks.length).toBe(2);
    expect(clicks[0]?.network).toBe('scaleo');
    expect(clicks[0]?.programmeId).toBe('1001');
    expect(clicks[0]?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('preserves rawNetworkData on each click', async () => {
    mockFetchQueue([fakeResponse(loadFixture('clicks.json'))]);
    const clicks = await scaleoAdapter.listClicks({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-07T00:00:00Z',
    });
    expect(clicks[0]?.rawNetworkData).toBeDefined();
  });

  it('chunks wide date ranges into ≤90-day slices', async () => {
    const spy = mockFetchQueue([
      fakeResponse(loadFixture('clicks.json')),
      fakeResponse({ data: [], meta: { total: 0 } }),
    ]);
    await scaleoAdapter.listClicks({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-01T00:00:00Z', // 120 days → 2 slices (90 + 30)
    });
    expect(spy.mock.calls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink (intentionally unsupported)
// ---------------------------------------------------------------------------

describe('Scaleo.generateTrackingLink', () => {
  it('throws NotImplementedError (affiliate id not among credentials)', async () => {
    await expect(
      scaleoAdapter.generateTrackingLink({
        programmeId: '1001',
        destinationUrl: 'https://www.atolls-bookshop.example.com/products',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('Scaleo.verifyAuth', () => {
  it('returns ok:true with identity when offers responds 200', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const r = await scaleoAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toContain('scaleo');
  });

  it('returns ok:false on 401 (§15.4)', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_api_key"}', {
        status: 401,
        rawBody: '{"error":"invalid_api_key"}',
      }),
    ]);
    const r = await scaleoAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/401/);
  });

  it('returns ok:false (not a throw) when the base URL is missing', async () => {
    delete process.env['SCALEO_BASE_URL'];
    const r = await scaleoAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// admin ops
// ---------------------------------------------------------------------------

describe('Scaleo admin operations (not implemented at v0.1)', () => {
  it('listPublishers throws NotImplementedError', async () => {
    await expect(scaleoAdapter.listPublishers()).rejects.toBeInstanceOf(NotImplementedError);
  });
  it('listPublisherSectors throws NotImplementedError', async () => {
    await expect(scaleoAdapter.listPublisherSectors()).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim Scaleo response body on a 500', async () => {
    const body = '{"error":"upstream_error","trace":"efg123"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await scaleoAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('scaleo');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream_error');
    }
  });

  it('classifies 401 as auth_error (§15.4)', async () => {
    mockFetchQueue([fakeResponse('Forbidden', { status: 401, rawBody: 'Forbidden' })]);
    try {
      await scaleoAdapter.listProgrammes();
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

describe('Scaleo.capabilitiesCheck', () => {
  it('reports operations and marks generateTrackingLink unsupported', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('offers.json')), // listProgrammes
      fakeResponse(loadFixture('conversions.json')), // listTransactions
      fakeResponse(loadFixture('conversions.json')), // getEarningsSummary → listTransactions
      fakeResponse(loadFixture('offers.json')), // verifyAuth
      fakeResponse(loadFixture('clicks.json')), // listClicks
    ]);
    const caps = await scaleoAdapter.capabilitiesCheck();
    expect(caps.network).toBe('scaleo');
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
    expect(caps.operations['listProgrammes']?.supported).toBe(true);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
