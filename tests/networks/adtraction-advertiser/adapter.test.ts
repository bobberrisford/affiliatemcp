/**
 * Adtraction advertiser adapter — unit tests.
 *
 * Exercises listBrands, getProgrammePerformance (with ctx), status mapping, raw
 * preservation, the read-only path allowlist guard, the NotImplemented ops, and
 * verifyAuth (ok + fail). Deterministic: a mock fetch queue feeds canned
 * responses and breakers are reset between tests.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  adtractionAdvertiserAdapter,
  _internals,
} from '../../../src/networks/adtraction-advertiser/adapter.js';
import {
  adtractionAdvRequest,
  ADV_PROGRAMMES_PATH,
} from '../../../src/networks/adtraction-advertiser/client.js';
import { _resetBreakers, DEFAULT_RESILIENCE } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'adtraction-advertiser');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { 'content-type': 'application/json' } });
}

function mockFetchQueue(responses: Response[]): {
  spy: ReturnType<typeof vi.fn>;
  urls: string[];
  bodies: Array<string | undefined>;
} {
  const urls: string[] = [];
  const bodies: Array<string | undefined> = [];
  const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    urls.push(typeof input === 'string' ? input : input.toString());
    bodies.push(typeof init?.body === 'string' ? init.body : undefined);
    const r = responses.shift();
    if (!r) throw new Error('mock fetch queue exhausted');
    return r;
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return { spy, urls, bodies };
}

const CTX = { networkBrandId: '90001' };

beforeEach(() => {
  _resetBreakers();
  process.env['ADTRACTION_ADVERTISER_API_TOKEN'] = 'fake-advertiser-token';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['ADTRACTION_ADVERTISER_API_TOKEN'];
});

// ---------------------------------------------------------------------------
// Transformers and helpers
// ---------------------------------------------------------------------------

describe('Adtraction advertiser transformers', () => {
  it('maps numeric transactionStatus codes to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ transactionStatus: 1 })).toBe('approved');
    expect(_internals.mapTransactionStatus({ transactionStatus: 2 })).toBe('pending');
    expect(_internals.mapTransactionStatus({ transactionStatus: 4 })).toBe('pending');
    expect(_internals.mapTransactionStatus({ transactionStatus: 5 })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ transactionStatus: 99 })).toBe('other');
  });

  it('collapses canonical status to the three performance-row states', () => {
    expect(_internals.toPerformanceStatus('approved')).toBe('approved');
    expect(_internals.toPerformanceStatus('paid')).toBe('approved');
    expect(_internals.toPerformanceStatus('reversed')).toBe('reversed');
    expect(_internals.toPerformanceStatus('pending')).toBe('pending');
    expect(_internals.toPerformanceStatus('other')).toBe('pending');
  });

  it('maps canonical status to the single Adtraction numeric filter code', () => {
    expect(_internals.mapCanonicalToAdtractionStatus(['approved'])).toBe(1);
    expect(_internals.mapCanonicalToAdtractionStatus(['pending'])).toBe(2);
    expect(_internals.mapCanonicalToAdtractionStatus(['reversed'])).toBe(5);
    expect(_internals.mapCanonicalToAdtractionStatus(['paid'])).toBeUndefined();
    expect(_internals.mapCanonicalToAdtractionStatus(['approved', 'pending'])).toBeUndefined();
  });

  it('preserves raw network data on every transform', () => {
    const raw = (loadFixture('transactions.json') as { transactions: Array<Record<string, unknown>> })
      .transactions[0];
    const t = _internals.toTransaction(raw as never);
    expect(t.rawNetworkData).toBe(raw);

    const prog = (loadFixture('programs.json') as { programs: Array<Record<string, unknown>> })
      .programs[0];
    const p = _internals.toProgramme(prog as never);
    expect(p.rawNetworkData).toBe(prog);
  });

  it('surfaces reversalReason on reversed transactions', () => {
    const raw = (loadFixture('transactions.json') as { transactions: Array<Record<string, unknown>> })
      .transactions[3];
    const t = _internals.toTransaction(raw as never);
    expect(t.status).toBe('reversed');
    expect(t.reversalReason).toBe('Order cancelled by customer');
  });

  it('derives discovered brands (programmes) with apiEnabled from the active flag', () => {
    const programs = (loadFixture('programs.json') as { programs: Array<Record<string, unknown>> })
      .programs;
    const b0 = _internals.toDiscoveredBrand(programs[0] as never);
    const b1 = _internals.toDiscoveredBrand(programs[1] as never);
    expect(b0.networkBrandId).toBe('90001');
    expect(b0.displayName).toBe('Nordic Outdoor Co.');
    expect(b0.apiEnabled).toBe(true);
    expect(b1.apiEnabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Read-only path allowlist guard
// ---------------------------------------------------------------------------

describe('Adtraction advertiser read-only allowlist guard', () => {
  it('permits POST to an allowlisted READ path (no method ban)', async () => {
    mockFetchQueue([fakeResponse({ programs: [] })]);
    await expect(
      adtractionAdvRequest({
        operation: 'listBrands',
        path: ADV_PROGRAMMES_PATH,
        token: 'fake-advertiser-token',
        method: 'POST',
        body: {},
        resilience: DEFAULT_RESILIENCE,
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a non-allowlisted (mutation) path with a config_error envelope', async () => {
    // A write/mutation endpoint — not on the allowlist — must be refused before
    // any network call goes out, even though Adtraction reads are POST.
    const promise = adtractionAdvRequest({
      operation: 'listTransactions',
      path: '/v3/advertiser/transactions/approve/',
      token: 'fake-advertiser-token',
      method: 'POST',
      body: { transactionId: 'TX-1' },
      resilience: DEFAULT_RESILIENCE,
    });
    await expect(promise).rejects.toBeInstanceOf(NetworkError);
    try {
      await promise;
    } catch (err) {
      const e = err as NetworkError;
      expect(e.envelope.type).toBe('config_error');
      expect(e.envelope.message).toMatch(/read-only/);
      expect(e.envelope.message).toMatch(/non-allowlisted/);
    }
  });
});

// ---------------------------------------------------------------------------
// listBrands
// ---------------------------------------------------------------------------

describe('Adtraction advertiser.listBrands', () => {
  it('enumerates the advertiser programmes the token addresses', async () => {
    const { urls } = mockFetchQueue([fakeResponse(loadFixture('programs.json'))]);
    const brands = await adtractionAdvertiserAdapter.listBrands();
    expect(brands).toHaveLength(2);
    expect(brands[0]?.networkBrandId).toBe('90001');
    expect(brands[1]?.apiEnabled).toBe(false);
    expect(urls[0]).toContain('/v3/advertiser/programs/');
    expect(urls[0]).toContain('token=fake-advertiser-token');
  });
});

// ---------------------------------------------------------------------------
// getProgrammePerformance (with ctx)
// ---------------------------------------------------------------------------

describe('Adtraction advertiser.getProgrammePerformance', () => {
  it('groups advertiser transactions by affiliate/channel and status', async () => {
    const { urls, bodies } = mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const rows = await adtractionAdvertiserAdapter.getProgrammePerformance(
      { from: '2026-05-01', to: '2026-05-31' },
      CTX,
    );

    // TX-1001 + TX-1002 collapse into one approved row for channel 5501.
    const trailApproved = rows.find(
      (r) => r.publisherId === '5501' && r.status === 'approved',
    );
    expect(trailApproved).toBeDefined();
    expect(trailApproved?.conversions).toBe(2);
    expect(trailApproved?.grossSale).toBe(2000);
    expect(trailApproved?.commission).toBe(200);
    expect(trailApproved?.publisherName).toBe('TrailGuide Blog');
    expect(trailApproved?.currency).toBe('SEK');

    // Channel 5502 has one pending and one reversed → two separate rows.
    expect(rows.filter((r) => r.publisherId === '5502')).toHaveLength(2);
    expect(rows.find((r) => r.publisherId === '5502' && r.status === 'reversed')).toBeDefined();

    // The request scoped to the resolved programme id.
    expect(urls[0]).toContain('/v3/advertiser/transactions/');
    expect(bodies[0]).toContain('"programId":"90001"');
  });

  it('honours a publisherId filter and scopes the request body to that channel', async () => {
    const { bodies } = mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const rows = await adtractionAdvertiserAdapter.getProgrammePerformance(
      { publisherId: '5501' },
      CTX,
    );
    expect(rows.every((r) => r.publisherId === '5501')).toBe(true);
    expect(bodies[0]).toContain('"channelId":"5501"');
  });

  it('returns an empty array when there are no transactions', async () => {
    mockFetchQueue([fakeResponse(loadFixture('empty.json'))]);
    const rows = await adtractionAdvertiserAdapter.getProgrammePerformance({}, CTX);
    expect(rows).toEqual([]);
  });

  it('refuses to run without a brand context (config_error)', async () => {
    await expect(
      adtractionAdvertiserAdapter.getProgrammePerformance({}),
    ).rejects.toBeInstanceOf(NetworkError);
    try {
      await adtractionAdvertiserAdapter.getProgrammePerformance({});
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('config_error');
    }
  });
});

// ---------------------------------------------------------------------------
// listTransactions / listProgrammes (brand-scoped)
// ---------------------------------------------------------------------------

describe('Adtraction advertiser.listTransactions', () => {
  it('returns transformed transactions scoped to the brand programme', async () => {
    const { bodies } = mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const txns = await adtractionAdvertiserAdapter.listTransactions(undefined, CTX);
    expect(txns).toHaveLength(4);
    expect(bodies[0]).toContain('"programId":"90001"');
  });

  it('filters by status client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const txns = await adtractionAdvertiserAdapter.listTransactions({ status: 'reversed' }, CTX);
    expect(txns).toHaveLength(1);
    expect(txns[0]?.reversalReason).toBe('Order cancelled by customer');
  });
});

describe('Adtraction advertiser.listProgrammes', () => {
  it('returns the resolved programme scoped to the brand id', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programs.json'))]);
    const progs = await adtractionAdvertiserAdapter.listProgrammes(undefined, CTX);
    expect(progs).toHaveLength(1);
    expect(progs[0]?.id).toBe('90001');
    expect(progs[0]?.status).toBe('joined');
  });
});

// ---------------------------------------------------------------------------
// Ops not implemented at v0.1
// ---------------------------------------------------------------------------

describe('Adtraction advertiser unimplemented ops', () => {
  it('throws NotImplementedError on getProgramme / getEarningsSummary / listClicks / generateTrackingLink', async () => {
    await expect(adtractionAdvertiserAdapter.getProgramme('X')).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(adtractionAdvertiserAdapter.getEarningsSummary()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(adtractionAdvertiserAdapter.listClicks()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(
      adtractionAdvertiserAdapter.generateTrackingLink({
        programmeId: 'X',
        destinationUrl: 'https://example.com',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
    await expect(adtractionAdvertiserAdapter.listPublishers()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('Adtraction advertiser.verifyAuth', () => {
  it('returns ok with a masked-token identity on success', async () => {
    mockFetchQueue([fakeResponse({ programs: [] })]);
    const r = await adtractionAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('adtraction-advertiser/token:');
    }
  });

  it('returns {ok:false} on a 401', async () => {
    mockFetchQueue([fakeResponse('unauthorized', { status: 401 })]);
    const r = await adtractionAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });
});
