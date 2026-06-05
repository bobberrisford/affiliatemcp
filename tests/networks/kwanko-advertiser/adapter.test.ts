/**
 * Kwanko advertiser adapter — unit tests.
 *
 * Exercises listBrands, getProgrammePerformance (with ctx), status mapping,
 * raw preservation, the read-only client guard, the NotImplemented ops, and
 * verifyAuth ok+fail. Deterministic: mock fetch queue, reset breakers, fake
 * creds in env, fixtures from tests/fixtures/kwanko-advertiser/.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  kwankoAdvertiserAdapter,
  _internals,
} from '../../../src/networks/kwanko-advertiser/adapter.js';
import { buildUrl, kwankoAdvRequest } from '../../../src/networks/kwanko-advertiser/client.js';
import { _resetBreakers, DEFAULT_RESILIENCE } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'kwanko-advertiser');

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

/** Queue mock fetch responses and capture the URLs called. */
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

const CTX = { networkBrandId: 'CAMP-1001' };

beforeEach(() => {
  _resetBreakers();
  process.env['KWANKO_ADVERTISER_API_TOKEN'] = 'fake-token';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['KWANKO_ADVERTISER_API_TOKEN'];
});

// ---------------------------------------------------------------------------
// Transformers + status mapping
// ---------------------------------------------------------------------------

