/**
 * Affise affiliate (partner) adapter — unit tests.
 *
 * Pattern matched to `tests/networks/everflow/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 *   - Fixtures live under `tests/networks/affise/fixtures/` and approximate the
 *     shape of real Affise API responses. No real tokens, no real data.
 *
 * Affise is multi-tenant: both AFFISE_BASE_URL (the per-network tracking
 * domain) and AFFISE_API_KEY are required for every authenticated call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { affiseAdapter, _internals } from '../../../src/networks/affise/adapter.js';
import { resolveBaseUrl } from '../../../src/networks/affise/client.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'networks', 'affise', 'fixtures');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(body: unknown, init: { status?: number; rawBody?: string } = {}): Response {
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
  process.env['AFFISE_BASE_URL'] = 'https://api-yournetwork.affise.com';
  process.env['AFFISE_API_KEY'] = 'test-api-key-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['AFFISE_BASE_URL'];
  delete process.env['AFFISE_API_KEY'];
});

// ---------------------------------------------------------------------------
// Per-tenant base URL (the key deviation from everflow)
// ---------------------------------------------------------------------------

describe('Affise per-tenant base URL', () => {
  it('resolves the configured base URL to its origin', () => {
    process.env['AFFISE_BASE_URL'] = 'https://api-yournetwork.affise.com/some/path?x=1';
    expect(resolveBaseUrl('test')).toBe('https://api-yournetwork.affise.com');
  });

  it('throws a config_error envelope when AFFISE_BASE_URL is missing (§15.4)', () => {
    delete process.env['AFFISE_BASE_URL'];
    try {
      resolveBaseUrl('test');
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).envelope.type).toBe('config_error');
    }
  });

  it('throws a config_error envelope when AFFISE_BASE_URL is not a valid URL', () => {
    process.env['AFFISE_BASE_URL'] = 'not a url';
    try {
      resolveBaseUrl('test');
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).envelope.type).toBe('config_error');
    }
  });

  it('rejects a non-http(s) scheme as config_error', () => {
    process.env['AFFISE_BASE_URL'] = 'ftp://api-yournetwork.affise.com';
    try {
      resolveBaseUrl('test');
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).envelope.type).toBe('config_error');
    }
  });

  it('builds request URLs against the per-tenant base', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    await affiseAdapter.listProgrammes({ limit: 1 });
    const calledUrl = String(spy.mock.calls[0]?.[0]);
    expect(calledUrl).toContain('https://api-yournetwork.affise.com/3.0/partner/offers');
  });
});

// ---------------------------------------------------------------------------
// Transformation (status mapping + raw preservation)
// ---------------------------------------------------------------------------

describe('Affise transformers (status normalisation, raw preservation)', () => {
  it('maps offer statuses to canonical ProgrammeStatus', () => {
    // Connection state takes precedence.
    expect(_internals.mapProgrammeStatus({ is_connected: true })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ is_connected: false, required_approval: true })).toBe(
      'pending',
    );
    // Fall back to lifecycle status.
    expect(_internals.mapProgrammeStatus({ status: 'active' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ status: 'stopped' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'suspended' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'something-new' })).toBe('unknown');
    expect(_internals.mapProgrammeStatus({})).toBe('unknown');
  });

  it('maps conversion statuses to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ status: 'confirmed' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'approved' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: '1' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'pending' })).toBe('pending');
    // Hold is a time-delayed approval — treated as pending.
    expect(_internals.mapTransactionStatus({ status: 'hold' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: '5' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'declined' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: '3' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'trash' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'unknown_future' })).toBe('other');
    expect(_internals.mapTransactionStatus({})).toBe('other');
  });

  it('preserves the raw Affise payload under rawNetworkData', () => {
    const conversions = (loadFixture('conversions.json') as { conversions: Record<string, unknown>[] })
      .conversions;
    const raw = conversions[0] as Record<string, unknown>;
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('surfaces reversalReason from comment on declined transactions (§15.10)', () => {
    const conversions = (loadFixture('conversions.json') as { conversions: Record<string, unknown>[] })
      .conversions;
    const declined = conversions[2] as Record<string, unknown>;
    const out = _internals.toTransaction(declined as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toContain('Duplicate conversion');
  });

  it('computes ageDays from created_at against a fixed now', () => {
    const now = new Date('2026-05-28T12:00:00Z');
    // 2026-01-15 10:00:00Z → 2026-05-28 12:00:00Z = 133 days 2 hours → floors to 133.
    const age = _internals.computeAgeDays({ created_at: '2026-01-15 10:00:00' } as never, now);
    expect(age).toBe(133);
  });

  it('returns 0 ageDays when created_at is missing', () => {
    const now = new Date('2026-05-28T00:00:00Z');
    expect(_internals.computeAgeDays({} as never, now)).toBe(0);
  });

  it('maps payout as commission and currency from the conversion record', () => {
    const tx = _internals.toTransaction({
      id: 'x1',
      status: 'confirmed',
      payouts: 6.5,
      revenue: 9.0,
      currency: 'EUR',
      created_at: '2026-01-15 10:00:00',
    } as never);
    expect(tx.commission).toBe(6.5);
    expect(tx.amount).toBe(9.0);
    expect(tx.currency).toBe('EUR');
  });

  it('maps offer payout and currency onto the programme', () => {
    const offers = (loadFixture('offers.json') as { offers: Record<string, unknown>[] }).offers;
    const prog = _internals.toProgramme(offers[0] as never);
    expect(prog.id).toBe('1001');
    expect(prog.currency).toBe('GBP');
    expect(prog.advertiserUrl).toBe('https://www.atolls-bookshop.example.com');
  });

  it('formatAffiseDate produces YYYY-MM-DD', () => {
    expect(_internals.formatAffiseDate(new Date('2026-05-28T13:45:00Z'))).toBe('2026-05-28');
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('Affise.listProgrammes', () => {
  it('maps offer statuses correctly from the offers fixture', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const programmes = await affiseAdapter.listProgrammes();
    expect(programmes.length).toBe(3);
    expect(programmes.find((p) => p.id === '1001')?.status).toBe('joined');
    expect(programmes.find((p) => p.id === '1002')?.status).toBe('pending');
    expect(programmes.find((p) => p.id === '1003')?.status).toBe('suspended');
  });

  it('filters by status client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const only = await affiseAdapter.listProgrammes({ status: 'joined' });
    expect(only.every((p) => p.status === 'joined')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('applies search filter client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const results = await affiseAdapter.listProgrammes({ search: 'gadgets' });
    expect(results.length).toBe(1);
    expect(results[0]?.name).toBe('Atolls Gadgets');
  });

  it('preserves rawNetworkData on each programme', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const programmes = await affiseAdapter.listProgrammes();
    for (const p of programmes) expect(p.rawNetworkData).toBeDefined();
  });

  it('throws a NetworkError when the API key is missing (§15.4)', async () => {
    delete process.env['AFFISE_API_KEY'];
    await expect(affiseAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error when the base URL is missing (§15.4)', async () => {
    delete process.env['AFFISE_BASE_URL'];
    await expect(affiseAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getProgramme
// ---------------------------------------------------------------------------

describe('Affise.getProgramme', () => {
  it('returns a Programme from the partner offers filter', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offer.json'))]);
    const prog = await affiseAdapter.getProgramme('1001');
    expect(prog.id).toBe('1001');
    expect(prog.name).toBe('Atolls Bookshop');
    expect(prog.network).toBe('affise');
  });

  it('throws a config_error envelope for non-numeric programmeId', async () => {
    await expect(affiseAdapter.getProgramme('not-a-number')).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error envelope for empty programmeId', async () => {
    await expect(affiseAdapter.getProgramme('')).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a network_api_error when no offer is returned', async () => {
    mockFetchQueue([fakeResponse({ status: 1, offers: [], pagination: { total_count: 0 } })]);
    try {
      await affiseAdapter.getProgramme('9999');
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).envelope.type).toBe('network_api_error');
    }
  });
});

// ---------------------------------------------------------------------------
// listTransactions — unpaid-age + reversed visibility (§15.9, §15.10)
// ---------------------------------------------------------------------------

describe('Affise.listTransactions', () => {
  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const aged = await affiseAdapter.listTransactions({
      from: '2026-01-01',
      to: '2026-05-28',
      minAgeDays: 50,
    });
    for (const t of aged) expect(t.ageDays).toBeGreaterThanOrEqual(50);
    expect(aged.length).toBeGreaterThan(0);
  });

  it('includes reversed transactions with reason populated (§15.10)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const all = await affiseAdapter.listTransactions({ from: '2026-01-01', to: '2026-05-28' });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toContain('Duplicate conversion');
  });

  it('filters by status when caller passes status[]', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const only = await affiseAdapter.listTransactions({
      from: '2026-01-01',
      to: '2026-05-28',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('sends date_from/date_to and offer[] in the query', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    await affiseAdapter.listTransactions({ from: '2026-01-01', to: '2026-01-31', programmeId: '1001' });
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain('date_from=2026-01-01');
    expect(url).toContain('date_to=2026-01-31');
    expect(url).toContain('offer%5B%5D=1001');
  });

  it('emits an error envelope when the API key is missing (§15.4)', async () => {
    delete process.env['AFFISE_API_KEY'];
    await expect(affiseAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('Affise.getEarningsSummary', () => {
  it('derives the summary from listTransactions correctly', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const summary = await affiseAdapter.getEarningsSummary({ from: '2026-01-01', to: '2026-05-28' });
    expect(summary.network).toBe('affise');
    // 6.5 (approved) + 6.5 (pending) + 0 (declined) = 13.0
    expect(summary.totalEarnings).toBeCloseTo(13.0, 2);
    expect(summary.byStatus.approved).toBeCloseTo(6.5, 2);
    expect(summary.byStatus.pending).toBeCloseTo(6.5, 2);
    expect(summary.byStatus.reversed).toBeCloseTo(0.0, 2);
    expect(summary.currency).toBe('GBP');
    expect(summary.byProgramme.length).toBeGreaterThan(0);
  });

  it('computes oldestUnpaidAgeDays from pending/approved transactions (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const summary = await affiseAdapter.getEarningsSummary({ from: '2026-01-01', to: '2026-05-28' });
    expect(summary.oldestUnpaidAgeDays).toBeGreaterThan(30);
  });
});

// ---------------------------------------------------------------------------
// listClicks — NotImplemented
// ---------------------------------------------------------------------------

describe('Affise.listClicks', () => {
  it('throws NotImplementedError (no raw click endpoint)', async () => {
    await expect(affiseAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink
// ---------------------------------------------------------------------------

describe('Affise.generateTrackingLink', () => {
  it('returns a TrackingLink built from the offer tracking URL', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offer.json'))]);
    const link = await affiseAdapter.generateTrackingLink({
      programmeId: '1001',
      destinationUrl: 'https://www.atolls-bookshop.example.com/products',
    });
    expect(link.network).toBe('affise');
    expect(link.programmeId).toBe('1001');
    expect(link.trackingUrl).toContain('api-yournetwork.affise.com');
    // The destination is appended as the `url` deep-link param.
    expect(link.trackingUrl).toContain('url=https');
  });

  it('throws a config_error envelope when programmeId is missing', async () => {
    await expect(
      affiseAdapter.generateTrackingLink({ programmeId: '', destinationUrl: 'https://x.example.com' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error envelope when programmeId is non-numeric', async () => {
    await expect(
      affiseAdapter.generateTrackingLink({
        programmeId: 'abc',
        destinationUrl: 'https://x.example.com',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a network_api_error when the offer has no tracking URL', async () => {
    mockFetchQueue([
      fakeResponse({ status: 1, offers: [{ offer_id: 1001, title: 'No URL' }], pagination: {} }),
    ]);
    try {
      await affiseAdapter.generateTrackingLink({
        programmeId: '1001',
        destinationUrl: 'https://x.example.com',
      });
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).envelope.type).toBe('network_api_error');
    }
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('Affise.verifyAuth', () => {
  it('returns ok:true with identity when partner offers responds 200', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const r = await affiseAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toContain('affise');
  });

  it('surfaces a failure on 401 (§15.4)', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid api-key"}', {
        status: 401,
        rawBody: '{"error":"invalid api-key"}',
      }),
    ]);
    const r = await affiseAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/HTTP 401|401/);
  });

  it('returns ok:false when base URL is missing rather than throwing', async () => {
    delete process.env['AFFISE_BASE_URL'];
    const r = await affiseAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// admin ops
// ---------------------------------------------------------------------------

describe('Affise admin operations (not implemented at v0.1)', () => {
  it('listPublishers throws NotImplementedError', async () => {
    await expect(affiseAdapter.listPublishers()).rejects.toBeInstanceOf(NotImplementedError);
  });
  it('listPublisherSectors throws NotImplementedError', async () => {
    await expect(affiseAdapter.listPublisherSectors()).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim Affise response body on a 500', async () => {
    const body = '{"error":"upstream_error","trace":"efg123"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await affiseAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('affise');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream_error');
    }
  });

  it('classifies 401 as auth_error (§15.4)', async () => {
    mockFetchQueue([fakeResponse('Forbidden', { status: 401, rawBody: 'Forbidden' })]);
    try {
      await affiseAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('auth_error');
    }
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('Affise.capabilitiesCheck', () => {
  it('reports operations with experimental claim status and listClicks unsupported', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('offers.json')), // listProgrammes
      fakeResponse(loadFixture('conversions.json')), // listTransactions
      fakeResponse(loadFixture('conversions.json')), // getEarningsSummary → listTransactions
      fakeResponse(loadFixture('offers.json')), // verifyAuth
    ]);
    const caps = await affiseAdapter.capabilitiesCheck();
    expect(caps.network).toBe('affise');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(true);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
