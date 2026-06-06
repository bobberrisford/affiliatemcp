/**
 * Tolt adapter — unit tests.
 *
 * Exercises status mapping, transformers, request shape (Bearer auth, the `/v1`
 * prefix), the advertiser operations, the requireCtx guard, NotImplemented ops,
 * and verifyAuth. No live calls — every fetch is mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { toltAdapter, _internals } from '../../../src/networks/tolt/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'networks', 'tolt', 'fixtures');
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
  process.env['TOLT_API_KEY'] = 'fake-key';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['TOLT_API_KEY'];
});

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

describe('Tolt transformers', () => {
  it('maps commission status to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'approved' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'paid' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ status: 'rejected' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'refunded' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'mystery' })).toBe('other');
  });

  it('maps partner status and derives a display name', () => {
    expect(_internals.mapPartnerStatus({ status: 'active' })).toBe('active');
    expect(_internals.mapPartnerStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapPartnerStatus({ status: 'suspended' })).toBe('inactive');
    expect(_internals.mapPartnerStatus({ status: 'mystery' })).toBe('unknown');
    expect(_internals.partnerName({ first_name: 'Alpha', last_name: 'Reviewer' })).toBe(
      'Alpha Reviewer',
    );
    expect(_internals.partnerName({ email: 'x@y.com' })).toBe('x@y.com');
  });

  it('converts cents to major units and preserves raw on Transaction', () => {
    const raw = {
      id: 'comm_x',
      status: 'approved',
      amount: 4200,
      currency: 'USD',
      created_at: '2024-04-01T10:00:00Z',
      program_id: 'prog_x',
      program: { id: 'prog_x', name: 'Default' },
    };
    const t = _internals.toTransaction(raw);
    expect(t.rawNetworkData).toBe(raw);
    expect(t.commission).toBe(42);
    expect(t.amount).toBe(42);
    expect(t.status).toBe('approved');
    expect(t.programmeId).toBe('prog_x');
  });

  it('builds structured commission rate on a Programme', () => {
    const percent = _internals.toProgramme({ id: 'x', name: 'C', commission_percent: 30, currency: 'USD' });
    expect(percent.commissionRate).toMatchObject({ type: 'percent', value: 30 });
    const flat = _internals.toProgramme({ id: 'y', name: 'D', commission_amount: 2500, currency: 'USD' });
    expect(flat.commissionRate).toMatchObject({ type: 'flat', value: 25, currency: 'USD' });
  });
});

// ---------------------------------------------------------------------------
// Request shape + ctx guard
// ---------------------------------------------------------------------------

describe('Tolt request shape', () => {
  it('listTransactions GETs /v1/commissions with a Bearer token', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);
    await toltAdapter.listTransactions(undefined, CTX);
    expect(calls[0]?.url).toContain('/v1/commissions');
    expect(calls[0]?.headers).toMatchObject({ Authorization: 'Bearer fake-key' });
  });

  it('listMediaPartners GETs /v1/partners', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('partners.json'))]);
    await toltAdapter.listMediaPartners(undefined, CTX);
    expect(calls[0]?.url).toContain('/v1/partners');
  });

  it('refuses to run without a brand context', async () => {
    await expect(toltAdapter.listTransactions(undefined)).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

describe('Tolt operations', () => {
  it('listProgrammes maps programmes to Programme records', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programs.json'))]);
    const programmes = await toltAdapter.listProgrammes(undefined, CTX);
    expect(programmes).toHaveLength(2);
    expect(programmes[0]?.name).toBe('Default Programme');
    expect(programmes[0]?.commissionRate).toMatchObject({ type: 'percent', value: 30 });
  });

  it('getProgramme fetches a single programme by id', async () => {
    const { calls } = mockFetchQueue([
      fakeResponse({ id: 'prog_1111111111111111111111111', name: 'Default Programme', currency: 'USD' }),
    ]);
    const programme = await toltAdapter.getProgramme('prog_1111111111111111111111111', CTX);
    expect(programme.name).toBe('Default Programme');
    expect(calls[0]?.url).toContain('/v1/programs/prog_1111111111111111111111111');
  });

  it('listTransactions maps commissions and filters by status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);
    const all = await toltAdapter.listTransactions(undefined, CTX);
    expect(all).toHaveLength(4);
    expect(all.map((t) => t.status).sort()).toEqual(['approved', 'paid', 'pending', 'reversed'].sort());

    mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);
    const reversed = await toltAdapter.listTransactions({ status: 'reversed' }, CTX);
    expect(reversed).toHaveLength(1);
    // The verbatim upstream status is preserved on rawNetworkData.
    expect((reversed[0]?.rawNetworkData as { status?: string }).status).toBe('rejected');
  });

  it('listMediaPartners maps partners with normalised status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('partners.json'))]);
    const partners = await toltAdapter.listMediaPartners(undefined, CTX);
    expect(partners).toHaveLength(2);
    expect(partners[0]?.name).toBe('Alpha Reviewer');
    expect(partners[0]?.status).toBe('active');
    expect(partners[1]?.name).toBe('beta@example.com');
    expect(partners[1]?.status).toBe('pending');
  });

  it('getEarningsSummary totals commission owed across a wide window', async () => {
    mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);
    const summary = await toltAdapter.getEarningsSummary(
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

  it('getProgrammePerformance buckets commissions per partner per day with 0 clicks', async () => {
    mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);
    const rows = await toltAdapter.getProgrammePerformance(
      { from: '2000-01-01', to: '2100-01-01' },
      CTX,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.clicks === 0)).toBe(true);
  });

  it('paginates while has_more is true', async () => {
    const page1 = {
      success: true,
      has_more: true,
      data: [{ id: 'part_a1', email: 'a@x.com', status: 'active' }],
    };
    const page2 = {
      success: true,
      has_more: false,
      data: [{ id: 'part_a2', email: 'b@x.com', status: 'active' }],
    };
    const { calls } = mockFetchQueue([fakeResponse(page1), fakeResponse(page2)]);
    const partners = await toltAdapter.listMediaPartners(undefined, CTX);
    expect(partners).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain('starting_after=part_a1');
  });

  it('returns empty array when there are no commissions', async () => {
    mockFetchQueue([fakeResponse(loadFixture('empty.json'))]);
    const txns = await toltAdapter.listTransactions(undefined, CTX);
    expect(txns).toEqual([]);
  });

  it('listClicks and generateTrackingLink throw NotImplementedError', async () => {
    await expect(toltAdapter.listClicks(undefined, CTX)).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(
      toltAdapter.generateTrackingLink({ programmeId: 'x', destinationUrl: 'https://x' }, CTX),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

describe('Tolt verifyAuth', () => {
  it('returns ok on a 200 partners probe', async () => {
    mockFetchQueue([fakeResponse(loadFixture('empty.json'))]);
    const result = await toltAdapter.verifyAuth();
    expect(result.ok).toBe(true);
  });

  it('returns ok:false on a 401', async () => {
    mockFetchQueue([fakeResponse({ error: 'unauthorised' }, { status: 401 })]);
    const result = await toltAdapter.verifyAuth();
    expect(result.ok).toBe(false);
  });
});
