/**
 * Admitad advertiser adapter — unit tests.
 *
 * Deterministic: mock fetch is queued (OAuth token POST first, then data GETs),
 * the resilience breakers + the OAuth token cache are reset before each test,
 * and fake credentials are injected in env. Fixtures live under
 * tests/fixtures/admitad-advertiser/.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  admitadAdvertiserAdapter,
  _internals,
} from '../../../src/networks/admitad-advertiser/adapter.js';
import { _resetTokenCache } from '../../../src/networks/admitad-advertiser/auth.js';
import {
  admitadAdvRequest,
  buildPath,
} from '../../../src/networks/admitad-advertiser/client.js';
import { _resetBreakers, DEFAULT_RESILIENCE } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'admitad-advertiser');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { 'content-type': 'application/json' } });
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

/** Standard OAuth token response (the first fetch in every authed flow). */
function tokenResponse(): Response {
  return fakeResponse(loadFixture('token.json'));
}

const CTX = { networkBrandId: '6' };

beforeEach(() => {
  _resetBreakers();
  _resetTokenCache();
  process.env['ADMITAD_ADVERTISER_CLIENT_ID'] = 'fake-client-id';
  process.env['ADMITAD_ADVERTISER_CLIENT_SECRET'] = 'fake-client-secret';
  process.env['ADMITAD_ADVERTISER_ID'] = '6';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['ADMITAD_ADVERTISER_CLIENT_ID'];
  delete process.env['ADMITAD_ADVERTISER_CLIENT_SECRET'];
  delete process.env['ADMITAD_ADVERTISER_ID'];
  _resetTokenCache();
});

// ---------------------------------------------------------------------------
// Transformers + status mapping
// ---------------------------------------------------------------------------

