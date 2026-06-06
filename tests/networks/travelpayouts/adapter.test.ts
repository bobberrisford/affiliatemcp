/**
 * Travelpayouts adapter — unit tests.
 *
 * Mirrors the Awin test patterns:
 *   - We mock `globalThis.fetch` directly (the adapter <-> network seam), which
 *     exercises the full client + resilience + transformer stack with no live
 *     HTTP.
 *   - Each test stubs only the fetch responses it needs.
 *   - No live calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { travelpayoutsAdapter, _internals } from '../../../src/networks/travelpayouts/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'networks', 'travelpayouts', 'fixtures');

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
  process.env['TRAVELPAYOUTS_ACCESS_TOKEN'] = 'test-token-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['TRAVELPAYOUTS_ACCESS_TOKEN'];
});

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

describe('Travelpayouts transformers (status normalisation, raw preservation)', () => {
  it('maps action_state processing|paid|cancelled to canonical statuses', () => {
    expect(_internals.mapActionStatus('processing')).toBe('pending');
    expect(_internals.mapActionStatus('paid')).toBe('paid');
    expect(_internals.mapActionStatus('cancelled')).toBe('reversed');
    expect(_internals.mapActionStatus('never-seen')).toBe('other');
  });

  it('preserves the raw action under rawNetworkData', () => {
    const raw = (loadFixture('actions.json') as { actions: Array<Record<string, unknown>> }).actions[0];
    const out = _internals.toTransaction(raw as never, 'USD');
    expect(out.rawNetworkData).toBe(raw);
  });

  it('reads profit as commission and price as amount (whole currency units)', () => {
    const raw = (loadFixture('actions.json') as { actions: Array<Record<string, unknown>> }).actions[0];
    const out = _internals.toTransaction(raw as never, 'USD');
    expect(out.commission).toBe(21);
    expect(out.amount).toBe(420);
    expect(out.currency).toBe('USD');
  });

  it('surfaces a reversal reason from description on reversed bookings', () => {
    const reversed = (loadFixture('actions.json') as { actions: Array<Record<string, unknown>> }).actions[2];
    const out = _internals.toTransaction(reversed as never, 'USD');
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Hotellook hotel booking returned by guest');
  });

  it('computes ageDays from booked_at', () => {
    const now = new Date('2024-09-11T00:00:00Z');
    const age = _internals.computeAgeDays({ booked_at: '2024-09-01T00:00:00Z' }, now);
    expect(age).toBe(10);
  });

  it('maps canonical statuses to Travelpayouts action_state for the fast path', () => {
    expect(_internals.canonicalToActionState('pending')).toBe('processing');
    expect(_internals.canonicalToActionState('paid')).toBe('paid');
    expect(_internals.canonicalToActionState('reversed')).toBe('cancelled');
    expect(_internals.canonicalToActionState('approved')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listProgrammes — synthesised
// ---------------------------------------------------------------------------

describe('Travelpayouts.listProgrammes (synthesised)', () => {
  it('synthesises joined programmes from available_campaigns', async () => {
    mockFetchQueue([fakeResponse(loadFixture('actions.json'))]);
    const programmes = await travelpayoutsAdapter.listProgrammes();
    expect(programmes.length).toBe(2);
    expect(programmes.every((p) => p.status === 'joined')).toBe(true);
    expect(programmes.map((p) => p.name).sort()).toEqual(['Aviasales', 'Hotellook']);
  });

  it('applies a client-side search filter', async () => {
    mockFetchQueue([fakeResponse(loadFixture('actions.json'))]);
    const programmes = await travelpayoutsAdapter.listProgrammes({ search: 'avia' });
    expect(programmes.length).toBe(1);
    expect(programmes[0]?.name).toBe('Aviasales');
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('Travelpayouts.listTransactions', () => {
  it('returns booking rows with profit/price/currency mapped', async () => {
    mockFetchQueue([fakeResponse(loadFixture('actions.json'))]);
    const txns = await travelpayoutsAdapter.listTransactions({
      from: '2024-01-01',
      to: '2026-01-01',
    });
    expect(txns.length).toBe(4);
    expect(txns.every((t) => t.network === 'travelpayouts')).toBe(true);
    expect(txns.find((t) => t.id === '1001')?.status).toBe('paid');
  });

  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('actions.json'))]);
    const aged = await travelpayoutsAdapter.listTransactions({
      from: '2024-01-01',
      to: '2026-12-31',
      minAgeDays: 365,
    });
    expect(aged.length).toBeGreaterThan(0);
    for (const t of aged) expect(t.ageDays).toBeGreaterThanOrEqual(365);
  });

  it('filters by status when caller passes status[]', async () => {
    mockFetchQueue([fakeResponse(loadFixture('actions.json'))]);
    const reversed = await travelpayoutsAdapter.listTransactions({
      from: '2024-01-01',
      to: '2026-12-31',
      status: ['reversed'],
    });
    expect(reversed.every((t) => t.status === 'reversed')).toBe(true);
    expect(reversed.length).toBe(1);
  });

  it('emits a config_error envelope when the token is missing', async () => {
    delete process.env['TRAVELPAYOUTS_ACCESS_TOKEN'];
    await expect(travelpayoutsAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('Travelpayouts.getEarningsSummary', () => {
  it('aggregates commission by status and programme', async () => {
    mockFetchQueue([fakeResponse(loadFixture('actions.json'))]);
    const summary = await travelpayoutsAdapter.getEarningsSummary({
      from: '2024-01-01',
      to: '2026-12-31',
    });
    expect(summary.network).toBe('travelpayouts');
    // 21 + 9.03 + 32 + 7.60 = 69.63
    expect(summary.totalEarnings).toBeCloseTo(69.63, 2);
    expect(summary.byStatus.paid).toBeCloseTo(28.6, 2);
    expect(summary.byStatus.reversed).toBeCloseTo(32, 2);
    expect(summary.byProgramme.length).toBe(2);
    expect(summary.currency).toBe('USD');
  });
});

// ---------------------------------------------------------------------------
// listClicks / generateTrackingLink — unsupported
// ---------------------------------------------------------------------------

describe('Travelpayouts unsupported operations', () => {
  it('listClicks throws NotImplementedError with the documented reason', async () => {
    await expect(travelpayoutsAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await travelpayoutsAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click-level data');
    }
  });

  it('generateTrackingLink throws NotImplementedError with the documented reason', async () => {
    await expect(
      travelpayoutsAdapter.generateTrackingLink({
        programmeId: '100',
        destinationUrl: 'https://www.aviasales.com/',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('Travelpayouts.verifyAuth', () => {
  it('returns ok:true and an identity when get_user_balance responds 200', async () => {
    mockFetchQueue([fakeResponse(loadFixture('balance.json'))]);
    const r = await travelpayoutsAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toContain('travelpayouts');
  });

  it('returns ok:false on 401', async () => {
    mockFetchQueue([fakeResponse('{"error":"invalid_token"}', { status: 401 })]);
    const r = await travelpayoutsAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/401/);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('Travelpayouts.validateCredential', () => {
  it('validates TRAVELPAYOUTS_ACCESS_TOKEN by calling get_user_balance', async () => {
    mockFetchQueue([fakeResponse(loadFixture('balance.json'))]);
    const r = await travelpayoutsAdapter.validateCredential('TRAVELPAYOUTS_ACCESS_TOKEN', 'fresh');
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with a hint when token validation fails', async () => {
    mockFetchQueue([fakeResponse('{"error":"bad"}', { status: 401 })]);
    const r = await travelpayoutsAdapter.validateCredential('TRAVELPAYOUTS_ACCESS_TOKEN', 'bad');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('rejects unknown credential fields', async () => {
    const r = await travelpayoutsAdapter.validateCredential('SOMETHING_ELSE', 'x');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('Travelpayouts.capabilitiesCheck', () => {
  it('records unsupported ops without probing and marks the surface experimental', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('actions.json')), // listProgrammes
      fakeResponse(loadFixture('actions.json')), // listTransactions probe
      fakeResponse(loadFixture('actions.json')), // getEarningsSummary -> listTransactions
      fakeResponse(loadFixture('balance.json')), // verifyAuth
    ]);
    const caps = await travelpayoutsAdapter.capabilitiesCheck();
    expect(caps.network).toBe('travelpayouts');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
    expect(caps.operations['listProgrammes']?.claimStatus).toBe('experimental');
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
    ]);
    try {
      await travelpayoutsAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('travelpayouts');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream broke');
    }
  });

  it('classifies 401 as auth_error', async () => {
    mockFetchQueue([fakeResponse('forbidden', { status: 401, rawBody: 'forbidden' })]);
    try {
      await travelpayoutsAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('auth_error');
    }
  });
});
