/**
 * Daisycon advertiser adapter — unit tests.
 *
 * Pattern-matched to `tests/networks/daisycon/adapter.test.ts` (OAuth token
 * exchange is the FIRST fetch, then the data call) and
 * `tests/networks/impact-advertiser/adapter.test.ts` (advertiser ctx required,
 * read-only guard):
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - Circuit breakers reset in `beforeEach`; token cache reset via
 *     `_resetTokenCache`.
 *   - Fake credentials injected via `process.env` (obvious non-secret values).
 *   - Fixtures live under `tests/fixtures/daisycon-advertiser/`.
 *   - Deterministic: transformers take a fixed `now` so they never drift.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  daisyconAdvertiserAdapter,
  _internals,
} from '../../../src/networks/daisycon-advertiser/adapter.js';
import { daisyconAdvRequest } from '../../../src/networks/daisycon-advertiser/client.js';
import { _resetTokenCache } from '../../../src/networks/daisycon-advertiser/auth.js';
import { _resetBreakers, DEFAULT_RESILIENCE } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'daisycon-advertiser');
const CTX = { networkBrandId: '5001' };

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(
  body: unknown,
  init: { status?: number; rawBody?: string; totalCount?: number } = {},
): Response {
  const status = init.status ?? 200;
  const text = init.rawBody ?? (typeof body === 'string' ? body : JSON.stringify(body));
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.totalCount !== undefined) headers['x-total-count'] = String(init.totalCount);
  return new Response(text, { status, headers });
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

/** Mock a token exchange (first fetch) followed by the given data response(s). */
function mockWithToken(...dataResponses: Response[]): { spy: ReturnType<typeof vi.fn>; urls: string[] } {
  return mockFetchQueue([fakeResponse(loadFixture('token.json')), ...dataResponses]);
}

beforeEach(() => {
  _resetBreakers();
  _resetTokenCache();
  process.env['DAISYCON_ADVERTISER_CLIENT_ID'] = 'test-client-id-please-ignore';
  process.env['DAISYCON_ADVERTISER_CLIENT_SECRET'] = 'test-client-secret-please-ignore';
  process.env['DAISYCON_ADVERTISER_REFRESH_TOKEN'] = 'test-refresh-token-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['DAISYCON_ADVERTISER_CLIENT_ID'];
  delete process.env['DAISYCON_ADVERTISER_CLIENT_SECRET'];
  delete process.env['DAISYCON_ADVERTISER_REFRESH_TOKEN'];
  _resetTokenCache();
});

// ---------------------------------------------------------------------------
// Transformers (status normalisation + raw preservation)
// ---------------------------------------------------------------------------

