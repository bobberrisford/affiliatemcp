/**
 * ValueCommerce advertiser adapter — unit tests.
 *
 * Exercises the transformers directly and the operations end-to-end via a
 * mocked fetch queue (token JSON first, then EC order-report XML). Confirms the
 * per-publisher rollup, status mapping, raw preservation, the read-only guard,
 * the brand-context requirement, and the NotImplemented ops. Deterministic: no
 * reliance on the wall clock for assertions.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  valueCommerceAdvertiserAdapter,
  _internals,
} from '../../../src/networks/value-commerce-advertiser/adapter.js';
import { _resetTokenCache } from '../../../src/networks/value-commerce-advertiser/auth.js';
import { valueCommerceAdvRequest } from '../../../src/networks/value-commerce-advertiser/client.js';
import { _resetBreakers, DEFAULT_RESILIENCE } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'value-commerce-advertiser');

function loadJson(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function loadXml(name: string): string {
  return loadJson(name)['xml'] as string;
}

function jsonResponse(body: unknown, status = 200): Response {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { 'content-type': 'application/json' } });
}

function xmlResponse(xml: string, status = 200): Response {
  return new Response(xml, { status, headers: { 'content-type': 'application/xml' } });
}

/** Queue mock fetch responses and capture the URLs called. */
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

function tokenResponse(): Response {
  return jsonResponse(loadJson('token.json'));
}

const CTX = { networkBrandId: '5001' };

beforeEach(() => {
  _resetBreakers();
  _resetTokenCache();
  process.env['VALUE_COMMERCE_ADVERTISER_CLIENT_KEY'] = 'fake-client-key';
  process.env['VALUE_COMMERCE_ADVERTISER_CLIENT_SECRET'] = 'fake-client-secret';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['VALUE_COMMERCE_ADVERTISER_CLIENT_KEY'];
  delete process.env['VALUE_COMMERCE_ADVERTISER_CLIENT_SECRET'];
  _resetTokenCache();
});

// ---------------------------------------------------------------------------
// Transformers and status mapping
// ---------------------------------------------------------------------------

