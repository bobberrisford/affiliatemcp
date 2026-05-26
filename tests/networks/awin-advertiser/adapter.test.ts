/**
 * Awin advertiser adapter — unit tests.
 *
 * Exercises every implemented operation, asserts the `/advertisers/{id}/...`
 * URL shape, status mapping (especially Awin `declined` → canonical
 * `reversed`), the per-publisher report round-trip, and that operations
 * refuse to run without a brand context.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  awinAdvertiserAdapter,
  _internals,
} from '../../../src/networks/awin-advertiser/adapter.js';
import { _resetRateLimiter } from '../../../src/networks/awin-advertiser/client.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'awin-advertiser');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/json' },
  });
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
  _resetRateLimiter();
  process.env['AWIN_ADVERTISER_API_TOKEN'] = 'fake-token';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['AWIN_ADVERTISER_API_TOKEN'];
  _resetRateLimiter();
});

// ---------------------------------------------------------------------------
// Transformers and status mapping
// ---------------------------------------------------------------------------

describe('Awin advertiser transformers', () => {
  it('maps Awin commissionStatus to canonical TransactionStatus (declined → reversed)', () => {
    expect(_internals.mapTransactionStatus({ commissionStatus: 'pending' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ commissionStatus: 'approved' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ commissionStatus: 'declined' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ commissionStatus: 'paid' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ commissionStatus: 'weird' })).toBe('other');
  });

  it('maps publisher status to active|pending|inactive|unknown', () => {
    expect(_internals.mapPublisherStatus({ status: 'active' })).toBe('active');
    expect(_internals.mapPublisherStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapPublisherStatus({ status: 'inactive' })).toBe('inactive');
    expect(_internals.mapPublisherStatus({ status: 'declined' })).toBe('inactive');
    expect(_internals.mapPublisherStatus({ status: 'something-else' })).toBe('unknown');
  });

  it('maps report-row aggregate counts to performance status', () => {
    expect(_internals.mapReportRowStatus({ declinedNo: 1, pendingNo: 0 })).toBe('reversed');
    expect(_internals.mapReportRowStatus({ declinedNo: 0, pendingNo: 5 })).toBe('pending');
    expect(_internals.mapReportRowStatus({ declinedNo: 0, pendingNo: 0 })).toBe('approved');
  });

  it('preserves raw network data on every domain transform', () => {
    const txn = (loadFixture('transactions.json') as Array<Record<string, unknown>>)[0];
    const t = _internals.toTransaction(txn as never);
    expect(t.rawNetworkData).toBe(txn);

    const pub = (loadFixture('publishers.json') as Array<Record<string, unknown>>)[0];
    const p = _internals.toMediaPartner(pub as never);
    expect(p.rawNetworkData).toBe(pub);
  });

  it('surfaces declineReason on declined transactions only', () => {
    const txns = loadFixture('transactions.json') as Array<Record<string, unknown>>;
    const declined = _internals.toTransaction(txns[2] as never);
    expect(declined.status).toBe('reversed');
    expect(declined.reversalReason).toBe('Customer returned the item within 14 days');

    const approved = _internals.toTransaction(txns[0] as never);
    expect(approved.status).toBe('approved');
    expect(approved.reversalReason).toBeUndefined();
  });

  it('round-trips a performance row with clicks/conversions/sale/commission', () => {
    const rows = loadFixture('performance-report.json') as Array<Record<string, unknown>>;
    const r = _internals.toPerformanceRow(rows[0] as never);
    expect(r.date).toBe('2026-05-01');
    expect(r.publisherId).toBe('555001');
    expect(r.publisherName).toBe('BestDeals.com');
    expect(r.clicks).toBe(1200);
    expect(r.conversions).toBe(24);
    expect(r.currency).toBe('GBP');
    // One declined row → 'reversed' status surfaces.
    expect(r.status).toBe('reversed');
  });

  it('normalises Awin date strings (best-effort tz)', () => {
    expect(_internals.parseAwinDate('2026-05-01T10:00:00Z')).toBe('2026-05-01T10:00:00.000Z');
    expect(_internals.parseAwinDate('not-a-date')).toBeUndefined();
    expect(_internals.parseAwinDate(undefined)).toBeUndefined();
  });

  it('canonicalToAwinStatus maps reversed back to declined', () => {
    expect(_internals.canonicalToAwinStatus('pending')).toBe('pending');
    expect(_internals.canonicalToAwinStatus('approved')).toBe('approved');
    expect(_internals.canonicalToAwinStatus('reversed')).toBe('declined');
  });

  it('toDiscoveredBrand returns apiEnabled:true (rate-budget rationale)', () => {
    const b = _internals.toDiscoveredBrand({
      accountId: 1001,
      accountName: 'Acme Widgets',
      type: 'advertiser',
    });
    expect(b.networkBrandId).toBe('1001');
    expect(b.displayName).toBe('Acme Widgets');
    expect(b.apiEnabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listBrands — /accounts filtered to advertiser type
// ---------------------------------------------------------------------------

describe('Awin advertiser.listBrands', () => {
  it('filters /accounts to advertiser-type entries and reports apiEnabled:true', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('accounts.json'))]);
    const brands = await awinAdvertiserAdapter.listBrands();
    expect(brands).toHaveLength(3);
    expect(brands.map((b) => b.networkBrandId).sort()).toEqual(['100001', '100002', '100003']);
    expect(brands.every((b) => b.apiEnabled === true)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/accounts');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers).toMatchObject({ Authorization: 'Bearer fake-token' });
  });

  it('tolerates a wrapped {accounts: [...]} response shape', async () => {
    const wrapped = { accounts: loadFixture('accounts.json') };
    mockFetchQueue([fakeResponse(wrapped)]);
    const brands = await awinAdvertiserAdapter.listBrands();
    expect(brands).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// URL shape — every data endpoint goes under /advertisers/{id}/...
// ---------------------------------------------------------------------------

describe('Awin advertiser URL shape', () => {
  it('listTransactions targets /advertisers/{id}/transactions/', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    await awinAdvertiserAdapter.listTransactions(
      { from: '2026-04-01', to: '2026-05-01' },
      { networkBrandId: '100001' },
    );
    expect(calls[0]?.url).toContain('/advertisers/100001/transactions/');
    expect(calls[0]?.url).toContain('startDate=2026-04-01');
    expect(calls[0]?.url).toContain('endDate=2026-05-01');
    expect(calls[0]?.url).toContain('dateType=transaction');
  });

  it('listMediaPartners targets /advertisers/{id}/publishers/', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('publishers.json'))]);
    await awinAdvertiserAdapter.listMediaPartners(undefined, { networkBrandId: '100001' });
    expect(calls[0]?.url).toContain('/advertisers/100001/publishers/');
  });

  it('getProgrammePerformance targets /advertisers/{id}/reports/publisher', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('performance-report.json'))]);
    await awinAdvertiserAdapter.getProgrammePerformance(
      { from: '2026-05-01', to: '2026-05-31' },
      { networkBrandId: '100001' },
    );
    expect(calls[0]?.url).toContain('/advertisers/100001/reports/publisher');
    expect(calls[0]?.url).toContain('startDate=2026-05-01');
    expect(calls[0]?.url).toContain('endDate=2026-05-31');
  });

  it('every data endpoint URL-encodes the networkBrandId', async () => {
    const { calls } = mockFetchQueue([fakeResponse([])]);
    await awinAdvertiserAdapter.listMediaPartners(undefined, {
      networkBrandId: 'has/slash',
    });
    // encodeURIComponent of '/' is %2F.
    expect(calls[0]?.url).toContain('/advertisers/has%2Fslash/publishers/');
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('Awin advertiser.listTransactions', () => {
  it('returns transformed transactions with normalised status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const r = await awinAdvertiserAdapter.listTransactions(undefined, {
      networkBrandId: '100001',
    });
    expect(r).toHaveLength(3);
    expect(r.map((t) => t.status).sort()).toEqual(['approved', 'pending', 'reversed']);
  });

  it('filters by status client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const r = await awinAdvertiserAdapter.listTransactions(
      { status: 'reversed' },
      { networkBrandId: '100001' },
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.reversalReason).toBe('Customer returned the item within 14 days');
  });

  it('passes a single-status filter through as an upstream query param (reversed → declined)', async () => {
    const { calls } = mockFetchQueue([fakeResponse([])]);
    await awinAdvertiserAdapter.listTransactions(
      { status: 'reversed' },
      { networkBrandId: '100001' },
    );
    expect(calls[0]?.url).toContain('status=declined');
  });

  it('refuses to run without a brand context (config_error)', async () => {
    await expect(awinAdvertiserAdapter.listTransactions()).rejects.toBeInstanceOf(NetworkError);
    try {
      await awinAdvertiserAdapter.listTransactions();
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('config_error');
    }
  });
});

// ---------------------------------------------------------------------------
// listMediaPartners
// ---------------------------------------------------------------------------

describe('Awin advertiser.listMediaPartners', () => {
  it('returns publishers with normalised status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('publishers.json'))]);
    const r = await awinAdvertiserAdapter.listMediaPartners(undefined, {
      networkBrandId: '100001',
    });
    expect(r).toHaveLength(3);
    expect(r.map((p) => p.status).sort()).toEqual(['active', 'inactive', 'pending']);
  });

  it('filters by status array', async () => {
    mockFetchQueue([fakeResponse(loadFixture('publishers.json'))]);
    const r = await awinAdvertiserAdapter.listMediaPartners(
      { status: ['active'] },
      { networkBrandId: '100001' },
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.name).toBe('BestDeals.com');
  });

  it('filters by search', async () => {
    mockFetchQueue([fakeResponse(loadFixture('publishers.json'))]);
    const r = await awinAdvertiserAdapter.listMediaPartners(
      { search: 'cabin' },
      { networkBrandId: '100001' },
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.name).toBe('Coupon Cabin');
  });
});

// ---------------------------------------------------------------------------
// getProgrammePerformance
// ---------------------------------------------------------------------------

describe('Awin advertiser.getProgrammePerformance', () => {
  it('returns one row per publisher with clicks/conversions/sale/commission', async () => {
    mockFetchQueue([fakeResponse(loadFixture('performance-report.json'))]);
    const rows = await awinAdvertiserAdapter.getProgrammePerformance(
      { from: '2026-05-01', to: '2026-05-31' },
      { networkBrandId: '100001' },
    );
    expect(rows).toHaveLength(2);
    const byPub = new Map(rows.map((r) => [r.publisherId, r]));
    const best = byPub.get('555001');
    expect(best?.clicks).toBe(1200);
    expect(best?.conversions).toBe(24);
    expect(best?.currency).toBe('GBP');
    // BestDeals had one declined row → status = 'reversed'.
    expect(best?.status).toBe('reversed');

    const coupon = byPub.get('555002');
    // Coupon Cabin had only pending → status = 'pending'.
    expect(coupon?.status).toBe('pending');
  });

  it('scopes to a single publisher when publisherId is provided', async () => {
    mockFetchQueue([fakeResponse(loadFixture('performance-report.json'))]);
    const rows = await awinAdvertiserAdapter.getProgrammePerformance(
      { publisherId: '555002' },
      { networkBrandId: '100001' },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.publisherId).toBe('555002');
  });

  it('tolerates a wrapped {rows: [...]} response shape', async () => {
    mockFetchQueue([fakeResponse({ rows: loadFixture('performance-report.json') })]);
    const rows = await awinAdvertiserAdapter.getProgrammePerformance(undefined, {
      networkBrandId: '100001',
    });
    expect(rows).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes — synthetic single-row
// ---------------------------------------------------------------------------

describe('Awin advertiser.listProgrammes', () => {
  it('returns one synthetic Programme keyed on the call-context advertiserId', async () => {
    const r = await awinAdvertiserAdapter.listProgrammes(undefined, {
      networkBrandId: '100001',
    });
    expect(r).toHaveLength(1);
    expect(r[0]?.id).toBe('100001');
    expect(r[0]?.network).toBe('awin-advertiser');
    expect(r[0]?.status).toBe('joined');
  });

  it('refuses to run without a brand context', async () => {
    await expect(awinAdvertiserAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });

  it('refuses to run without a token (config_error)', async () => {
    delete process.env['AWIN_ADVERTISER_API_TOKEN'];
    await expect(
      awinAdvertiserAdapter.listProgrammes(undefined, { networkBrandId: '100001' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('Awin advertiser.verifyAuth', () => {
  it('returns ok with an identity describing the advertiser-account count', async () => {
    mockFetchQueue([fakeResponse(loadFixture('accounts.json'))]);
    const r = await awinAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('advertiser-account');
    }
  });

  it('returns {ok:false} on 401', async () => {
    // Default resilience retries; queue enough failures to exhaust them.
    mockFetchQueue([
      fakeResponse('unauthorized', { status: 401 }),
      fakeResponse('unauthorized', { status: 401 }),
      fakeResponse('unauthorized', { status: 401 }),
    ]);
    const r = await awinAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });

  it('returns {ok:false} when the token is missing entirely', async () => {
    delete process.env['AWIN_ADVERTISER_API_TOKEN'];
    const r = await awinAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ops not implemented at v0.1
// ---------------------------------------------------------------------------

describe('Awin advertiser unimplemented ops', () => {
  it('throws NotImplementedError on getProgramme / getEarningsSummary / listClicks / generateTrackingLink', async () => {
    await expect(awinAdvertiserAdapter.getProgramme('X')).rejects.toBeInstanceOf(NotImplementedError);
    await expect(awinAdvertiserAdapter.getEarningsSummary()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(awinAdvertiserAdapter.listClicks()).rejects.toBeInstanceOf(NotImplementedError);
    await expect(
      awinAdvertiserAdapter.generateTrackingLink({
        programmeId: 'X',
        destinationUrl: 'https://example.com',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// Per-operation claimStatus (review feedback workstream 1)
// ---------------------------------------------------------------------------

describe('Awin advertiser.capabilitiesCheck — per-op claimStatus', () => {
  it('marks listBrands as partial (tier-probing skipped)', async () => {
    const caps = await awinAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['listBrands']?.claimStatus).toBe('partial');
  });

  it('marks getProgrammePerformance as experimental (report column aliases unverified)', async () => {
    const caps = await awinAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['getProgrammePerformance']?.claimStatus).toBe('experimental');
  });

  it('marks listProgrammes as experimental (synthetic single-row fallback)', async () => {
    const caps = await awinAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['listProgrammes']?.claimStatus).toBe('experimental');
  });

  it('does NOT mark listTransactions or listMediaPartners — no override', async () => {
    const caps = await awinAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['listTransactions']?.claimStatus).toBeUndefined();
    expect(caps.operations['listMediaPartners']?.claimStatus).toBeUndefined();
  });
});
