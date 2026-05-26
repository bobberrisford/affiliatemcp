/**
 * CJ advertiser adapter — unit tests.
 *
 * Exercises every implemented operation, asserts request shape (POST to
 * CJ_ADVERTISER_GRAPHQL, correct `forAdvertisers` from ctx.networkBrandId,
 * correct query document), status mapping, the commissionDetails-to-
 * ProgrammePerformanceRow aggregation, and that operations refuse to run
 * without a brand context.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  cjAdvertiserAdapter,
  _internals,
} from '../../../src/networks/cj-advertiser/adapter.js';
import { CJ_ADVERTISER_GRAPHQL } from '../../../src/networks/cj-advertiser/client.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'cj-advertiser');

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
  body: unknown;
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
    let parsedBody: unknown;
    if (init?.body && typeof init.body === 'string') {
      try {
        parsedBody = JSON.parse(init.body);
      } catch {
        parsedBody = init.body;
      }
    }
    calls.push({ url, method, headers, body: parsedBody });
    const r = responses.shift();
    if (!r) throw new Error('mock fetch queue exhausted');
    return r;
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return { spy, calls };
}

beforeEach(() => {
  _resetBreakers();
  process.env['CJ_ADVERTISER_API_TOKEN'] = 'fake-pat';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['CJ_ADVERTISER_API_TOKEN'];
});

// ---------------------------------------------------------------------------
// Transformers and helpers
// ---------------------------------------------------------------------------

describe('CJ advertiser transformers', () => {
  it('maps actionStatus to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ actionStatus: 'EXTENDED' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ actionStatus: 'LOCKED' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ actionStatus: 'NEW' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ actionStatus: 'CLOSED' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ actionStatus: 'CORRECTED' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ actionStatus: 'REVERSED' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ actionStatus: 'WEIRD' })).toBe('other');
  });

  it('maps actionStatus to the 3-value performance status', () => {
    expect(_internals.mapPerformanceStatus({ actionStatus: 'LOCKED' })).toBe('pending');
    expect(_internals.mapPerformanceStatus({ actionStatus: 'EXTENDED' })).toBe('pending');
    expect(_internals.mapPerformanceStatus({ actionStatus: 'CLOSED' })).toBe('approved');
    expect(_internals.mapPerformanceStatus({ actionStatus: 'CORRECTED' })).toBe('reversed');
    expect(_internals.mapPerformanceStatus({ actionStatus: 'REVERSED' })).toBe('reversed');
  });

  it('preserves raw network data on Transaction', () => {
    const raw = {
      commissionId: 'C-1',
      advertiserId: '1234567',
      advertiserName: 'Acme',
      publisherId: 'PUB-1',
      publisherName: 'Pub',
      actionStatus: 'LOCKED',
      saleAmountUsd: '100',
      commissionAmountUsd: '10',
      postingDate: '2026-05-01T10:00:00Z',
      eventDate: '2026-04-30T10:00:00Z',
    };
    const t = _internals.toTransaction(raw);
    expect(t.rawNetworkData).toBe(raw);
    expect(t.currency).toBe('USD');
    expect(t.amount).toBe(100);
    expect(t.commission).toBe(10);
    expect(t.status).toBe('pending');
  });

  it('normalises CJ ISO dates and reports yyyy-mm-dd buckets', () => {
    expect(_internals.parseCjDate('2026-05-01T10:00:00Z')).toBe('2026-05-01T10:00:00.000Z');
    expect(_internals.parseCjDate('not-a-date')).toBeUndefined();
    expect(_internals.parseCjDate(undefined)).toBeUndefined();
  });

  it('aggregates performance row from a multi-row bucket', () => {
    const rows = [
      { commissionAmountUsd: '5', saleAmountUsd: '50', actionStatus: 'LOCKED' },
      { commissionAmountUsd: '3', saleAmountUsd: '30', actionStatus: 'CLOSED' },
    ];
    const r = _internals.toPerformanceRow('2026-05-01', 'PUB-1', 'BestDeals', rows);
    expect(r.conversions).toBe(2);
    expect(r.grossSale).toBe(80);
    expect(r.commission).toBe(8);
    expect(r.clicks).toBe(0);
    expect(r.currency).toBe('USD');
    // Mix of LOCKED (pending) and CLOSED (approved) ⇒ worst-news rule keeps
    // pending.
    expect(r.status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------
// Request shape — every operation POSTs to the GraphQL endpoint with the right
// `forAdvertisers` and the right query document.
// ---------------------------------------------------------------------------

describe('CJ advertiser request shape', () => {
  it('listTransactions POSTs commissionDetails with forAdvertisers=[networkBrandId]', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('commission-details.json'))]);
    await cjAdvertiserAdapter.listTransactions(
      { from: '2026-04-01', to: '2026-05-01' },
      { networkBrandId: '1234567' },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(CJ_ADVERTISER_GRAPHQL);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.headers).toMatchObject({ Authorization: 'Bearer fake-pat' });
    const body = calls[0]?.body as { query: string; variables: Record<string, unknown> };
    expect(body.query).toContain('commissionDetails');
    expect(body.query).toContain('forAdvertisers');
    expect(body.variables.forAdvertisers).toEqual(['1234567']);
  });

  it('listMediaPartners POSTs commissionDetails with forAdvertisers=[networkBrandId]', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('commission-details.json'))]);
    await cjAdvertiserAdapter.listMediaPartners(undefined, { networkBrandId: '1234567' });
    const body = calls[0]?.body as { variables: Record<string, unknown> };
    expect(body.variables.forAdvertisers).toEqual(['1234567']);
  });

  it('getProgrammePerformance POSTs commissionDetails with the right CID and window', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('commission-details.json'))]);
    await cjAdvertiserAdapter.getProgrammePerformance(
      { from: '2026-05-01', to: '2026-05-31' },
      { networkBrandId: '1234567' },
    );
    const body = calls[0]?.body as { variables: Record<string, string> };
    expect(body.variables.forAdvertisers).toEqual(['1234567']);
    expect(body.variables.sincePostingDate).toContain('2026-05-01');
    expect(body.variables.beforePostingDate).toContain('2026-05-31');
  });
});

// ---------------------------------------------------------------------------
// listTransactions — status mapping and filtering
// ---------------------------------------------------------------------------

describe('CJ advertiser.listTransactions', () => {
  it('returns transformed records with normalised status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('commission-details.json'))]);
    const r = await cjAdvertiserAdapter.listTransactions(undefined, {
      networkBrandId: '1234567',
    });
    expect(r).toHaveLength(5);
    // LOCKED + EXTENDED → pending; CLOSED → approved; CORRECTED + REVERSED → reversed.
    const statuses = r.map((t) => t.status).sort();
    expect(statuses).toEqual(['approved', 'pending', 'pending', 'reversed', 'reversed']);
  });

  it('filters by status client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('commission-details.json'))]);
    const r = await cjAdvertiserAdapter.listTransactions(
      { status: 'reversed' },
      { networkBrandId: '1234567' },
    );
    expect(r).toHaveLength(2);
    expect(r.every((t) => t.status === 'reversed')).toBe(true);
  });

  it('refuses to run without a brand context (config_error)', async () => {
    await expect(cjAdvertiserAdapter.listTransactions()).rejects.toBeInstanceOf(NetworkError);
    try {
      await cjAdvertiserAdapter.listTransactions();
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('config_error');
    }
  });

  it('returns an empty array when CJ reports no records', async () => {
    mockFetchQueue([fakeResponse(loadFixture('commission-details-empty.json'))]);
    const r = await cjAdvertiserAdapter.listTransactions(undefined, {
      networkBrandId: '1234567',
    });
    expect(r).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listMediaPartners — derived view from commissionDetails aggregation
// ---------------------------------------------------------------------------

describe('CJ advertiser.listMediaPartners', () => {
  it('aggregates distinct publishers from a recent commissionDetails pull', async () => {
    mockFetchQueue([fakeResponse(loadFixture('commission-details.json'))]);
    const partners = await cjAdvertiserAdapter.listMediaPartners(undefined, {
      networkBrandId: '1234567',
    });
    expect(partners).toHaveLength(3);
    const ids = partners.map((p) => p.id).sort();
    expect(ids).toEqual(['PUB-1', 'PUB-2', 'PUB-3']);
    // Every aggregated partner is reported as `active` (had >= 1 row).
    expect(partners.every((p) => p.status === 'active')).toBe(true);
  });

  it('filters by search', async () => {
    mockFetchQueue([fakeResponse(loadFixture('commission-details.json'))]);
    const r = await cjAdvertiserAdapter.listMediaPartners(
      { search: 'cabin' },
      { networkBrandId: '1234567' },
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.name).toBe('Coupon Cabin');
  });
});

// ---------------------------------------------------------------------------
// getProgrammePerformance — client-side aggregation
// ---------------------------------------------------------------------------

describe('CJ advertiser.getProgrammePerformance', () => {
  it('buckets commissionDetails rows by (publisherId, day) and aggregates', async () => {
    mockFetchQueue([fakeResponse(loadFixture('commission-details.json'))]);
    const rows = await cjAdvertiserAdapter.getProgrammePerformance(undefined, {
      networkBrandId: '1234567',
    });
    // Buckets in fixture (postingDate day, publisherId):
    //   2026-05-01 / PUB-1 : 2 rows (LOCKED + EXTENDED) → pending, 250/25
    //   2026-05-02 / PUB-2 : 2 rows (CLOSED + CORRECTED) → reversed, 150/15
    //   2026-05-03 / PUB-3 : 1 row (REVERSED) → reversed, 75/7.5
    expect(rows).toHaveLength(3);

    const byKey = new Map(rows.map((r) => [`${r.date}|${r.publisherId}`, r]));
    const pub1 = byKey.get('2026-05-01|PUB-1');
    expect(pub1?.conversions).toBe(2);
    expect(pub1?.grossSale).toBe(250);
    expect(pub1?.commission).toBe(25);
    expect(pub1?.status).toBe('pending');
    expect(pub1?.clicks).toBe(0);
    expect(pub1?.currency).toBe('USD');

    const pub2 = byKey.get('2026-05-02|PUB-2');
    expect(pub2?.status).toBe('reversed');
    expect(pub2?.grossSale).toBe(150);

    const pub3 = byKey.get('2026-05-03|PUB-3');
    expect(pub3?.status).toBe('reversed');
  });

  it('scopes to a single publisher when publisherId is provided', async () => {
    mockFetchQueue([fakeResponse(loadFixture('commission-details.json'))]);
    const rows = await cjAdvertiserAdapter.getProgrammePerformance(
      { publisherId: 'PUB-2' },
      { networkBrandId: '1234567' },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.publisherId).toBe('PUB-2');
  });
});

// ---------------------------------------------------------------------------
// listProgrammes — synthetic per-CID Programme
// ---------------------------------------------------------------------------

describe('CJ advertiser.listProgrammes', () => {
  it('returns one synthetic Programme for the call-context CID', async () => {
    const r = await cjAdvertiserAdapter.listProgrammes(undefined, {
      networkBrandId: '1234567',
    });
    expect(r).toHaveLength(1);
    expect(r[0]?.id).toBe('1234567');
    expect(r[0]?.status).toBe('joined');
    expect(r[0]?.network).toBe('cj-advertiser');
    expect(r[0]?.currency).toBe('USD');
  });

  it('refuses to run without a brand context', async () => {
    await expect(cjAdvertiserAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listBrands — NOT implemented; honest gap.
// ---------------------------------------------------------------------------

describe('CJ advertiser.listBrands', () => {
  it('throws NotImplementedError with a hint to add brands manually', async () => {
    await expect(cjAdvertiserAdapter.listBrands()).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await cjAdvertiserAdapter.listBrands();
    } catch (err) {
      expect((err as NotImplementedError).message).toMatch(/brands\.json/);
    }
  });
});

// ---------------------------------------------------------------------------
// Ops not implemented at v0.1
// ---------------------------------------------------------------------------

describe('CJ advertiser unimplemented ops', () => {
  it('throws NotImplementedError on getProgramme / getEarningsSummary / listClicks / generateTrackingLink', async () => {
    await expect(cjAdvertiserAdapter.getProgramme('X')).rejects.toBeInstanceOf(NotImplementedError);
    await expect(cjAdvertiserAdapter.getEarningsSummary()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(cjAdvertiserAdapter.listClicks()).rejects.toBeInstanceOf(NotImplementedError);
    await expect(
      cjAdvertiserAdapter.generateTrackingLink({
        programmeId: 'X',
        destinationUrl: 'https://example.com',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('CJ advertiser.verifyAuth', () => {
  it('returns ok when the commissionDetails probe is accepted', async () => {
    mockFetchQueue([
      fakeResponse({ data: { commissionDetails: { payloadComplete: true, count: 0 } } }),
    ]);
    const r = await cjAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(true);
  });

  it('returns {ok:false} on a 401', async () => {
    mockFetchQueue([
      fakeResponse('unauthorized', { status: 401 }),
      fakeResponse('unauthorized', { status: 401 }),
      fakeResponse('unauthorized', { status: 401 }),
    ]);
    const r = await cjAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });

  it('returns {ok:false} when the PAT is missing entirely', async () => {
    delete process.env['CJ_ADVERTISER_API_TOKEN'];
    const r = await cjAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-operation claimStatus (review feedback workstream 1)
// ---------------------------------------------------------------------------

describe('CJ advertiser.capabilitiesCheck — per-op claimStatus', () => {
  it('marks listBrands as experimental (throws NotImplementedError)', async () => {
    const caps = await cjAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['listBrands']?.claimStatus).toBe('experimental');
  });

  it('marks getProgrammePerformance as experimental (CLOSED status mapping unverified)', async () => {
    const caps = await cjAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['getProgrammePerformance']?.claimStatus).toBe('experimental');
  });

  it('marks listTransactions as partial (status mapping `// TODO(verify)`)', async () => {
    const caps = await cjAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['listTransactions']?.claimStatus).toBe('partial');
  });

  it('does NOT mark listMediaPartners — no override (falls back to network-level)', async () => {
    const caps = await cjAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['listMediaPartners']?.claimStatus).toBeUndefined();
    expect(caps.operations['listProgrammes']?.claimStatus).toBeUndefined();
  });
});
