/**
 * LeadDyno adapter — unit tests.
 *
 * Exercises status mapping, transformers, request shape (the `key` query param,
 * the `/v1` prefix), the advertiser operations, the requireCtx guard,
 * NotImplemented ops, and verifyAuth. Mirrors the Rewardful adapter tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { leaddynoAdapter, _internals } from '../../../src/networks/leaddyno/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'leaddyno');
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
  process.env['LEADDYNO_API_KEY'] = 'fake-key';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['LEADDYNO_API_KEY'];
});

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

describe('LeadDyno transformers', () => {
  it('maps purchase cancelled flag to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ cancelled: false })).toBe('approved');
    expect(_internals.mapTransactionStatus({ cancelled: true })).toBe('reversed');
    expect(_internals.mapTransactionStatus({})).toBe('approved');
  });

  it('maps affiliate state and derives a display name', () => {
    expect(_internals.mapAffiliateStatus({ state: 'active' })).toBe('active');
    expect(_internals.mapAffiliateStatus({ state: 'pending' })).toBe('pending');
    expect(_internals.mapAffiliateStatus({ state: 'archived' })).toBe('inactive');
    expect(_internals.mapAffiliateStatus({ archived: true })).toBe('inactive');
    expect(_internals.mapAffiliateStatus({ state: 'mystery' })).toBe('unknown');
    expect(_internals.affiliateName({ first_name: 'Alpha', last_name: 'Reviewer' })).toBe(
      'Alpha Reviewer',
    );
    expect(_internals.affiliateName({ email: 'x@y.com' })).toBe('x@y.com');
  });

  it('reads purchase amounts in major units and preserves raw on Transaction', () => {
    const raw = {
      id: 225,
      cancelled: false,
      purchase_amount: 100.0,
      commission_amount_override: 30.0,
      created_at: '2024-04-01T10:00:00Z',
      affiliate: { id: 101, email: 'alpha@example.com' },
    };
    const t = _internals.toTransaction(raw);
    expect(t.rawNetworkData).toBe(raw);
    expect(t.amount).toBe(100);
    expect(t.commission).toBe(30);
    expect(t.status).toBe('approved');
    expect(t.programmeId).toBe('account');
    expect(t.id).toBe('225');
  });

  it('coerces string and missing amounts safely', () => {
    expect(_internals.toAmount(49.5)).toBe(49.5);
    expect(_internals.toAmount('49.5')).toBe(49.5);
    expect(_internals.toAmount(null)).toBe(0);
    expect(_internals.toAmount(undefined)).toBe(0);
  });

  it('models the single account programme', () => {
    const p = _internals.accountProgramme();
    expect(p.id).toBe('account');
    expect(p.network).toBe('leaddyno');
    expect(p.status).toBe('joined');
  });
});

// ---------------------------------------------------------------------------
// Request shape + ctx guard
// ---------------------------------------------------------------------------

describe('LeadDyno request shape', () => {
  it('listTransactions GETs /v1/purchases with the key query param', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('purchases.json'))]);
    await leaddynoAdapter.listTransactions(undefined, CTX);
    expect(calls[0]?.url).toContain('/v1/purchases');
    expect(calls[0]?.url).toContain('key=fake-key');
    // The key travels in the query string, not an Authorization header.
    expect(calls[0]?.headers).not.toHaveProperty('Authorization');
  });

  it('listMediaPartners GETs /v1/affiliates', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('affiliates.json'))]);
    await leaddynoAdapter.listMediaPartners(undefined, CTX);
    expect(calls[0]?.url).toContain('/v1/affiliates');
  });

  it('passes created_after / created_before through on date-filtered transactions', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('empty.json'))]);
    await leaddynoAdapter.listTransactions(
      { from: '2024-04-01T00:00:00Z', to: '2024-04-30T00:00:00Z' },
      CTX,
    );
    expect(calls[0]?.url).toContain('created_after=');
    expect(calls[0]?.url).toContain('created_before=');
  });

  it('refuses to run without a brand context', async () => {
    await expect(leaddynoAdapter.listTransactions(undefined)).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

describe('LeadDyno operations', () => {
  it('listProgrammes returns the single synthetic programme', async () => {
    const programmes = await leaddynoAdapter.listProgrammes(undefined, CTX);
    expect(programmes).toHaveLength(1);
    expect(programmes[0]?.id).toBe('account');
  });

  it('getProgramme returns the account programme and rejects unknown ids', async () => {
    const programme = await leaddynoAdapter.getProgramme('account', CTX);
    expect(programme.id).toBe('account');
    await expect(leaddynoAdapter.getProgramme('nope', CTX)).rejects.toBeInstanceOf(NetworkError);
  });

  it('listTransactions maps purchases and filters by status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('purchases.json'))]);
    const all = await leaddynoAdapter.listTransactions(undefined, CTX);
    expect(all).toHaveLength(3);
    expect(all.map((t) => t.status).sort()).toEqual(['approved', 'approved', 'reversed']);

    mockFetchQueue([fakeResponse(loadFixture('purchases.json'))]);
    const reversed = await leaddynoAdapter.listTransactions({ status: 'reversed' }, CTX);
    expect(reversed).toHaveLength(1);
    // The verbatim upstream cancelled flag is preserved on rawNetworkData.
    expect((reversed[0]?.rawNetworkData as { cancelled?: boolean }).cancelled).toBe(true);
  });

  it('listMediaPartners maps affiliates with normalised status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('affiliates.json'))]);
    const partners = await leaddynoAdapter.listMediaPartners(undefined, CTX);
    expect(partners).toHaveLength(2);
    expect(partners[0]?.name).toBe('Alpha Reviewer');
    expect(partners[0]?.status).toBe('active');
    expect(partners[1]?.name).toBe('beta@example.com');
    expect(partners[1]?.status).toBe('pending');
  });

  it('getEarningsSummary totals commission across a wide window', async () => {
    mockFetchQueue([fakeResponse(loadFixture('purchases.json'))]);
    const summary = await leaddynoAdapter.getEarningsSummary(
      { from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' },
      CTX,
    );
    // 30 + 15 (approved) + 24 (reversed)
    expect(summary.totalEarnings).toBeCloseTo(69, 5);
    expect(summary.byStatus.approved).toBeCloseTo(45, 5);
    expect(summary.byStatus.reversed).toBeCloseTo(24, 5);
  });

  it('getProgrammePerformance buckets purchases per affiliate per day with 0 clicks', async () => {
    mockFetchQueue([fakeResponse(loadFixture('purchases.json'))]);
    const rows = await leaddynoAdapter.getProgrammePerformance(
      { from: '2000-01-01', to: '2100-01-01' },
      CTX,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.clicks === 0)).toBe(true);
  });

  it('paginates while a full page is returned', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      email: `a${i}@x.com`,
      state: 'active',
    }));
    const lastPage = [{ id: 9999, email: 'last@x.com', state: 'active' }];
    const { calls } = mockFetchQueue([fakeResponse(fullPage), fakeResponse(lastPage)]);
    const partners = await leaddynoAdapter.listMediaPartners(undefined, CTX);
    expect(partners).toHaveLength(101);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain('page=2');
  });

  it('returns empty array when there are no purchases', async () => {
    mockFetchQueue([fakeResponse(loadFixture('empty.json'))]);
    const txns = await leaddynoAdapter.listTransactions(undefined, CTX);
    expect(txns).toEqual([]);
  });

  it('listClicks and generateTrackingLink throw NotImplementedError', async () => {
    await expect(leaddynoAdapter.listClicks(undefined, CTX)).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(
      leaddynoAdapter.generateTrackingLink({ programmeId: 'x', destinationUrl: 'https://x' }, CTX),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

describe('LeadDyno verifyAuth', () => {
  it('returns ok on a 200 affiliates probe', async () => {
    mockFetchQueue([fakeResponse(loadFixture('empty.json'))]);
    const result = await leaddynoAdapter.verifyAuth();
    expect(result.ok).toBe(true);
  });

  it('returns ok:false on a 401', async () => {
    mockFetchQueue([fakeResponse({ error: 'unauthorised' }, { status: 401 })]);
    const result = await leaddynoAdapter.verifyAuth();
    expect(result.ok).toBe(false);
  });
});
