/**
 * Partnerize advertiser adapter — unit tests.
 *
 * All tests are fixture-only (no live calls). `globalThis.fetch` is mocked with
 * a queued response list. Circuit breakers are reset and fake credentials are
 * injected via `process.env` in `beforeEach`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  partnerizeAdvertiserAdapter,
  _internals,
} from '../../../src/networks/partnerize-advertiser/adapter.js';
import { buildUrl } from '../../../src/networks/partnerize-advertiser/client.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';
import { DEFAULT_RESILIENCE } from '../../../src/shared/resilience.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'partnerize-advertiser');

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
  process.env['PARTNERIZE_APPLICATION_KEY'] = 'test-app-key-1234';
  process.env['PARTNERIZE_USER_API_KEY'] = 'test-user-key-5678';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['PARTNERIZE_APPLICATION_KEY'];
  delete process.env['PARTNERIZE_USER_API_KEY'];
});

// ---------------------------------------------------------------------------
// Transformer unit tests
// ---------------------------------------------------------------------------

describe('Partnerize advertiser transformers', () => {
  it('maps campaign status to canonical ProgrammeStatus', () => {
    expect(_internals.mapCampaignStatus({ status: 'active' })).toBe('joined');
    expect(_internals.mapCampaignStatus({ status: 'live' })).toBe('joined');
    expect(_internals.mapCampaignStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapCampaignStatus({ status: 'paused' })).toBe('suspended');
    expect(_internals.mapCampaignStatus({ status: 'closed' })).toBe('suspended');
    expect(_internals.mapCampaignStatus({ status: 'declined' })).toBe('declined');
    expect(_internals.mapCampaignStatus({ status: 'unrecognised' })).toBe('unknown');
    expect(_internals.mapCampaignStatus({})).toBe('unknown');
  });

  it('maps conversion status to canonical TransactionStatus', () => {
    // Full string values confirmed from PerformanceHorizonGroup/apidocs data/common.apib.
    expect(_internals.mapConversionStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapConversionStatus({ status: 'approved' })).toBe('approved');
    expect(_internals.mapConversionStatus({ status: 'validated' })).toBe('approved');
    expect(_internals.mapConversionStatus({ status: 'rejected' })).toBe('reversed');
    expect(_internals.mapConversionStatus({ status: 'reversed' })).toBe('reversed');
    expect(_internals.mapConversionStatus({ status: 'paid' })).toBe('paid');
    expect(_internals.mapConversionStatus({ status: 'weird' })).toBe('other');
    // Single-letter codes from publisher_campaign.apib (v1 API); handled defensively.
    expect(_internals.mapConversionStatus({ status: 'a' })).toBe('approved');
    expect(_internals.mapConversionStatus({ status: 'p' })).toBe('pending');
    expect(_internals.mapConversionStatus({ status: 'r' })).toBe('reversed');
  });

  it('maps publisher status to active|pending|inactive|unknown', () => {
    // Full string values.
    expect(_internals.mapPublisherStatus({ status: 'active' })).toBe('active');
    expect(_internals.mapPublisherStatus({ status: 'approved' })).toBe('active');
    expect(_internals.mapPublisherStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapPublisherStatus({ status: 'inactive' })).toBe('inactive');
    expect(_internals.mapPublisherStatus({ status: 'declined' })).toBe('inactive');
    expect(_internals.mapPublisherStatus({ status: 'unrecognised' })).toBe('unknown');
    // Single-letter codes from publisher_campaign.apib.
    expect(_internals.mapPublisherStatus({ status: 'a' })).toBe('active');
    expect(_internals.mapPublisherStatus({ status: 'p' })).toBe('pending');
    expect(_internals.mapPublisherStatus({ status: 'r' })).toBe('inactive');
    // campaign_status field preferred over status.
    expect(_internals.mapPublisherStatus({ status: 'inactive', campaign_status: 'a' })).toBe('active');
  });

  it('preserves rawNetworkData on every domain transform', () => {
    const raw = (loadFixture('conversions.json') as {
      conversions: Array<Record<string, unknown>>;
    }).conversions[0];
    const t = _internals.toTransaction(raw as never, new Date('2026-05-28T00:00:00Z'));
    expect(t.rawNetworkData).toBe(raw);

    const pub = (loadFixture('publishers.json') as {
      publishers: Array<Record<string, unknown>>;
    }).publishers[0];
    const mp = _internals.toMediaPartner(pub as never);
    expect(mp.rawNetworkData).toBe(pub);

    const cam = (loadFixture('campaigns.json') as {
      campaigns: Array<Record<string, unknown>>;
    }).campaigns[0];
    const prog = _internals.toProgramme(cam as never);
    expect(prog.rawNetworkData).toBe(cam);
  });

  it('surfaces rejection_reason on reversed conversions', () => {
    const raw = (loadFixture('conversions.json') as {
      conversions: Array<Record<string, unknown>>;
    }).conversions[2];
    const t = _internals.toTransaction(raw as never, new Date('2026-05-28T00:00:00Z'));
    expect(t.status).toBe('reversed');
    expect(t.reversalReason).toBe('Item returned within 30 days');
  });

  it('normalises performance metric dates to yyyy-mm-dd', () => {
    const row = _internals.toPerformanceRow({
      date: '2026-05-01T00:00:00Z',
      publisher_id: 'PUB-201',
      publisher_name: 'BestDealsDaily',
      clicks: 500,
      conversions: 8,
      sale_amount: '960.00',
      commission: '96.00',
      currency: 'GBP',
      status: 'approved',
    });
    expect(row.date).toBe('2026-05-01');
    expect(row.clicks).toBe(500);
    expect(row.conversions).toBe(8);
    expect(row.grossSale).toBe(960);
    expect(row.commission).toBe(96);
    expect(row.status).toBe('approved');
    expect(row.currency).toBe('GBP');
  });

  it('computes ageDays relative to the injected `now`', () => {
    const raw = {
      conversion_id: 'X',
      approved_at: '2026-04-28T00:00:00Z',
      conversion_time: '2026-04-20T00:00:00Z',
    };
    const now = new Date('2026-05-28T00:00:00Z');
    // ageDays should be anchored on approved_at (30 days before now)
    const age = _internals.computeAgeDays(raw, now);
    expect(age).toBe(30);
  });

  it('resolves conversion date from conversion_date_time alias when conversion_time absent', () => {
    // export_reporting.apib confirms conversion_date_time as an alternate field name.
    const raw = {
      conversion_id: 'Y',
      conversion_date_time: '2026-04-28T00:00:00Z',
    };
    const now = new Date('2026-05-28T00:00:00Z');
    const age = _internals.computeAgeDays(raw, now);
    expect(age).toBe(30);
  });

  it('handles `value` and `publisher_commission` field aliases in toTransaction', () => {
    // data/reporting.apib confirms `value` (not sale_amount) and
    // `publisher_commission` (not commission) as the primary field names.
    const now = new Date('2026-05-28T00:00:00Z');
    const raw = {
      conversion_id: 'Z1',
      campaign_id: 'CAM-1001',
      status: 'approved',
      value: '150.00',
      publisher_commission: '15.00',
      currency: 'GBP',
      conversion_time: '2026-05-01T00:00:00Z',
    };
    const t = _internals.toTransaction(raw as never, now);
    expect(t.amount).toBe(150);
    expect(t.commission).toBe(15);
  });

  it('handles reject_reason alias (campaign_conversion.apib) in toTransaction', () => {
    // campaign_conversion.apib uses `reject_reason` not `rejection_reason`.
    const now = new Date('2026-05-28T00:00:00Z');
    const raw = {
      conversion_id: 'Z2',
      campaign_id: 'CAM-1001',
      status: 'rejected',
      value: '50.00',
      publisher_commission: '5.00',
      currency: 'GBP',
      conversion_time: '2026-05-01T00:00:00Z',
      reject_reason: 'Duplicate order',
    };
    const t = _internals.toTransaction(raw as never, now);
    expect(t.status).toBe('reversed');
    expect(t.reversalReason).toBe('Duplicate order');
  });

  it('uses account_name as publisher name fallback in toMediaPartner', () => {
    // data/publisher.apib confirms `account_name` as a publisher field.
    const raw = { publisher_id: 'PUB-999', account_name: 'My Publisher Co' };
    const mp = _internals.toMediaPartner(raw as never);
    expect(mp.name).toBe('My Publisher Co');
  });

  it('toDiscoveredBrand marks paused campaigns as apiEnabled=false', () => {
    const raw = (loadFixture('campaigns.json') as {
      campaigns: Array<Record<string, unknown>>;
    }).campaigns[2];
    const brand = _internals.toDiscoveredBrand(raw as never);
    expect(brand.apiEnabled).toBe(false);
    expect(brand.displayName).toContain('Paused');
  });
});

// ---------------------------------------------------------------------------
// buildUrl helper
// ---------------------------------------------------------------------------

describe('Partnerize advertiser buildUrl', () => {
  it('builds a URL from a relative path', () => {
    const url = buildUrl('/v3/brand/campaigns');
    expect(url).toBe('https://api.partnerize.com/v3/brand/campaigns');
  });

  it('appends query parameters, omitting undefined values', () => {
    const url = buildUrl('/v3/brand/campaigns', {
      limit: 50,
      start_date: undefined,
      end_date: '2026-05-31',
    });
    expect(url).toContain('limit=50');
    expect(url).toContain('end_date=2026-05-31');
    expect(url).not.toContain('start_date');
  });
});

// ---------------------------------------------------------------------------
// Read-only guard
// ---------------------------------------------------------------------------

describe('Partnerize advertiser read-only guard', () => {
  it('refuses POST with a config_error envelope', async () => {
    const { partnerizeAdvRequest } = await import(
      '../../../src/networks/partnerize-advertiser/client.js'
    );
    const promise = partnerizeAdvRequest({
      operation: 'verifyAuth',
      path: '/v3/brand/campaigns',
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

describe('Partnerize advertiser.verifyAuth', () => {
  it('returns ok=true with identity on 200 response', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const r = await partnerizeAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('partnerize-advertiser');
    }
  });

  it('returns ok=false on 401 (auth failure)', async () => {
    mockFetchQueue([fakeResponse('{"error":"unauthorized"}', { status: 401 })]);
    const r = await partnerizeAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/401|rejected|Application Key/i);
    }
  });

  it('returns ok=false on 403 (forbidden)', async () => {
    mockFetchQueue([fakeResponse('{"error":"forbidden"}', { status: 403 })]);
    const r = await partnerizeAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listBrands
// ---------------------------------------------------------------------------

describe('Partnerize advertiser.listBrands', () => {
  it('returns all campaigns as DiscoveredBrand[]', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const brands = await partnerizeAdvertiserAdapter.listBrands();
    expect(brands).toHaveLength(3);
    expect(brands[0]?.networkBrandId).toBe('CAM-1001');
    expect(brands[0]?.displayName).toBe('Acme Widgets UK');
    expect(brands[0]?.apiEnabled).toBe(true);
  });

  it('marks paused campaigns as apiEnabled=false', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const brands = await partnerizeAdvertiserAdapter.listBrands();
    const paused = brands.find((b) => b.networkBrandId === 'CAM-1003');
    expect(paused?.apiEnabled).toBe(false);
  });

  it('handles a plain array response (no envelope)', async () => {
    const rawList = (loadFixture('campaigns.json') as { campaigns: unknown[] }).campaigns;
    mockFetchQueue([fakeResponse(rawList)]);
    const brands = await partnerizeAdvertiserAdapter.listBrands();
    expect(brands).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('Partnerize advertiser.listProgrammes', () => {
  it('returns campaigns as Programme[] without requiring ctx', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const r = await partnerizeAdvertiserAdapter.listProgrammes();
    expect(r).toHaveLength(3);
    expect(r[0]?.id).toBe('CAM-1001');
    expect(r[0]?.name).toBe('Acme Widgets UK');
    expect(r[0]?.network).toBe('partnerize-advertiser');
  });

  it('filters by search substring client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const r = await partnerizeAdvertiserAdapter.listProgrammes({ search: 'Gadget' });
    expect(r).toHaveLength(1);
    expect(r[0]?.name).toBe('Gadget Store EU');
  });

  it('respects limit', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const r = await partnerizeAdvertiserAdapter.listProgrammes({ limit: 2 });
    expect(r).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('Partnerize advertiser.listTransactions', () => {
  it('throws config_error when ctx is missing', async () => {
    await expect(partnerizeAdvertiserAdapter.listTransactions()).rejects.toBeInstanceOf(NetworkError);
    try {
      await partnerizeAdvertiserAdapter.listTransactions();
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('config_error');
    }
  });

  it('returns transformed conversions for a campaign', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const r = await partnerizeAdvertiserAdapter.listTransactions(undefined, {
      networkBrandId: 'CAM-1001',
    });
    expect(r).toHaveLength(3);
    const statuses = r.map((t) => t.status).sort();
    expect(statuses).toEqual(['approved', 'pending', 'reversed']);
  });

  it('filters by status client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const r = await partnerizeAdvertiserAdapter.listTransactions(
      { status: 'reversed' },
      { networkBrandId: 'CAM-1001' },
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.reversalReason).toBe('Item returned within 30 days');
  });

  it('calls the correct URL for the campaign', async () => {
    const { urls } = mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    await partnerizeAdvertiserAdapter.listTransactions(undefined, { networkBrandId: 'CAM-1001' });
    expect(urls[0]).toContain('/v3/brand/campaigns/CAM-1001/conversions');
  });
});

// ---------------------------------------------------------------------------
// listMediaPartners
// ---------------------------------------------------------------------------

describe('Partnerize advertiser.listMediaPartners', () => {
  it('throws config_error when ctx is missing', async () => {
    await expect(partnerizeAdvertiserAdapter.listMediaPartners()).rejects.toBeInstanceOf(NetworkError);
  });

  it('returns normalised publisher roster', async () => {
    const { urls } = mockFetchQueue([fakeResponse(loadFixture('publishers.json'))]);
    const r = await partnerizeAdvertiserAdapter.listMediaPartners(undefined, {
      networkBrandId: 'CAM-1001',
    });
    expect(r).toHaveLength(3);
    const statuses = r.map((p) => p.status).sort();
    expect(statuses).toEqual(['active', 'inactive', 'pending']);
    expect(urls[0]).toContain('/v3/brand/campaigns/CAM-1001/publishers');
  });

  it('filters by status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('publishers.json'))]);
    const r = await partnerizeAdvertiserAdapter.listMediaPartners(
      { status: ['active'] },
      { networkBrandId: 'CAM-1001' },
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.name).toBe('BestDealsDaily');
  });

  it('filters by search substring', async () => {
    mockFetchQueue([fakeResponse(loadFixture('publishers.json'))]);
    const r = await partnerizeAdvertiserAdapter.listMediaPartners(
      { search: 'Coupon' },
      { networkBrandId: 'CAM-1001' },
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.name).toBe('CouponHub');
  });
});

// ---------------------------------------------------------------------------
// getProgrammePerformance
// ---------------------------------------------------------------------------

describe('Partnerize advertiser.getProgrammePerformance', () => {
  it('throws config_error when ctx is missing', async () => {
    await expect(partnerizeAdvertiserAdapter.getProgrammePerformance()).rejects.toBeInstanceOf(NetworkError);
  });

  it('returns metric rows with correct field mapping', async () => {
    const { urls } = mockFetchQueue([fakeResponse(loadFixture('metrics.json'))]);
    const r = await partnerizeAdvertiserAdapter.getProgrammePerformance(
      { from: '2026-05-01', to: '2026-05-31' },
      { networkBrandId: 'CAM-1001' },
    );
    expect(r).toHaveLength(2);
    expect(r[0]?.publisherName).toBe('BestDealsDaily');
    expect(r[0]?.clicks).toBe(850);
    expect(r[0]?.conversions).toBe(12);
    expect(r[0]?.commission).toBe(144);
    expect(r[0]?.status).toBe('approved');
    expect(urls[0]).toContain('/v3/brand/analytics/metrics');
    expect(urls[0]).toContain('campaign_id=CAM-1001');
  });

  it('scopes to publisherId when provided', async () => {
    const { urls } = mockFetchQueue([fakeResponse(loadFixture('metrics.json'))]);
    await partnerizeAdvertiserAdapter.getProgrammePerformance(
      { publisherId: 'PUB-201' },
      { networkBrandId: 'CAM-1001' },
    );
    expect(urls[0]).toContain('publisher_id=PUB-201');
  });
});

// ---------------------------------------------------------------------------
// Ops not implemented at v0.1
// ---------------------------------------------------------------------------

describe('Partnerize advertiser unimplemented ops', () => {
  it('throws NotImplementedError on getProgramme', async () => {
    await expect(partnerizeAdvertiserAdapter.getProgramme('X')).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });

  it('throws NotImplementedError on getEarningsSummary', async () => {
    await expect(partnerizeAdvertiserAdapter.getEarningsSummary()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });

  it('throws NotImplementedError on listClicks', async () => {
    await expect(partnerizeAdvertiserAdapter.listClicks()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });

  it('throws NotImplementedError on generateTrackingLink', async () => {
    await expect(
      partnerizeAdvertiserAdapter.generateTrackingLink({
        programmeId: 'X',
        destinationUrl: 'https://example.com',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('throws NotImplementedError on listPublishers', async () => {
    await expect(partnerizeAdvertiserAdapter.listPublishers()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });
});

// ---------------------------------------------------------------------------
// Auth failure envelope path
// ---------------------------------------------------------------------------

describe('Partnerize advertiser auth failure → envelope', () => {
  it('surfaces HTTP 401 from conversions endpoint as a NetworkError with auth_error type', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_credentials","message":"Unauthorized"}', { status: 401 }),
    ]);
    try {
      await partnerizeAdvertiserAdapter.listTransactions(undefined, { networkBrandId: 'CAM-1001' });
      expect.fail('Expected NetworkError');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const e = err as NetworkError;
      expect(e.envelope.type).toBe('auth_error');
      expect(e.envelope.network).toBe('partnerize-advertiser');
      expect(e.envelope.operation).toBe('listTransactions');
      expect(e.envelope.httpStatus).toBe(401);
    }
  });

  it('preserves the verbatim upstream body in networkErrorBody', async () => {
    const verbatimBody = '{"error":"server_error","code":500}';
    mockFetchQueue([fakeResponse(verbatimBody, { status: 500 })]);
    try {
      await partnerizeAdvertiserAdapter.listMediaPartners(undefined, { networkBrandId: 'CAM-1001' });
      expect.fail('Expected NetworkError');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const e = err as NetworkError;
      expect(e.envelope.networkErrorBody).toBe(verbatimBody);
    }
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('Partnerize advertiser.capabilitiesCheck', () => {
  it('marks implemented ops as supported', async () => {
    const caps = await partnerizeAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['verifyAuth']?.supported).toBe(true);
    expect(caps.operations['listBrands']?.supported).toBe(true);
    expect(caps.operations['listProgrammes']?.supported).toBe(true);
    expect(caps.operations['listTransactions']?.supported).toBe(true);
    expect(caps.operations['listMediaPartners']?.supported).toBe(true);
    expect(caps.operations['getProgrammePerformance']?.supported).toBe(true);
  });

  it('marks unsupported ops correctly', async () => {
    const caps = await partnerizeAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['getProgramme']?.supported).toBe(false);
    expect(caps.operations['getEarningsSummary']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
  });

  it('marks all experimental ops with claimStatus=experimental', async () => {
    const caps = await partnerizeAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['listBrands']?.claimStatus).toBe('experimental');
    expect(caps.operations['getProgrammePerformance']?.claimStatus).toBe('experimental');
  });
});
