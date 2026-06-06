/**
 * TUNE (HasOffers) affiliate adapter — unit tests.
 *
 * Pattern matched to `tests/networks/affise/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 *   - Fixtures live under `tests/networks/tune/fixtures/` and approximate the
 *     shape of real TUNE/HasOffers Apiv3 responses. No real keys, no real data.
 *
 * TUNE is multi-tenant: the API host is built from TUNE_NETWORK_ID
 * (https://{network_id}.api.hasoffers.com) and both that and TUNE_API_KEY are
 * required for every authenticated call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { tuneAdapter, _internals } from '../../../src/networks/tune/adapter.js';
import { resolveBaseUrl } from '../../../src/networks/tune/client.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'networks', 'tune', 'fixtures');

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
  process.env['TUNE_NETWORK_ID'] = 'atollsnet';
  process.env['TUNE_API_KEY'] = 'test-api-key-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['TUNE_NETWORK_ID'];
  delete process.env['TUNE_API_KEY'];
});

// ---------------------------------------------------------------------------
// Per-tenant base URL built from the NetworkId (the key deviation from awin)
// ---------------------------------------------------------------------------

describe('TUNE per-tenant base URL (built from NetworkId)', () => {
  it('builds the host from the NetworkId credential', () => {
    process.env['TUNE_NETWORK_ID'] = 'atollsnet';
    expect(resolveBaseUrl('test')).toBe('https://atollsnet.api.hasoffers.com');
  });

  it('trims surrounding whitespace on the NetworkId', () => {
    process.env['TUNE_NETWORK_ID'] = '  atollsnet  ';
    expect(resolveBaseUrl('test')).toBe('https://atollsnet.api.hasoffers.com');
  });

  it('throws a config_error envelope when TUNE_NETWORK_ID is missing (§15.4)', () => {
    delete process.env['TUNE_NETWORK_ID'];
    try {
      resolveBaseUrl('test');
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).envelope.type).toBe('config_error');
    }
  });

  it('rejects a NetworkId with unsafe characters as config_error', () => {
    process.env['TUNE_NETWORK_ID'] = 'evil.com/path';
    try {
      resolveBaseUrl('test');
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).envelope.type).toBe('config_error');
    }
  });

  it('builds request URLs against the per-tenant host derived from the NetworkId', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    await tuneAdapter.listProgrammes({ limit: 1 });
    const calledUrl = String(spy.mock.calls[0]?.[0]);
    expect(calledUrl).toContain('https://atollsnet.api.hasoffers.com/Apiv3/json');
    // Routing + auth params are present.
    expect(calledUrl).toContain('Target=Affiliate_Offer');
    expect(calledUrl).toContain('Method=findAll');
    expect(calledUrl).toContain('NetworkId=atollsnet');
    expect(calledUrl).toContain('api_key=test-api-key-please-ignore');
  });

  it('uses a different host when the NetworkId changes (one adapter, any HasOffers network)', async () => {
    process.env['TUNE_NETWORK_ID'] = 'othernet';
    const spy = mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    await tuneAdapter.listProgrammes({ limit: 1 });
    const calledUrl = String(spy.mock.calls[0]?.[0]);
    expect(calledUrl).toContain('https://othernet.api.hasoffers.com/Apiv3/json');
  });
});

// ---------------------------------------------------------------------------
// Transformation (status mapping + raw preservation)
// ---------------------------------------------------------------------------

describe('TUNE transformers (status normalisation, raw preservation)', () => {
  it('maps offer statuses to canonical ProgrammeStatus', () => {
    // Approval state takes precedence.
    expect(_internals.mapProgrammeStatus({ approval_status: 'approved' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ approval_status: 'pending' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ approval_status: 'rejected' })).toBe('declined');
    // Fall back to lifecycle status.
    expect(_internals.mapProgrammeStatus({ status: 'active' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ status: 'paused' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'something-new' })).toBe('unknown');
    expect(_internals.mapProgrammeStatus({})).toBe('unknown');
  });

  it('maps conversion statuses to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ status: 'approved' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'rejected' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'unknown_future' })).toBe('other');
    expect(_internals.mapTransactionStatus({})).toBe('other');
  });

  it('preserves the raw TUNE conversion row under rawNetworkData', () => {
    const rows = (
      loadFixture('conversions.json') as {
        response: { data: { data: Record<string, Record<string, unknown>> } };
      }
    ).response.data.data;
    const row = rows['0'] as Record<string, unknown>;
    const out = _internals.toTransaction(row as never);
    expect(out.rawNetworkData).toBe(row);
  });

  it('surfaces reversalReason from Stat.note on rejected transactions (§15.10)', () => {
    const rows = (
      loadFixture('conversions.json') as {
        response: { data: { data: Record<string, Record<string, unknown>> } };
      }
    ).response.data.data;
    const rejected = rows['2'] as Record<string, unknown>;
    const out = _internals.toTransaction(rejected as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toContain('Duplicate conversion');
  });

  it('computes ageDays from Stat.datetime against a fixed now', () => {
    const now = new Date('2026-05-28T12:00:00Z');
    // 2026-01-15 10:00:00 → 2026-05-28 12:00:00 = 133 days 2 hours → floors to 133.
    const age = _internals.computeAgeDays({ datetime: '2026-01-15 10:00:00' } as never, now);
    expect(age).toBe(133);
  });

  it('returns 0 ageDays when datetime is missing', () => {
    const now = new Date('2026-05-28T00:00:00Z');
    expect(_internals.computeAgeDays({} as never, now)).toBe(0);
  });

  it('maps payout as commission (parsing the string amount) and currency', () => {
    const tx = _internals.toTransaction({
      Stat: {
        id: 'x1',
        status: 'approved',
        payout: '6.50',
        sale_amount: '9.00',
        currency: 'EUR',
        datetime: '2026-01-15 10:00:00',
      },
    } as never);
    expect(tx.commission).toBe(6.5);
    expect(tx.amount).toBe(9.0);
    expect(tx.currency).toBe('EUR');
  });

  it('maps offer payout and currency onto the programme', () => {
    const offers = (
      loadFixture('offers.json') as {
        response: { data: { data: Record<string, { Offer: Record<string, unknown> }> } };
      }
    ).response.data.data;
    const prog = _internals.toProgramme(offers['1001']?.Offer as never);
    expect(prog.id).toBe('1001');
    expect(prog.currency).toBe('GBP');
    expect(prog.advertiserUrl).toBe('https://www.atolls-bookshop.example.com');
  });

  it('formatTuneDatetime produces YYYY-MM-DD HH:mm:SS', () => {
    expect(_internals.formatTuneDatetime(new Date('2026-05-28T13:45:09Z'))).toBe(
      '2026-05-28 13:45:09',
    );
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('TUNE.listProgrammes', () => {
  it('maps offer statuses correctly from the offers fixture', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const programmes = await tuneAdapter.listProgrammes();
    expect(programmes.length).toBe(3);
    expect(programmes.find((p) => p.id === '1001')?.status).toBe('joined');
    expect(programmes.find((p) => p.id === '1002')?.status).toBe('pending');
    // 1003 is approved but paused → joined wins on approval precedence.
    expect(programmes.find((p) => p.id === '1003')?.status).toBe('joined');
  });

  it('filters by status client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const only = await tuneAdapter.listProgrammes({ status: 'pending' });
    expect(only.every((p) => p.status === 'pending')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('applies search filter client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const results = await tuneAdapter.listProgrammes({ search: 'gadgets' });
    expect(results.length).toBe(1);
    expect(results[0]?.name).toBe('Atolls Gadgets');
  });

  it('preserves rawNetworkData on each programme', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const programmes = await tuneAdapter.listProgrammes();
    for (const p of programmes) expect(p.rawNetworkData).toBeDefined();
  });

  it('throws a NetworkError when the API key is missing (§15.4)', async () => {
    delete process.env['TUNE_API_KEY'];
    await expect(tuneAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error when the NetworkId is missing (§15.4)', async () => {
    delete process.env['TUNE_NETWORK_ID'];
    await expect(tuneAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getProgramme
// ---------------------------------------------------------------------------

describe('TUNE.getProgramme', () => {
  it('returns a Programme from the Affiliate_Offer findAll id filter', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('offer.json'))]);
    const prog = await tuneAdapter.getProgramme('1001');
    expect(prog.id).toBe('1001');
    expect(prog.name).toBe('Atolls Bookshop');
    expect(prog.network).toBe('tune');
    // The id filter is sent on the wire as filters[id]=1001.
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain('filters%5Bid%5D=1001');
  });

  it('throws a config_error envelope for non-numeric programmeId', async () => {
    await expect(tuneAdapter.getProgramme('not-a-number')).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error envelope for empty programmeId', async () => {
    await expect(tuneAdapter.getProgramme('')).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a network_api_error when no offer is returned', async () => {
    mockFetchQueue([
      fakeResponse({ response: { status: 1, data: { page: 1, pageCount: 1, count: 0, data: {} } } }),
    ]);
    try {
      await tuneAdapter.getProgramme('9999');
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

describe('TUNE.listTransactions', () => {
  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const aged = await tuneAdapter.listTransactions({
      from: '2026-05-01',
      to: '2026-05-28',
      minAgeDays: 50,
    });
    for (const t of aged) expect(t.ageDays).toBeGreaterThanOrEqual(50);
    expect(aged.length).toBeGreaterThan(0);
  });

  it('includes reversed transactions with reason populated (§15.10)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const all = await tuneAdapter.listTransactions({ from: '2026-05-01', to: '2026-05-28' });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toContain('Duplicate conversion');
  });

  it('filters by status when caller passes status[]', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const only = await tuneAdapter.listTransactions({
      from: '2026-05-01',
      to: '2026-05-28',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('sends Stat.datetime start/end and Stat.offer_id filters on the wire', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    await tuneAdapter.listTransactions({
      from: '2026-01-01',
      to: '2026-01-31',
      programmeId: '1001',
    });
    const url = decodeURIComponent(String(spy.mock.calls[0]?.[0]));
    expect(url).toContain('Target=Affiliate_Report');
    expect(url).toContain('Method=getConversions');
    // URLSearchParams encodes spaces as '+'; the wire form keeps them as '+'.
    expect(url).toContain('filters[Stat.datetime][start]=2026-01-01+00:00:00');
    expect(url).toContain('filters[Stat.datetime][end]=2026-01-31+00:00:00');
    expect(url).toContain('filters[Stat.offer_id]=1001');
  });

  it('chunks a window wider than 31 days into multiple calls', async () => {
    const spy = mockFetchQueue([
      fakeResponse(loadFixture('conversions.json')),
      fakeResponse(loadFixture('conversions.json')),
      fakeResponse(loadFixture('conversions.json')),
      fakeResponse(loadFixture('conversions.json')),
      fakeResponse(loadFixture('conversions.json')),
    ]);
    // ~120 days → 4 slices of ≤31 days.
    await tuneAdapter.listTransactions({ from: '2026-01-01', to: '2026-05-01' });
    expect(spy.mock.calls.length).toBe(4);
  });

  it('emits an error envelope when the API key is missing (§15.4)', async () => {
    delete process.env['TUNE_API_KEY'];
    await expect(tuneAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('TUNE.getEarningsSummary', () => {
  it('derives the summary from listTransactions correctly', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const summary = await tuneAdapter.getEarningsSummary({ from: '2026-05-01', to: '2026-05-28' });
    expect(summary.network).toBe('tune');
    // 6.5 (approved) + 6.5 (pending) + 10.0 (rejected) = 23.0 total commission.
    expect(summary.totalEarnings).toBeCloseTo(23.0, 2);
    expect(summary.byStatus.approved).toBeCloseTo(6.5, 2);
    expect(summary.byStatus.pending).toBeCloseTo(6.5, 2);
    expect(summary.byStatus.reversed).toBeCloseTo(10.0, 2);
    expect(summary.currency).toBe('GBP');
    expect(summary.byProgramme.length).toBeGreaterThan(0);
  });

  it('computes oldestUnpaidAgeDays from pending/approved transactions (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const summary = await tuneAdapter.getEarningsSummary({ from: '2026-05-01', to: '2026-05-28' });
    expect(summary.oldestUnpaidAgeDays).toBeGreaterThan(30);
  });
});

// ---------------------------------------------------------------------------
// listClicks — NotImplemented
// ---------------------------------------------------------------------------

describe('TUNE.listClicks', () => {
  it('throws NotImplementedError (no raw click endpoint)', async () => {
    await expect(tuneAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink
// ---------------------------------------------------------------------------

describe('TUNE.generateTrackingLink', () => {
  it('returns a TrackingLink built from the generateTrackingLink click_url', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('tracking-link.json'))]);
    const link = await tuneAdapter.generateTrackingLink({
      programmeId: '1001',
      destinationUrl: 'https://www.atolls-bookshop.example.com/products',
    });
    expect(link.network).toBe('tune');
    expect(link.programmeId).toBe('1001');
    expect(link.trackingUrl).toContain('atollsnet.api.hasoffers.com');
    // The call routes to Affiliate_Offer::generateTrackingLink with offer_id and
    // the destination override as params[url].
    const url = decodeURIComponent(String(spy.mock.calls[0]?.[0]));
    expect(url).toContain('Method=generateTrackingLink');
    expect(url).toContain('offer_id=1001');
    expect(url).toContain('params[url]=https://www.atolls-bookshop.example.com/products');
  });

  it('throws a config_error envelope when programmeId is missing', async () => {
    await expect(
      tuneAdapter.generateTrackingLink({ programmeId: '', destinationUrl: 'https://x.example.com' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error envelope when programmeId is non-numeric', async () => {
    await expect(
      tuneAdapter.generateTrackingLink({
        programmeId: 'abc',
        destinationUrl: 'https://x.example.com',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a network_api_error when no click_url is returned', async () => {
    mockFetchQueue([fakeResponse({ response: { status: 1, data: {} } })]);
    try {
      await tuneAdapter.generateTrackingLink({
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

describe('TUNE.verifyAuth', () => {
  it('returns ok:true with identity when Affiliate_Offer findAll responds 200', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const r = await tuneAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toContain('tune');
  });

  it('surfaces a failure on 401 (§15.4)', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid api_key"}', {
        status: 401,
        rawBody: '{"error":"invalid api_key"}',
      }),
    ]);
    const r = await tuneAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/HTTP 401|401/);
  });

  it('returns ok:false when NetworkId is missing rather than throwing', async () => {
    delete process.env['TUNE_NETWORK_ID'];
    const r = await tuneAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// admin ops
// ---------------------------------------------------------------------------

describe('TUNE admin operations (not implemented at v0.1)', () => {
  it('listPublishers throws NotImplementedError', async () => {
    await expect(tuneAdapter.listPublishers()).rejects.toBeInstanceOf(NotImplementedError);
  });
  it('listPublisherSectors throws NotImplementedError', async () => {
    await expect(tuneAdapter.listPublisherSectors()).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim TUNE response body on a 500', async () => {
    const body = '{"error":"upstream_error","trace":"efg123"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await tuneAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('tune');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream_error');
    }
  });

  it('classifies 401 as auth_error (§15.4)', async () => {
    mockFetchQueue([fakeResponse('Forbidden', { status: 401, rawBody: 'Forbidden' })]);
    try {
      await tuneAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('auth_error');
    }
  });

  it('raises a network_api_error when the HasOffers envelope reports status <= 0 over HTTP 200', async () => {
    mockFetchQueue([
      fakeResponse({
        response: { status: -1, httpStatus: 200, errorMessage: 'Invalid api_key.', errors: [] },
      }),
    ]);
    try {
      await tuneAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('network_api_error');
      expect(env.message).toContain('Invalid api_key');
    }
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('TUNE.capabilitiesCheck', () => {
  it('reports operations with experimental claim status and listClicks unsupported', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('offers.json')), // listProgrammes
      fakeResponse(loadFixture('conversions.json')), // listTransactions
      fakeResponse(loadFixture('conversions.json')), // getEarningsSummary → listTransactions
      fakeResponse(loadFixture('offers.json')), // verifyAuth
    ]);
    const caps = await tuneAdapter.capabilitiesCheck();
    expect(caps.network).toBe('tune');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(true);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
