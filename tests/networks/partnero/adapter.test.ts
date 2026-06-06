/**
 * Partnero adapter — unit tests.
 *
 * Exercises status mapping, transformers, request shape (Bearer auth, the `/v1`
 * prefix), the advertiser operations, the requireCtx guard, NotImplemented ops,
 * and verifyAuth. Mirrors `tests/networks/rewardful/adapter.test.ts`. No live
 * calls — fixtures are derived from the documented response shapes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { partneroAdapter, _internals } from '../../../src/networks/partnero/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
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
  process.env['PARTNERO_API_KEY'] = 'fake-token';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['PARTNERO_API_KEY'];
});

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

describe('Partnero transformers', () => {
  it('maps reward / transaction status to canonical TransactionStatus', () => {
    expect(_internals.mapStatusString('pending')).toBe('pending');
    expect(_internals.mapStatusString('in_review')).toBe('pending');
    expect(_internals.mapStatusString('approved')).toBe('approved');
    expect(_internals.mapStatusString('ok')).toBe('approved');
    expect(_internals.mapStatusString('paid')).toBe('paid');
    expect(_internals.mapStatusString('rejected')).toBe('reversed');
    expect(_internals.mapStatusString('revoked')).toBe('reversed');
    expect(_internals.mapStatusString('mystery')).toBe('other');
  });

  it('reads transaction status from the primary reward when present', () => {
    expect(
      _internals.mapTransactionStatus({ status: 'pending', rewards: [{ status: 'approved' }] }),
    ).toBe('approved');
    // Falls back to the transaction status when there is no reward.
    expect(_internals.mapTransactionStatus({ status: 'paid', rewards: [] })).toBe('paid');
  });

  it('maps partner status and derives a display name', () => {
    expect(_internals.mapPartnerStatus({ status: 'active' })).toBe('active');
    expect(_internals.mapPartnerStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapPartnerStatus({ deleted: true })).toBe('inactive');
    expect(_internals.mapPartnerStatus({ status: 'mystery' })).toBe('unknown');
    expect(_internals.partnerName({ name: 'Alpha Reviewer' })).toBe('Alpha Reviewer');
    expect(_internals.partnerName({ name: '', email: 'x@y.com' })).toBe('x@y.com');
  });

  it('treats amounts as major units and reads commission from rewards', () => {
    const raw = {
      key: 'txn_x',
      amount: 100.0,
      amount_units: 'USD',
      created_at: '2024-04-01T10:00:00Z',
      partner: { key: 'p1', name: 'P One' },
      rewards: [{ status: 'approved', amount: 25.0, amount_units: 'USD' }],
    };
    const t = _internals.toTransaction(raw, 'acme');
    expect(t.rawNetworkData).toBe(raw);
    expect(t.amount).toBe(100);
    expect(t.commission).toBe(25);
    expect(t.status).toBe('approved');
    expect(t.programmeId).toBe('acme');
    expect(t.currency).toBe('USD');
  });

  it('sums commission across multiple rewards', () => {
    expect(
      _internals.rewardTotal({ rewards: [{ amount: 5 }, { amount: 7.5 }, { amount: 2.5 }] }),
    ).toBe(15);
    expect(_internals.rewardTotal({})).toBe(0);
  });

  it('synthesises a single programme from the brand context', () => {
    const p = _internals.toProgramme('acme');
    expect(p.id).toBe('acme');
    expect(p.status).toBe('joined');
    expect((p.rawNetworkData as { synthetic?: boolean }).synthetic).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Request shape + ctx guard
// ---------------------------------------------------------------------------

describe('Partnero request shape', () => {
  it('listTransactions GETs /v1/transactions with a Bearer token', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    await partneroAdapter.listTransactions(undefined, CTX);
    expect(calls[0]?.url).toContain('/v1/transactions');
    expect(calls[0]?.headers).toMatchObject({ Authorization: 'Bearer fake-token' });
  });

  it('listMediaPartners GETs /v1/partners', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('partners.json'))]);
    await partneroAdapter.listMediaPartners(undefined, CTX);
    expect(calls[0]?.url).toContain('/v1/partners');
  });

  it('refuses to run without a brand context', async () => {
    await expect(partneroAdapter.listTransactions(undefined)).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

describe('Partnero operations', () => {
  it('listProgrammes returns the single synthetic programme', async () => {
    const programmes = await partneroAdapter.listProgrammes(undefined, CTX);
    expect(programmes).toHaveLength(1);
    expect(programmes[0]?.id).toBe('acme');
    expect(programmes[0]?.status).toBe('joined');
  });

  it('getProgramme returns the programme for the bound brand and rejects others', async () => {
    const programme = await partneroAdapter.getProgramme('acme', CTX);
    expect(programme.id).toBe('acme');
    await expect(partneroAdapter.getProgramme('other', CTX)).rejects.toBeInstanceOf(NetworkError);
  });

  it('listTransactions maps transactions and filters by status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const all = await partneroAdapter.listTransactions(undefined, CTX);
    expect(all).toHaveLength(4);
    expect(all.map((t) => t.status).sort()).toEqual(
      ['approved', 'paid', 'pending', 'reversed'].sort(),
    );

    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const reversed = await partneroAdapter.listTransactions({ status: 'reversed' }, CTX);
    expect(reversed).toHaveLength(1);
    // The verbatim upstream payload is preserved on rawNetworkData.
    expect((reversed[0]?.rawNetworkData as { key?: string }).key).toBe('txn_0004');
  });

  it('listMediaPartners maps partners with normalised status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('partners.json'))]);
    const partners = await partneroAdapter.listMediaPartners(undefined, CTX);
    expect(partners).toHaveLength(2);
    expect(partners[0]?.name).toBe('Alpha Reviewer');
    expect(partners[0]?.status).toBe('active');
    expect(partners[1]?.name).toBe('beta@example.com');
    expect(partners[1]?.status).toBe('pending');
  });

  it('getEarningsSummary totals commission across a wide window', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const summary = await partneroAdapter.getEarningsSummary(
      { from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' },
      CTX,
    );
    // 10 + 25 + 8 + 6
    expect(summary.totalEarnings).toBeCloseTo(49, 5);
    expect(summary.byStatus.pending).toBeCloseTo(10, 5);
    expect(summary.byStatus.approved).toBeCloseTo(25, 5);
    expect(summary.byStatus.paid).toBeCloseTo(8, 5);
    expect(summary.byStatus.reversed).toBeCloseTo(6, 5);
  });

  it('getProgrammePerformance buckets transactions per partner per day with 0 clicks', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const rows = await partneroAdapter.getProgrammePerformance(
      { from: '2000-01-01', to: '2100-01-01' },
      CTX,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.clicks === 0)).toBe(true);
  });

  it('paginates while last_page reports more pages', async () => {
    const page1 = {
      data: [{ key: 'p1', email: 'a@x.com', status: 'active' }],
      current_page: 1,
      last_page: 2,
      per_page: 100,
    };
    const page2 = {
      data: [{ key: 'p2', email: 'b@x.com', status: 'active' }],
      current_page: 2,
      last_page: 2,
      per_page: 100,
    };
    const { calls } = mockFetchQueue([fakeResponse(page1), fakeResponse(page2)]);
    const partners = await partneroAdapter.listMediaPartners(undefined, CTX);
    expect(partners).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain('page=2');
  });

  it('returns empty array when there are no transactions', async () => {
    mockFetchQueue([fakeResponse(loadFixture('empty.json'))]);
    const txns = await partneroAdapter.listTransactions(undefined, CTX);
    expect(txns).toEqual([]);
  });

  it('listClicks and generateTrackingLink throw NotImplementedError', async () => {
    await expect(partneroAdapter.listClicks(undefined, CTX)).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(
      partneroAdapter.generateTrackingLink({ programmeId: 'x', destinationUrl: 'https://x' }, CTX),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

describe('Partnero verifyAuth', () => {
  it('returns ok on a 200 partners probe', async () => {
    mockFetchQueue([fakeResponse(loadFixture('empty.json'))]);
    const result = await partneroAdapter.verifyAuth();
    expect(result.ok).toBe(true);
  });

  it('returns ok:false on a 401', async () => {
    mockFetchQueue([fakeResponse({ error: 'unauthorised' }, { status: 401 })]);
    const result = await partneroAdapter.verifyAuth();
    expect(result.ok).toBe(false);
  });
});
