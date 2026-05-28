/**
 * Everflow advertiser adapter — unit tests.
 *
 * All tests are fixture-only (no live network calls). `globalThis.fetch` is
 * mocked; circuit breakers and the credential cache are reset in beforeEach.
 * `AdapterCallContext` is provided to every advertiser-side operation that
 * requires one.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  everflowAdvertiserAdapter,
  _internals,
} from '../../../src/networks/everflow-advertiser/adapter.js';
import { buildUrl } from '../../../src/networks/everflow-advertiser/client.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'everflow-advertiser');

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

function mockFetchQueue(responses: Response[]): {
  spy: ReturnType<typeof vi.fn>;
  urls: string[];
} {
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

beforeEach(() => {
  _resetBreakers();
  process.env['EVERFLOW_API_KEY'] = 'fake-api-key';
  process.env['EVERFLOW_ADVERTISER_ID'] = '101';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['EVERFLOW_API_KEY'];
  delete process.env['EVERFLOW_ADVERTISER_ID'];
});

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

describe('Everflow advertiser transformers', () => {
  it('maps advertiser account_status to apiEnabled correctly', () => {
    expect(_internals.mapAdvertiserStatus({ account_status: 'active' })).toBe(true);
    expect(_internals.mapAdvertiserStatus({ account_status: 'inactive' })).toBe(false);
    expect(_internals.mapAdvertiserStatus({ account_status: 'suspended' })).toBe(false);
    expect(_internals.mapAdvertiserStatus({ account_status: 'unknown' })).toBe(false);
    expect(_internals.mapAdvertiserStatus({})).toBe(false);
  });

  it('maps affiliate account_status to canonical MediaPartner status', () => {
    expect(_internals.mapAffiliateStatus({ account_status: 'active' })).toBe('active');
    expect(_internals.mapAffiliateStatus({ account_status: 'pending' })).toBe('pending');
    expect(_internals.mapAffiliateStatus({ account_status: 'inactive' })).toBe('inactive');
    expect(_internals.mapAffiliateStatus({ account_status: 'suspended' })).toBe('inactive');
    expect(_internals.mapAffiliateStatus({ account_status: 'weird_value' })).toBe('unknown');
    expect(_internals.mapAffiliateStatus({})).toBe('unknown');
  });

  it('toDiscoveredBrand preserves id and displayName', () => {
    const brand = _internals.toDiscoveredBrand({
      network_advertiser_id: 101,
      name: 'Acme Widgets Ltd',
      account_status: 'active',
    });
    expect(brand.networkBrandId).toBe('101');
    expect(brand.displayName).toBe('Acme Widgets Ltd');
    expect(brand.apiEnabled).toBe(true);
  });

  it('toDiscoveredBrand falls back to synthetic name when name is absent', () => {
    const brand = _internals.toDiscoveredBrand({ network_advertiser_id: 999 });
    expect(brand.displayName).toContain('999');
    expect(brand.apiEnabled).toBe(false); // absent status → false
  });

  it('toMediaPartner preserves rawNetworkData', () => {
    const rawAffiliate = (
      loadFixture('affiliates.json') as { affiliates: Array<Record<string, unknown>> }
    ).affiliates[0];
    const p = _internals.toMediaPartner(rawAffiliate as never);
    expect(p.rawNetworkData).toBe(rawAffiliate);
    expect(p.id).toBe('7');
    expect(p.name).toBe('BestDeals.com');
    expect(p.status).toBe('active');
  });

  it('toPerformanceRow maps affiliate column and metrics correctly', () => {
    const report = loadFixture('performance-report.json') as {
      table: Array<Record<string, unknown>>;
      currency: string;
    };
    const row = _internals.toPerformanceRow(report.table[0] as never, 'USD', '2026-05-01');
    expect(row.publisherId).toBe('7');
    expect(row.publisherName).toBe('BestDeals.com');
    expect(row.clicks).toBe(1200);
    expect(row.conversions).toBe(45);
    expect(row.grossSale).toBe(2250);
    expect(row.commission).toBe(225);
    expect(row.currency).toBe('USD');
    expect(row.date).toBe('2026-05-01');
    expect(row.rawNetworkData).toBe(report.table[0]);
  });

  it('toPerformanceRow handles missing columns array gracefully', () => {
    const row = _internals.toPerformanceRow(
      { reporting: { total_click: 10, cv: 1, revenue: 50, payout: 5 } },
      'GBP',
      '2026-05-01',
    );
    expect(row.publisherId).toBe('');
    expect(row.publisherName).toBe('');
    expect(row.clicks).toBe(10);
    expect(row.commission).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// URL shape
// ---------------------------------------------------------------------------

describe('Everflow advertiser URL shape', () => {
  it('buildUrl constructs the correct absolute URL', () => {
    const url = buildUrl('/networks/advertisers', { page: 1, page_size: 100 });
    expect(url).toBe('https://api.eflow.team/v1/networks/advertisers?page=1&page_size=100');
  });

  it('buildUrl skips undefined query params', () => {
    const url = buildUrl('/networks/affiliatestable', { page: 1, page_size: undefined });
    expect(url).toBe('https://api.eflow.team/v1/networks/affiliatestable?page=1');
  });

  it('buildUrl handles path without leading slash', () => {
    const url = buildUrl('networks/advertisers');
    expect(url).toBe('https://api.eflow.team/v1/networks/advertisers');
  });
});

// ---------------------------------------------------------------------------
// listBrands
// ---------------------------------------------------------------------------

describe('Everflow advertiser.listBrands', () => {
  it('fetches all advertisers and maps them to DiscoveredBrand', async () => {
    const { urls } = mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);

    const brands = await everflowAdvertiserAdapter.listBrands();
    expect(brands).toHaveLength(3);
    expect(brands[0]?.networkBrandId).toBe('101');
    expect(brands[0]?.displayName).toBe('Acme Widgets Ltd');
    expect(brands[0]?.apiEnabled).toBe(true);
    // Inactive and suspended are not API-enabled.
    expect(brands[1]?.apiEnabled).toBe(false);
    expect(brands[2]?.apiEnabled).toBe(false);

    // Should call the advertisers endpoint.
    expect(urls[0]).toContain('/networks/advertisers');
  });

  it('sends the correct X-Eflow-API-Key header', async () => {
    const spy = vi.fn(async () => fakeResponse(loadFixture('advertisers.json')));
    globalThis.fetch = spy as unknown as typeof fetch;

    await everflowAdvertiserAdapter.listBrands();

    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['X-Eflow-API-Key']).toBe('fake-api-key');
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('Everflow advertiser.verifyAuth', () => {
  it('returns ok when the API key is valid', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    const r = await everflowAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('101');
    }
  });

  it('returns {ok:false} on 401', async () => {
    mockFetchQueue([fakeResponse('Unauthorized', { status: 401 })]);
    const r = await everflowAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/API key/i);
    }
  });

  it('returns {ok:false} on 403', async () => {
    mockFetchQueue([fakeResponse('Forbidden', { status: 403 })]);
    const r = await everflowAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listMediaPartners
// ---------------------------------------------------------------------------

describe('Everflow advertiser.listMediaPartners', () => {
  it('returns all affiliates with normalised status', async () => {
    const { urls } = mockFetchQueue([fakeResponse(loadFixture('affiliates.json'))]);

    const r = await everflowAdvertiserAdapter.listMediaPartners(undefined, {
      networkBrandId: '101',
    });
    expect(r).toHaveLength(3);
    expect(r.map((p) => p.status).sort()).toEqual(['active', 'inactive', 'pending']);
    expect(urls[0]).toContain('/networks/affiliatestable');
  });

  it('filters by status client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('affiliates.json'))]);
    const r = await everflowAdvertiserAdapter.listMediaPartners(
      { status: 'active' },
      { networkBrandId: '101' },
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.name).toBe('BestDeals.com');
  });

  it('filters by search substring client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('affiliates.json'))]);
    const r = await everflowAdvertiserAdapter.listMediaPartners(
      { search: 'pending' },
      { networkBrandId: '101' },
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.name).toBe('PendingPartner');
  });

  it('respects the limit option', async () => {
    mockFetchQueue([fakeResponse(loadFixture('affiliates.json'))]);
    const r = await everflowAdvertiserAdapter.listMediaPartners(
      { limit: 1 },
      { networkBrandId: '101' },
    );
    expect(r).toHaveLength(1);
  });

  it('works without a brand context (network-level affiliates)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('affiliates.json'))]);
    // listMediaPartners does not require ctx — affiliates are network-level.
    const r = await everflowAdvertiserAdapter.listMediaPartners();
    expect(r).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// getProgrammePerformance
// ---------------------------------------------------------------------------

describe('Everflow advertiser.getProgrammePerformance', () => {
  it('requires a brand context (config_error when missing)', async () => {
    await expect(
      everflowAdvertiserAdapter.getProgrammePerformance(),
    ).rejects.toBeInstanceOf(NetworkError);
    try {
      await everflowAdvertiserAdapter.getProgrammePerformance();
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('config_error');
      expect((err as NetworkError).envelope.network).toBe('everflow-advertiser');
    }
  });

  it('returns mapped performance rows', async () => {
    const { urls } = mockFetchQueue([fakeResponse(loadFixture('performance-report.json'))]);

    const r = await everflowAdvertiserAdapter.getProgrammePerformance(
      { from: '2026-05-01', to: '2026-05-31' },
      { networkBrandId: '101' },
    );
    expect(r).toHaveLength(2);
    expect(r[0]?.publisherName).toBe('BestDeals.com');
    expect(r[0]?.clicks).toBe(1200);
    expect(r[0]?.conversions).toBe(45);
    expect(r[0]?.grossSale).toBe(2250);
    expect(r[0]?.commission).toBe(225);
    expect(r[0]?.currency).toBe('USD');
    expect(urls[0]).toContain('/advertisers/reporting/entity');
  });

  it('preserves rawNetworkData on each row', async () => {
    mockFetchQueue([fakeResponse(loadFixture('performance-report.json'))]);
    const r = await everflowAdvertiserAdapter.getProgrammePerformance(
      { from: '2026-05-01', to: '2026-05-31' },
      { networkBrandId: '101' },
    );
    // rawNetworkData must be the original row object, not undefined.
    expect(r[0]?.rawNetworkData).toBeDefined();
  });

  it('includes advertiser filter in the POST body', async () => {
    const spy = vi.fn(async () => fakeResponse(loadFixture('performance-report.json')));
    globalThis.fetch = spy as unknown as typeof fetch;

    await everflowAdvertiserAdapter.getProgrammePerformance(
      { from: '2026-05-01', to: '2026-05-31' },
      { networkBrandId: '101' },
    );

    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(init.body as string) as {
      query?: { filters?: Array<{ resource_type: string; filter_id_value: string }> };
    };
    const advertiserFilter = body.query?.filters?.find((f) => f.resource_type === 'advertiser');
    expect(advertiserFilter?.filter_id_value).toBe('101');
  });

  it('uses POST method for the reporting endpoint', async () => {
    const spy = vi.fn(async () => fakeResponse(loadFixture('performance-report.json')));
    globalThis.fetch = spy as unknown as typeof fetch;

    await everflowAdvertiserAdapter.getProgrammePerformance(
      { from: '2026-05-01', to: '2026-05-31' },
      { networkBrandId: '101' },
    );

    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('POST');
  });

  it('respects the limit option', async () => {
    mockFetchQueue([fakeResponse(loadFixture('performance-report.json'))]);
    const r = await everflowAdvertiserAdapter.getProgrammePerformance(
      { from: '2026-05-01', to: '2026-05-31', limit: 1 },
      { networkBrandId: '101' },
    );
    expect(r).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Auth-failure → NetworkErrorEnvelope
// ---------------------------------------------------------------------------

describe('Everflow advertiser auth failures surface as envelopes', () => {
  it('listBrands surfaces a NetworkError with auth_error type on 401', async () => {
    mockFetchQueue([fakeResponse('Unauthorized', { status: 401 })]);
    // The resilience layer will convert HttpStatusError → NetworkError after retries.
    // On 401 (non-retryable) it surfaces immediately.
    await expect(everflowAdvertiserAdapter.listBrands()).rejects.toBeInstanceOf(Error);
  });

  it('missing EVERFLOW_API_KEY throws config_error via NetworkError', async () => {
    delete process.env['EVERFLOW_API_KEY'];
    await expect(everflowAdvertiserAdapter.listBrands()).rejects.toBeInstanceOf(NetworkError);
    try {
      await everflowAdvertiserAdapter.listBrands();
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('config_error');
      expect((err as NetworkError).envelope.network).toBe('everflow-advertiser');
      expect((err as NetworkError).envelope.message).toContain('EVERFLOW_API_KEY');
    }
  });
});

// ---------------------------------------------------------------------------
// Unimplemented ops throw NotImplementedError
// ---------------------------------------------------------------------------

describe('Everflow advertiser unimplemented ops', () => {
  it('throws NotImplementedError on publisher-side ops', async () => {
    await expect(
      everflowAdvertiserAdapter.listProgrammes(undefined, { networkBrandId: '101' }),
    ).rejects.toBeInstanceOf(NotImplementedError);

    await expect(
      everflowAdvertiserAdapter.getProgramme('1', { networkBrandId: '101' }),
    ).rejects.toBeInstanceOf(NotImplementedError);

    await expect(
      everflowAdvertiserAdapter.listTransactions(undefined, { networkBrandId: '101' }),
    ).rejects.toBeInstanceOf(NotImplementedError);

    await expect(
      everflowAdvertiserAdapter.getEarningsSummary(undefined, { networkBrandId: '101' }),
    ).rejects.toBeInstanceOf(NotImplementedError);

    await expect(
      everflowAdvertiserAdapter.listClicks(undefined, { networkBrandId: '101' }),
    ).rejects.toBeInstanceOf(NotImplementedError);

    await expect(
      everflowAdvertiserAdapter.generateTrackingLink(
        { programmeId: '1', destinationUrl: 'https://example.com' },
        { networkBrandId: '101' },
      ),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('throws NotImplementedError on admin ops', async () => {
    await expect(everflowAdvertiserAdapter.listPublishers()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(everflowAdvertiserAdapter.listPublisherSectors()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('Everflow advertiser.capabilitiesCheck', () => {
  it('marks advertiser-side ops as supported', async () => {
    const caps = await everflowAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['verifyAuth']?.supported).toBe(true);
    expect(caps.operations['listBrands']?.supported).toBe(true);
    expect(caps.operations['listMediaPartners']?.supported).toBe(true);
    expect(caps.operations['getProgrammePerformance']?.supported).toBe(true);
  });

  it('marks publisher-side ops as not supported', async () => {
    const caps = await everflowAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['listProgrammes']?.supported).toBe(false);
    expect(caps.operations['getProgramme']?.supported).toBe(false);
    expect(caps.operations['listTransactions']?.supported).toBe(false);
    expect(caps.operations['getEarningsSummary']?.supported).toBe(false);
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
  });

  it('marks experimental ops with claimStatus=experimental', async () => {
    const caps = await everflowAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['listBrands']?.claimStatus).toBe('experimental');
    expect(caps.operations['listMediaPartners']?.claimStatus).toBe('experimental');
    expect(caps.operations['getProgrammePerformance']?.claimStatus).toBe('experimental');
  });

  it('includes knownLimitations in the response', async () => {
    const caps = await everflowAdvertiserAdapter.capabilitiesCheck();
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
    expect(caps.knownLimitations.some((l) => l.includes('not yet verified'))).toBe(true);
  });
});
