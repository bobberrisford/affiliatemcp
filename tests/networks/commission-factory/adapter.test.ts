/**
 * Commission Factory adapter — unit tests.
 *
 * Pattern-matched to `tests/networks/skimlinks/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - Circuit breakers are reset in `beforeEach` so no test bleeds state.
 *   - Fake credentials are injected via `process.env` (obvious non-secret values).
 *   - Fixtures live under `tests/fixtures/commission-factory/`.
 *
 * Commission Factory has no token-exchange step (the API key is a query
 * parameter), so each operation makes a single fetch — no token pre-call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  commissionFactoryAdapter,
  _internals,
} from '../../../src/networks/commission-factory/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'commission-factory');
const NOW = new Date('2026-06-04T00:00:00Z');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(
  body: unknown,
  init: { status?: number; rawBody?: string } = {},
): Response {
  const status = init.status ?? 200;
  const text = init.rawBody ?? (typeof body === 'string' ? body : JSON.stringify(body));
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockFetchQueue(responses: Response[]): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => {
    const r = responses.shift();
    if (!r) throw new Error('mock fetch queue exhausted');
    return r;
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

beforeEach(() => {
  _resetBreakers();
  process.env['COMMISSION_FACTORY_API_KEY'] = 'test-api-key-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['COMMISSION_FACTORY_API_KEY'];
});

// ---------------------------------------------------------------------------
// Transformer unit tests (status normalisation + raw preservation)
// ---------------------------------------------------------------------------

describe('Commission Factory transformers (status normalisation, raw preservation)', () => {
  it('maps CF Status2 strings to canonical TransactionStatus (prefers Status2)', () => {
    expect(_internals.mapTransactionStatus({ Status2: 'Pending' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ Status2: 'Confirmed' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ Status2: 'Paid' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ Status2: 'Declined' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ Status2: 'Void' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ Status2: 'Something' })).toBe('other');
    expect(_internals.mapTransactionStatus({})).toBe('other');
    // Falls back to deprecated Status when Status2 absent.
    expect(_internals.mapTransactionStatus({ Status: 'Approved' })).toBe('approved');
    // Status2 wins over Status.
    expect(_internals.mapTransactionStatus({ Status2: 'Paid', Status: 'Pending' })).toBe('paid');
  });

  it('maps CF merchant statuses to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ Status: 'Joined' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ Status: 'Pending' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ Status: 'Declined' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ Status: 'Available' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ Status: 'Suspended' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ Status: 'Mystery' })).toBe('unknown');
    expect(_internals.mapProgrammeStatus({})).toBe('unknown');
  });

  it('preserves the raw CF payload in rawNetworkData', () => {
    const fixture = loadFixture('transactions.json') as Record<string, unknown>[];
    const raw = fixture[0] as Record<string, unknown>;
    const out = _internals.toTransaction(raw as never, NOW);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('reads currency per transaction, not hardcoded (AUD and NZD both appear)', () => {
    const fixture = loadFixture('transactions.json') as Record<string, unknown>[];
    const aud = _internals.toTransaction(fixture[0] as never, NOW);
    const nzd = _internals.toTransaction(fixture[2] as never, NOW);
    expect(aud.currency).toBe('AUD');
    expect(nzd.currency).toBe('NZD');
  });

  it('surfaces reversalReason from VoidReason on reversed transactions', () => {
    const fixture = loadFixture('transactions.json') as Record<string, unknown>[];
    const declined = fixture[2] as Record<string, unknown>;
    const out = _internals.toTransaction(declined as never, NOW);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Customer returned the item within 30 days');
  });

  it('computes ageDays from OrderDate, then DateCreated (deterministic now)', () => {
    // OrderDate = 2026-05-25 → 10 days before 2026-06-04
    const age1 = _internals.computeAgeDays(
      { OrderDate: '2026-05-25T00:00:00Z', DateCreated: '2026-05-01T00:00:00Z' },
      NOW,
    );
    expect(age1).toBe(10);
    // No OrderDate → falls back to DateCreated = 2026-05-30 → 5 days
    const age2 = _internals.computeAgeDays({ DateCreated: '2026-05-30T00:00:00Z' }, NOW);
    expect(age2).toBe(5);
    // No anchor → 0
    expect(_internals.computeAgeDays({}, NOW)).toBe(0);
  });

  it('normalises string and number amounts', () => {
    expect(_internals.toAmount(5.5)).toBe(5.5);
    expect(_internals.toAmount('12.75')).toBe(12.75);
    expect(_internals.toAmount(undefined)).toBe(0);
    expect(_internals.toAmount('not-a-number')).toBe(0);
  });

  it('maps commission rate type from CommissionType', () => {
    expect(_internals.mapCommissionRate({ CommissionType: 'Percentage', CommissionRate: 5 })?.type).toBe(
      'percent',
    );
    expect(_internals.mapCommissionRate({ CommissionType: 'Fixed', CommissionRate: 4 })?.type).toBe(
      'flat',
    );
    expect(_internals.mapCommissionRate({})).toBeUndefined();
  });

  it('normalises both bare-array and wrapped-array CF responses', () => {
    expect(_internals.asArray([{ Id: 1 }]).length).toBe(1);
    expect(_internals.asArray({ Items: [{ Id: 1 }, { Id: 2 }] }).length).toBe(2);
    expect(_internals.asArray({ nothing: true }).length).toBe(0);
  });

  it('builds a deep link by swapping /t/ for /b/ and appending ?Url=', () => {
    const link = _internals.buildDeepLink(
      'https://t.cfjump.com/0/t/5001',
      'https://shop.test/item?id=9&ref=x',
    );
    expect(link).toBe(
      'https://t.cfjump.com/0/b/5001?Url=https%3A%2F%2Fshop.test%2Fitem%3Fid%3D9%26ref%3Dx',
    );
  });

  it('maps canonical status to CF Status2 only for single resolvable statuses', () => {
    expect(_internals.mapCanonicalToCfStatus(['pending'])).toBe('Pending');
    expect(_internals.mapCanonicalToCfStatus(['approved'])).toBe('Confirmed');
    expect(_internals.mapCanonicalToCfStatus(['paid'])).toBe('Paid');
    // reversed maps to two upstream values → undefined (client-side filtering).
    expect(_internals.mapCanonicalToCfStatus(['reversed'])).toBeUndefined();
    expect(_internals.mapCanonicalToCfStatus(['pending', 'paid'])).toBeUndefined();
    expect(_internals.mapCanonicalToCfStatus(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('CommissionFactoryAdapter.listProgrammes', () => {
  it('lists merchants and normalises programme status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchants.json'))]);
    const programmes = await commissionFactoryAdapter.listProgrammes();
    expect(programmes.length).toBe(3);
    expect(programmes[0]?.status).toBe('joined');
    expect(programmes[0]?.network).toBe('commission-factory');
  });

  it('filters by canonical programme status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchants.json'))]);
    const joined = await commissionFactoryAdapter.listProgrammes({ status: 'joined' });
    expect(joined.every((p) => p.status === 'joined')).toBe(true);
    expect(joined.length).toBe(1);
  });

  it('filters by search term and respects limit', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchants.json'))]);
    const found = await commissionFactoryAdapter.listProgrammes({ search: 'beauty', limit: 5 });
    expect(found.length).toBe(1);
    expect(found[0]?.name).toContain('Beauty');
  });

  it('emits a NetworkError when the API key is missing', async () => {
    delete process.env['COMMISSION_FACTORY_API_KEY'];
    await expect(commissionFactoryAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getProgramme
// ---------------------------------------------------------------------------

describe('CommissionFactoryAdapter.getProgramme', () => {
  it('fetches and normalises a single merchant', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchant.json'))]);
    const p = await commissionFactoryAdapter.getProgramme('5001');
    expect(p.id).toBe('5001');
    expect(p.status).toBe('joined');
    expect(p.advertiserUrl).toBe('https://www.exampleoutdoor.test/');
  });

  it('throws config_error when programmeId is empty', async () => {
    await expect(commissionFactoryAdapter.getProgramme('')).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('CommissionFactoryAdapter.listTransactions', () => {
  it('returns all transactions in the window', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const all = await commissionFactoryAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    expect(all.length).toBe(4);
  });

  it('returns only aged transactions when minAgeDays is set', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const aged = await commissionFactoryAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
      minAgeDays: 365,
    });
    expect(aged.length).toBeGreaterThan(0);
    for (const t of aged) expect(t.ageDays).toBeGreaterThanOrEqual(365);
  });

  it('filters by canonical status[] (reversed) client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const only = await commissionFactoryAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
    expect(only[0]?.reversalReason).toBe('Customer returned the item within 30 days');
  });

  it('respects limit after all other filters', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const limited = await commissionFactoryAdapter.listTransactions({ limit: 2 });
    expect(limited.length).toBeLessThanOrEqual(2);
  });

  it('emits a NetworkError when the API key is missing', async () => {
    delete process.env['COMMISSION_FACTORY_API_KEY'];
    await expect(commissionFactoryAdapter.listTransactions({})).rejects.toBeInstanceOf(
      NetworkError,
    );
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary — derived from listTransactions
// ---------------------------------------------------------------------------

describe('CommissionFactoryAdapter.getEarningsSummary', () => {
  it('aggregates commissions correctly from fixture data', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const summary = await commissionFactoryAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    expect(summary.network).toBe('commission-factory');
    expect(summary.totalEarnings).toBeCloseTo(6.0 + 12.5 + 3.2 + 8.0, 2);
    expect(summary.byStatus.pending).toBeCloseTo(6.0, 2);
    expect(summary.byStatus.approved).toBeCloseTo(12.5, 2);
    expect(summary.byStatus.reversed).toBeCloseTo(3.2, 2);
    expect(summary.byStatus.paid).toBeCloseTo(8.0, 2);
    expect(summary.byProgramme.length).toBe(2);
  });

  it('sets oldestUnpaidAgeDays from the longest-pending/approved transaction', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const summary = await commissionFactoryAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    // txn-10002 OrderDate 2024-01-18 is approved and unpaid — oldest unpaid.
    expect(summary.oldestUnpaidAgeDays).toBeDefined();
    expect(summary.oldestUnpaidAgeDays ?? 0).toBeGreaterThan(365);
  });

  it('returns an empty summary when no transactions match', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions_empty.json'))]);
    const summary = await commissionFactoryAdapter.getEarningsSummary({});
    expect(summary.totalEarnings).toBe(0);
    expect(summary.byProgramme).toHaveLength(0);
    expect(summary.oldestUnpaidAgeDays).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listClicks — not exposed
// ---------------------------------------------------------------------------

describe('CommissionFactoryAdapter.listClicks', () => {
  it('throws NotImplementedError with a CF-specific reason', async () => {
    await expect(commissionFactoryAdapter.listClicks({})).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    try {
      await commissionFactoryAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click-level data');
    }
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink
// ---------------------------------------------------------------------------

describe('CommissionFactoryAdapter.generateTrackingLink', () => {
  it('derives a deep link from the merchant TrackingUrl', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchant.json'))]);
    const link = await commissionFactoryAdapter.generateTrackingLink({
      programmeId: '5001',
      destinationUrl: 'https://www.exampleoutdoor.test/product?q=tent',
    });
    expect(link.network).toBe('commission-factory');
    expect(link.programmeId).toBe('5001');
    expect(link.trackingUrl).toBe(
      'https://t.cfjump.com/0/b/5001?Url=https%3A%2F%2Fwww.exampleoutdoor.test%2Fproduct%3Fq%3Dtent',
    );
  });

  it('throws config_error when destinationUrl is empty', async () => {
    await expect(
      commissionFactoryAdapter.generateTrackingLink({ programmeId: '5001', destinationUrl: '' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws config_error when programmeId is empty', async () => {
    await expect(
      commissionFactoryAdapter.generateTrackingLink({
        programmeId: '',
        destinationUrl: 'https://x.test/',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a network error when the merchant has no TrackingUrl (not joined)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchant_not_joined.json'))]);
    await expect(
      commissionFactoryAdapter.generateTrackingLink({
        programmeId: '5003',
        destinationUrl: 'https://www.examplegadgets.test/',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth — happy + failure paths
// ---------------------------------------------------------------------------

describe('CommissionFactoryAdapter.verifyAuth', () => {
  it('returns ok:true with a redacted key fingerprint on success', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchants.json'))]);
    const r = await commissionFactoryAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('commission-factory/key:****');
      // Must not echo the full key.
      expect(r.identity).not.toContain('test-api-key-please-ignore');
    }
  });

  it('returns ok:false (does not throw) on a 401', async () => {
    mockFetchQueue([fakeResponse('Unauthorized', { status: 401, rawBody: 'Unauthorized' })]);
    await expect(commissionFactoryAdapter.verifyAuth()).resolves.toMatchObject({ ok: false });
  });

  it('returns ok:false with a reason mentioning the failure on 403', async () => {
    mockFetchQueue([fakeResponse('Forbidden', { status: 403, rawBody: 'Forbidden' })]);
    const r = await commissionFactoryAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/403|forbidden|auth/i);
  });

  it('returns ok:false when the API key is missing', async () => {
    delete process.env['COMMISSION_FACTORY_API_KEY'];
    const r = await commissionFactoryAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('CommissionFactoryAdapter.validateCredential', () => {
  it('validates the API key via a live probe', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchants.json'))]);
    const r = await commissionFactoryAdapter.validateCredential(
      'COMMISSION_FACTORY_API_KEY',
      'another-test-key-please-ignore',
    );
    expect(r.ok).toBe(true);
  });

  it('rejects an empty API key', async () => {
    const r = await commissionFactoryAdapter.validateCredential('COMMISSION_FACTORY_API_KEY', '');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('returns ok:false with a hint when the key is rejected upstream', async () => {
    mockFetchQueue([fakeResponse('Unauthorized', { status: 401, rawBody: 'Unauthorized' })]);
    const r = await commissionFactoryAdapter.validateCredential(
      'COMMISSION_FACTORY_API_KEY',
      'bad-key',
    );
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('returns ok:false for unknown credential fields', async () => {
    const r = await commissionFactoryAdapter.validateCredential('COMMISSION_FACTORY_UNKNOWN', 'x');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Admin operations
// ---------------------------------------------------------------------------

describe('CommissionFactoryAdapter admin ops', () => {
  it('listPublishers throws NotImplementedError', async () => {
    await expect(commissionFactoryAdapter.listPublishers()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });

  it('listPublisherSectors throws NotImplementedError', async () => {
    await expect(commissionFactoryAdapter.listPublisherSectors()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency
// ---------------------------------------------------------------------------

describe('error transparency', () => {
  it('surfaces the verbatim response body on a 500', async () => {
    const body = '{"error":"upstream exploded","trace":"xyz"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await commissionFactoryAdapter.listTransactions({});
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('commission-factory');
      expect(env.operation).toBe('listTransactions');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream exploded');
    }
  });

  it('classifies 401 on the Affiliate API as auth_error', async () => {
    mockFetchQueue([fakeResponse('Forbidden', { status: 401, rawBody: 'Forbidden' })]);
    try {
      await commissionFactoryAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('auth_error');
    }
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('CommissionFactoryAdapter.capabilitiesCheck', () => {
  it('records listClicks as not supported and probes the rest', async () => {
    // Probes: verifyAuth (1), listProgrammes (1), listTransactions (1),
    // getEarningsSummary → listTransactions (1).
    mockFetchQueue([
      fakeResponse(loadFixture('merchants.json')), // verifyAuth
      fakeResponse(loadFixture('merchants.json')), // listProgrammes
      fakeResponse(loadFixture('transactions_empty.json')), // listTransactions
      fakeResponse(loadFixture('transactions_empty.json')), // getEarningsSummary
    ]);
    const caps = await commissionFactoryAdapter.capabilitiesCheck();
    expect(caps.network).toBe('commission-factory');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['verifyAuth']?.supported).toBe(true);
    expect(caps.operations['listProgrammes']?.supported).toBe(true);
    expect(caps.operations['listTransactions']?.supported).toBe(true);
    expect(caps.operations['getEarningsSummary']?.supported).toBe(true);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(true);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