describe('Kwanko advertiser transformers', () => {
  it('maps conversion status to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'validated' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'paid' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ status: 'refused' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'weird' })).toBe('other');
  });

  it('maps statistics-row status to the 3-value performance status', () => {
    expect(_internals.mapPerformanceStatus({ status: 'validated' })).toBe('approved');
    expect(_internals.mapPerformanceStatus({ status: 'refused' })).toBe('reversed');
    expect(_internals.mapPerformanceStatus({ status: 'pending' })).toBe('pending');
    // Missing status defaults to pending.
    expect(_internals.mapPerformanceStatus({})).toBe('pending');
  });

  it('maps campaign status to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ status: 'active' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'paused' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ status: 'mystery' })).toBe('unknown');
  });

  it('normalises a performance row to yyyy-mm-dd with numeric metrics', () => {
    const row = _internals.toPerformanceRow({
      date: '2026-05-01',
      site_id: 'SITE-77',
      site_name: 'BestDeals.fr',
      clicks: '1200',
      conversions: '18',
      amount: '2400.00',
      commission: '240.00',
      currency: 'eur',
      status: 'validated',
    });
    expect(row.date).toBe('2026-05-01');
    expect(row.publisherId).toBe('SITE-77');
    expect(row.publisherName).toBe('BestDeals.fr');
    expect(row.clicks).toBe(1200);
    expect(row.conversions).toBe(18);
    expect(row.grossSale).toBe(2400);
    expect(row.commission).toBe(240);
    expect(row.currency).toBe('EUR');
    expect(row.status).toBe('approved');
  });

  it('preserves raw network data on every domain transform', () => {
    const conv = (loadFixture('conversions.json') as { data: Array<Record<string, unknown>> })
      .data[0];
    const t = _internals.toTransaction(conv as never);
    expect(t.rawNetworkData).toBe(conv);

    const stat = (loadFixture('statistics-by-publisher.json') as {
      data: Array<Record<string, unknown>>;
    }).data[0];
    const row = _internals.toPerformanceRow(stat as never);
    expect(row.rawNetworkData).toBe(stat);

    const camp = (loadFixture('campaigns.json') as { data: Array<Record<string, unknown>> })
      .data[0];
    const p = _internals.toProgramme(camp as never);
    expect(p.rawNetworkData).toBe(camp);
  });

  it('derives apiEnabled=false only when a campaign flag says so', () => {
    const brand = _internals.toDiscoveredBrand({ id: 'CAMP-1003', api_enabled: false });
    expect(brand.apiEnabled).toBe(false);
    const dflt = _internals.toDiscoveredBrand({ id: 'CAMP-1001' });
    expect(dflt.apiEnabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// URL shape
// ---------------------------------------------------------------------------

describe('Kwanko advertiser URL shape', () => {
  it('joins path + query against the base URL', () => {
    const url = buildUrl('https://api.kwanko.com', '/advertiser/statistics', {
      debut: '2026-05-01',
      fin: '2026-05-31',
      camp: 'CAMP-1001',
      group: 'website',
      skip: undefined,
    });
    expect(url).toBe(
      'https://api.kwanko.com/advertiser/statistics?debut=2026-05-01&fin=2026-05-31&camp=CAMP-1001&group=website',
    );
  });
});

// ---------------------------------------------------------------------------
// Read-only guard
// ---------------------------------------------------------------------------

describe('Kwanko advertiser read-only guard', () => {
  it('refuses any non-GET method with a config_error envelope', async () => {
    const promise = kwankoAdvRequest({
      operation: 'listProgrammes',
      path: '/advertiser/campaigns',
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

describe('Kwanko advertiser.listBrands', () => {
  it('enumerates campaigns as brands, one per campaign', async () => {
    const { urls } = mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const brands = await kwankoAdvertiserAdapter.listBrands();
    expect(brands).toHaveLength(3);
    expect(brands[0]?.networkBrandId).toBe('CAMP-1001');
    expect(brands[0]?.displayName).toBe('Acme Widgets FR');
    expect(brands[2]?.apiEnabled).toBe(false);
    expect(urls[0]).toContain('/advertiser/campaigns');
  });

  it('returns an empty list when the advertiser has no campaigns', async () => {
    mockFetchQueue([fakeResponse(loadFixture('empty.json'))]);
    const brands = await kwankoAdvertiserAdapter.listBrands();
    expect(brands).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('Kwanko advertiser.listProgrammes', () => {
  it('returns the brand campaign scoped to the ctx campaign id', async () => {
    const { urls } = mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const r = await kwankoAdvertiserAdapter.listProgrammes(undefined, CTX);
    expect(r).toHaveLength(1);
    expect(r[0]?.id).toBe('CAMP-1001');
    expect(r[0]?.status).toBe('joined');
    expect(urls[0]).toContain('/advertiser/campaigns');
    expect(urls[0]).toContain('camp=CAMP-1001');
  });

  it('refuses to run without a brand context (config_error)', async () => {
    await expect(kwankoAdvertiserAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
    try {
      await kwankoAdvertiserAdapter.listProgrammes();
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('config_error');
    }
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('Kwanko advertiser.listTransactions', () => {
  it('returns transformed conversions for the brand', async () => {
    const { urls } = mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const r = await kwankoAdvertiserAdapter.listTransactions(undefined, CTX);
    expect(r).toHaveLength(3);
    expect(r.map((t) => t.status).sort()).toEqual(['approved', 'pending', 'reversed']);
    expect(urls[0]).toContain('/advertiser/conversions');
  });

  it('surfaces refusal reason on reversed conversions and filters by status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const r = await kwankoAdvertiserAdapter.listTransactions({ status: 'reversed' }, CTX);
    expect(r).toHaveLength(1);
    expect(r[0]?.reversalReason).toBe(
      'Order cancelled by the customer within the cooling-off period',
    );
  });
});

// ---------------------------------------------------------------------------
// getProgrammePerformance — per-publisher rollup
// ---------------------------------------------------------------------------

describe('Kwanko advertiser.getProgrammePerformance', () => {
  it('returns per-publisher rows grouped by website', async () => {
    const { urls } = mockFetchQueue([
      fakeResponse(loadFixture('statistics-by-publisher.json')),
    ]);
    const r = await kwankoAdvertiserAdapter.getProgrammePerformance(
      { from: '2026-05-01', to: '2026-05-31' },
      CTX,
    );
    expect(r).toHaveLength(3);
    // Stable order: by date then publisherId.
    expect(r[0]?.date).toBe('2026-05-01');
    expect(r[0]?.publisherId).toBe('SITE-77');
    expect(r[0]?.clicks).toBe(1200);
    expect(r[0]?.status).toBe('approved');
    expect(urls[0]).toContain('/advertiser/statistics');
    expect(urls[0]).toContain('group=website');
    expect(urls[0]).toContain('camp=CAMP-1001');
  });

  it('filters rows by publisherId when supplied', async () => {
    mockFetchQueue([fakeResponse(loadFixture('statistics-by-publisher.json'))]);
    const r = await kwankoAdvertiserAdapter.getProgrammePerformance(
      { publisherId: 'SITE-88' },
      CTX,
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.publisherName).toBe('CouponHero.fr');
    expect(r[0]?.status).toBe('pending');
  });

  it('refuses to run without a brand context (config_error)', async () => {
    await expect(kwankoAdvertiserAdapter.getProgrammePerformance()).rejects.toBeInstanceOf(
      NetworkError,
    );
    try {
      await kwankoAdvertiserAdapter.getProgrammePerformance();
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('config_error');
    }
  });
});

// ---------------------------------------------------------------------------
// Ops not implemented at v0.1
// ---------------------------------------------------------------------------

describe('Kwanko advertiser unimplemented ops', () => {
  it('throws NotImplementedError on getProgramme / getEarningsSummary / listClicks / generateTrackingLink', async () => {
    await expect(kwankoAdvertiserAdapter.getProgramme('X')).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(kwankoAdvertiserAdapter.getEarningsSummary()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(kwankoAdvertiserAdapter.listClicks()).rejects.toBeInstanceOf(NotImplementedError);
    await expect(
      kwankoAdvertiserAdapter.generateTrackingLink({
        programmeId: 'X',
        destinationUrl: 'https://example.com',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('throws NotImplementedError on the admin ops', async () => {
    await expect(kwankoAdvertiserAdapter.listPublishers()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(kwankoAdvertiserAdapter.listPublisherSectors()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('Kwanko advertiser.verifyAuth', () => {
  it('returns ok with a token-fingerprint identity on success', async () => {
    mockFetchQueue([fakeResponse(loadFixture('empty.json'))]);
    const r = await kwankoAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('kwanko-advertiser/token:');
    }
  });

  it('returns {ok:false} on a 401', async () => {
    mockFetchQueue([fakeResponse('unauthorized', { status: 401 })]);
    const r = await kwankoAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('Kwanko advertiser.capabilitiesCheck', () => {
  it('marks the brand-scoped ops experimental and the unsupported ops unsupported', async () => {
    const caps = await kwankoAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['getProgrammePerformance']?.claimStatus).toBe('experimental');
    expect(caps.operations['listBrands']?.claimStatus).toBe('experimental');
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
    expect(caps.operations['getProgramme']?.supported).toBe(false);
    expect(caps.knownLimitations[0]).toBe(
      'Adapter built from public API documentation; not yet verified against a live account.',
    );
  });
});
