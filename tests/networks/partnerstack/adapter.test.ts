/**
 * PartnerStack (partner) adapter — unit tests.
 *
 * Exercises status mapping, transformers, request shape (Bearer auth, the
 * `/api/v2` prefix), the seven operations, NotImplemented ops, and verifyAuth.
 * Network I/O is mocked via a fetch queue + scrubbed fixtures.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { partnerstackAdapter, _internals } from '../../../src/networks/partnerstack/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'partnerstack');

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
  process.env['PARTNERSTACK_API_KEY'] = 'fake-key';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['PARTNERSTACK_API_KEY'];
});

// ---------------------------------------------------------------------------
// Transformers and helpers
// ---------------------------------------------------------------------------

describe('PartnerStack transformers', () => {
  it('maps reward status to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'approved' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'actioned' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'paid' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ status: 'declined' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'voided' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'something-new' })).toBe('other');
  });

  it('maps partnership status to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ status: 'active' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ status: 'declined' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ status: 'paused' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'mystery' })).toBe('unknown');
  });

  it('converts minor units to major and preserves raw on Transaction', () => {
    const raw = {
      key: 'rwd_x',
      status: 'approved',
      amount: 4200,
      currency: 'GBP',
      created_at: 1714000000000,
      group: { name: 'Acme', slug: 'acme' },
    };
    const t = _internals.toTransaction(raw);
    expect(t.rawNetworkData).toBe(raw);
    expect(t.commission).toBe(42);
    expect(t.currency).toBe('GBP');
    expect(t.status).toBe('approved');
    expect(t.programmeId).toBe('acme');
    expect(t.ageDays).toBeGreaterThanOrEqual(0);
  });

  it('extractList tolerates array, items, and envelope shapes', () => {
    expect(_internals.extractList([1, 2])).toEqual([1, 2]);
    expect(_internals.extractList({ items: [1] })).toEqual([1]);
    expect(_internals.unwrapData({ data: { items: [1] } })).toEqual({ items: [1] });
    expect(_internals.hasMore({ has_more: true })).toBe(true);
    expect(_internals.hasMore({ has_more: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

describe('PartnerStack request shape', () => {
  it('listProgrammes GETs /api/v2/partnerships with a Bearer token', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('partnerships.json'))]);
    await partnerstackAdapter.listProgrammes({ limit: 10 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/api/v2/partnerships');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers).toMatchObject({ Authorization: 'Bearer fake-key' });
  });

  it('listTransactions GETs /api/v2/rewards', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('rewards.json'))]);
    await partnerstackAdapter.listTransactions({ limit: 10 });
    expect(calls[0]?.url).toContain('/api/v2/rewards');
  });
});

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

describe('PartnerStack operations', () => {
  it('listProgrammes maps partnerships to Programme records', async () => {
    mockFetchQueue([fakeResponse(loadFixture('partnerships.json'))]);
    const programmes = await partnerstackAdapter.listProgrammes();
    expect(programmes).toHaveLength(2);
    expect(programmes[0]?.name).toBe('Acme SaaS');
    expect(programmes[0]?.status).toBe('joined');
    expect(programmes[1]?.status).toBe('pending');
  });

  it('listProgrammes applies the search filter client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('partnerships.json'))]);
    const programmes = await partnerstackAdapter.listProgrammes({ search: 'beta' });
    expect(programmes).toHaveLength(1);
    expect(programmes[0]?.name).toBe('Beta Tools');
  });

  it('listTransactions maps rewards and filters by status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('rewards.json'))]);
    const all = await partnerstackAdapter.listTransactions();
    expect(all).toHaveLength(4);
    expect(all.map((t) => t.status).sort()).toEqual(['approved', 'paid', 'pending', 'reversed']);

    mockFetchQueue([fakeResponse(loadFixture('rewards.json'))]);
    const reversed = await partnerstackAdapter.listTransactions({ status: 'reversed' });
    expect(reversed).toHaveLength(1);
    // The verbatim upstream status is preserved on rawNetworkData.
    expect((reversed[0]?.rawNetworkData as { status?: string }).status).toBe('declined');
  });

  it('getEarningsSummary aggregates commission by status and programme', async () => {
    mockFetchQueue([fakeResponse(loadFixture('rewards.json'))]);
    // Explicit wide window so the test is independent of the wall clock (the
    // default window is the last 30 days).
    const summary = await partnerstackAdapter.getEarningsSummary({
      from: '2000-01-01T00:00:00Z',
      to: '2100-01-01T00:00:00Z',
    });
    // 50 + 25 + 10 + 7.5
    expect(summary.totalEarnings).toBeCloseTo(92.5, 5);
    expect(summary.byStatus.pending).toBeCloseTo(50, 5);
    expect(summary.byStatus.approved).toBeCloseTo(25, 5);
    expect(summary.byStatus.paid).toBeCloseTo(10, 5);
    expect(summary.byStatus.reversed).toBeCloseTo(7.5, 5);
    expect(summary.byProgramme.length).toBe(2);
  });

  it('paginates with starting_after when has_more is set', async () => {
    const page1 = {
      data: { items: [{ key: 'rwd_1', status: 'pending', amount: 100, created_at: 1714000000000 }], has_more: true },
    };
    const page2 = {
      data: { items: [{ key: 'rwd_2', status: 'paid', amount: 200, created_at: 1714100000000 }], has_more: false },
    };
    const { calls } = mockFetchQueue([fakeResponse(page1), fakeResponse(page2)]);
    const txns = await partnerstackAdapter.listTransactions();
    expect(txns).toHaveLength(2);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.url).toContain('starting_after=rwd_1');
  });

  it('returns empty array when the partner has no rewards', async () => {
    mockFetchQueue([fakeResponse(loadFixture('empty.json'))]);
    const txns = await partnerstackAdapter.listTransactions();
    expect(txns).toEqual([]);
  });

  it('listClicks throws NotImplementedError', async () => {
    await expect(partnerstackAdapter.listClicks()).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('generateTrackingLink throws NotImplementedError', async () => {
    await expect(
      partnerstackAdapter.generateTrackingLink({ programmeId: 'acme', destinationUrl: 'https://x' }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('getProgramme throws a config_error for an unknown id', async () => {
    mockFetchQueue([fakeResponse(loadFixture('partnerships.json'))]);
    await expect(partnerstackAdapter.getProgramme('does-not-exist')).rejects.toBeInstanceOf(
      NetworkError,
    );
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('PartnerStack verifyAuth', () => {
  it('returns ok on a 200 partnerships probe', async () => {
    mockFetchQueue([fakeResponse(loadFixture('partnerships.json'))]);
    const result = await partnerstackAdapter.verifyAuth();
    expect(result.ok).toBe(true);
  });

  it('returns ok:false on a 401', async () => {
    mockFetchQueue([fakeResponse({ message: 'unauthorised' }, { status: 401 })]);
    const result = await partnerstackAdapter.verifyAuth();
    expect(result.ok).toBe(false);
  });
});
