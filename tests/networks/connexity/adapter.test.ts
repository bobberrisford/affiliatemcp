/**
 * Connexity adapter — unit tests.
 *
 * Mirrors the Awin test pattern: we mock `globalThis.fetch` directly, exercising
 * the full client + resilience + transformer stack with no live HTTP. Each test
 * stubs only the fetch responses it needs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { connexityAdapter, _internals } from '../../../src/networks/connexity/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'networks', 'connexity', 'fixtures');

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
  process.env['CONNEXITY_PUBLISHER_ID'] = '725846';
  process.env['CONNEXITY_API_KEY'] = 'test-key-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['CONNEXITY_PUBLISHER_ID'];
  delete process.env['CONNEXITY_API_KEY'];
});

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

describe('Connexity transformers (status normalisation, raw preservation)', () => {
  it('maps every matched merchant to joined (open CPC network)', () => {
    expect(_internals.mapMerchantStatus({})).toBe('joined');
  });

  it('maps every daily earnings row to approved (no sale lifecycle)', () => {
    expect(_internals.mapEarningsStatus({})).toBe('approved');
  });

  it('preserves the raw merchant payload under rawNetworkData', () => {
    const raw = (loadFixture('merchant-match.json') as { merchantMatches: Array<Record<string, unknown>> })
      .merchantMatches[0];
    const out = _internals.toProgramme(raw as never);
    expect(out.rawNetworkData).toBe(raw);
    expect(out.id).toBe('100123');
    expect(out.name).toBe('Wayfair');
    expect(out.currency).toBe('USD');
  });

  it('surfaces effective CPC as a structured flat commission', () => {
    const raw = (loadFixture('merchant-match.json') as { merchantMatches: Array<Record<string, unknown>> })
      .merchantMatches[0];
    const out = _internals.toProgramme(raw as never);
    expect(out.commissionRate).toMatchObject({ type: 'flat', value: 0.42, currency: 'USD' });
  });

  it('builds a synthetic per-day transaction with stable id and commission', () => {
    const row = { date: '2026-05-01', redirects: 120, estimatedEarnings: 180.0, cpc: 0.55 };
    const out = _internals.toTransaction(row as never, new Date('2026-06-06T00:00:00Z'));
    expect(out.id).toBe('connexity-earnings-2026-05-01');
    expect(out.status).toBe('approved');
    expect(out.amount).toBe(180);
    expect(out.commission).toBe(180);
    expect(out.currency).toBe('USD');
    expect(out.rawNetworkData).toBe(row);
  });

  it('computes ageDays from the row date', () => {
    const now = new Date('2026-06-06T00:00:00Z');
    expect(_internals.computeAgeDays({ date: '2026-05-07' }, now)).toBe(30);
    expect(_internals.computeAgeDays({}, now)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes — Merchant Match
// ---------------------------------------------------------------------------

describe('Connexity.listProgrammes', () => {
  it('returns merchants from the merchant match envelope', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchant-match.json'))]);
    const programmes = await connexityAdapter.listProgrammes({ search: 'home' });
    expect(programmes.length).toBe(2);
    expect(programmes[0]?.name).toBe('Wayfair');
    expect(programmes.every((p) => p.status === 'joined')).toBe(true);
  });

  it('respects limit', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchant-match.json'))]);
    const programmes = await connexityAdapter.listProgrammes({ limit: 1 });
    expect(programmes.length).toBe(1);
  });

  it('returns an empty list for a non-joined status request (honest, no invention)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchant-match.json'))]);
    const programmes = await connexityAdapter.listProgrammes({ status: 'pending' });
    expect(programmes).toEqual([]);
  });

  it('emits a config_error envelope when a credential is missing', async () => {
    delete process.env['CONNEXITY_API_KEY'];
    await expect(connexityAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getProgramme
// ---------------------------------------------------------------------------

describe('Connexity.getProgramme', () => {
  it('selects the merchant whose id matches', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchant-match.json'))]);
    const p = await connexityAdapter.getProgramme('100124');
    expect(p.name).toBe('Walmart');
  });

  it('throws a network_api_error envelope when the merchant is not found', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchant-match.json'))]);
    try {
      await connexityAdapter.getProgramme('999999');
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).envelope.type).toBe('network_api_error');
    }
  });

  it('throws a config_error envelope for an empty id', async () => {
    await expect(connexityAdapter.getProgramme('')).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listTransactions — daily CPC earnings
// ---------------------------------------------------------------------------

describe('Connexity.listTransactions', () => {
  it('returns one synthetic transaction per daily earnings row', async () => {
    mockFetchQueue([fakeResponse(loadFixture('earnings.json'))]);
    const txns = await connexityAdapter.listTransactions({
      from: '2026-05-01',
      to: '2026-06-01',
    });
    expect(txns.length).toBe(3);
    expect(txns.every((t) => t.status === 'approved')).toBe(true);
    expect(txns.every((t) => t.currency === 'USD')).toBe(true);
  });

  it('filters by age (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('earnings.json'))]);
    const recent = await connexityAdapter.listTransactions({
      from: '2026-05-01',
      to: '2026-06-01',
      maxAgeDays: 400,
    });
    for (const t of recent) {
      expect(t.ageDays).toBeLessThanOrEqual(400);
    }
    expect(recent.length).toBeGreaterThan(0);
  });

  it('chunks date ranges wider than 90 days into multiple calls', async () => {
    const spy = mockFetchQueue([
      fakeResponse({ earnings: [] }),
      fakeResponse({ earnings: [] }),
      fakeResponse({ earnings: [] }),
    ]);
    await connexityAdapter.listTransactions({
      from: '2026-01-01',
      to: '2026-08-01', // ~212 days → 3 slices
    });
    expect(spy.mock.calls.length).toBe(3);
  });

  it('emits an error envelope when a credential is missing', async () => {
    delete process.env['CONNEXITY_PUBLISHER_ID'];
    await expect(connexityAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('Connexity.getEarningsSummary', () => {
  it('aggregates commission across daily rows', async () => {
    mockFetchQueue([fakeResponse(loadFixture('earnings.json'))]);
    const summary = await connexityAdapter.getEarningsSummary({
      from: '2026-05-01',
      to: '2026-06-01',
    });
    expect(summary.totalEarnings).toBeCloseTo(363, 2);
    expect(summary.currency).toBe('USD');
    expect(summary.byStatus.approved).toBeCloseTo(363, 2);
    expect(summary.oldestUnpaidAgeDays).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// listClicks
// ---------------------------------------------------------------------------

describe('Connexity.listClicks', () => {
  it('throws NotImplementedError with the documented reason', async () => {
    await expect(connexityAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await connexityAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click');
    }
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — Deep Link API round-trip
// ---------------------------------------------------------------------------

describe('Connexity.generateTrackingLink', () => {
  it('returns the monetised link from the Deep Link API', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('link-generate.json'))]);
    const link = await connexityAdapter.generateTrackingLink({
      programmeId: '100123',
      destinationUrl: 'https://www.wayfair.com/furniture/cat',
    });
    expect(link.network).toBe('connexity');
    expect(link.trackingUrl).toContain('rd.bizrate.com');
    expect(link.programmeId).toBe('100123');
    // The deep-link host must have been called.
    expect(spy.mock.calls.length).toBe(1);
    const calledUrl = String(spy.mock.calls[0]?.[0]);
    expect(calledUrl).toContain('api.cnnx.link');
    expect(calledUrl).toContain('/api/link/generate');
  });

  it('does not require programmeId (monetises by URL)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('link-generate.json'))]);
    const link = await connexityAdapter.generateTrackingLink({
      programmeId: '',
      destinationUrl: 'https://www.wayfair.com/furniture/cat',
    });
    expect(link.trackingUrl).toBeTruthy();
    expect(link.programmeId).toBeUndefined();
  });

  it('throws a config_error envelope when destinationUrl is missing', async () => {
    await expect(
      connexityAdapter.generateTrackingLink({ programmeId: '100123', destinationUrl: '' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('Connexity.verifyAuth', () => {
  it('returns ok:true and identity when the earnings probe responds 200', async () => {
    mockFetchQueue([fakeResponse(loadFixture('earnings.json'))]);
    const r = await connexityAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toContain('connexity/725846');
  });

  it('returns ok:false on 401', async () => {
    mockFetchQueue([fakeResponse('{"error":"invalid_key"}', { status: 401 })]);
    const r = await connexityAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/401/);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('Connexity.validateCredential', () => {
  it('rejects malformed publisher IDs', async () => {
    expect((await connexityAdapter.validateCredential('CONNEXITY_PUBLISHER_ID', 'abc')).ok).toBe(false);
    expect((await connexityAdapter.validateCredential('CONNEXITY_PUBLISHER_ID', '0')).ok).toBe(false);
  });

  it('accepts well-formed publisher IDs', async () => {
    expect((await connexityAdapter.validateCredential('CONNEXITY_PUBLISHER_ID', '725846')).ok).toBe(true);
  });

  it('validates CONNEXITY_API_KEY by calling the earnings probe', async () => {
    mockFetchQueue([fakeResponse(loadFixture('earnings.json'))]);
    const r = await connexityAdapter.validateCredential('CONNEXITY_API_KEY', 'fresh-key');
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with a hint when the API key fails', async () => {
    mockFetchQueue([fakeResponse('{"error":"bad"}', { status: 401 })]);
    const r = await connexityAdapter.validateCredential('CONNEXITY_API_KEY', 'bad-key');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('Connexity.capabilitiesCheck', () => {
  it('records listClicks.supported = false and reports the network slug', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('merchant-match.json')), // listProgrammes
      fakeResponse(loadFixture('earnings.json')), // listTransactions probe
      fakeResponse(loadFixture('earnings.json')), // getEarningsSummary → listTransactions
      fakeResponse(loadFixture('earnings.json')), // verifyAuth
    ]);
    const caps = await connexityAdapter.capabilitiesCheck();
    expect(caps.network).toBe('connexity');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim Connexity body on a 500', async () => {
    const body = '{"error":"upstream broke","trace":"abc"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await connexityAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('connexity');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream broke');
    }
  });

  it('classifies 401 as auth_error', async () => {
    mockFetchQueue([fakeResponse('forbidden', { status: 401, rawBody: 'forbidden' })]);
    try {
      await connexityAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('auth_error');
    }
  });
});
