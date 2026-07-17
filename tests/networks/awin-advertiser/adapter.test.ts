/**
 * Awin advertiser adapter — unit tests.
 *
 * Exercises every implemented operation, asserts the `/advertisers/{id}/...`
 * URL shape, status mapping (especially Awin `declined` → canonical
 * `reversed`), the per-publisher report round-trip, and that operations
 * refuse to run without a brand context.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  awinAdvertiserAdapter,
  _internals,
} from '../../../src/networks/awin-advertiser/adapter.js';
import { _resetRateLimiter } from '../../../src/networks/awin-advertiser/client.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'awin-advertiser');

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
    calls.push({ url, method, headers });
    const r = responses.shift();
    if (!r) throw new Error('mock fetch queue exhausted');
    return r;
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return { spy, calls };
}

beforeEach(() => {
  _resetBreakers();
  _resetRateLimiter();
  process.env['AWIN_ADVERTISER_API_TOKEN'] = 'fake-token';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['AWIN_ADVERTISER_API_TOKEN'];
  _resetRateLimiter();
});

// ---------------------------------------------------------------------------
// Transformers and status mapping
// ---------------------------------------------------------------------------

describe('Awin advertiser transformers', () => {
  it('maps Awin commissionStatus to canonical TransactionStatus (declined → reversed)', () => {
    expect(_internals.mapTransactionStatus({ commissionStatus: 'pending' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ commissionStatus: 'approved' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ commissionStatus: 'declined' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ commissionStatus: 'paid' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ commissionStatus: 'weird' })).toBe('other');
  });

  it('maps publisher status to active|pending|inactive|unknown', () => {
    expect(_internals.mapPublisherStatus({ status: 'active' })).toBe('active');
    expect(_internals.mapPublisherStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapPublisherStatus({ status: 'inactive' })).toBe('inactive');
    expect(_internals.mapPublisherStatus({ status: 'declined' })).toBe('inactive');
    expect(_internals.mapPublisherStatus({ status: 'something-else' })).toBe('unknown');
  });

  it('splits a report row into one performance row per status tier', () => {
    const rows = loadFixture('performance-report.json') as Array<Record<string, unknown>>;
    const out = _internals.toPerformanceRows(rows[0] as never);
    const pick = (s: string) => {
      const r = out.find((row) => row.status === s);
      if (!r) throw new Error(`expected a ${s} row`);
      return r;
    };

    // pending / confirmed(approved) / declined(reversed) each surface with their
    // own value and commission — the split is no longer collapsed (#282).
    expect(pick('approved')).toMatchObject({ conversions: 18, grossSale: 1800, commission: 240 });
    expect(pick('pending')).toMatchObject({ conversions: 5, grossSale: 500, commission: 50 });
    expect(pick('reversed')).toMatchObject({ conversions: 1, grossSale: 100, commission: 10 });

    // total tracked (pending + confirmed) ties out to the report's total columns.
    expect(pick('pending').commission + pick('approved').commission).toBe(290);

    // Clicks attach to the approved row only, so a per-publisher click sum is exact.
    expect(pick('approved').clicks).toBe(1200);
    expect(pick('pending').clicks).toBe(0);
    expect(pick('reversed').clicks).toBe(0);
    expect(out.reduce((n, r) => n + r.clicks, 0)).toBe(1200);
  });

  it('emits only the approved row when a publisher has no pending or declined activity', () => {
    const rows = loadFixture('performance-report.json') as Array<Record<string, unknown>>;
    const out = _internals.toPerformanceRows(rows[1] as never);
    // Coupon Cabin has pending but no confirmed and no declined.
    const statuses = out.map((r) => r.status).sort();
    expect(statuses).toEqual(['approved', 'pending']);
    expect(out.find((r) => r.status === 'approved')).toMatchObject({ grossSale: 0, commission: 0, clicks: 350 });
  });

  it('preserves raw network data on every domain transform', () => {
    const txn = (loadFixture('transactions.json') as Array<Record<string, unknown>>)[0];
    const t = _internals.toTransaction(txn as never);
    expect(t.rawNetworkData).toBe(txn);

    const pub = (loadFixture('publishers.json') as Array<Record<string, unknown>>)[0];
    const p = _internals.toMediaPartner(pub as never);
    expect(p.rawNetworkData).toBe(pub);
  });

  it('surfaces declineReason on declined transactions only', () => {
    const txns = loadFixture('transactions.json') as Array<Record<string, unknown>>;
    const declined = _internals.toTransaction(txns[2] as never);
    expect(declined.status).toBe('reversed');
    expect(declined.reversalReason).toBe('Customer returned the item within 14 days');

    const approved = _internals.toTransaction(txns[0] as never);
    expect(approved.status).toBe('approved');
    expect(approved.reversalReason).toBeUndefined();
  });

  it('round-trips per-publisher identity and date onto every emitted row', () => {
    const rows = loadFixture('performance-report.json') as Array<Record<string, unknown>>;
    const out = _internals.toPerformanceRows(rows[0] as never);
    for (const r of out) {
      expect(r.date).toBe('2026-05-01');
      expect(r.publisherId).toBe('555001');
      expect(r.publisherName).toBe('BestDeals.com');
      expect(r.currency).toBe('GBP');
      expect(r.rawNetworkData).toBe(rows[0]);
    }
  });

  it('normalises Awin date strings (best-effort tz)', () => {
    expect(_internals.parseAwinDate('2026-05-01T10:00:00Z')).toBe('2026-05-01T10:00:00.000Z');
    expect(_internals.parseAwinDate('not-a-date')).toBeUndefined();
    expect(_internals.parseAwinDate(undefined)).toBeUndefined();
  });

  it('canonicalToAwinStatus maps reversed back to declined', () => {
    expect(_internals.canonicalToAwinStatus('pending')).toBe('pending');
    expect(_internals.canonicalToAwinStatus('approved')).toBe('approved');
    expect(_internals.canonicalToAwinStatus('reversed')).toBe('declined');
  });

  it('toDiscoveredBrand returns apiEnabled:true (rate-budget rationale)', () => {
    const b = _internals.toDiscoveredBrand({
      accountId: 1001,
      accountName: 'Acme Widgets',
      type: 'advertiser',
    });
    expect(b.networkBrandId).toBe('1001');
    expect(b.displayName).toBe('Acme Widgets');
    expect(b.apiEnabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-network normalisation fields (rollout: Awin advertiser reference)
// See docs/contributing/normalisation-rollout.md for the per-field pattern.
// ---------------------------------------------------------------------------

describe('Awin advertiser normalisation fields', () => {
  it('declares networkTimezone = Europe/London', () => {
    expect(awinAdvertiserAdapter.meta.networkTimezone).toBe('Europe/London');
  });

  it('preserves offset-qualified timestamps and converts naïve ones via the zone', () => {
    // Offset-qualified passthrough (also covered by the existing test).
    expect(_internals.parseAwinDate('2026-04-15T10:00:00Z')).toBe('2026-04-15T10:00:00.000Z');
    // Naïve input is interpreted in Europe/London, NOT blindly assumed UTC.
    // 2026-07-01 is BST (UTC+1): naïve 10:00 → 09:00Z.
    expect(_internals.parseAwinDate('2026-07-01T10:00:00')).toBe('2026-07-01T09:00:00.000Z');
    // 2026-01-01 is GMT (UTC+0): naïve 10:00 → 10:00Z.
    expect(_internals.parseAwinDate('2026-01-01T10:00:00')).toBe('2026-01-01T10:00:00.000Z');
  });

  it('populates statusRaw with the verbatim Awin commissionStatus token', () => {
    const txns = loadFixture('transactions.json') as Array<Record<string, unknown>>;
    expect(_internals.toTransaction(txns[0] as never).statusRaw).toBe('approved');
    expect(_internals.toTransaction(txns[1] as never).statusRaw).toBe('pending');
    const declined = _internals.toTransaction(txns[2] as never);
    expect(declined.status).toBe('reversed');
    expect(declined.statusRaw).toBe('declined');
  });

  it('derives transaction merchantKey from the brand landing url domain', () => {
    const txns = loadFixture('transactions.json') as Array<Record<string, unknown>>;
    // transaction[0] url = https://acme.example.com/checkout → example.com.
    expect(_internals.toTransaction(txns[0] as never).merchantKey).toBe('example.com');
    // transaction[1] has no url → no key (no fallback-name on advertiser rows).
    expect(_internals.toTransaction(txns[1] as never).merchantKey).toBeUndefined();
  });

  it('marks the synthetic listProgrammes row merchantKeySource = none', async () => {
    const r = await awinAdvertiserAdapter.listProgrammes(undefined, { networkBrandId: '100001' });
    expect(r[0]?.merchantKey).toBeUndefined();
    expect(r[0]?.merchantKeySource).toBe('none');
  });

  it('registrableDomain handles two-part TLDs and strips www', () => {
    expect(_internals.registrableDomain('https://www.shop.co.uk/x')).toBe('shop.co.uk');
    expect(_internals.registrableDomain('https://deep.sub.example.com')).toBe('example.com');
    expect(_internals.registrableDomain('not a url')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listBrands — /accounts filtered to advertiser type
// ---------------------------------------------------------------------------

describe('Awin advertiser.listBrands', () => {
  it('filters /accounts to advertiser-type entries and reports apiEnabled:true', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('accounts.json'))]);
    const brands = await awinAdvertiserAdapter.listBrands();
    expect(brands).toHaveLength(3);
    expect(brands.map((b) => b.networkBrandId).sort()).toEqual(['100001', '100002', '100003']);
    expect(brands.every((b) => b.apiEnabled === true)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/accounts');
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.headers).toMatchObject({ Authorization: 'Bearer fake-token' });
  });

  it('tolerates a wrapped {accounts: [...]} response shape', async () => {
    const wrapped = { accounts: loadFixture('accounts.json') };
    mockFetchQueue([fakeResponse(wrapped)]);
    const brands = await awinAdvertiserAdapter.listBrands();
    expect(brands).toHaveLength(3);
  });

  it('discovers advertisers from the live `accountType` field, not just `type`', async () => {
    // Live `GET /accounts` carries the kind on `accountType`; reading `type`
    // alone returned zero advertisers (the no-advertiser-accounts bug).
    mockFetchQueue([fakeResponse(loadFixture('accounts-accounttype.json'))]);
    const brands = await awinAdvertiserAdapter.listBrands();
    expect(brands.map((b) => b.networkBrandId).sort()).toEqual(['19011', '74386']);
    expect(brands.every((b) => b.apiEnabled === true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// URL shape — every data endpoint goes under /advertisers/{id}/...
// ---------------------------------------------------------------------------

describe('Awin advertiser URL shape', () => {
  it('listTransactions targets /advertisers/{id}/transactions/', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    await awinAdvertiserAdapter.listTransactions(
      { from: '2026-04-01', to: '2026-05-01' },
      { networkBrandId: '100001' },
    );
    expect(calls[0]?.url).toContain('/advertisers/100001/transactions/');
    expect(calls[0]?.url).toContain('startDate=2026-04-01');
    expect(calls[0]?.url).toContain('endDate=2026-05-01');
    expect(calls[0]?.url).toContain('dateType=transaction');
  });

  it('listMediaPartners targets /advertisers/{id}/publishers/', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('publishers.json'))]);
    await awinAdvertiserAdapter.listMediaPartners(undefined, { networkBrandId: '100001' });
    expect(calls[0]?.url).toContain('/advertisers/100001/publishers/');
  });

  it('getProgrammePerformance targets /advertisers/{id}/reports/publisher', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('performance-report.json'))]);
    await awinAdvertiserAdapter.getProgrammePerformance(
      { from: '2026-05-01', to: '2026-05-31' },
      { networkBrandId: '100001' },
    );
    expect(calls[0]?.url).toContain('/advertisers/100001/reports/publisher');
    expect(calls[0]?.url).toContain('startDate=2026-05-01');
    expect(calls[0]?.url).toContain('endDate=2026-05-31');
  });

  it('every data endpoint URL-encodes the networkBrandId', async () => {
    const { calls } = mockFetchQueue([fakeResponse([])]);
    await awinAdvertiserAdapter.listMediaPartners(undefined, {
      networkBrandId: 'has/slash',
    });
    // encodeURIComponent of '/' is %2F.
    expect(calls[0]?.url).toContain('/advertisers/has%2Fslash/publishers/');
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('Awin advertiser.listTransactions', () => {
  it('returns transformed transactions with normalised status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const r = await awinAdvertiserAdapter.listTransactions(undefined, {
      networkBrandId: '100001',
    });
    expect(r).toHaveLength(3);
    expect(r.map((t) => t.status).sort()).toEqual(['approved', 'pending', 'reversed']);
  });

  it('filters by status client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const r = await awinAdvertiserAdapter.listTransactions(
      { status: 'reversed' },
      { networkBrandId: '100001' },
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.reversalReason).toBe('Customer returned the item within 14 days');
  });

  it('passes a single-status filter through as an upstream query param (reversed → declined)', async () => {
    const { calls } = mockFetchQueue([fakeResponse([])]);
    await awinAdvertiserAdapter.listTransactions(
      { status: 'reversed' },
      { networkBrandId: '100001' },
    );
    expect(calls[0]?.url).toContain('status=declined');
  });

  it('refuses to run without a brand context (config_error)', async () => {
    await expect(awinAdvertiserAdapter.listTransactions()).rejects.toBeInstanceOf(NetworkError);
    try {
      await awinAdvertiserAdapter.listTransactions();
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('config_error');
    }
  });
});

// ---------------------------------------------------------------------------
// listMediaPartners
// ---------------------------------------------------------------------------

describe('Awin advertiser.listMediaPartners', () => {
  it('returns publishers with normalised status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('publishers.json'))]);
    const r = await awinAdvertiserAdapter.listMediaPartners(undefined, {
      networkBrandId: '100001',
    });
    expect(r).toHaveLength(3);
    expect(r.map((p) => p.status).sort()).toEqual(['active', 'inactive', 'pending']);
  });

  it('filters by status array', async () => {
    mockFetchQueue([fakeResponse(loadFixture('publishers.json'))]);
    const r = await awinAdvertiserAdapter.listMediaPartners(
      { status: ['active'] },
      { networkBrandId: '100001' },
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.name).toBe('BestDeals.com');
  });

  it('filters by search', async () => {
    mockFetchQueue([fakeResponse(loadFixture('publishers.json'))]);
    const r = await awinAdvertiserAdapter.listMediaPartners(
      { search: 'cabin' },
      { networkBrandId: '100001' },
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.name).toBe('Coupon Cabin');
  });
});

// ---------------------------------------------------------------------------
// getProgrammePerformance
// ---------------------------------------------------------------------------

describe('Awin advertiser.getProgrammePerformance', () => {
  it('returns per-status rows per publisher with an accurate commission split', async () => {
    mockFetchQueue([fakeResponse(loadFixture('performance-report.json'))]);
    const rows = await awinAdvertiserAdapter.getProgrammePerformance(
      { from: '2026-05-01', to: '2026-05-31' },
      { networkBrandId: '100001' },
    );
    // BestDeals → 3 tiers (approved/pending/reversed); Coupon Cabin → 2 (approved/pending).
    expect(rows).toHaveLength(5);

    const best = rows.filter((r) => r.publisherId === '555001');
    const bestByStatus = Object.fromEntries(best.map((r) => [r.status, r]));
    expect(bestByStatus['approved']?.commission).toBe(240);
    expect(bestByStatus['pending']?.commission).toBe(50);
    expect(bestByStatus['reversed']?.commission).toBe(10);
    // Clicks attributed once (approved row), so the per-publisher sum is exact.
    expect(best.reduce((n, r) => n + r.clicks, 0)).toBe(1200);
    expect(best.every((r) => r.currency === 'GBP')).toBe(true);
  });

  it('scopes to a single publisher when publisherId is provided', async () => {
    mockFetchQueue([fakeResponse(loadFixture('performance-report.json'))]);
    const rows = await awinAdvertiserAdapter.getProgrammePerformance(
      { publisherId: '555002' },
      { networkBrandId: '100001' },
    );
    // Coupon Cabin has approved + pending tiers.
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.publisherId === '555002')).toBe(true);
  });

  it('tolerates a wrapped {rows: [...]} response shape', async () => {
    mockFetchQueue([fakeResponse({ rows: loadFixture('performance-report.json') })]);
    const rows = await awinAdvertiserAdapter.getProgrammePerformance(undefined, {
      networkBrandId: '100001',
    });
    expect(rows).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes — synthetic single-row
// ---------------------------------------------------------------------------

describe('Awin advertiser.listProgrammes', () => {
  it('returns one synthetic Programme keyed on the call-context advertiserId', async () => {
    const r = await awinAdvertiserAdapter.listProgrammes(undefined, {
      networkBrandId: '100001',
    });
    expect(r).toHaveLength(1);
    expect(r[0]?.id).toBe('100001');
    expect(r[0]?.network).toBe('awin-advertiser');
    expect(r[0]?.status).toBe('joined');
  });

  it('refuses to run without a brand context', async () => {
    await expect(awinAdvertiserAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });

  it('refuses to run without a token (config_error)', async () => {
    delete process.env['AWIN_ADVERTISER_API_TOKEN'];
    await expect(
      awinAdvertiserAdapter.listProgrammes(undefined, { networkBrandId: '100001' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('Awin advertiser.verifyAuth', () => {
  it('returns ok with an identity describing the advertiser-account count', async () => {
    mockFetchQueue([fakeResponse(loadFixture('accounts.json'))]);
    const r = await awinAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('advertiser-account');
    }
  });

  it('returns {ok:false} on 401', async () => {
    // Default resilience retries; queue enough failures to exhaust them.
    mockFetchQueue([
      fakeResponse('unauthorized', { status: 401 }),
      fakeResponse('unauthorized', { status: 401 }),
      fakeResponse('unauthorized', { status: 401 }),
    ]);
    const r = await awinAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });

  it('returns {ok:false} when the token is missing entirely', async () => {
    delete process.env['AWIN_ADVERTISER_API_TOKEN'];
    const r = await awinAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ops not implemented at v0.1
// ---------------------------------------------------------------------------

describe('Awin advertiser unimplemented ops', () => {
  it('throws NotImplementedError on getProgramme / getEarningsSummary / listClicks / generateTrackingLink', async () => {
    await expect(awinAdvertiserAdapter.getProgramme('X')).rejects.toBeInstanceOf(NotImplementedError);
    await expect(awinAdvertiserAdapter.getEarningsSummary()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(awinAdvertiserAdapter.listClicks()).rejects.toBeInstanceOf(NotImplementedError);
    await expect(
      awinAdvertiserAdapter.generateTrackingLink({
        programmeId: 'X',
        destinationUrl: 'https://example.com',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// Per-operation claimStatus (review feedback workstream 1)
// ---------------------------------------------------------------------------

describe('Awin advertiser.capabilitiesCheck — per-op claimStatus', () => {
  it('marks listBrands as partial (tier-probing skipped)', async () => {
    const caps = await awinAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['listBrands']?.claimStatus).toBe('partial');
  });

  it('marks getProgrammePerformance as experimental (report column aliases unverified)', async () => {
    const caps = await awinAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['getProgrammePerformance']?.claimStatus).toBe('experimental');
  });

  it('marks listProgrammes as experimental (synthetic single-row fallback)', async () => {
    const caps = await awinAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['listProgrammes']?.claimStatus).toBe('experimental');
  });

  it('does NOT mark listTransactions or listMediaPartners — no override', async () => {
    const caps = await awinAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['listTransactions']?.claimStatus).toBeUndefined();
    expect(caps.operations['listMediaPartners']?.claimStatus).toBeUndefined();
  });
});
