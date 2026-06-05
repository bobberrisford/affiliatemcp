/**
 * Commission Factory advertiser adapter — unit tests.
 *
 * Exercises listBrands, getProgrammePerformance (per-affiliate rollup),
 * listTransactions, listProgrammes, status mapping, raw preservation, the
 * read-only client guard, the NotImplemented ops, and verifyAuth ok+fail.
 *
 * Deterministic: a fixed clock is injected into the adapter under test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  CommissionFactoryAdvertiserAdapter,
  _internals,
} from '../../../src/networks/commission-factory-advertiser/adapter.js';
import {
  buildUrl,
  commissionFactoryAdvertiserRequest,
} from '../../../src/networks/commission-factory-advertiser/client.js';
import { _resetBreakers, DEFAULT_RESILIENCE } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'commission-factory-advertiser');
const FIXED_NOW = new Date('2026-06-01T00:00:00Z');
const CTX = { networkBrandId: '5501' };

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { 'content-type': 'application/json' } });
}

function mockFetchQueue(responses: Response[]): { spy: ReturnType<typeof vi.fn>; urls: string[] } {
  const urls: string[] = [];
  const spy = vi.fn(async (input: string | URL | Request) => {
    urls.push(typeof input === 'string' ? input : input.toString());
    const r = responses.shift();
    if (!r) throw new Error('mock fetch queue exhausted');
    return r;
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return { spy, urls };
}

function makeAdapter(): CommissionFactoryAdvertiserAdapter {
  return new CommissionFactoryAdvertiserAdapter({ now: () => FIXED_NOW });
}

beforeEach(() => {
  _resetBreakers();
  process.env['COMMISSION_FACTORY_ADVERTISER_API_KEY'] = 'fake-merchant-key-abcd';
  delete process.env['COMMISSION_FACTORY_ADVERTISER_MERCHANT_ID'];
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['COMMISSION_FACTORY_ADVERTISER_API_KEY'];
  delete process.env['COMMISSION_FACTORY_ADVERTISER_MERCHANT_ID'];
});

// ---------------------------------------------------------------------------
// Transformers + status mapping
// ---------------------------------------------------------------------------

describe('Commission Factory advertiser transformers', () => {
  it('maps Status2 to the canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ Status2: 'Pending' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ Status2: 'Confirmed' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ Status2: 'Paid' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ Status2: 'Void' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ Status2: 'Declined' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ Status2: 'Weird' })).toBe('other');
  });

  it('falls back to deprecated Status when Status2 is absent', () => {
    expect(_internals.mapTransactionStatus({ Status: 'Confirmed' })).toBe('approved');
  });

  it('maps performance-row status to pending|approved|reversed (paid folds to approved)', () => {
    expect(_internals.mapPerfStatus({ Status2: 'Pending' })).toBe('pending');
    expect(_internals.mapPerfStatus({ Status2: 'Confirmed' })).toBe('approved');
    expect(_internals.mapPerfStatus({ Status2: 'Paid' })).toBe('approved');
    expect(_internals.mapPerfStatus({ Status2: 'Void' })).toBe('reversed');
    expect(_internals.mapPerfStatus({ Status2: 'Weird' })).toBe('pending');
  });

  it('surfaces VoidReason as reversalReason on reversed transactions', () => {
    const raw = (loadFixture('merchant-transactions.json') as {
      Items: Array<Record<string, unknown>>;
    }).Items[2];
    const t = _internals.toTransaction(raw as never, FIXED_NOW);
    expect(t.status).toBe('reversed');
    expect(t.reversalReason).toBe('Order cancelled by customer');
    expect(t.rawNetworkData).toBe(raw);
  });

  it('computes ageDays from OrderDate against the injected clock', () => {
    const t = _internals.toTransaction(
      { Id: 1, OrderDate: '2026-05-02T00:00:00Z', Status2: 'Pending' },
      FIXED_NOW,
    );
    expect(t.ageDays).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// rollupByAffiliate
// ---------------------------------------------------------------------------

describe('Commission Factory advertiser rollupByAffiliate', () => {
  it('groups by affiliate + status + date and sums sale/commission', () => {
    const txns = (loadFixture('merchant-transactions.json') as {
      Items: Array<Record<string, unknown>>;
    }).Items;
    const rows = _internals.rollupByAffiliate(txns as never, FIXED_NOW);

    // 7001: one approved + one pending on 2026-05-02  → 2 rows
    // 7002: one reversed + one approved(paid) on 2026-05-03 → 2 rows
    expect(rows).toHaveLength(4);

    const approved7001 = rows.find(
      (r) => r.publisherId === '7001' && r.status === 'approved',
    );
    expect(approved7001?.conversions).toBe(1);
    expect(approved7001?.grossSale).toBe(200);
    expect(approved7001?.commission).toBe(20);
    expect(approved7001?.clicks).toBe(0);
    expect(approved7001?.publisherName).toBe('BestDeals AU');
    expect(approved7001?.currency).toBe('AUD');

    const reversed7002 = rows.find(
      (r) => r.publisherId === '7002' && r.status === 'reversed',
    );
    expect(reversed7002?.conversions).toBe(1);
    expect(reversed7002?.grossSale).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// URL shape
// ---------------------------------------------------------------------------

describe('Commission Factory advertiser URL shape', () => {
  it('builds /V1/Merchant/Transactions with the apiKey query param', () => {
    const url = buildUrl('https://api.commissionfactory.com/V1/', '/Merchant/Transactions', {
      fromDate: '2026-05-01',
      apiKey: 'secret',
    });
    expect(url).toBe(
      'https://api.commissionfactory.com/V1/Merchant/Transactions?fromDate=2026-05-01&apiKey=secret',
    );
  });
});

// ---------------------------------------------------------------------------
// Read-only guard
// ---------------------------------------------------------------------------

describe('Commission Factory advertiser read-only guard', () => {
  it('refuses any non-GET method with a config_error envelope', async () => {
    const promise = commissionFactoryAdvertiserRequest({
      operation: 'listTransactions',
      path: '/Merchant/Transactions',
      apiKey: 'k',
      method: 'POST' as 'GET',
      resilience: DEFAULT_RESILIENCE,
    });
    await expect(promise).rejects.toBeInstanceOf(NetworkError);
    try {
      await promise;
    } catch (err) {
      const e = err as NetworkError;
      expect(e.envelope.type).toBe('config_error');
      expect(e.envelope.message).toMatch(/read-only/);
    }
  });
});

// ---------------------------------------------------------------------------
// listBrands
// ---------------------------------------------------------------------------

describe('Commission Factory advertiser.listBrands', () => {
  it('uses the merchant id hint when set (no network call)', async () => {
    process.env['COMMISSION_FACTORY_ADVERTISER_MERCHANT_ID'] = '5501';
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;

    const brands = await makeAdapter().listBrands();
    expect(brands).toHaveLength(1);
    expect(brands[0]?.networkBrandId).toBe('5501');
    expect(brands[0]?.apiEnabled).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('derives the merchant identity from a sample transaction when no hint', async () => {
    const { urls } = mockFetchQueue([fakeResponse(loadFixture('merchant-transactions.json'))]);
    const brands = await makeAdapter().listBrands();
    expect(brands).toHaveLength(1);
    expect(brands[0]?.networkBrandId).toBe('5501');
    expect(brands[0]?.displayName).toBe('Sample Brand Co');
    expect(urls[0]).toContain('/V1/Merchant/Transactions');
  });

  it('falls back to a synthetic label when no transactions are available', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchant-transactions-empty.json'))]);
    const brands = await makeAdapter().listBrands();
    expect(brands).toHaveLength(1);
    expect(brands[0]?.displayName).toContain('Commission Factory merchant');
  });
});

// ---------------------------------------------------------------------------
// getProgrammePerformance (primary op)
// ---------------------------------------------------------------------------

describe('Commission Factory advertiser.getProgrammePerformance', () => {
  it('returns a per-publisher rollup from merchant transactions', async () => {
    const { urls } = mockFetchQueue([fakeResponse(loadFixture('merchant-transactions.json'))]);
    const rows = await makeAdapter().getProgrammePerformance(
      { from: '2026-05-01', to: '2026-05-31' },
      CTX,
    );
    expect(rows).toHaveLength(4);
    const totalConversions = rows.reduce((a, r) => a + r.conversions, 0);
    expect(totalConversions).toBe(4);
    expect(rows.every((r) => r.clicks === 0)).toBe(true);
    expect(urls[0]).toContain('fromDate=2026-05-01');
    expect(urls[0]).toContain('toDate=2026-05-31');
  });

  it('preserves the contributing raw transactions on each row', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchant-transactions.json'))]);
    const rows = await makeAdapter().getProgrammePerformance({}, CTX);
    const row = rows.find((r) => r.publisherId === '7001' && r.status === 'approved');
    expect(Array.isArray(row?.rawNetworkData)).toBe(true);
    expect((row?.rawNetworkData as unknown[]).length).toBe(1);
  });

  it('scopes to a single publisher via affiliateId', async () => {
    const { urls } = mockFetchQueue([fakeResponse(loadFixture('merchant-transactions.json'))]);
    const rows = await makeAdapter().getProgrammePerformance({ publisherId: '7002' }, CTX);
    expect(rows.every((r) => r.publisherId === '7002')).toBe(true);
    expect(urls[0]).toContain('affiliateId=7002');
  });

  it('refuses to run without a brand context (config_error)', async () => {
    await expect(makeAdapter().getProgrammePerformance({})).rejects.toBeInstanceOf(NetworkError);
    try {
      await makeAdapter().getProgrammePerformance({});
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('config_error');
    }
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('Commission Factory advertiser.listTransactions', () => {
  it('returns transformed transactions for the brand', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchant-transactions.json'))]);
    const r = await makeAdapter().listTransactions({ from: '2026-05-01', to: '2026-05-31' }, CTX);
    expect(r).toHaveLength(4);
    expect(r.map((t) => t.status).sort()).toEqual(['approved', 'paid', 'pending', 'reversed']);
  });

  it('filters by status client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchant-transactions.json'))]);
    const r = await makeAdapter().listTransactions({ status: 'reversed' }, CTX);
    expect(r).toHaveLength(1);
    expect(r[0]?.reversalReason).toBe('Order cancelled by customer');
  });

  it('requires a brand context', async () => {
    await expect(makeAdapter().listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('Commission Factory advertiser.listProgrammes', () => {
  it('maps merchant promotions to programmes', async () => {
    const { urls } = mockFetchQueue([fakeResponse(loadFixture('merchant-promotions.json'))]);
    const r = await makeAdapter().listProgrammes(undefined, CTX);
    expect(r).toHaveLength(2);
    expect(r[0]?.status).toBe('joined');
    expect(r[1]?.status).toBe('suspended');
    expect(urls[0]).toContain('/V1/Merchant/Promotions');
  });
});

// ---------------------------------------------------------------------------
// Unimplemented ops
// ---------------------------------------------------------------------------

describe('Commission Factory advertiser unimplemented ops', () => {
  it('throws NotImplementedError on getProgramme / getEarningsSummary / listClicks / generateTrackingLink', async () => {
    const a = makeAdapter();
    await expect(a.getProgramme('X')).rejects.toBeInstanceOf(NotImplementedError);
    await expect(a.getEarningsSummary()).rejects.toBeInstanceOf(NotImplementedError);
    await expect(a.listClicks()).rejects.toBeInstanceOf(NotImplementedError);
    await expect(
      a.generateTrackingLink({ programmeId: 'X', destinationUrl: 'https://example.com' }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('Commission Factory advertiser.verifyAuth', () => {
  it('returns ok with a redacted key fingerprint on success', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchant-transactions-empty.json'))]);
    const r = await makeAdapter().verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('commission-factory-advertiser/key:****');
    }
  });

  it('returns {ok:false} on 401', async () => {
    mockFetchQueue([fakeResponse('unauthorized', { status: 401 })]);
    const r = await makeAdapter().verifyAuth();
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('Commission Factory advertiser.capabilitiesCheck', () => {
  it('marks the primary ops supported and the unsupported ops false', async () => {
    const caps = await makeAdapter().capabilitiesCheck();
    expect(caps.operations['getProgrammePerformance']?.supported).toBe(true);
    expect(caps.operations['listBrands']?.supported).toBe(true);
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
  });
});