describe('Admitad advertiser transformers', () => {
  it('maps Admitad action status to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'approved' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'approved_but_stalled' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'declined' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'approved', payment_status: 1 })).toBe('paid');
    expect(_internals.mapTransactionStatus({ status: 'weird' })).toBe('other');
  });

  it('maps action status to the three-state performance status', () => {
    expect(_internals.mapPerformanceStatus({ status: 'approved' })).toBe('approved');
    expect(_internals.mapPerformanceStatus({ status: 'approved', payment_status: 1 })).toBe(
      'approved',
    );
    expect(_internals.mapPerformanceStatus({ status: 'declined' })).toBe('reversed');
    expect(_internals.mapPerformanceStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapPerformanceStatus({ status: 'weird' })).toBe('pending');
  });

  it('preserves raw network data on every domain transform', () => {
    const actions = (loadFixture('statistics-actions.json') as { results: Array<Record<string, unknown>> })
      .results;
    const t = _internals.toTransaction(actions[0] as never);
    expect(t.rawNetworkData).toBe(actions[0]);

    const info = (loadFixture('advertiser-info.json') as { results: Array<Record<string, unknown>> })
      .results;
    const p = _internals.toProgramme(info[0] as never);
    expect(p.rawNetworkData).toBe(info[0]);
  });

  it('surfaces reversalReason on reversed transactions', () => {
    const actions = (loadFixture('statistics-actions.json') as { results: Array<Record<string, unknown>> })
      .results;
    const declined = actions[3];
    const t = _internals.toTransaction(declined as never);
    expect(t.status).toBe('reversed');
    expect(t.reversalReason).toBe('Order cancelled by customer');
  });

  it('formats statistics dates as DD.MM.YYYY', () => {
    expect(_internals.toAdmitadDate(new Date('2026-05-01T00:00:00Z'))).toBe('01.05.2026');
  });

  it('aggregates per-action rows by (date, publisher, status)', () => {
    const actions = (loadFixture('statistics-actions.json') as { results: Array<Record<string, unknown>> })
      .results;
    const rows = _internals.aggregatePerformance(actions.map((a) => _internals.toPerformanceRow(a as never)));
    // A-1001 + A-1002 collapse (same date 2026-05-01, publisher 555, approved).
    const collapsed = rows.find((r) => r.publisherId === '555' && r.status === 'approved');
    expect(collapsed?.conversions).toBe(2);
    expect(collapsed?.grossSale).toBe(165);
    expect(collapsed?.commission).toBe(16.5);
    expect(collapsed?.clicks).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Brand path construction
// ---------------------------------------------------------------------------

describe('Admitad advertiser path construction', () => {
  it('prefixes brand-relative paths with /advertiser/{id}', () => {
    expect(buildPath('/statistics/actions/', undefined, '6')).toBe(
      '/advertiser/6/statistics/actions/',
    );
    expect(buildPath('/info/', undefined, '42')).toBe('/advertiser/42/info/');
  });

  it('passes absolute account-level paths verbatim', () => {
    expect(buildPath(undefined, '/me/', undefined)).toBe('/me/');
  });

  it('rejects both paths or neither, and brandPath without an id', () => {
    expect(() => buildPath('/info/', '/me/', '6')).toThrow();
    expect(() => buildPath(undefined, undefined, undefined)).toThrow();
    expect(() => buildPath('/info/', undefined, undefined)).toThrow(/networkBrandId/);
  });
});

// ---------------------------------------------------------------------------
// Read-only guard
// ---------------------------------------------------------------------------

describe('Admitad advertiser read-only guard', () => {
  it('refuses any non-GET method with a config_error envelope', async () => {
    const promise = admitadAdvRequest({
      operation: 'listProgrammes',
      brandPath: '/info/',
      networkBrandId: '6',
      token: 'fake',
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

describe('Admitad advertiser.listBrands', () => {
  it('enumerates campaigns via GET /advertiser/{id}/info/', async () => {
    const { urls } = mockFetchQueue([tokenResponse(), fakeResponse(loadFixture('advertiser-info.json'))]);
    const brands = await admitadAdvertiserAdapter.listBrands();
    expect(brands).toHaveLength(2);
    expect(brands[0]?.networkBrandId).toBe('6');
    expect(brands[0]?.displayName).toBe('Acme Widgets DE');
    expect(brands[0]?.apiEnabled).toBe(true);
    // First URL is the token endpoint, second the advertiser info path.
    expect(urls[0]).toContain('/token/');
    expect(urls[1]).toContain('/advertiser/6/info/');
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('Admitad advertiser.listProgrammes', () => {
  it('returns the advertiser campaigns under brand context', async () => {
    const { urls } = mockFetchQueue([tokenResponse(), fakeResponse(loadFixture('advertiser-info.json'))]);
    const r = await admitadAdvertiserAdapter.listProgrammes(undefined, CTX);
    expect(r).toHaveLength(2);
    expect(r[0]?.status).toBe('joined');
    expect(urls[1]).toContain('/advertiser/6/info/');
  });

  it('refuses to run without a brand context (config_error)', async () => {
    await expect(admitadAdvertiserAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
    try {
      await admitadAdvertiserAdapter.listProgrammes();
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('config_error');
    }
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('Admitad advertiser.listTransactions', () => {
  it('returns transformed actions, brand-scoped', async () => {
    const { urls } = mockFetchQueue([
      tokenResponse(),
      fakeResponse(loadFixture('statistics-actions.json')),
    ]);
    const r = await admitadAdvertiserAdapter.listTransactions({ from: '2026-05-01', to: '2026-05-31' }, CTX);
    expect(r).toHaveLength(4);
    expect(r.map((t) => t.status).sort()).toEqual(['approved', 'approved', 'pending', 'reversed']);
    expect(urls[1]).toContain('/advertiser/6/statistics/actions/');
  });

  it('filters by status client-side', async () => {
    mockFetchQueue([tokenResponse(), fakeResponse(loadFixture('statistics-actions.json'))]);
    const r = await admitadAdvertiserAdapter.listTransactions({ status: 'reversed' }, CTX);
    expect(r).toHaveLength(1);
    expect(r[0]?.reversalReason).toBe('Order cancelled by customer');
  });
});

// ---------------------------------------------------------------------------
// getProgrammePerformance
// ---------------------------------------------------------------------------

describe('Admitad advertiser.getProgrammePerformance', () => {
  it('rolls the actions report up per publisher', async () => {
    const { urls } = mockFetchQueue([
      tokenResponse(),
      fakeResponse(loadFixture('statistics-actions.json')),
    ]);
    const rows = await admitadAdvertiserAdapter.getProgrammePerformance(
      { from: '2026-05-01', to: '2026-05-31' },
      CTX,
    );
    // publisher 555 approved (x2 collapsed), publisher 777 pending, publisher 777 reversed.
    expect(rows).toHaveLength(3);
    const p555 = rows.find((r) => r.publisherId === '555');
    expect(p555?.conversions).toBe(2);
    expect(p555?.status).toBe('approved');
    expect(p555?.clicks).toBe(0);
    expect(p555?.publisherName).toBe('BestDeals.example');
    expect(urls[1]).toContain('/advertiser/6/statistics/actions/');
  });

  it('returns an empty array when the report is empty', async () => {
    mockFetchQueue([tokenResponse(), fakeResponse(loadFixture('statistics-actions-empty.json'))]);
    const rows = await admitadAdvertiserAdapter.getProgrammePerformance(undefined, CTX);
    expect(rows).toEqual([]);
  });

  it('filters by publisherId', async () => {
    mockFetchQueue([tokenResponse(), fakeResponse(loadFixture('statistics-actions.json'))]);
    const rows = await admitadAdvertiserAdapter.getProgrammePerformance({ publisherId: '777' }, CTX);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.publisherId === '777')).toBe(true);
  });

  it('requires a brand context', async () => {
    await expect(admitadAdvertiserAdapter.getProgrammePerformance()).rejects.toBeInstanceOf(
      NetworkError,
    );
  });
});

// ---------------------------------------------------------------------------
// Ops not implemented at v0.1
// ---------------------------------------------------------------------------

describe('Admitad advertiser unimplemented ops', () => {
  it('throws NotImplementedError on getProgramme / getEarningsSummary / listClicks / generateTrackingLink', async () => {
    await expect(admitadAdvertiserAdapter.getProgramme('X')).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(admitadAdvertiserAdapter.getEarningsSummary()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(admitadAdvertiserAdapter.listClicks()).rejects.toBeInstanceOf(NotImplementedError);
    await expect(
      admitadAdvertiserAdapter.generateTrackingLink({
        programmeId: 'X',
        destinationUrl: 'https://example.com',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
    await expect(admitadAdvertiserAdapter.listPublishers()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(admitadAdvertiserAdapter.listPublisherSectors()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('Admitad advertiser.verifyAuth', () => {
  it('returns ok with an identity on a successful token exchange + /me/', async () => {
    mockFetchQueue([tokenResponse(), fakeResponse(loadFixture('me.json'))]);
    const r = await admitadAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('acme-advertiser');
    }
  });

  it('returns {ok:false} when the token exchange fails (401)', async () => {
    mockFetchQueue([fakeResponse('invalid_client', { status: 401 })]);
    const r = await admitadAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });

  it('still reports ok when /me/ fails but the token exchange succeeded', async () => {
    mockFetchQueue([tokenResponse(), fakeResponse('forbidden', { status: 403 })]);
    const r = await admitadAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('identity lookup unavailable');
    }
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('Admitad advertiser.capabilitiesCheck', () => {
  it('marks getProgrammePerformance and listBrands as experimental', async () => {
    const caps = await admitadAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['getProgrammePerformance']?.claimStatus).toBe('experimental');
    expect(caps.operations['listBrands']?.claimStatus).toBe('experimental');
  });

  it('does not mark listProgrammes / listTransactions with an override', async () => {
    const caps = await admitadAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['listProgrammes']?.claimStatus).toBeUndefined();
    expect(caps.operations['listTransactions']?.claimStatus).toBeUndefined();
  });
});
