/**
 * FirstPromoter adapter — unit tests.
 *
 * Exercises status mapping, transformers, request shape (Bearer + ACCOUNT-ID
 * headers, the `/api/v2/company` prefix), the advertiser operations, the
 * requireCtx guard, Link-header pagination, NotImplemented ops, and verifyAuth.
 * No live network calls — `fetch` is mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { firstPromoterAdapter, _internals } from '../../../src/networks/firstpromoter/adapter.js';
import { parseNextLink } from '../../../src/networks/firstpromoter/client.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'firstpromoter');
const CTX = { networkBrandId: 'acme' };

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(body: unknown, init: { status?: number; nextUrl?: string } = {}): Response {
  const status = init.status ?? 200;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.nextUrl) headers['link'] = `<${init.nextUrl}>; rel="next"`;
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
  process.env['FIRSTPROMOTER_API_KEY'] = 'fake-key';
  process.env['FIRSTPROMOTER_ACCOUNT_ID'] = '123456';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['FIRSTPROMOTER_API_KEY'];
  delete process.env['FIRSTPROMOTER_ACCOUNT_ID'];
});

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

describe('FirstPromoter transformers', () => {
  it('maps commission status to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'approved' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'paid' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ status: 'denied' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'mystery' })).toBe('other');
  });

  it('treats is_paid as paid regardless of an approved status', () => {
    expect(_internals.mapTransactionStatus({ status: 'approved', is_paid: true })).toBe('paid');
  });

  it('maps promoter state and derives a display name', () => {
    expect(_internals.mapPromoterStatus({ state: 'active' })).toBe('active');
    expect(_internals.mapPromoterStatus({ state: 'pending' })).toBe('pending');
    expect(_internals.mapPromoterStatus({ state: 'disabled' })).toBe('inactive');
    expect(_internals.mapPromoterStatus({ state: 'mystery' })).toBe('unknown');
    expect(_internals.promoterName({ name: 'Alpha Reviewer' })).toBe('Alpha Reviewer');
    expect(_internals.promoterName({ name: '', email: 'x@y.com' })).toBe('x@y.com');
  });

  it('converts cents to major units and preserves raw on Transaction', () => {
    const raw = {
      id: 1001,
      status: 'approved',
      amount: 4200,
      sale_amount: 42000,
      unit: 'USD',
      created_at: '2024-04-01T10:00:00Z',
      status_updated_at: '2024-05-01T10:00:00Z',
      promoter_campaign: { campaign: { id: 3001, name: 'Default Campaign' } },
    };
    const t = _internals.toTransaction(raw);
    expect(t.rawNetworkData).toBe(raw);
    expect(t.commission).toBe(42);
    expect(t.amount).toBe(420);
    expect(t.status).toBe('approved');
    expect(t.programmeId).toBe('3001');
    expect(t.programmeName).toBe('Default Campaign');
  });

  it('builds structured commission rate on a Programme', () => {
    const percent = _internals.toProgramme({
      id: 3001,
      name: 'C',
      default_promoter_reward: { type: 'per', amount: 30 },
    });
    expect(percent.commissionRate).toMatchObject({ type: 'percent', value: 30 });
    const flat = _internals.toProgramme({
      id: 3002,
      name: 'D',
      default_promoter_reward: { type: 'per_amount', amount: 2500, unit: 'USD' },
    });
    expect(flat.commissionRate).toMatchObject({ type: 'flat', value: 25, currency: 'USD' });
  });

  it('parses the rel="next" Link header', () => {
    expect(
      parseNextLink('<https://api.firstpromoter.com/api/v2/company/promoters?page=2>; rel="next"'),
    ).toBe('https://api.firstpromoter.com/api/v2/company/promoters?page=2');
    expect(parseNextLink('<https://x/prev>; rel="prev"')).toBeUndefined();
    expect(parseNextLink(null)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Request shape + ctx guard
// ---------------------------------------------------------------------------

describe('FirstPromoter request shape', () => {
  it('listTransactions GETs /api/v2/company/commissions with Bearer + ACCOUNT-ID headers', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);
    await firstPromoterAdapter.listTransactions(undefined, CTX);
    expect(calls[0]?.url).toContain('/api/v2/company/commissions');
    expect(calls[0]?.headers).toMatchObject({
      Authorization: 'Bearer fake-key',
      'ACCOUNT-ID': '123456',
    });
  });

  it('listMediaPartners GETs /api/v2/company/promoters', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('promoters.json'))]);
    await firstPromoterAdapter.listMediaPartners(undefined, CTX);
    expect(calls[0]?.url).toContain('/api/v2/company/promoters');
  });

  it('refuses to run without a brand context', async () => {
    await expect(firstPromoterAdapter.listTransactions(undefined)).rejects.toBeInstanceOf(
      NetworkError,
    );
  });
});

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

describe('FirstPromoter operations', () => {
  it('listProgrammes maps campaigns to Programme records', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const programmes = await firstPromoterAdapter.listProgrammes(undefined, CTX);
    expect(programmes).toHaveLength(2);
    expect(programmes[0]?.name).toBe('Default Campaign');
    expect(programmes[0]?.commissionRate).toMatchObject({ type: 'percent', value: 30 });
  });

  it('getProgramme fetches a single campaign by id', async () => {
    const { calls } = mockFetchQueue([
      fakeResponse({ id: 3001, name: 'Default Campaign' }),
    ]);
    const programme = await firstPromoterAdapter.getProgramme('3001', CTX);
    expect(programme.name).toBe('Default Campaign');
    expect(calls[0]?.url).toContain('/api/v2/company/campaigns/3001');
  });

  it('listTransactions maps commissions and filters by status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);
    const all = await firstPromoterAdapter.listTransactions(undefined, CTX);
    expect(all).toHaveLength(4);
    expect(all.map((t) => t.status).sort()).toEqual(
      ['approved', 'paid', 'pending', 'reversed'].sort(),
    );

    mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);
    const reversed = await firstPromoterAdapter.listTransactions({ status: 'reversed' }, CTX);
    expect(reversed).toHaveLength(1);
    // The verbatim upstream status is preserved on rawNetworkData.
    expect((reversed[0]?.rawNetworkData as { status?: string }).status).toBe('denied');
  });

  it('listMediaPartners maps promoters with normalised status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('promoters.json'))]);
    const partners = await firstPromoterAdapter.listMediaPartners(undefined, CTX);
    expect(partners).toHaveLength(2);
    expect(partners[0]?.name).toBe('Alpha Reviewer');
    expect(partners[0]?.status).toBe('active');
    expect(partners[1]?.name).toBe('beta@example.com');
    expect(partners[1]?.status).toBe('pending');
  });

  it('getEarningsSummary totals commission owed across a wide window', async () => {
    mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);
    const summary = await firstPromoterAdapter.getEarningsSummary(
      { from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' },
      CTX,
    );
    // 50 + 25 + 10 + 7.5
    expect(summary.totalEarnings).toBeCloseTo(92.5, 5);
    expect(summary.byStatus.approved).toBeCloseTo(25, 5);
    expect(summary.byStatus.paid).toBeCloseTo(10, 5);
    expect(summary.byStatus.reversed).toBeCloseTo(7.5, 5);
  });

  it('getProgrammePerformance buckets commissions per promoter per day with 0 clicks', async () => {
    mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);
    const rows = await firstPromoterAdapter.getProgrammePerformance(
      { from: '2000-01-01', to: '2100-01-01' },
      CTX,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.clicks === 0)).toBe(true);
  });

  it('follows the Link header rel="next" through pages', async () => {
    const nextUrl = 'https://api.firstpromoter.com/api/v2/company/promoters?page=2';
    const page1 = fakeResponse([{ id: 5001, email: 'a@x.com', state: 'active' }], { nextUrl });
    const page2 = fakeResponse([{ id: 5002, email: 'b@x.com', state: 'active' }]);
    const { calls } = mockFetchQueue([page1, page2]);
    const partners = await firstPromoterAdapter.listMediaPartners(undefined, CTX);
    expect(partners).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toBe(nextUrl);
  });

  it('returns empty array when there are no commissions', async () => {
    mockFetchQueue([fakeResponse(loadFixture('empty.json'))]);
    const txns = await firstPromoterAdapter.listTransactions(undefined, CTX);
    expect(txns).toEqual([]);
  });

  it('listClicks and generateTrackingLink throw NotImplementedError', async () => {
    await expect(firstPromoterAdapter.listClicks(undefined, CTX)).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(
      firstPromoterAdapter.generateTrackingLink(
        { programmeId: 'x', destinationUrl: 'https://x' },
        CTX,
      ),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

describe('FirstPromoter verifyAuth', () => {
  it('returns ok on a 200 promoters probe', async () => {
    mockFetchQueue([fakeResponse(loadFixture('empty.json'))]);
    const result = await firstPromoterAdapter.verifyAuth();
    expect(result.ok).toBe(true);
  });

  it('returns ok:false on a 401', async () => {
    mockFetchQueue([fakeResponse({ error: 'unauthorised' }, { status: 401 })]);
    const result = await firstPromoterAdapter.verifyAuth();
    expect(result.ok).toBe(false);
  });
});
