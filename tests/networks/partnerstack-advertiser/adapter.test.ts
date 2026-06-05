/**
 * PartnerStack (vendor / advertiser) adapter — unit tests.
 *
 * Exercises status mapping, transformers, request shape (HTTP Basic auth, the
 * `/v2` prefix), the advertiser operations, the requireCtx guard, and verifyAuth.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  partnerstackAdvertiserAdapter,
  _internals,
} from '../../../src/networks/partnerstack-advertiser/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'partnerstack-advertiser');
const CTX = { networkBrandId: 'vendor-acme' };

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
  process.env['PARTNERSTACK_PUBLIC_KEY'] = 'pub-key';
  process.env['PARTNERSTACK_SECRET_KEY'] = 'sec-key';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['PARTNERSTACK_PUBLIC_KEY'];
  delete process.env['PARTNERSTACK_SECRET_KEY'];
});

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

describe('PartnerStack vendor transformers', () => {
  it('maps reward status to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'paid' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ status: 'declined' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'weird' })).toBe('other');
  });

  it('derives a partner display name and status', () => {
    expect(_internals.partnerDisplayName({ name: 'Alpha' })).toBe('Alpha');
    expect(_internals.partnerDisplayName({ first_name: 'Beta', last_name: 'Bloggers' })).toBe(
      'Beta Bloggers',
    );
    expect(_internals.partnerDisplayName({ email: 'x@y.com' })).toBe('x@y.com');
    expect(_internals.partnerStatus({ status: 'active' })).toBe('active');
    expect(_internals.partnerStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.partnerStatus({ status: 'mystery' })).toBe('unknown');
  });

  it('aggregates a performance row with worst-news status and 0 clicks', () => {
    const rows = [
      { status: 'approved', amount: 1500, transaction: { amount: 15000 } },
      { status: 'declined', amount: 500, transaction: { amount: 5000 } },
    ];
    const r = _internals.toPerformanceRow('2026-05-01', 'ptn_1', 'Alpha', rows);
    expect(r.conversions).toBe(2);
    expect(r.commission).toBeCloseTo(20, 5);
    expect(r.grossSale).toBeCloseTo(200, 5);
    expect(r.clicks).toBe(0);
    expect(r.status).toBe('reversed');
  });
});

// ---------------------------------------------------------------------------
// Request shape + ctx guard
// ---------------------------------------------------------------------------

describe('PartnerStack vendor request shape', () => {
  it('listTransactions GETs /v2/rewards with HTTP Basic auth', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('rewards.json'))]);
    await partnerstackAdvertiserAdapter.listTransactions(undefined, CTX);
    expect(calls[0]?.url).toContain('/v2/rewards');
    const expected = `Basic ${Buffer.from('pub-key:sec-key').toString('base64')}`;
    expect(calls[0]?.headers).toMatchObject({ Authorization: expected });
  });

  it('listMediaPartners GETs /v2/partners', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('partners.json'))]);
    await partnerstackAdvertiserAdapter.listMediaPartners(undefined, CTX);
    expect(calls[0]?.url).toContain('/v2/partners');
  });

  it('refuses to run without a brand context', async () => {
    await expect(partnerstackAdvertiserAdapter.listTransactions(undefined)).rejects.toBeInstanceOf(
      NetworkError,
    );
  });
});

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

describe('PartnerStack vendor operations', () => {
  it('listProgrammes synthesises one Programme for the bound vendor', async () => {
    const programmes = await partnerstackAdvertiserAdapter.listProgrammes(undefined, CTX);
    expect(programmes).toHaveLength(1);
    expect(programmes[0]?.id).toBe('vendor-acme');
    expect(programmes[0]?.status).toBe('joined');
  });

  it('listMediaPartners maps partners with normalised status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('partners.json'))]);
    const partners = await partnerstackAdvertiserAdapter.listMediaPartners(undefined, CTX);
    expect(partners).toHaveLength(2);
    expect(partners[0]?.name).toBe('Alpha Affiliates');
    expect(partners[0]?.status).toBe('active');
    expect(partners[1]?.name).toBe('Beta Bloggers');
    expect(partners[1]?.status).toBe('pending');
  });

  it('listTransactions maps vendor rewards', async () => {
    mockFetchQueue([fakeResponse(loadFixture('rewards.json'))]);
    const txns = await partnerstackAdvertiserAdapter.listTransactions(undefined, CTX);
    expect(txns).toHaveLength(3);
    expect(txns[0]?.commission).toBeCloseTo(30, 5);
    expect(txns[0]?.status).toBe('pending');
  });

  it('getEarningsSummary totals commission owed to partners', async () => {
    mockFetchQueue([fakeResponse(loadFixture('rewards.json'))]);
    const summary = await partnerstackAdvertiserAdapter.getEarningsSummary(
      { from: '2000-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' },
      CTX,
    );
    // 30 + 15 + 5
    expect(summary.totalEarnings).toBeCloseTo(50, 5);
    expect(summary.byStatus.reversed).toBeCloseTo(5, 5);
  });

  it('getProgrammePerformance buckets rewards per partner per day', async () => {
    mockFetchQueue([fakeResponse(loadFixture('rewards.json'))]);
    const rows = await partnerstackAdvertiserAdapter.getProgrammePerformance(
      { from: '2000-01-01', to: '2100-01-01' },
      CTX,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.clicks === 0)).toBe(true);
  });

  it('getProgramme / listClicks / generateTrackingLink throw NotImplementedError', async () => {
    await expect(partnerstackAdvertiserAdapter.getProgramme('x', CTX)).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(partnerstackAdvertiserAdapter.listClicks(undefined, CTX)).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(
      partnerstackAdvertiserAdapter.generateTrackingLink(
        { programmeId: 'x', destinationUrl: 'https://x' },
        CTX,
      ),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

describe('PartnerStack vendor verifyAuth', () => {
  it('returns ok on a 200 partnerships probe', async () => {
    mockFetchQueue([fakeResponse({ data: [] })]);
    const result = await partnerstackAdvertiserAdapter.verifyAuth();
    expect(result.ok).toBe(true);
  });
});
