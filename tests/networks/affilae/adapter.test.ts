/**
 * Affilae adapter — unit tests.
 *
 * Mirrors the Awin test patterns:
 *   - We mock `globalThis.fetch` directly: the seam between adapter and
 *     network, exercising client + resilience + transformer with no live HTTP.
 *   - Fixtures are built from Affilae's documented shapes (amounts in cents,
 *     pending/accepted/refused conversion statuses, UTC ISO-8601 dates).
 *   - No live calls. The adapter is `experimental`; these tests pin the
 *     transformer behaviour, not the (unverified) live response shape.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { affilaeAdapter, _internals } from '../../../src/networks/affilae/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'networks', 'affilae', 'fixtures');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function conversions(): Array<Record<string, unknown>> {
  return (loadFixture('conversions-list.json') as { conversions: Array<Record<string, unknown>> })
    .conversions;
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
  process.env['AFFILAE_API_TOKEN'] = 'test-token-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['AFFILAE_API_TOKEN'];
});

// ---------------------------------------------------------------------------
// Transformation (status mapping, cents→major, raw preservation)
// ---------------------------------------------------------------------------

describe('Affilae transformers', () => {
  it('maps accepted|pending|refused → approved|pending|reversed; paid flag wins', () => {
    const rows = conversions();
    const accepted = _internals.toTransaction(rows[0] as never);
    const pending = _internals.toTransaction(rows[1] as never);
    const refused = _internals.toTransaction(rows[2] as never);
    const paid = _internals.toTransaction(rows[3] as never);
    expect(accepted.status).toBe('approved');
    expect(pending.status).toBe('pending');
    // Affilae 'refused' is our 'reversed' — the user did not get paid.
    expect(refused.status).toBe('reversed');
    // paid flag overrides the (still 'accepted') status string.
    expect(paid.status).toBe('paid');
  });

  it('converts cents to major units for amount and commission', () => {
    const accepted = _internals.toTransaction(conversions()[0] as never);
    // amount 12000 cents → 120.00; commission 960 cents → 9.60
    expect(accepted.amount).toBe(120);
    expect(accepted.commission).toBe(9.6);
    expect(accepted.currency).toBe('EUR');
  });

  it('centsToMajor handles missing values as 0', () => {
    expect(_internals.centsToMajor(undefined)).toBe(0);
    expect(_internals.centsToMajor(2550)).toBe(25.5);
  });

  it('preserves the raw Affilae payload under rawNetworkData', () => {
    const raw = conversions()[0];
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('surfaces reversalReason on reversed conversions (§15.10)', () => {
    const refused = _internals.toTransaction(conversions()[2] as never);
    expect(refused.status).toBe('reversed');
    expect(refused.reversalReason).toBe('Customer returned the item within 14 days');
  });

  it('computes ageDays from validation date (preferred) then conversion date', () => {
    const now = new Date('2026-06-06T00:00:00Z');
    const age1 = _internals.computeAgeDays({ validationDate: '2026-01-01T00:00:00Z' }, now);
    expect(age1).toBe(156);
    const age2 = _internals.computeAgeDays({ conversionDate: '2026-05-07T00:00:00Z' }, now);
    expect(age2).toBe(30);
  });

  it('maps programme partnership statuses to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ partnershipStatus: 'accepted' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ partnershipStatus: 'pending' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ partnershipStatus: 'refused' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ partnershipStatus: 'open' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ partnershipStatus: 'paused' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ partnershipStatus: 'never-seen' })).toBe('unknown');
  });

  it('unwrapList reads bare arrays, named keys, and data/results envelopes', () => {
    expect(_internals.unwrapList([1, 2], 'programs')).toEqual([1, 2]);
    expect(_internals.unwrapList({ programs: [3] }, 'programs')).toEqual([3]);
    expect(_internals.unwrapList({ data: [4] }, 'programs')).toEqual([4]);
    expect(_internals.unwrapList({ nope: [5] }, 'programs')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('Affilae.listProgrammes', () => {
  it('lists programmes and maps status from the partnership field', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programs-list.json'))]);
    const programmes = await affilaeAdapter.listProgrammes();
    expect(programmes.length).toBe(3);
    expect(programmes[0]?.status).toBe('joined');
    expect(programmes[0]?.name).toBe('Atolls Bookshop');
    expect(programmes[0]?.network).toBe('affilae');
  });

  it('filters by status client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programs-list.json'))]);
    const joined = await affilaeAdapter.listProgrammes({ status: 'joined' });
    expect(joined.length).toBe(1);
    expect(joined.every((p) => p.status === 'joined')).toBe(true);
  });

  it('filters by search substring', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programs-list.json'))]);
    const found = await affilaeAdapter.listProgrammes({ search: 'travel' });
    expect(found.length).toBe(1);
    expect(found[0]?.name).toBe('Atolls Travel');
  });
});

// ---------------------------------------------------------------------------
// getProgramme
// ---------------------------------------------------------------------------

describe('Affilae.getProgramme', () => {
  it('rejects malformed (non-hex-24) ids with a config_error envelope', async () => {
    await expect(affilaeAdapter.getProgramme('abc')).rejects.toBeInstanceOf(NetworkError);
  });

  it('returns the matching programme by id', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programs-list.json'))]);
    const p = await affilaeAdapter.getProgramme('5e2f798000000000000000a2');
    expect(p.name).toBe('Atolls Garden');
    expect(p.status).toBe('pending');
  });

  it('throws when the id is well-formed but not among the publisher programmes', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programs-list.json'))]);
    await expect(
      affilaeAdapter.getProgramme('5e2f7980000000000000ffff'),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('Affilae.listTransactions', () => {
  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions-list.json'))]);
    const aged = await affilaeAdapter.listTransactions({
      from: '2026-05-07T00:00:00Z',
      to: '2026-06-06T00:00:00Z',
      minAgeDays: 365,
    });
    for (const t of aged) expect(t.ageDays).toBeGreaterThanOrEqual(365);
    expect(aged.length).toBeGreaterThan(0);
  });

  it('includes reversed transactions with reason populated (§15.10)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions-list.json'))]);
    const all = await affilaeAdapter.listTransactions({
      from: '2026-05-07T00:00:00Z',
      to: '2026-06-06T00:00:00Z',
    });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toBe('Customer returned the item within 14 days');
  });

  it('chunks date ranges wider than 31 days into multiple calls', async () => {
    const spy = mockFetchQueue([fakeResponse([]), fakeResponse([]), fakeResponse([])]);
    await affilaeAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-03-31T00:00:00Z', // ~90 days → 3 slices
    });
    expect(spy.mock.calls.length).toBe(3);
  });

  it('filters by status when caller passes status[]', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions-list.json'))]);
    const only = await affilaeAdapter.listTransactions({
      from: '2026-05-07T00:00:00Z',
      to: '2026-06-06T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('emits a NetworkError when the token is missing', async () => {
    delete process.env['AFFILAE_API_TOKEN'];
    await expect(affilaeAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('Affilae.getEarningsSummary', () => {
  it('aggregates commission by status and programme from conversions', async () => {
    // A single ≤31-day window means exactly one upstream call; the mock echoes
    // the full fixture regardless of the date params, so all four conversions
    // feed the aggregation.
    mockFetchQueue([fakeResponse(loadFixture('conversions-list.json'))]);
    const summary = await affilaeAdapter.getEarningsSummary({
      from: '2026-05-10T00:00:00Z',
      to: '2026-06-06T00:00:00Z',
    });
    // commissions in major units: 9.60 (approved) + 6.00 (pending) + 6.40 (reversed) + 16.00 (paid)
    expect(summary.byStatus.approved).toBeCloseTo(9.6, 5);
    expect(summary.byStatus.pending).toBeCloseTo(6.0, 5);
    expect(summary.byStatus.reversed).toBeCloseTo(6.4, 5);
    expect(summary.byStatus.paid).toBeCloseTo(16.0, 5);
    expect(summary.totalEarnings).toBeCloseTo(38.0, 5);
    expect(summary.network).toBe('affilae');
    expect(summary.byProgramme.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// listClicks + generateTrackingLink (unsupported)
// ---------------------------------------------------------------------------

describe('Affilae unsupported ops', () => {
  it('listClicks throws NotImplementedError with a documented reason', async () => {
    await expect(affilaeAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await affilaeAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click-level data');
    }
  });

  it('generateTrackingLink throws NotImplementedError pending live verification', async () => {
    await expect(
      affilaeAdapter.generateTrackingLink({
        programmeId: '5e2f798000000000000000a1',
        destinationUrl: 'https://x.example.com',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('Affilae.verifyAuth', () => {
  it('returns ok:true and identity when publishers.me responds 200', async () => {
    mockFetchQueue([fakeResponse(loadFixture('publishers-me.json'))]);
    const r = await affilaeAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toContain('affilae/5e2f79800000000000000000');
  });

  it('returns ok:false on 401', async () => {
    mockFetchQueue([fakeResponse('{"error":"invalid_token"}', { status: 401 })]);
    const r = await affilaeAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/401/);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('Affilae.validateCredential', () => {
  it('validates AFFILAE_API_TOKEN by calling publishers.me', async () => {
    mockFetchQueue([fakeResponse(loadFixture('publishers-me.json'))]);
    const r = await affilaeAdapter.validateCredential('AFFILAE_API_TOKEN', 'fresh-token');
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with a hint when validation fails', async () => {
    mockFetchQueue([fakeResponse('{"error":"bad"}', { status: 401 })]);
    const r = await affilaeAdapter.validateCredential('AFFILAE_API_TOKEN', 'bad-token');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('rejects unknown credential fields', async () => {
    const r = await affilaeAdapter.validateCredential('AFFILAE_UNKNOWN', 'x');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('Affilae.capabilitiesCheck', () => {
  it('records listClicks and generateTrackingLink as unsupported without probing', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('programs-list.json')), // listProgrammes
      fakeResponse(loadFixture('conversions-list.json')), // listTransactions probe
      fakeResponse(loadFixture('conversions-list.json')), // getEarningsSummary → listTransactions
      fakeResponse(loadFixture('publishers-me.json')), // verifyAuth
    ]);
    const caps = await affilaeAdapter.capabilitiesCheck();
    expect(caps.network).toBe('affilae');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency
// ---------------------------------------------------------------------------

describe('Affilae error transparency', () => {
  it('surfaces the verbatim Affilae response body on a 500', async () => {
    const body = '{"error":"upstream broke","trace":"xyz"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await affilaeAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('affilae');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream broke');
    }
  });

  it('classifies 401 as auth_error', async () => {
    mockFetchQueue([fakeResponse('forbidden', { status: 401, rawBody: 'forbidden' })]);
    try {
      await affilaeAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('auth_error');
    }
  });
});
