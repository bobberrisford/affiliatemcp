/**
 * Rewardful adapter — unit tests.
 *
 * Exercises status mapping, transformers, request shape (HTTP Basic with the
 * secret as username, the `/v1` prefix), the advertiser operations, the
 * requireCtx guard, NotImplemented ops, and verifyAuth.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { rewardfulAdapter, _internals } from '../../../src/networks/rewardful/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'rewardful');
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
  process.env['REWARDFUL_API_SECRET'] = 'fake-secret';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['REWARDFUL_API_SECRET'];
});

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

describe('Rewardful transformers', () => {
  it('maps commission state to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ state: 'pending' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ state: 'due' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ state: 'paid' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ state: 'void' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ state: 'mystery' })).toBe('other');
  });

  it('maps affiliate state and derives a display name', () => {
    expect(_internals.mapAffiliateStatus({ state: 'active' })).toBe('active');
    expect(_internals.mapAffiliateStatus({ state: 'pending' })).toBe('pending');
    expect(_internals.mapAffiliateStatus({ state: 'mystery' })).toBe('unknown');
    expect(_internals.affiliateName({ first_name: 'Alpha', last_name: 'Reviewer' })).toBe(
      'Alpha Reviewer',
    );
    expect(_internals.affiliateName({ email: 'x@y.com' })).toBe('x@y.com');
  });

  it('converts cents to major units and preserves raw on Transaction', () => {
    const raw = {
      id: 'c1',
      state: 'due',
      amount: 4200,
      currency: 'USD',
      created_at: '2024-04-01T10:00:00Z',
      campaign: { id: 'camp1', name: 'Default' },
      sale: { sale_amount_cents: 42000, charged_at: '2024-04-01T09:00:00Z', currency: 'USD' },
    };
    const t = _internals.toTransaction(raw);
    expect(t.rawNetworkData).toBe(raw);
    expect(t.commission).toBe(42);
    expect(t.amount).toBe(420);
    expect(t.status).toBe('approved');
    expect(t.programmeId).toBe('camp1');
  });

  it('builds structured commission rate on a Programme', () => {
    const percent = _internals.toProgramme({ id: 'x', name: 'C', commission_percent: 30, currency: 'USD' });
    expect(percent.commissionRate).toMatchObject({ type: 'percent', value: 30 });
    const flat = _internals.toProgramme({ id: 'y', name: 'D', commission_amount_cents: 2500, currency: 'USD' });
    expect(flat.commissionRate).toMatchObject({ type: 'flat', value: 25, currency: 'USD' });
  });
});

// ---------------------------------------------------------------------------
// Request shape + ctx guard
// ---------------------------------------------------------------------------

describe('Rewardful request shape', () => {
  it('listTransactions GETs /v1/commissions with HTTP Basic (secret as username)', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);
    await rewardfulAdapter.listTransactions(undefined, CTX);
    expect(calls[0]?.url).toContain('/v1/commissions');
    const expected = `Basic ${Buffer.from('fake-secret:').toString('base64')}`;
    expect(calls[0]?.headers).toMatchObject({ Authorization: expected });
  });

  it('listMediaPartners GETs /v1/affiliates', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('affiliates.json'))]);
    await rewardfulAdapter.listMediaPartners(undefined, CTX);
    expect(calls[0]?.url).toContain('/v1/affiliates');
  });

  it('refuses to run without a brand context', async () => {
    await expect(rewardfulAdapter.listTransactions(undefined)).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

describe('Rewardful operations', () => {
  it('listProgrammes maps campaigns to Programme records', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const programmes = await rewardfulAdapter.listProgrammes(undefined, CTX);
    expect(programmes).toHaveLength(2);
    expect(programmes[0]?.name).toBe('Default Campaign');
    expect(programmes[0]?.commissionRate).toMatchObject({ type: 'percent', value: 30 });
  });

  it('getProgramme fetches a single campaign by id', async () => {
    const { calls } = mockFetchQueue([
      fakeResponse({ id: '11111111-1111-4111-8111-111111111111', name: 'Default Campaign', currency: 'USD' }),
    ]);
    const programme = await rewardfulAdapter.getProgramme('11111111-1111-4111-8111-111111111111', CTX);
    expect(programme.name).toBe('Default Campaign');
    expect(calls[0]?.url).toContain('/v1/campaigns/11111111-1111-4111-8111-111111111111');
  });

  it('listTransactions maps commissions and filters by status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);
    const all = await rewardfulAdapter.listTransactions(undefined, CTX);
    expect(all).toHaveLength(4);
    expect(all.map((t) => t.status).sort()).toEqual(['approved', 'paid', 'pending', 'reversed'].sort());

    mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);
    const reversed = await rewardfulAdapter.listTransactions({ status: 'reversed' }, CTX);
    expect(reversed).toHaveLength(1);
    // The verbatim upstream state is preserved on rawNetworkData.
    expect((reversed[0]?.rawNetworkData as { state?: string }).state).toBe('void');
  });

  it('listMediaPartners maps affiliates with normalised status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('affiliates.json'))]);
    const partners = await rewardfulAdapter.listMediaPartners(undefined, CTX);
    expect(partners).toHaveLength(2);
    expect(partners[0]?.name).toBe('Alpha Reviewer');
    expect(partners[0]?.status).toBe('active');
    expect(partners[1]?.name).toBe('beta@example.com');
    expect(partners[1]?.status).toBe('pending');
  });

  it('getEarningsSummary totals commission owed across a wide window', async () => {
    mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);
    const summary = await rewardfulAdapter.getEarningsSummary(
      { from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' },
      CTX,
    );
    // 50 + 25 + 10 + 7.5
    expect(summary.totalEarnings).toBeCloseTo(92.5, 5);
    expect(summary.byStatus.approved).toBeCloseTo(25, 5);
    expect(summary.byStatus.paid).toBeCloseTo(10, 5);
    expect(summary.byStatus.reversed).toBeCloseTo(7.5, 5);
  });

  it('getProgrammePerformance buckets commissions per affiliate per day with 0 clicks', async () => {
    mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);
    const rows = await rewardfulAdapter.getProgrammePerformance(
      { from: '2000-01-01', to: '2100-01-01' },
      CTX,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.clicks === 0)).toBe(true);
  });

  it('paginates while next_page is set', async () => {
    const page1 = {
      pagination: { current_page: 1, next_page: 2 },
      data: [{ id: 'a1', email: 'a@x.com', state: 'active' }],
    };
    const page2 = {
      pagination: { current_page: 2, next_page: null },
      data: [{ id: 'a2', email: 'b@x.com', state: 'active' }],
    };
    const { calls } = mockFetchQueue([fakeResponse(page1), fakeResponse(page2)]);
    const partners = await rewardfulAdapter.listMediaPartners(undefined, CTX);
    expect(partners).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain('page=2');
  });

  it('returns empty array when there are no commissions', async () => {
    mockFetchQueue([fakeResponse(loadFixture('empty.json'))]);
    const txns = await rewardfulAdapter.listTransactions(undefined, CTX);
    expect(txns).toEqual([]);
  });

  it('listClicks and generateTrackingLink throw NotImplementedError', async () => {
    await expect(rewardfulAdapter.listClicks(undefined, CTX)).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(
      rewardfulAdapter.generateTrackingLink({ programmeId: 'x', destinationUrl: 'https://x' }, CTX),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

describe('Rewardful verifyAuth', () => {
  it('returns ok on a 200 campaigns probe', async () => {
    mockFetchQueue([fakeResponse(loadFixture('empty.json'))]);
    const result = await rewardfulAdapter.verifyAuth();
    expect(result.ok).toBe(true);
  });

  it('returns ok:false on a 401', async () => {
    mockFetchQueue([fakeResponse({ error: 'unauthorised' }, { status: 401 })]);
    const result = await rewardfulAdapter.verifyAuth();
    expect(result.ok).toBe(false);
  });
});
