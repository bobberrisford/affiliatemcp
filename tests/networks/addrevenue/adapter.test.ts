/**
 * Addrevenue adapter — unit tests.
 *
 * Mirrors the Awin test patterns:
 *   - We mock `globalThis.fetch` directly — the seam between adapter and
 *     network. Mocking it exercises the full client + resilience + transformer
 *     stack with no live HTTP.
 *   - Each test stubs only the fetch responses it needs.
 *   - Fixtures live under tests/networks/addrevenue/fixtures (the adapter lives
 *     under src/networks/addrevenue; fixtures are kept beside this test).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { addrevenueAdapter, _internals } from '../../../src/networks/addrevenue/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'networks', 'addrevenue', 'fixtures');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(body: unknown, init: { status?: number; rawBody?: string } = {}): Response {
  const status = init.status ?? 200;
  const text = init.rawBody ?? (typeof body === 'string' ? body : JSON.stringify(body));
  return new Response(text, { status, headers: { 'content-type': 'application/json' } });
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
  process.env['ADDREVENUE_API_TOKEN'] = 'test-token-please-ignore';
  process.env['ADDREVENUE_CHANNEL_ID'] = '123456';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['ADDREVENUE_API_TOKEN'];
  delete process.env['ADDREVENUE_CHANNEL_ID'];
});

// ---------------------------------------------------------------------------
// Transformation
// ---------------------------------------------------------------------------

describe('Addrevenue transformers (status normalisation, raw preservation)', () => {
  it('maps conversion status pending|approved|rejected|paid → canonical statuses', () => {
    const rows = (loadFixture('conversions.json') as { results: Array<Record<string, unknown>> })
      .results;
    expect(_internals.toTransaction(rows[0] as never).status).toBe('approved');
    expect(_internals.toTransaction(rows[1] as never).status).toBe('pending');
    // rejected → reversed (the publisher did not get paid).
    expect(_internals.toTransaction(rows[2] as never).status).toBe('reversed');
    // paidDate present overrides the "approved" status string.
    expect(_internals.toTransaction(rows[3] as never).status).toBe('paid');
  });

  it('preserves the raw response under rawNetworkData', () => {
    const raw = (loadFixture('conversions.json') as { results: Array<Record<string, unknown>> })
      .results[0];
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('surfaces reversalReason on reversed transactions (§15.10)', () => {
    const rejected = (loadFixture('conversions.json') as {
      results: Array<Record<string, unknown>>;
    }).results[2];
    const out = _internals.toTransaction(rejected as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Customer returned the item within 14 days');
  });

  it('maps advertiser state to canonical ProgrammeStatus', () => {
    expect(_internals.mapAdvertiserStatus({ joined: true })).toBe('joined');
    expect(_internals.mapAdvertiserStatus({ status: 'active' })).toBe('joined');
    expect(_internals.mapAdvertiserStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapAdvertiserStatus({ status: 'rejected' })).toBe('declined');
    expect(_internals.mapAdvertiserStatus({ status: 'available' })).toBe('available');
    expect(_internals.mapAdvertiserStatus({ status: 'paused' })).toBe('suspended');
    expect(_internals.mapAdvertiserStatus({ status: 'never-seen' })).toBe('unknown');
  });

  it('computes ageDays from approvedDate (preferred) or conversionDate', () => {
    const now = new Date('2026-06-06T00:00:00Z');
    const approved = _internals.computeAgeDays({ approvedDate: '2026-01-01T00:00:00Z' }, now);
    expect(approved).toBe(156);
    const converted = _internals.computeAgeDays({ conversionDate: '2026-05-07T00:00:00Z' }, now);
    expect(converted).toBe(30);
  });

  it('unwraps the { results: [] } envelope and tolerates a bare array', () => {
    expect(_internals.extractResults({ results: [{ id: 1 }] })).toHaveLength(1);
    expect(_internals.extractResults([{ id: 2 }] as never)).toHaveLength(1);
    expect(_internals.extractResults(undefined)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes / getProgramme
// ---------------------------------------------------------------------------

describe('Addrevenue.listProgrammes', () => {
  it('lists advertisers from the results envelope', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    const programmes = await addrevenueAdapter.listProgrammes();
    expect(programmes.length).toBe(3);
    expect(programmes[0]?.network).toBe('addrevenue');
    expect(programmes[0]?.name).toBe('Atolls Bookshop');
    expect(programmes[0]?.status).toBe('joined');
  });

  it('filters by search substring and limit client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    const programmes = await addrevenueAdapter.listProgrammes({ search: 'nordic', limit: 5 });
    expect(programmes.length).toBe(1);
    expect(programmes[0]?.id).toBe('1002');
  });

  it('emits a config_error envelope when the token is missing', async () => {
    delete process.env['ADDREVENUE_API_TOKEN'];
    await expect(addrevenueAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('Addrevenue.getProgramme', () => {
  it('selects the matching advertiser from the listing', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    const programme = await addrevenueAdapter.getProgramme('1002');
    expect(programme.id).toBe('1002');
    expect(programme.name).toBe('Nordic Outdoors');
  });

  it('rejects non-numeric IDs with a config_error envelope', async () => {
    await expect(addrevenueAdapter.getProgramme('abc')).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a network_api_error envelope for an unknown advertiser', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    await expect(addrevenueAdapter.getProgramme('9999')).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('Addrevenue.listTransactions', () => {
  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const aged = await addrevenueAdapter.listTransactions({
      from: '2026-05-07T00:00:00Z',
      to: '2026-06-06T00:00:00Z',
      minAgeDays: 365,
    });
    for (const t of aged) {
      expect(t.ageDays).toBeGreaterThanOrEqual(365);
    }
    expect(aged.length).toBeGreaterThan(0);
  });

  it('includes reversed transactions with reason populated (§15.10)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const all = await addrevenueAdapter.listTransactions({
      from: '2026-05-07T00:00:00Z',
      to: '2026-06-06T00:00:00Z',
    });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toBe('Customer returned the item within 14 days');
  });

  it('chunks date ranges wider than 31 days into multiple calls', async () => {
    const spy = mockFetchQueue([
      fakeResponse({ results: [] }),
      fakeResponse({ results: [] }),
      fakeResponse({ results: [] }),
    ]);
    await addrevenueAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-03-31T00:00:00Z',
    });
    expect(spy.mock.calls.length).toBe(3);
  });

  it('filters by status when caller passes status[]', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const only = await addrevenueAdapter.listTransactions({
      from: '2026-05-07T00:00:00Z',
      to: '2026-06-06T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('emits a config_error envelope when the channel ID is missing', async () => {
    delete process.env['ADDREVENUE_CHANNEL_ID'];
    await expect(addrevenueAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('Addrevenue.getEarningsSummary', () => {
  it('aggregates commission by status and programme', async () => {
    // A single 31-day window → exactly one upstream call returning the fixture.
    // The adapter does not filter by date client-side, so all four conversions
    // are aggregated regardless of the narrow window.
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const summary = await addrevenueAdapter.getEarningsSummary({
      from: '2026-05-07T00:00:00Z',
      to: '2026-06-06T00:00:00Z',
    });
    expect(summary.network).toBe('addrevenue');
    // 39.92 (approved) + 60 (pending) + 0 (reversed) + 48 (paid).
    expect(summary.totalEarnings).toBeCloseTo(147.92, 2);
    expect(summary.byStatus.pending).toBeCloseTo(60, 2);
    expect(summary.byStatus.paid).toBeCloseTo(48, 2);
    expect(summary.byProgramme.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// listClicks (Addrevenue exposes clicks)
// ---------------------------------------------------------------------------

describe('Addrevenue.listClicks', () => {
  it('returns click rows from the clicks endpoint', async () => {
    mockFetchQueue([fakeResponse(loadFixture('clicks.json'))]);
    const clicks = await addrevenueAdapter.listClicks({
      from: '2026-05-01T00:00:00Z',
      to: '2026-05-03T00:00:00Z',
    });
    expect(clicks.length).toBe(2);
    expect(clicks[0]?.network).toBe('addrevenue');
    expect(clicks[0]?.programmeId).toBe('1001');
    expect(clicks[0]?.destinationUrl).toContain('atolls-bookshop');
  });

  it('filters clicks by programmeId', async () => {
    mockFetchQueue([fakeResponse(loadFixture('clicks.json'))]);
    const clicks = await addrevenueAdapter.listClicks({
      from: '2026-05-01T00:00:00Z',
      to: '2026-05-03T00:00:00Z',
      programmeId: '1002',
    });
    expect(clicks.length).toBe(1);
    expect(clicks[0]?.programmeId).toBe('1002');
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — deterministic construction
// ---------------------------------------------------------------------------

describe('Addrevenue.generateTrackingLink', () => {
  it('constructs the redirect URL with channel, advertiser, and encoded destination', async () => {
    const link = await addrevenueAdapter.generateTrackingLink({
      programmeId: '1001',
      destinationUrl: 'https://shop.example.se/path?q=a b&c=ü',
    });
    expect(link.trackingUrl).toContain('https://addrevenue.io/t?c=123456');
    expect(link.trackingUrl).toContain('&a=1001');
    expect(link.trackingUrl).toContain('url=https%3A%2F%2Fshop.example.se%2Fpath%3Fq%3Da%20b%26c%3D%C3%BC');
    expect(link.network).toBe('addrevenue');
    expect(link.programmeId).toBe('1001');
  });

  it('throws a config_error envelope when programmeId is missing', async () => {
    await expect(
      addrevenueAdapter.generateTrackingLink({ programmeId: '', destinationUrl: 'https://x.se' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('does NOT call fetch (deterministic construction)', async () => {
    const spy = mockFetchQueue([]);
    await addrevenueAdapter.generateTrackingLink({
      programmeId: '1001',
      destinationUrl: 'https://x.se',
    });
    expect(spy.mock.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth + admin stubs
// ---------------------------------------------------------------------------

describe('Addrevenue.verifyAuth', () => {
  it('returns ok:true and identity when /advertisers responds 200', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    const r = await addrevenueAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toContain('addrevenue/channel/123456');
  });

  it('returns ok:false on 401', async () => {
    mockFetchQueue([fakeResponse('{"error":"invalid_token"}', { status: 401 })]);
    const r = await addrevenueAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/401/);
  });
});

describe('Addrevenue admin stubs', () => {
  it('listPublishers throws NotImplementedError', async () => {
    await expect(addrevenueAdapter.listPublishers()).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('Addrevenue.validateCredential', () => {
  it('rejects malformed channel IDs', async () => {
    expect((await addrevenueAdapter.validateCredential('ADDREVENUE_CHANNEL_ID', 'abc')).ok).toBe(
      false,
    );
    expect((await addrevenueAdapter.validateCredential('ADDREVENUE_CHANNEL_ID', '-5')).ok).toBe(
      false,
    );
  });

  it('accepts well-formed channel IDs', async () => {
    const r = await addrevenueAdapter.validateCredential('ADDREVENUE_CHANNEL_ID', '123456');
    expect(r.ok).toBe(true);
  });

  it('validates ADDREVENUE_API_TOKEN by calling /advertisers', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    const r = await addrevenueAdapter.validateCredential('ADDREVENUE_API_TOKEN', 'fresh');
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with a hint when the token fails', async () => {
    mockFetchQueue([fakeResponse('{"error":"bad"}', { status: 401 })]);
    const r = await addrevenueAdapter.validateCredential('ADDREVENUE_API_TOKEN', 'bad');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('Addrevenue.capabilitiesCheck', () => {
  it('records listClicks as supported (Addrevenue exposes clicks)', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('advertisers.json')), // listProgrammes
      fakeResponse({ results: [] }), // listTransactions
      fakeResponse({ results: [] }), // getEarningsSummary → listTransactions
      fakeResponse(loadFixture('clicks.json')), // listClicks
      fakeResponse(loadFixture('advertisers.json')), // verifyAuth
    ]);
    const caps = await addrevenueAdapter.capabilitiesCheck();
    expect(caps.network).toBe('addrevenue');
    expect(caps.operations['listClicks']?.supported).toBe(true);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim response body on a 500', async () => {
    const body = '{"error":"upstream broke","trace":"abc"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await addrevenueAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('addrevenue');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream broke');
    }
  });

  it('classifies 401 as auth_error', async () => {
    mockFetchQueue([fakeResponse('forbidden', { status: 401, rawBody: 'forbidden' })]);
    try {
      await addrevenueAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('auth_error');
    }
  });
});
