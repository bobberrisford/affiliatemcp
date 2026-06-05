/**
 * Webgains advertiser adapter — unit tests.
 *
 * Exercises listBrands, getProgrammePerformance (with ctx), status mapping, raw
 * preservation, the read-only guard, NotImplemented ops, and verifyAuth
 * (ok + fail). Deterministic: fetch is mocked from a response queue and the
 * resilience breakers are reset before each test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  webgainsAdvertiserAdapter,
  _internals,
} from '../../../src/networks/webgains-advertiser/adapter.js';
import {
  buildUrl,
  webgainsAdvRequest,
} from '../../../src/networks/webgains-advertiser/client.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';
import { DEFAULT_RESILIENCE } from '../../../src/shared/resilience.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'webgains-advertiser');
const CTX = { networkBrandId: 'PRG-5001' };

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

beforeEach(() => {
  _resetBreakers();
  process.env['WEBGAINS_ADVERTISER_API_KEY'] = 'fake-pat';
  process.env['WEBGAINS_ADVERTISER_ACCOUNT_ID'] = '654321';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['WEBGAINS_ADVERTISER_API_KEY'];
  delete process.env['WEBGAINS_ADVERTISER_ACCOUNT_ID'];
});

// ---------------------------------------------------------------------------
// Transformers + status mapping
// ---------------------------------------------------------------------------

describe('Webgains advertiser transformers', () => {
  it('maps Webgains commission status to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ status: 'open' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'in recall' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'confirmed' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'paid' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ status: 'cancelled' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'delayed' })).toBe('other');
    expect(_internals.mapTransactionStatus({ status: 'weird' })).toBe('other');
  });

  it('maps performance-row status to pending|approved|reversed (paid→approved, delayed→pending)', () => {
    expect(_internals.mapReportRowStatus({ status: 'open' })).toBe('pending');
    expect(_internals.mapReportRowStatus({ status: 'confirmed' })).toBe('approved');
    expect(_internals.mapReportRowStatus({ status: 'paid' })).toBe('approved');
    expect(_internals.mapReportRowStatus({ status: 'cancelled' })).toBe('reversed');
    expect(_internals.mapReportRowStatus({ status: 'delayed' })).toBe('pending');
  });

  it('preserves raw network data on every domain transform', () => {
    const txns = (loadFixture('transactions.json') as { transactions: Array<Record<string, unknown>> })
      .transactions;
    const raw = txns[0] as Record<string, unknown>;
    const t = _internals.toTransaction(raw as never);
    expect(t.rawNetworkData).toBe(raw);

    const progs = (loadFixture('programmes.json') as { programs: Array<Record<string, unknown>> })
      .programs;
    const p = _internals.toProgramme(progs[0] as never);
    expect(p.rawNetworkData).toBe(progs[0]);

    const row = _internals.toPerformanceRow(raw as never);
    expect(row.rawNetworkData).toBe(raw);
  });

  it('surfaces reversalReason on reversed transactions', () => {
    const txns = (loadFixture('transactions.json') as { transactions: Array<Record<string, unknown>> })
      .transactions;
    const t = _internals.toTransaction(txns[3] as never);
    expect(t.status).toBe('reversed');
    expect(t.reversalReason).toBe('Order returned within the cooling-off window');
  });

  it('aggregates per-publisher performance rows by (date, publisher, status)', () => {
    const txns = (loadFixture('transactions.json') as { transactions: Array<Record<string, unknown>> })
      .transactions;
    const rows = txns.map((r) => _internals.toPerformanceRow(r as never));
    const agg = _internals.aggregatePerformance(rows);
    // PUB-100: one approved (TXN-1) + one pending (TXN-2) = two buckets.
    // PUB-200: one approved (TXN-3) + one reversed (TXN-4) = two buckets.
    expect(agg).toHaveLength(4);
    const pub100Approved = agg.find((r) => r.publisherId === 'PUB-100' && r.status === 'approved');
    expect(pub100Approved?.conversions).toBe(1);
    expect(pub100Approved?.commission).toBe(12);
    expect(pub100Approved?.grossSale).toBe(120);
  });
});

// ---------------------------------------------------------------------------
// URL shape
// ---------------------------------------------------------------------------

describe('Webgains advertiser URL shape', () => {
  it('builds advertiser-scoped paths with query params', () => {
    const url = buildUrl('https://platform.webgains.io', '/advertisers/654321/transactions', {
      dateFrom: '2026-05-01',
      dateTo: '2026-05-31',
      programId: 'PRG-5001',
    });
    expect(url).toBe(
      'https://platform.webgains.io/advertisers/654321/transactions?dateFrom=2026-05-01&dateTo=2026-05-31&programId=PRG-5001',
    );
  });
});

// ---------------------------------------------------------------------------
// Read-only guard
// ---------------------------------------------------------------------------

describe('Webgains advertiser read-only guard', () => {
  it('refuses any non-GET method with a config_error envelope', async () => {
    const promise = webgainsAdvRequest({
      operation: 'verifyAuth',
      path: '/advertisers/654321/programs',
      token: 'fake-pat',
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

describe('Webgains advertiser.listBrands', () => {
  it('enumerates the advertiser account programmes as brands', async () => {
    const { urls } = mockFetchQueue([fakeResponse(loadFixture('programmes.json'))]);
    const brands = await webgainsAdvertiserAdapter.listBrands();
    expect(brands).toHaveLength(2);
    expect(brands[0]?.networkBrandId).toBe('PRG-5001');
    expect(brands[0]?.displayName).toBe('Acme Outdoors UK');
    expect(brands[0]?.apiEnabled).toBe(true);
    expect(brands[1]?.apiEnabled).toBe(false);
    expect(urls[0]).toContain('/advertisers/654321/programs');
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('Webgains advertiser.listProgrammes', () => {
  it('returns the brand-scoped programme', async () => {
    const { urls } = mockFetchQueue([fakeResponse(loadFixture('programmes.json'))]);
    const r = await webgainsAdvertiserAdapter.listProgrammes(undefined, CTX);
    expect(r).toHaveLength(1);
    expect(r[0]?.id).toBe('PRG-5001');
    expect(r[0]?.status).toBe('joined');
    expect(urls[0]).toContain('/advertisers/654321/programs');
  });

  it('refuses to run without a brand context (config_error)', async () => {
    await expect(webgainsAdvertiserAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
    try {
      await webgainsAdvertiserAdapter.listProgrammes();
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('config_error');
    }
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('Webgains advertiser.listTransactions', () => {
  it('returns transformed transactions for the brand programme', async () => {
    const { urls } = mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const r = await webgainsAdvertiserAdapter.listTransactions(
      { from: '2026-05-01', to: '2026-05-31' },
      CTX,
    );
    expect(r).toHaveLength(4);
    expect(r.map((t) => t.status).sort()).toEqual(['approved', 'approved', 'pending', 'reversed']);
    expect(urls[0]).toContain('/advertisers/654321/transactions');
    expect(urls[0]).toContain('programId=PRG-5001');
  });

  it('filters by canonical status client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const r = await webgainsAdvertiserAdapter.listTransactions(
      { status: 'reversed', from: '2026-05-01', to: '2026-05-31' },
      CTX,
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.id).toBe('TXN-4');
  });
});

// ---------------------------------------------------------------------------
// getProgrammePerformance
// ---------------------------------------------------------------------------

describe('Webgains advertiser.getProgrammePerformance', () => {
  it('rolls transactions up per publisher with ctx', async () => {
    const { urls } = mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const rows = await webgainsAdvertiserAdapter.getProgrammePerformance(
      { from: '2026-05-01', to: '2026-05-31' },
      CTX,
    );
    // Four (date, publisher, status) buckets.
    expect(rows).toHaveLength(4);
    const ids = rows.map((r) => r.publisherId).sort();
    expect(ids).toEqual(['PUB-100', 'PUB-100', 'PUB-200', 'PUB-200']);
    expect(urls[0]).toContain('/advertisers/654321/transactions');
    expect(urls[0]).toContain('programId=PRG-5001');
  });

  it('returns an empty array when there are no transactions', async () => {
    mockFetchQueue([fakeResponse(loadFixture('empty.json'))]);
    const rows = await webgainsAdvertiserAdapter.getProgrammePerformance(
      { from: '2026-05-01', to: '2026-05-31' },
      CTX,
    );
    expect(rows).toEqual([]);
  });

  it('filters to a single publisher when publisherId is supplied', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const rows = await webgainsAdvertiserAdapter.getProgrammePerformance(
      { from: '2026-05-01', to: '2026-05-31', publisherId: 'PUB-200' },
      CTX,
    );
    expect(rows.every((r) => r.publisherId === 'PUB-200')).toBe(true);
    expect(rows).toHaveLength(2);
  });

  it('refuses to run without a brand context (config_error)', async () => {
    await expect(webgainsAdvertiserAdapter.getProgrammePerformance()).rejects.toBeInstanceOf(
      NetworkError,
    );
  });
});

// ---------------------------------------------------------------------------
// Ops not implemented at v0.1
// ---------------------------------------------------------------------------

describe('Webgains advertiser unimplemented ops', () => {
  it('throws NotImplementedError on getProgramme / getEarningsSummary / listClicks / generateTrackingLink', async () => {
    await expect(webgainsAdvertiserAdapter.getProgramme('X')).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(webgainsAdvertiserAdapter.getEarningsSummary()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(webgainsAdvertiserAdapter.listClicks()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(
      webgainsAdvertiserAdapter.generateTrackingLink({
        programmeId: 'X',
        destinationUrl: 'https://example.com',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
    await expect(webgainsAdvertiserAdapter.listPublishers()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('Webgains advertiser.verifyAuth', () => {
  it('returns ok with an account identity on success', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programmes.json'))]);
    const r = await webgainsAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('654321');
    }
  });

  it('returns {ok:false} on 401', async () => {
    mockFetchQueue([fakeResponse('unauthorized', { status: 401 })]);
    const r = await webgainsAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck — per-op claimStatus
// ---------------------------------------------------------------------------

describe('Webgains advertiser.capabilitiesCheck', () => {
  it('marks listBrands and getProgrammePerformance experimental', async () => {
    const caps = await webgainsAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['listBrands']?.claimStatus).toBe('experimental');
    expect(caps.operations['getProgrammePerformance']?.claimStatus).toBe('experimental');
    expect(caps.operations['listProgrammes']?.claimStatus).toBeUndefined();
  });
});