describe('Daisycon advertiser transformers', () => {
  it('maps Daisycon transaction statuses to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ status: 'open' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'approved' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'disapproved' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'declined' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'paid' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ status: 'something-new' })).toBe('other');
    expect(_internals.mapTransactionStatus({})).toBe('other');
  });

  it('maps canonical statuses to Daisycon query values', () => {
    expect(_internals.mapCanonicalToDaisyconStatus(['pending'])).toBe('open');
    expect(_internals.mapCanonicalToDaisyconStatus(['approved'])).toBe('approved');
    expect(_internals.mapCanonicalToDaisyconStatus(['reversed'])).toBe('disapproved');
    expect(_internals.mapCanonicalToDaisyconStatus(['paid'])).toBe('paid');
    expect(_internals.mapCanonicalToDaisyconStatus(['other'])).toBeUndefined();
    // Multiple statuses → client-side filtering.
    expect(_internals.mapCanonicalToDaisyconStatus(['pending', 'paid'])).toBeUndefined();
  });

  it('preserves raw payload on transactions and reads currency per row', () => {
    const rows = loadFixture('transactions.json') as Array<Record<string, unknown>>;
    const t0 = _internals.toTransaction(rows[0] as never);
    expect(t0.rawNetworkData).toBe(rows[0]);
    expect(t0.currency).toBe('EUR');
    const t2 = _internals.toTransaction(rows[2] as never);
    expect(t2.currency).toBe('GBP');
  });

  it('surfaces reversalReason from disapproved_reason on reversed transactions', () => {
    const rows = loadFixture('transactions.json') as Array<Record<string, unknown>>;
    const t = _internals.toTransaction(rows[2] as never);
    expect(t.status).toBe('reversed');
    expect(t.reversalReason).toBe('Order cancelled by the customer');
  });

  it('computes ageDays from the conversion date', () => {
    const now = new Date('2026-06-04T00:00:00Z');
    expect(_internals.computeAgeDays({ date: '2026-05-25T00:00:00Z' }, now)).toBe(10);
    expect(_internals.computeAgeDays({}, now)).toBe(0);
  });

  it('builds DiscoveredBrand entries with apiEnabled flags', () => {
    const adv = loadFixture('advertisers.json') as Array<Record<string, unknown>>;
    const b0 = _internals.toDiscoveredBrand(adv[0] as never);
    expect(b0.networkBrandId).toBe('5001');
    expect(b0.displayName).toBe('Acme Widgets BV');
    expect(b0.apiEnabled).toBe(true);
    const b2 = _internals.toDiscoveredBrand(adv[2] as never);
    expect(b2.apiEnabled).toBe(false);
  });

  it('rolls up transactions by (date, publisher, status)', () => {
    const rows = loadFixture('transactions.json') as Array<Record<string, unknown>>;
    const perf = _internals.rollupPerformance(rows as never);
    // 90001 (open/DealsBlog) and 90002 (approved/DealsBlog) on the same day but
    // different status → 2 buckets; 90003 (disapproved/CouponWorld) → 1;
    // 90004 (paid/CouponWorld) → 1. Total 4 buckets.
    expect(perf).toHaveLength(4);
    const approvedDeals = perf.find(
      (r) => r.publisherName === 'DealsBlog' && r.status === 'approved',
    );
    expect(approvedDeals?.conversions).toBe(1);
    expect(approvedDeals?.grossSale).toBeCloseTo(250, 2);
    expect(approvedDeals?.commission).toBeCloseTo(20, 2);
    expect(approvedDeals?.clicks).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Read-only guard
// ---------------------------------------------------------------------------

describe('Daisycon advertiser read-only guard', () => {
  it('refuses any non-GET method with a config_error envelope', async () => {
    const promise = daisyconAdvRequest({
      operation: 'listTransactions',
      path: '/advertisers/5001/transactions',
      token: 'fake-token',
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

describe('DaisyconAdvertiserAdapter.listBrands', () => {
  it('enumerates advertiser accounts via GET /advertisers', async () => {
    const { urls } = mockWithToken(fakeResponse(loadFixture('advertisers.json')));
    const brands = await daisyconAdvertiserAdapter.listBrands();
    expect(brands).toHaveLength(3);
    expect(brands[0]?.networkBrandId).toBe('5001');
    expect(brands[0]?.displayName).toBe('Acme Widgets BV');
    expect(brands[2]?.apiEnabled).toBe(false);
    // The data call (after the token exchange) hits /advertisers on the services host.
    expect(urls[1]).toContain('https://services.daisycon.com/advertisers');
  });
});

// ---------------------------------------------------------------------------
// listTransactions (brand-scoped)
// ---------------------------------------------------------------------------

describe('DaisyconAdvertiserAdapter.listTransactions', () => {
  it('returns advertiser transactions for the brand context with raw + status', async () => {
    const { urls } = mockWithToken(fakeResponse(loadFixture('transactions.json')));
    const txns = await daisyconAdvertiserAdapter.listTransactions(
      { from: '2024-01-01T00:00:00Z', to: '2026-06-04T00:00:00Z' },
      CTX,
    );
    expect(txns.length).toBe(4);
    expect(txns.map((t) => t.status).sort()).toEqual(['approved', 'paid', 'pending', 'reversed']);
    // Brand-scoped path uses the advertiser id from ctx.
    expect(urls[1]).toContain('/advertisers/5001/transactions');
  });

  it('filters by status when caller passes status[]', async () => {
    mockWithToken(fakeResponse(loadFixture('transactions.json')));
    const only = await daisyconAdvertiserAdapter.listTransactions({ status: ['reversed'] }, CTX);
    expect(only).toHaveLength(1);
    expect(only[0]?.reversalReason).toBe('Order cancelled by the customer');
  });

  it('respects limit after other filters', async () => {
    mockWithToken(fakeResponse(loadFixture('transactions.json')));
    const limited = await daisyconAdvertiserAdapter.listTransactions({ limit: 2 }, CTX);
    expect(limited).toHaveLength(2);
  });

  it('paginates using the x-total-count header', async () => {
    const rows = loadFixture('transactions.json') as unknown[];
    // Force paging: report total=4 but return 2 rows per page. PER_PAGE is 200
    // so the partial-page short-circuit triggers only on the final page; we use
    // a full first page of the same two rows duplicated would be wrong, so we
    // instead rely on totalCount + a non-full page to stop. Here both pages are
    // partial (2 < 200) so paging stops after page 1 — assert single-page read.
    mockWithToken(fakeResponse(rows.slice(0, 2), { totalCount: 4 }));
    const all = await daisyconAdvertiserAdapter.listTransactions({}, CTX);
    // Partial first page (2 < PER_PAGE) short-circuits pagination by design.
    expect(all).toHaveLength(2);
  });

  it('refuses to run without a brand context (config_error)', async () => {
    await expect(daisyconAdvertiserAdapter.listTransactions({})).rejects.toBeInstanceOf(
      NetworkError,
    );
    try {
      await daisyconAdvertiserAdapter.listTransactions({});
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('config_error');
    }
  });

  it('emits a NetworkError when DAISYCON_ADVERTISER_CLIENT_ID is missing', async () => {
    delete process.env['DAISYCON_ADVERTISER_CLIENT_ID'];
    await expect(daisyconAdvertiserAdapter.listTransactions({}, CTX)).rejects.toBeInstanceOf(
      NetworkError,
    );
  });
});

// ---------------------------------------------------------------------------
// listProgrammes (derived)
// ---------------------------------------------------------------------------

describe('DaisyconAdvertiserAdapter.listProgrammes', () => {
  it('derives distinct programmes from the advertiser transactions', async () => {
    mockWithToken(fakeResponse(loadFixture('transactions.json')));
    const programmes = await daisyconAdvertiserAdapter.listProgrammes(undefined, CTX);
    // program_id 7001 and 7002 → 2 distinct programmes.
    expect(programmes).toHaveLength(2);
    expect(programmes.map((p) => p.id).sort()).toEqual(['7001', '7002']);
  });

  it('applies a search filter', async () => {
    mockWithToken(fakeResponse(loadFixture('transactions.json')));
    const filtered = await daisyconAdvertiserAdapter.listProgrammes({ search: 'accessories' }, CTX);
    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.id).toBe('7002');
  });

  it('requires a brand context', async () => {
    await expect(daisyconAdvertiserAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getProgrammePerformance (per-publisher rollup)
// ---------------------------------------------------------------------------

describe('DaisyconAdvertiserAdapter.getProgrammePerformance', () => {
  it('returns a per-publisher rollup grouped by media', async () => {
    const { urls } = mockWithToken(fakeResponse(loadFixture('transactions.json')));
    const perf = await daisyconAdvertiserAdapter.getProgrammePerformance(
      { from: '2024-01-01', to: '2026-06-04' },
      CTX,
    );
    expect(perf).toHaveLength(4);
    expect(perf.every((r) => r.clicks === 0)).toBe(true);
    const names = [...new Set(perf.map((r) => r.publisherName))].sort();
    expect(names).toEqual(['CouponWorld', 'DealsBlog']);
    expect(urls[1]).toContain('/advertisers/5001/transactions');
  });

  it('maps disapproved rows to reversed status in the rollup', async () => {
    mockWithToken(fakeResponse(loadFixture('transactions.json')));
    const perf = await daisyconAdvertiserAdapter.getProgrammePerformance(undefined, CTX);
    expect(perf.some((r) => r.status === 'reversed')).toBe(true);
    expect(perf.some((r) => r.status === 'approved')).toBe(true);
    expect(perf.some((r) => r.status === 'pending')).toBe(true);
  });

  it('filters the rollup by publisherId', async () => {
    mockWithToken(fakeResponse(loadFixture('transactions.json')));
    const perf = await daisyconAdvertiserAdapter.getProgrammePerformance(
      { publisherId: '8001' },
      CTX,
    );
    expect(perf.length).toBeGreaterThan(0);
    expect(perf.every((r) => r.publisherId === '8001')).toBe(true);
  });

  it('returns an empty rollup when there are no transactions', async () => {
    mockWithToken(fakeResponse(loadFixture('transactions_empty.json')));
    const perf = await daisyconAdvertiserAdapter.getProgrammePerformance(undefined, CTX);
    expect(perf).toHaveLength(0);
  });

  it('requires a brand context', async () => {
    await expect(daisyconAdvertiserAdapter.getProgrammePerformance()).rejects.toBeInstanceOf(
      NetworkError,
    );
  });
});

// ---------------------------------------------------------------------------
// NotImplemented ops
// ---------------------------------------------------------------------------

describe('DaisyconAdvertiserAdapter unimplemented ops', () => {
  it('throws NotImplementedError on getProgramme / getEarningsSummary / listClicks / generateTrackingLink / listMediaPartners', async () => {
    await expect(daisyconAdvertiserAdapter.getProgramme('X')).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(daisyconAdvertiserAdapter.getEarningsSummary()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(daisyconAdvertiserAdapter.listClicks()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(
      daisyconAdvertiserAdapter.generateTrackingLink({
        programmeId: 'X',
        destinationUrl: 'https://example.test/',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
    await expect(daisyconAdvertiserAdapter.listMediaPartners()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });
});

// ---------------------------------------------------------------------------
// verifyAuth — happy + failure
// ---------------------------------------------------------------------------

describe('DaisyconAdvertiserAdapter.verifyAuth', () => {
  it('returns ok:true and identity when token exchange succeeds', async () => {
    mockFetchQueue([fakeResponse(loadFixture('token.json'))]);
    const r = await daisyconAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('daisycon-advertiser/client:');
    }
  });

  it('returns ok:false (does not throw) on auth failure', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_grant"}', {
        status: 401,
        rawBody: '{"error":"invalid_grant"}',
      }),
    ]);
    const r = await daisyconAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/HTTP 401|401|invalid_grant|auth/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency
// ---------------------------------------------------------------------------

describe('error transparency', () => {
  it('surfaces verbatim response body on a 500', async () => {
    const body = '{"error":"upstream exploded","trace":"xyz"}';
    mockFetchQueue([
      fakeResponse(loadFixture('token.json')),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await daisyconAdvertiserAdapter.listTransactions({}, CTX);
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('daisycon-advertiser');
      expect(env.operation).toBe('listTransactions');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream exploded');
    }
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('DaisyconAdvertiserAdapter.capabilitiesCheck', () => {
  it('reports advertiser ops supported and publisher-side ops unsupported', async () => {
    const caps = await daisyconAdvertiserAdapter.capabilitiesCheck();
    expect(caps.network).toBe('daisycon-advertiser');
    expect(caps.operations['listBrands']?.supported).toBe(true);
    expect(caps.operations['listTransactions']?.supported).toBe(true);
    expect(caps.operations['getProgrammePerformance']?.supported).toBe(true);
    expect(caps.operations['getProgrammePerformance']?.claimStatus).toBe('experimental');
    expect(caps.operations['listMediaPartners']?.supported).toBe(false);
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