describe('ValueCommerce advertiser transformers', () => {
  it('maps approval_status codes to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus('p')).toBe('pending');
    expect(_internals.mapTransactionStatus('a')).toBe('approved');
    expect(_internals.mapTransactionStatus('c')).toBe('reversed');
    expect(_internals.mapTransactionStatus('i')).toBe('paid');
    expect(_internals.mapTransactionStatus('保留')).toBe('pending');
    expect(_internals.mapTransactionStatus('zzz')).toBe('other');
    expect(_internals.mapTransactionStatus(undefined)).toBe('other');
  });

  it('maps approval_status codes to the three performance-row states', () => {
    expect(_internals.mapPerformanceStatus('p')).toBe('pending');
    expect(_internals.mapPerformanceStatus('a')).toBe('approved');
    expect(_internals.mapPerformanceStatus('i')).toBe('approved');
    expect(_internals.mapPerformanceStatus('c')).toBe('reversed');
    expect(_internals.mapPerformanceStatus('zzz')).toBe('pending');
  });

  it('maps canonical status back to the upstream approval_status code', () => {
    expect(_internals.mapCanonicalToApprovalStatus(['pending'])).toBe('p');
    expect(_internals.mapCanonicalToApprovalStatus(['approved'])).toBe('a');
    expect(_internals.mapCanonicalToApprovalStatus(['reversed'])).toBe('c');
    expect(_internals.mapCanonicalToApprovalStatus(['paid'])).toBe('i');
    // multi-status requests are filtered client-side, so no single upstream code.
    expect(_internals.mapCanonicalToApprovalStatus(['pending', 'approved'])).toBeUndefined();
    expect(_internals.mapCanonicalToApprovalStatus(undefined)).toBeUndefined();
  });

  it('preserves the raw row on transform and surfaces reversalReason', () => {
    const raw = {
      transactionId: 'EC-1',
      pid: '5001',
      sid: '9200',
      siteName: 'CouponHub JP',
      approvalStatus: 'c',
      amount: '3200',
      reward: '160',
      rejectReason: 'Customer cancelled the order',
      orderDate: '2026-05-03 16:25:00',
    };
    const t = _internals.toTransaction(raw, new Date('2026-05-10T00:00:00Z'));
    expect(t.rawNetworkData).toBe(raw);
    expect(t.status).toBe('reversed');
    expect(t.reversalReason).toBe('Customer cancelled the order');
    expect(t.commission).toBe(160);
    expect(t.amount).toBe(3200);
  });

  it('maps a row to a per-order performance row (conversions=1, clicks=0)', () => {
    const row = _internals.toPerformanceRow({
      pid: '5001',
      sid: '9100',
      siteName: 'BestDeals JP',
      approvalStatus: 'a',
      amount: '12000',
      reward: '600',
      orderDate: '2026-05-01 09:20:00',
    });
    expect(row.publisherId).toBe('9100');
    expect(row.publisherName).toBe('BestDeals JP');
    expect(row.date).toBe('2026-05-01');
    expect(row.conversions).toBe(1);
    expect(row.clicks).toBe(0);
    expect(row.grossSale).toBe(12000);
    expect(row.commission).toBe(600);
    expect(row.status).toBe('approved');
  });

  it('extractRowNodes returns [] for an empty / non-record tree', () => {
    expect(_internals.extractRowNodes('' as never)).toEqual([]);
    expect(_internals.extractRowNodes({})).toEqual([]);
  });

  it('aggregates per-order rows by (publisher, date, status)', () => {
    const a = _internals.toPerformanceRow({
      sid: '9100',
      approvalStatus: 'a',
      amount: '12000',
      reward: '600',
      orderDate: '2026-05-01 09:20:00',
    });
    const b = _internals.toPerformanceRow({
      sid: '9100',
      approvalStatus: 'a',
      amount: '8000',
      reward: '400',
      orderDate: '2026-05-01 11:30:00',
    });
    const agg = _internals.aggregateByPublisher([a, b]);
    expect(agg).toHaveLength(1);
    expect(agg[0]?.conversions).toBe(2);
    expect(agg[0]?.grossSale).toBe(20000);
    expect(agg[0]?.commission).toBe(1000);
    expect(Array.isArray(agg[0]?.rawNetworkData)).toBe(true);
    expect((agg[0]?.rawNetworkData as unknown[]).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Read-only guard
// ---------------------------------------------------------------------------

describe('ValueCommerce advertiser read-only guard', () => {
  it('refuses any non-GET method with a config_error envelope', async () => {
    const promise = valueCommerceAdvRequest({
      operation: 'listTransactions',
      path: '/report/v2/merchant/transaction/',
      token: 'x',
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
// verifyAuth
// ---------------------------------------------------------------------------

describe('ValueCommerce advertiser.verifyAuth', () => {
  it('returns ok with identity on a successful token exchange', async () => {
    mockFetchQueue([tokenResponse()]);
    const r = await valueCommerceAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('value-commerce-advertiser/client:fake-client-key');
    }
  });

  it('returns {ok:false} on a 401 from the token endpoint', async () => {
    mockFetchQueue([jsonResponse({ error: 'invalid_client' }, 401)]);
    const r = await valueCommerceAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listBrands
// ---------------------------------------------------------------------------

describe('ValueCommerce advertiser.listBrands', () => {
  it('derives the distinct advertiser programmes (PIDs) from the EC report', async () => {
    const { urls } = mockFetchQueue([tokenResponse(), xmlResponse(loadXml('order-report.json'))]);
    const brands = await valueCommerceAdvertiserAdapter.listBrands();
    // Fixture has PID 5001 and 5002.
    expect(brands.map((b) => b.networkBrandId).sort()).toEqual(['5001', '5002']);
    expect(brands.find((b) => b.networkBrandId === '5001')?.displayName).toBe('Acme Direct Store');
    // First URL is the token endpoint; second is the EC report.
    expect(urls[0]).toContain('/auth/v1/merchant/token/');
    expect(urls[1]).toContain('/report/v2/merchant/transaction/');
  });

  it('returns an empty list when the report has no rows', async () => {
    mockFetchQueue([tokenResponse(), xmlResponse(loadXml('order-report-empty.json'))]);
    const brands = await valueCommerceAdvertiserAdapter.listBrands();
    expect(brands).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getProgrammePerformance
// ---------------------------------------------------------------------------

describe('ValueCommerce advertiser.getProgrammePerformance', () => {
  it('groups EC report rows by publisher for the scoped programme', async () => {
    const { urls } = mockFetchQueue([tokenResponse(), xmlResponse(loadXml('order-report.json'))]);
    const rows = await valueCommerceAdvertiserAdapter.getProgrammePerformance(
      { from: '2026-05-01', to: '2026-05-31' },
      CTX,
    );
    // PID 5001 has two approved rows on sid 9100, one pending on 9200, one
    // reversed on 9200 → three aggregated rows (9100/approved, 9200/pending,
    // 9200/reversed). PID 5002 (invoiced) is scoped out.
    expect(rows).toHaveLength(3);
    const bestDeals = rows.find((r) => r.publisherId === '9100');
    expect(bestDeals?.conversions).toBe(2);
    expect(bestDeals?.grossSale).toBe(20000);
    expect(bestDeals?.commission).toBe(1000);
    expect(bestDeals?.status).toBe('approved');
    expect(rows.some((r) => r.publisherId === '9200' && r.status === 'pending')).toBe(true);
    expect(rows.some((r) => r.publisherId === '9200' && r.status === 'reversed')).toBe(true);
    expect(urls[1]).toContain('/report/v2/merchant/transaction/');
    expect(urls[1]).toContain('criteria=o');
  });

  it('filters to a single publisherId when requested', async () => {
    mockFetchQueue([tokenResponse(), xmlResponse(loadXml('order-report.json'))]);
    const rows = await valueCommerceAdvertiserAdapter.getProgrammePerformance(
      { publisherId: '9100' },
      CTX,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.publisherId).toBe('9100');
  });

  it('refuses to run without a brand context (config_error)', async () => {
    await expect(
      valueCommerceAdvertiserAdapter.getProgrammePerformance(),
    ).rejects.toBeInstanceOf(NetworkError);
    try {
      await valueCommerceAdvertiserAdapter.getProgrammePerformance();
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('config_error');
    }
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('ValueCommerce advertiser.listTransactions', () => {
  it('returns rows scoped to the programme and preserves raw XML data', async () => {
    mockFetchQueue([tokenResponse(), xmlResponse(loadXml('order-report.json'))]);
    const txns = await valueCommerceAdvertiserAdapter.listTransactions(undefined, CTX);
    // PID 5001 has four rows (5002 is scoped out).
    expect(txns).toHaveLength(4);
    expect(txns.every((t) => t.programmeId === '5001')).toBe(true);
    expect(txns[0]?.rawNetworkData).toBeTypeOf('object');
  });

  it('filters by canonical status client-side', async () => {
    mockFetchQueue([tokenResponse(), xmlResponse(loadXml('order-report.json'))]);
    const reversed = await valueCommerceAdvertiserAdapter.listTransactions({ status: 'reversed' }, CTX);
    expect(reversed).toHaveLength(1);
    expect(reversed[0]?.reversalReason).toBe('Customer cancelled the order');
  });

  it('refuses to run without a brand context (config_error)', async () => {
    await expect(valueCommerceAdvertiserAdapter.listTransactions()).rejects.toBeInstanceOf(
      NetworkError,
    );
    try {
      await valueCommerceAdvertiserAdapter.listTransactions();
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('config_error');
    }
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('ValueCommerce advertiser.listProgrammes', () => {
  it('surfaces the advertiser programmes derived from the EC report', async () => {
    mockFetchQueue([tokenResponse(), xmlResponse(loadXml('order-report.json'))]);
    const programmes = await valueCommerceAdvertiserAdapter.listProgrammes();
    expect(programmes.map((p) => p.id).sort()).toEqual(['5001', '5002']);
    expect(programmes[0]?.status).toBe('joined');
  });
});

// ---------------------------------------------------------------------------
// Ops not implemented at v0.1
// ---------------------------------------------------------------------------

describe('ValueCommerce advertiser unimplemented ops', () => {
  it('throws NotImplementedError on getProgramme / getEarningsSummary / listClicks / generateTrackingLink', async () => {
    await expect(valueCommerceAdvertiserAdapter.getProgramme('5001')).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(valueCommerceAdvertiserAdapter.getEarningsSummary()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(valueCommerceAdvertiserAdapter.listClicks()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(
      valueCommerceAdvertiserAdapter.generateTrackingLink({
        programmeId: '5001',
        destinationUrl: 'https://example.com',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
    await expect(valueCommerceAdvertiserAdapter.listPublishers()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(valueCommerceAdvertiserAdapter.listPublisherSectors()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck — per-op claimStatus
// ---------------------------------------------------------------------------

describe('ValueCommerce advertiser.capabilitiesCheck', () => {
  it('marks the derived/report-backed ops as experimental and the unsupported ops as unsupported', async () => {
    const caps = await valueCommerceAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['listBrands']?.claimStatus).toBe('experimental');
    expect(caps.operations['getProgrammePerformance']?.claimStatus).toBe('experimental');
    expect(caps.operations['getProgramme']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
  });
});
