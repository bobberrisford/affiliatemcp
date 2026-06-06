/**
 * Refersion adapter — unit tests.
 *
 * Exercises status mapping, transformers, request shape (the two custom auth
 * headers, the `/v2` prefix, POST list endpoints), the advertiser operations,
 * the requireCtx guard, NotImplemented ops, and verifyAuth.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { refersionAdapter, _internals } from '../../../src/networks/refersion/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'refersion');
const CTX = { networkBrandId: 'acme' };

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { 'content-type': 'application/json' } });
}

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function mockFetchQueue(responses: Response[]): {
  spy: ReturnType<typeof vi.fn>;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = (init?.headers as Record<string, string>) ?? {};
    calls.push({ url, method, headers });
    const r = responses.shift();
    if (!r) throw new Error('mock fetch queue exhausted');
    return r;
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return { spy, calls };
}

beforeEach(() => {
  _resetBreakers();
  process.env['REFERSION_API_KEY'] = 'fake-public-key';
  process.env['REFERSION_SECRET_KEY'] = 'fake-secret-key';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['REFERSION_API_KEY'];
  delete process.env['REFERSION_SECRET_KEY'];
});

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

describe('Refersion transformers', () => {
  it('maps conversion status to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'approved' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'paid' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ status: 'reversed' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'denied' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'unqualified' })).toBe('other');
    expect(_internals.mapTransactionStatus({ status: 'mystery' })).toBe('other');
  });

  it('maps affiliate status and derives a display name', () => {
    expect(_internals.mapAffiliateStatus({ status: 'active' })).toBe('active');
    expect(_internals.mapAffiliateStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapAffiliateStatus({ status: 'mystery' })).toBe('unknown');
    expect(_internals.affiliateName({ first_name: 'Alpha', last_name: 'Reviewer' })).toBe(
      'Alpha Reviewer',
    );
    expect(_internals.affiliateName({ email: 'x@y.com' })).toBe('x@y.com');
  });

  it('reads commission / sale in major units and preserves raw on Transaction', () => {
    const raw = {
      id: 9002,
      status: 'approved',
      commission_total: 42,
      total: 420,
      currency: 'USD',
      created: '2024-04-01 10:00:00',
      offer_id: 5001,
      offer_name: 'Default Offer',
    };
    const t = _internals.toTransaction(raw);
    expect(t.rawNetworkData).toBe(raw);
    expect(t.commission).toBe(42);
    expect(t.amount).toBe(420);
    expect(t.status).toBe('approved');
    expect(t.programmeId).toBe('5001');
  });

  it('builds structured commission rate on a Programme from offer type/amount', () => {
    const percent = _internals.toProgramme({ id: 'x', name: 'C', type: 'PERCENT_OF_SALE', amount: 30, currency: 'USD' });
    expect(percent.commissionRate).toMatchObject({ type: 'percent', value: 30 });
    const flat = _internals.toProgramme({ id: 'y', name: 'D', type: 'FLAT_RATE', amount: 25, currency: 'USD' });
    expect(flat.commissionRate).toMatchObject({ type: 'flat', value: 25, currency: 'USD' });
  });
});

// ---------------------------------------------------------------------------
// Request shape + ctx guard
// ---------------------------------------------------------------------------

describe('Refersion request shape', () => {
  it('listTransactions POSTs /v2/conversions/list with the two custom auth headers', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    await refersionAdapter.listTransactions(undefined, CTX);
    expect(calls[0]?.url).toContain('/v2/conversions/list');
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers).toMatchObject({
      'Refersion-Public-Key': 'fake-public-key',
      'Refersion-Secret-Key': 'fake-secret-key',
    });
  });

  it('listMediaPartners POSTs /v2/affiliate/list', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('affiliates.json'))]);
    await refersionAdapter.listMediaPartners(undefined, CTX);
    expect(calls[0]?.url).toContain('/v2/affiliate/list');
  });

  it('refuses to run without a brand context', async () => {
    await expect(refersionAdapter.listTransactions(undefined)).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

describe('Refersion operations', () => {
  it('listProgrammes maps offers to Programme records', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const programmes = await refersionAdapter.listProgrammes(undefined, CTX);
    expect(programmes).toHaveLength(2);
    expect(programmes[0]?.name).toBe('Default Offer');
    expect(programmes[0]?.commissionRate).toMatchObject({ type: 'percent', value: 30 });
  });

  it('getProgramme selects a single offer by id', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const programme = await refersionAdapter.getProgramme('5001', CTX);
    expect(programme.name).toBe('Default Offer');
    expect(calls[0]?.url).toContain('/v2/offer/list');
  });

  it('getProgramme throws config_error for an unknown id', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    await expect(refersionAdapter.getProgramme('does-not-exist', CTX)).rejects.toBeInstanceOf(
      NetworkError,
    );
  });

  it('listTransactions maps conversions and filters by status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const all = await refersionAdapter.listTransactions(undefined, CTX);
    expect(all).toHaveLength(4);
    expect(all.map((t) => t.status).sort()).toEqual(['approved', 'paid', 'pending', 'reversed'].sort());

    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const reversed = await refersionAdapter.listTransactions({ status: 'reversed' }, CTX);
    expect(reversed).toHaveLength(1);
    // The verbatim upstream status is preserved on rawNetworkData.
    expect((reversed[0]?.rawNetworkData as { status?: string }).status).toBe('reversed');
  });

  it('listMediaPartners maps affiliates with normalised status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('affiliates.json'))]);
    const partners = await refersionAdapter.listMediaPartners(undefined, CTX);
    expect(partners).toHaveLength(2);
    expect(partners[0]?.name).toBe('Alpha Reviewer');
    expect(partners[0]?.status).toBe('active');
    expect(partners[1]?.name).toBe('beta@example.com');
    expect(partners[1]?.status).toBe('pending');
  });

  it('getEarningsSummary totals commission owed across a wide window', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const summary = await refersionAdapter.getEarningsSummary(
      { from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' },
      CTX,
    );
    // 50 + 25 + 10 + 7.5
    expect(summary.totalEarnings).toBeCloseTo(92.5, 5);
    expect(summary.byStatus.approved).toBeCloseTo(25, 5);
    expect(summary.byStatus.paid).toBeCloseTo(10, 5);
    expect(summary.byStatus.reversed).toBeCloseTo(7.5, 5);
  });

  it('getProgrammePerformance buckets conversions per affiliate per day with 0 clicks', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const rows = await refersionAdapter.getProgrammePerformance(
      { from: '2000-01-01', to: '2100-01-01' },
      CTX,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.clicks === 0)).toBe(true);
  });

  it('paginates while total_pages indicates more', async () => {
    const fullPage = {
      page: 1,
      per_page: 100,
      total_pages: 2,
      results: Array.from({ length: 100 }, (_, i) => ({ id: i, email: `a${i}@x.com`, status: 'active' })),
    };
    const page2 = {
      page: 2,
      per_page: 100,
      total_pages: 2,
      results: [{ id: 999, email: 'last@x.com', status: 'active' }],
    };
    const { calls } = mockFetchQueue([fakeResponse(fullPage), fakeResponse(page2)]);
    const partners = await refersionAdapter.listMediaPartners(undefined, CTX);
    expect(partners).toHaveLength(101);
    expect(calls).toHaveLength(2);
  });

  it('returns empty array when there are no conversions', async () => {
    mockFetchQueue([fakeResponse(loadFixture('empty.json'))]);
    const txns = await refersionAdapter.listTransactions(undefined, CTX);
    expect(txns).toEqual([]);
  });

  it('listClicks and generateTrackingLink throw NotImplementedError', async () => {
    await expect(refersionAdapter.listClicks(undefined, CTX)).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(
      refersionAdapter.generateTrackingLink({ programmeId: 'x', destinationUrl: 'https://x' }, CTX),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

describe('Refersion verifyAuth', () => {
  it('returns ok on a 200 affiliate-list probe', async () => {
    mockFetchQueue([fakeResponse(loadFixture('empty.json'))]);
    const result = await refersionAdapter.verifyAuth();
    expect(result.ok).toBe(true);
  });

  it('returns ok:false on a 401', async () => {
    mockFetchQueue([fakeResponse({ error: 'unauthorised' }, { status: 401 })]);
    const result = await refersionAdapter.verifyAuth();
    expect(result.ok).toBe(false);
  });
});
