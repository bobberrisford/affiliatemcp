/**
 * Affiliate Future adapter — unit tests.
 *
 * Patterns mirrored from the Awin reference tests:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - Each test stubs only the responses it needs.
 *
 * The headline Affiliate Future behaviour under test is the one-day-per-call
 * pull window: a multi-day range MUST fan out into one fetch per calendar day.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  affiliateFutureAdapter,
  _internals,
} from '../../../src/networks/affiliate-future/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(
  process.cwd(),
  'tests',
  'networks',
  'affiliate-future',
  'fixtures',
);

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

beforeEach(() => {
  _resetBreakers();
  process.env['AFFILIATE_FUTURE_API_KEY'] = 'test-key-please-ignore';
  process.env['AFFILIATE_FUTURE_PASSWORD'] = 'test-password-please-ignore';
  process.env['AFFILIATE_FUTURE_AFFILIATE_ID'] = '24641';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['AFFILIATE_FUTURE_API_KEY'];
  delete process.env['AFFILIATE_FUTURE_PASSWORD'];
  delete process.env['AFFILIATE_FUTURE_AFFILIATE_ID'];
});

// ---------------------------------------------------------------------------
// Transformers (status normalisation, raw preservation, ageing)
// ---------------------------------------------------------------------------

describe('Affiliate Future transformers', () => {
  it('maps statuses Validated|Pending|Declined|Paid → canonical statuses', () => {
    const txns = loadFixture('transactions.json') as Array<Record<string, unknown>>;
    expect(_internals.toTransaction(txns[0] as never).status).toBe('approved');
    expect(_internals.toTransaction(txns[1] as never).status).toBe('pending');
    // Declined → reversed (user-facing intent: did not pay out).
    expect(_internals.toTransaction(txns[2] as never).status).toBe('reversed');
    expect(_internals.toTransaction(txns[3] as never).status).toBe('paid');
  });

  it('preserves the raw response under rawNetworkData', () => {
    const raw = (loadFixture('transactions.json') as Array<Record<string, unknown>>)[0];
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('maps merchant joined flag to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ joined: true })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ joined: false })).toBe('available');
    expect(_internals.mapProgrammeStatus({})).toBe('unknown');
  });

  it('computes ageDays from the transaction date', () => {
    const now = new Date('2026-05-21T00:00:00Z');
    const age = _internals.computeAgeDays({ transactionDate: '2026-01-01T00:00:00Z' }, now);
    expect(age).toBe(140);
  });

  it('reads amount fields with mixed casing and surfaces commission', () => {
    const t = _internals.toTransaction({ SaleValue: '120.00', SaleCommission: '9.60' } as never);
    expect(t.amount).toBe(120);
    expect(t.commission).toBe(9.6);
  });

  it('formats dates as DD-MMM-YYYY for the transaction endpoint', () => {
    expect(_internals.formatAFDate(new Date('2026-01-05T00:00:00Z'))).toBe('05-jan-2026');
    expect(_internals.formatAFDate(new Date('2026-12-31T00:00:00Z'))).toBe('31-dec-2026');
  });
});

// ---------------------------------------------------------------------------
// listTransactions — one-day-per-call fan-out (the headline behaviour)
// ---------------------------------------------------------------------------

describe('Affiliate Future.listTransactions one-day-per-call chunking', () => {
  it('fans a multi-day range out into one fetch per calendar day', async () => {
    // 2026-01-01 .. 2026-01-05 inclusive → 5 days → 5 calls.
    const spy = mockFetchQueue([
      fakeResponse([]),
      fakeResponse([]),
      fakeResponse([]),
      fakeResponse([]),
      fakeResponse([]),
    ]);
    await affiliateFutureAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-05T00:00:00Z',
    });
    expect(spy.mock.calls.length).toBe(5);
  });

  it('issues startDate === endDate for each day slice', async () => {
    const spy = mockFetchQueue([fakeResponse([]), fakeResponse([])]);
    await affiliateFutureAdapter.listTransactions({
      from: '2026-03-10T00:00:00Z',
      to: '2026-03-11T00:00:00Z',
    });
    expect(spy.mock.calls.length).toBe(2);
    // Inspect the first request URL: startDate and endDate must be the same day.
    const firstUrl = String(spy.mock.calls[0]?.[0]);
    const u = new URL(firstUrl);
    expect(u.searchParams.get('startDate')).toBe('10-mar-2026');
    expect(u.searchParams.get('endDate')).toBe('10-mar-2026');
    // Auth travels on the query string.
    expect(u.searchParams.get('key')).toBe('test-key-please-ignore');
    expect(u.searchParams.get('passcode')).toBe('test-password-please-ignore');
  });

  it('chunkDateRangeByDay yields inclusive day slices', () => {
    const slices = _internals.chunkDateRangeByDay(
      new Date('2026-01-01T12:00:00Z'),
      new Date('2026-01-03T08:00:00Z'),
    );
    expect(slices.length).toBe(3);
  });

  it('aggregates rows from each day into one list and applies status filter', async () => {
    const txns = loadFixture('transactions.json') as unknown[];
    // Two-day window: serve all rows on day one, nothing on day two.
    mockFetchQueue([fakeResponse(txns), fakeResponse([])]);
    const reversed = await affiliateFutureAdapter.listTransactions({
      from: '2026-05-19T00:00:00Z',
      to: '2026-05-20T00:00:00Z',
      status: ['reversed'],
    });
    expect(reversed.every((t) => t.status === 'reversed')).toBe(true);
    expect(reversed.length).toBe(1);
  });

  it('filters by minAgeDays after mapping (§15.9)', async () => {
    const now = new Date();
    const txns = loadFixture('transactions.json') as unknown[];
    mockFetchQueue([fakeResponse(txns)]);
    const today = now.toISOString();
    const aged = await affiliateFutureAdapter.listTransactions({
      from: today,
      to: today,
      minAgeDays: 365,
    });
    for (const t of aged) {
      expect(t.ageDays).toBeGreaterThanOrEqual(365);
    }
  });

  it('emits a NetworkError when credentials are missing', async () => {
    delete process.env['AFFILIATE_FUTURE_API_KEY'];
    await expect(affiliateFutureAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes / getProgramme
// ---------------------------------------------------------------------------

describe('Affiliate Future.listProgrammes', () => {
  it('returns merchants as programmes and filters by status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchants.json'))]);
    const joined = await affiliateFutureAdapter.listProgrammes({ status: 'joined' });
    expect(joined.length).toBe(2);
    expect(joined.every((p) => p.status === 'joined')).toBe(true);
    expect(joined[0]?.network).toBe('affiliate-future');
  });

  it('getProgramme resolves a merchant by id from the list', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchants.json'))]);
    const p = await affiliateFutureAdapter.getProgramme('5969');
    expect(p.id).toBe('5969');
    expect(p.name).toBe('Atolls Bookshop');
  });

  it('getProgramme rejects a non-numeric id with a config_error', async () => {
    await expect(affiliateFutureAdapter.getProgramme('abc')).rejects.toBeInstanceOf(NetworkError);
  });

  it('getProgramme throws when the id is not found', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchants.json'))]);
    await expect(affiliateFutureAdapter.getProgramme('999999')).rejects.toBeInstanceOf(
      NetworkError,
    );
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('Affiliate Future.getEarningsSummary', () => {
  it('aggregates commission by status and programme from a single day', async () => {
    const txns = loadFixture('transactions.json') as unknown[];
    const today = new Date().toISOString();
    mockFetchQueue([fakeResponse(txns)]);
    const summary = await affiliateFutureAdapter.getEarningsSummary({ from: today, to: today });
    expect(summary.network).toBe('affiliate-future');
    // 9.6 + 4.0 + 6.04 + 20.0
    expect(summary.totalEarnings).toBeCloseTo(39.64, 2);
    expect(summary.byStatus.approved).toBeCloseTo(9.6, 2);
    expect(summary.byStatus.pending).toBeCloseTo(4.0, 2);
    expect(summary.byStatus.reversed).toBeCloseTo(6.04, 2);
    expect(summary.byStatus.paid).toBeCloseTo(20.0, 2);
    expect(summary.byProgramme.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// listClicks
// ---------------------------------------------------------------------------

describe('Affiliate Future.listClicks', () => {
  it('throws NotImplementedError with the documented reason', async () => {
    await expect(affiliateFutureAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await affiliateFutureAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('does not expose click-level data');
    }
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — deterministic AFClick construction
// ---------------------------------------------------------------------------

describe('Affiliate Future.generateTrackingLink', () => {
  it('constructs the AFClick URL with URL-encoded destination', async () => {
    const link = await affiliateFutureAdapter.generateTrackingLink({
      programmeId: '5969',
      destinationUrl: 'https://www.atolls-bookshop.example.com/path?q=a b',
    });
    expect(link.trackingUrl).toContain(
      'https://scripts.affiliatefuture.com/AFClick.asp?affiliateID=24641',
    );
    expect(link.trackingUrl).toContain('merchantID=5969');
    expect(link.trackingUrl).toContain('url=https%3A%2F%2Fwww.atolls-bookshop.example.com%2Fpath%3Fq%3Da%20b');
    expect(link.network).toBe('affiliate-future');
    expect(link.programmeId).toBe('5969');
  });

  it('does NOT call fetch (deterministic construction)', async () => {
    const spy = mockFetchQueue([]);
    await affiliateFutureAdapter.generateTrackingLink({
      programmeId: '5969',
      destinationUrl: 'https://x.example.com',
    });
    expect(spy.mock.calls.length).toBe(0);
  });

  it('throws a config_error when programmeId is missing', async () => {
    await expect(
      affiliateFutureAdapter.generateTrackingLink({
        programmeId: '',
        destinationUrl: 'https://x.example.com',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error when the affiliate ID is not configured', async () => {
    delete process.env['AFFILIATE_FUTURE_AFFILIATE_ID'];
    await expect(
      affiliateFutureAdapter.generateTrackingLink({
        programmeId: '5969',
        destinationUrl: 'https://x.example.com',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth + validateCredential
// ---------------------------------------------------------------------------

describe('Affiliate Future.verifyAuth', () => {
  it('returns ok:true when the Merchant List call succeeds', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchants.json'))]);
    const r = await affiliateFutureAdapter.verifyAuth();
    expect(r.ok).toBe(true);
  });

  it('returns ok:false on a 401', async () => {
    mockFetchQueue([fakeResponse('{"error":"bad credentials"}', { status: 401 })]);
    const r = await affiliateFutureAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/401/);
  });
});

describe('Affiliate Future.validateCredential', () => {
  it('rejects an empty API key', async () => {
    const r = await affiliateFutureAdapter.validateCredential('AFFILIATE_FUTURE_API_KEY', '');
    expect(r.ok).toBe(false);
  });

  it('validates the password by calling the Merchant List', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchants.json'))]);
    const r = await affiliateFutureAdapter.validateCredential(
      'AFFILIATE_FUTURE_PASSWORD',
      'fresh-password',
    );
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with a hint when password validation fails', async () => {
    mockFetchQueue([fakeResponse('{"error":"bad"}', { status: 401 })]);
    const r = await affiliateFutureAdapter.validateCredential(
      'AFFILIATE_FUTURE_PASSWORD',
      'bad-password',
    );
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim response body on a 500', async () => {
    const body = '{"error":"upstream broke","trace":"xyz"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await affiliateFutureAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('affiliate-future');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream broke');
    }
  });

  it('classifies 401 as auth_error', async () => {
    mockFetchQueue([fakeResponse('forbidden', { status: 401, rawBody: 'forbidden' })]);
    try {
      await affiliateFutureAdapter.listProgrammes();
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

describe('Affiliate Future.capabilitiesCheck', () => {
  it('records listClicks unsupported with the known-limitation note', async () => {
    mockFetchQueue([
      fakeResponse([]), // listProgrammes
      fakeResponse([]), // listTransactions (single-day probe)
      fakeResponse([]), // getEarningsSummary → listTransactions
      fakeResponse(loadFixture('merchants.json')), // verifyAuth
    ]);
    const caps = await affiliateFutureAdapter.capabilitiesCheck();
    expect(caps.network).toBe('affiliate-future');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['listClicks']?.note).toContain('Click-level data');
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
