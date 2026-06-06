/**
 * Tapfiliate adapter — unit tests.
 *
 * Exercises status mapping, transformers, request shape (the X-Api-Key header,
 * the `/1.6` prefix), the advertiser operations, the requireCtx guard,
 * NotImplemented ops, header-based pagination, and verifyAuth. No live calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { tapfiliateAdapter, _internals } from '../../../src/networks/tapfiliate/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'tapfiliate');
const CTX = { networkBrandId: 'acme' };

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

/**
 * Build a fake Response. `nextPage` true adds a Link header with rel="next" so
 * the adapter's header-based pagination loop continues.
 */
function fakeResponse(
  body: unknown,
  init: { status?: number; nextPage?: boolean } = {},
): Response {
  const status = init.status ?? 200;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.nextPage) {
    headers['link'] = '<https://api.tapfiliate.com/1.6/conversions/?page=2>; rel="next"';
  }
  return new Response(text, { status, headers });
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
  process.env['TAPFILIATE_API_KEY'] = 'fake-key';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['TAPFILIATE_API_KEY'];
});

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

describe('Tapfiliate transformers', () => {
  it('maps a single commission approved flag to canonical TransactionStatus', () => {
    expect(_internals.mapCommissionStatus({ approved: null })).toBe('pending');
    expect(_internals.mapCommissionStatus({ approved: true })).toBe('approved');
    expect(_internals.mapCommissionStatus({ approved: false })).toBe('reversed');
    expect(_internals.mapCommissionStatus({ approved: true, payout: { id: 'p1' } })).toBe('paid');
  });

  it('maps a conversion status as the most cautionary across its commissions', () => {
    expect(
      _internals.mapConversionStatus({
        commissions: [{ approved: true }, { approved: false }],
      }),
    ).toBe('reversed');
    expect(
      _internals.mapConversionStatus({
        commissions: [{ approved: true }, { approved: null }],
      }),
    ).toBe('pending');
    expect(
      _internals.mapConversionStatus({
        commissions: [{ approved: true, payout: { id: 'p1' } }],
      }),
    ).toBe('paid');
    expect(_internals.mapConversionStatus({ commissions: [{ approved: true }] })).toBe('approved');
  });

  it('maps affiliate approved/state and derives a display name', () => {
    expect(_internals.mapAffiliateStatus({ approved: true })).toBe('active');
    expect(_internals.mapAffiliateStatus({ approved: null })).toBe('unknown');
    expect(_internals.mapAffiliateStatus({ approved: false })).toBe('inactive');
    expect(_internals.affiliateName({ firstname: 'Alpha', lastname: 'Reviewer' })).toBe(
      'Alpha Reviewer',
    );
    expect(_internals.affiliateName({ email: 'x@y.com' })).toBe('x@y.com');
  });

  it('passes decimal amounts through verbatim and preserves raw on Transaction', () => {
    const raw = {
      id: 'conv-1',
      created_at: '2024-04-01T10:00:00+00:00',
      amount: 420.0,
      program: { id: 'prog-default', title: 'Default', currency: 'USD' },
      commissions: [{ id: 'com-1', amount: 42.0, approved: true }],
    };
    const t = _internals.toTransaction(raw);
    expect(t.rawNetworkData).toBe(raw);
    expect(t.commission).toBe(42);
    expect(t.amount).toBe(420);
    expect(t.status).toBe('approved');
    expect(t.programmeId).toBe('prog-default');
  });

  it('builds structured commission rate on a Programme', () => {
    const percent = _internals.toProgramme({
      id: 'x',
      title: 'C',
      commission: 30,
      commission_type: 'percentage',
      currency: 'USD',
    });
    expect(percent.commissionRate).toMatchObject({ type: 'percent', value: 30 });
    const flat = _internals.toProgramme({
      id: 'y',
      title: 'D',
      commission: 25,
      commission_type: 'fixed',
      currency: 'USD',
    });
    expect(flat.commissionRate).toMatchObject({ type: 'flat', value: 25, currency: 'USD' });
  });
});

// ---------------------------------------------------------------------------
// Request shape + ctx guard
// ---------------------------------------------------------------------------

