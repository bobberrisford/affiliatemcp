/**
 * Post Affiliate Pro adapter — unit tests.
 *
 * Exercises status mapping, transformers, request shape (Bearer API key, the
 * per-tenant base URL from POST_AFFILIATE_PRO_BASE_URL), the advertiser
 * operations, the requireCtx guard, NotImplemented ops, and verifyAuth. No live
 * calls — fetch is mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { postAffiliateProAdapter, _internals } from '../../../src/networks/post-affiliate-pro/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'networks', 'post-affiliate-pro', 'fixtures');
const CTX = { networkBrandId: 'acme' };
const BASE_URL = 'https://acme.postaffiliatepro.com/api/v3';

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
  process.env['POST_AFFILIATE_PRO_BASE_URL'] = BASE_URL;
  process.env['POST_AFFILIATE_PRO_API_KEY'] = 'fake-key';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['POST_AFFILIATE_PRO_BASE_URL'];
  delete process.env['POST_AFFILIATE_PRO_API_KEY'];
});

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

describe('Post Affiliate Pro transformers', () => {
  it('maps transaction rstatus + refund type to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ rstatus: 'P' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ rstatus: 'A' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ rstatus: 'D' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ rstatus: 'A', type: 'R' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ rstatus: 'A', type: 'H' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ rstatus: 'Z' })).toBe('other');
  });

  it('maps affiliate status and derives a display name', () => {
    expect(_internals.mapAffiliateStatus({ rstatus: 'A' })).toBe('active');
    expect(_internals.mapAffiliateStatus({ rstatus: 'P' })).toBe('pending');
    expect(_internals.mapAffiliateStatus({ rstatus: 'Z' })).toBe('unknown');
    expect(_internals.affiliateName({ firstname: 'Alpha', surname: 'Reviewer' })).toBe(
      'Alpha Reviewer',
    );
    expect(_internals.affiliateName({ username: 'beta' })).toBe('beta');
    expect(_internals.affiliateName({ email: 'x@y.com' })).toBe('x@y.com');
  });

  it('treats amounts as major units and preserves raw on Transaction', () => {
    const raw = {
      id: 'txn-2',
      type: 'S',
      rstatus: 'A',
      totalCost: 250,
      commission: 25,
      currencyId: 'USD',
      dateInserted: '2024-04-02 11:00:00',
      campaignId: 'camp-1',
      campaignName: 'Default Campaign',
    };
    const t = _internals.toTransaction(raw);
    expect(t.rawNetworkData).toBe(raw);
    expect(t.commission).toBe(25);
    expect(t.amount).toBe(250);
    expect(t.status).toBe('approved');
    expect(t.programmeId).toBe('camp-1');
  });

  it('builds a flat commission rate on a Programme', () => {
    const flat = _internals.toProgramme({ id: 'y', name: 'D', commission: 25, currencyId: 'USD' });
    expect(flat.commissionRate).toMatchObject({ type: 'flat', value: 25, currency: 'USD' });
    const none = _internals.toProgramme({ id: 'z', name: 'E', currencyId: 'USD' });
    expect(none.commissionRate).toBeUndefined();
  });

  it('normalises `YYYY-MM-DD HH:MM:SS` timestamps to ISO', () => {
    expect(_internals.isoOrUndefined('2024-04-02 11:00:00')).toBe(
      new Date('2024-04-02T11:00:00').toISOString(),
    );
    expect(_internals.isoOrUndefined(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Request shape + ctx guard
// ---------------------------------------------------------------------------

describe('Post Affiliate Pro request shape', () => {
  it('listTransactions GETs /api/v3/transactions on the tenant host with Bearer auth', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    await postAffiliateProAdapter.listTransactions(undefined, CTX);
    expect(calls[0]?.url).toContain('acme.postaffiliatepro.com/api/v3/transactions');
    expect(calls[0]?.headers).toMatchObject({ Authorization: 'Bearer fake-key' });
  });

  it('listMediaPartners GETs /api/v3/affiliates', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('affiliates.json'))]);
    await postAffiliateProAdapter.listMediaPartners(undefined, CTX);
    expect(calls[0]?.url).toContain('/api/v3/affiliates');
  });

  it('refuses to run without a brand context', async () => {
    await expect(postAffiliateProAdapter.listTransactions(undefined)).rejects.toBeInstanceOf(
      NetworkError,
    );
  });

  it('surfaces a config_error when the base URL is invalid', async () => {
    process.env['POST_AFFILIATE_PRO_BASE_URL'] = 'not-a-url';
    await expect(postAffiliateProAdapter.listTransactions(undefined, CTX)).rejects.toBeInstanceOf(
      NetworkError,
    );
  });
});

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

describe('Post Affiliate Pro operations', () => {
  it('listProgrammes maps campaigns to Programme records', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const programmes = await postAffiliateProAdapter.listProgrammes(undefined, CTX);
    expect(programmes).toHaveLength(2);
    expect(programmes[0]?.name).toBe('Default Campaign');
    expect(programmes[0]?.commissionRate).toMatchObject({ type: 'flat', value: 25 });
  });

  it('listProgrammes synthesises a single programme when the account has none', async () => {
    mockFetchQueue([fakeResponse(loadFixture('empty.json'))]);
    const programmes = await postAffiliateProAdapter.listProgrammes(undefined, CTX);
    expect(programmes).toHaveLength(1);
    expect(programmes[0]?.id).toBe('acme');
    expect(programmes[0]?.status).toBe('joined');
  });

  it('getProgramme fetches a single campaign by id', async () => {
    const { calls } = mockFetchQueue([
      fakeResponse({ id: 'camp-1', name: 'Default Campaign', currencyId: 'USD' }),
    ]);
    const programme = await postAffiliateProAdapter.getProgramme('camp-1', CTX);
    expect(programme.name).toBe('Default Campaign');
    expect(calls[0]?.url).toContain('/api/v3/campaigns/camp-1');
  });

  it('listTransactions maps transactions and filters by status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const all = await postAffiliateProAdapter.listTransactions(undefined, CTX);
    expect(all).toHaveLength(4);
    expect(all.map((t) => t.status).sort()).toEqual(
      ['approved', 'approved', 'pending', 'reversed'].sort(),
    );

    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const reversed = await postAffiliateProAdapter.listTransactions({ status: 'reversed' }, CTX);
    expect(reversed).toHaveLength(1);
    // The verbatim upstream payload is preserved on rawNetworkData.
    expect((reversed[0]?.rawNetworkData as { type?: string }).type).toBe('R');
  });

  it('listMediaPartners maps affiliates with normalised status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('affiliates.json'))]);
    const partners = await postAffiliateProAdapter.listMediaPartners(undefined, CTX);
    expect(partners).toHaveLength(2);
    expect(partners[0]?.name).toBe('Alpha Reviewer');
    expect(partners[0]?.status).toBe('active');
    expect(partners[1]?.status).toBe('pending');
  });

  it('getEarningsSummary totals commission owed across a wide window', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const summary = await postAffiliateProAdapter.getEarningsSummary(
      { from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' },
      CTX,
    );
    // 50 + 25 + 10 + 7.5
    expect(summary.totalEarnings).toBeCloseTo(92.5, 5);
    expect(summary.byStatus.pending).toBeCloseTo(50, 5);
    expect(summary.byStatus.approved).toBeCloseTo(35, 5);
    expect(summary.byStatus.reversed).toBeCloseTo(7.5, 5);
  });

  it('getProgrammePerformance buckets transactions per affiliate per day with 0 clicks', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const rows = await postAffiliateProAdapter.getProgrammePerformance(
      { from: '2000-01-01', to: '2100-01-01' },
      CTX,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.clicks === 0)).toBe(true);
  });

  it('paginates while a full page comes back', async () => {
    const fullPage = {
      data: Array.from({ length: 100 }, (_, i) => ({ id: `aff-${i}`, username: `u${i}`, rstatus: 'A' })),
    };
    const lastPage = { data: [{ id: 'aff-last', username: 'last', rstatus: 'A' }] };
    const { calls } = mockFetchQueue([fakeResponse(fullPage), fakeResponse(lastPage)]);
    const partners = await postAffiliateProAdapter.listMediaPartners(undefined, CTX);
    expect(partners).toHaveLength(101);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain('offset=100');
  });

  it('returns empty array when there are no transactions', async () => {
    mockFetchQueue([fakeResponse(loadFixture('empty.json'))]);
    const txns = await postAffiliateProAdapter.listTransactions(undefined, CTX);
    expect(txns).toEqual([]);
  });

  it('listClicks and generateTrackingLink throw NotImplementedError', async () => {
    await expect(postAffiliateProAdapter.listClicks(undefined, CTX)).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(
      postAffiliateProAdapter.generateTrackingLink({ programmeId: 'x', destinationUrl: 'https://x' }, CTX),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

describe('Post Affiliate Pro verifyAuth', () => {
  it('returns ok on a 200 affiliates probe', async () => {
    mockFetchQueue([fakeResponse(loadFixture('empty.json'))]);
    const result = await postAffiliateProAdapter.verifyAuth();
    expect(result.ok).toBe(true);
  });

  it('returns ok:false on a 401', async () => {
    mockFetchQueue([fakeResponse({ error: 'unauthorised' }, { status: 401 })]);
    const result = await postAffiliateProAdapter.verifyAuth();
    expect(result.ok).toBe(false);
  });
});