describe('Tapfiliate request shape', () => {
  it('listTransactions GETs /1.6/conversions/ with the X-Api-Key header', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    await tapfiliateAdapter.listTransactions(undefined, CTX);
    expect(calls[0]?.url).toContain('/1.6/conversions/');
    expect(calls[0]?.headers).toMatchObject({ 'X-Api-Key': 'fake-key' });
  });

  it('listMediaPartners GETs /1.6/affiliates/', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('affiliates.json'))]);
    await tapfiliateAdapter.listMediaPartners(undefined, CTX);
    expect(calls[0]?.url).toContain('/1.6/affiliates/');
  });

  it('refuses to run without a brand context', async () => {
    await expect(tapfiliateAdapter.listTransactions(undefined)).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

describe('Tapfiliate operations', () => {
  it('listProgrammes maps programmes to Programme records', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programs.json'))]);
    const programmes = await tapfiliateAdapter.listProgrammes(undefined, CTX);
    expect(programmes).toHaveLength(2);
    expect(programmes[0]?.name).toBe('Default Programme');
    expect(programmes[0]?.commissionRate).toMatchObject({ type: 'percent', value: 30 });
  });

  it('getProgramme fetches a single programme by id', async () => {
    const { calls } = mockFetchQueue([
      fakeResponse({ id: 'prog-default', title: 'Default Programme', currency: 'USD' }),
    ]);
    const programme = await tapfiliateAdapter.getProgramme('prog-default', CTX);
    expect(programme.name).toBe('Default Programme');
    expect(calls[0]?.url).toContain('/1.6/programs/prog-default/');
  });

  it('listTransactions maps conversions and filters by status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const all = await tapfiliateAdapter.listTransactions(undefined, CTX);
    expect(all).toHaveLength(4);
    expect(all.map((t) => t.status).sort()).toEqual(
      ['approved', 'paid', 'pending', 'reversed'].sort(),
    );

    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const reversed = await tapfiliateAdapter.listTransactions({ status: 'reversed' }, CTX);
    expect(reversed).toHaveLength(1);
    // The verbatim upstream payload is preserved on rawNetworkData.
    expect((reversed[0]?.rawNetworkData as { id?: string }).id).toBe('conv-reversed');
  });

  it('listMediaPartners maps affiliates with normalised status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('affiliates.json'))]);
    const partners = await tapfiliateAdapter.listMediaPartners(undefined, CTX);
    expect(partners).toHaveLength(2);
    expect(partners[0]?.name).toBe('Alpha Reviewer');
    expect(partners[0]?.status).toBe('active');
    expect(partners[1]?.name).toBe('beta@example.com');
    expect(partners[1]?.status).toBe('unknown');
  });

  it('getEarningsSummary totals commission owed across a wide window', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const summary = await tapfiliateAdapter.getEarningsSummary(
      { from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' },
      CTX,
    );
    // 50 + 25 + 10 + 7.5
    expect(summary.totalEarnings).toBeCloseTo(92.5, 5);
    expect(summary.byStatus.pending).toBeCloseTo(50, 5);
    expect(summary.byStatus.approved).toBeCloseTo(25, 5);
    expect(summary.byStatus.paid).toBeCloseTo(10, 5);
    expect(summary.byStatus.reversed).toBeCloseTo(7.5, 5);
  });

  it('getProgrammePerformance buckets conversions per affiliate per day with 0 clicks', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const rows = await tapfiliateAdapter.getProgrammePerformance(
      { from: '2000-01-01', to: '2100-01-01' },
      CTX,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.clicks === 0)).toBe(true);
  });

  it('paginates while the Link header advertises a next page', async () => {
    const page1 = [{ id: 'aff-1', email: 'a@x.com', approved: true }];
    const page2 = [{ id: 'aff-2', email: 'b@x.com', approved: true }];
    const { calls } = mockFetchQueue([
      fakeResponse(page1, { nextPage: true }),
      fakeResponse(page2),
    ]);
    const partners = await tapfiliateAdapter.listMediaPartners(undefined, CTX);
    expect(partners).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain('page=2');
  });

  it('returns empty array when there are no conversions', async () => {
    mockFetchQueue([fakeResponse(loadFixture('empty.json'))]);
    const txns = await tapfiliateAdapter.listTransactions(undefined, CTX);
    expect(txns).toEqual([]);
  });

  it('listClicks and generateTrackingLink throw NotImplementedError', async () => {
    await expect(tapfiliateAdapter.listClicks(undefined, CTX)).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(
      tapfiliateAdapter.generateTrackingLink({ programmeId: 'x', destinationUrl: 'https://x' }, CTX),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

describe('Tapfiliate verifyAuth', () => {
  it('returns ok on a 200 programmes probe', async () => {
    mockFetchQueue([fakeResponse(loadFixture('empty.json'))]);
    const result = await tapfiliateAdapter.verifyAuth();
    expect(result.ok).toBe(true);
  });

  it('returns ok:false on a 401', async () => {
    mockFetchQueue([fakeResponse({ error: 'unauthorised' }, { status: 401 })]);
    const result = await tapfiliateAdapter.verifyAuth();
    expect(result.ok).toBe(false);
  });
});
