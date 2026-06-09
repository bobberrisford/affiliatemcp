/**
 * 2Performant adapter — unit tests.
 *
 * Mirrors the Awin test patterns:
 *   - We mock `globalThis.fetch` directly (the adapter ↔ network seam) so the
 *     full client + resilience + transformer stack runs with no live HTTP.
 *   - Each test stubs only the fetch responses it needs.
 *
 * 2Performant-specific: the session lives in RESPONSE HEADERS
 * (`access-token` / `client` / `uid`), so `sessionResponse()` attaches them and
 * `fakeResponse()` leaves them off. The 401-relogin test asserts that one 401
 * triggers exactly one re-login (a fresh sign-in) and one retry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { twoPerformantAdapter, _internals } from '../../../src/networks/2performant/adapter.js';
import { _resetSession } from '../../../src/networks/2performant/auth.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', '2performant');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

/** A response WITHOUT session headers (data responses do not need to rotate). */
function fakeResponse(body: unknown, init: { status?: number; rawBody?: string } = {}): Response {
  const status = init.status ?? 200;
  const text = init.rawBody ?? (typeof body === 'string' ? body : JSON.stringify(body));
  return new Response(text, { status, headers: { 'content-type': 'application/json' } });
}

/** A response WITH the three session headers — used for sign-in and rotations. */
function sessionResponse(
  body: unknown,
  init: { status?: number; session?: { accessToken: string; client: string; uid: string } } = {},
): Response {
  const status = init.status ?? 200;
  const s = init.session ?? { accessToken: 'tok-1', client: 'cli-1', uid: 'user@example.com' };
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'access-token': s.accessToken,
      client: s.client,
      uid: s.uid,
    },
  });
}

const SIGN_IN_BODY = {
  user: { id: 1, email: 'user@example.com', role: 'affiliate', unique_code: 'aff999' },
};

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
  _resetSession();
  process.env['TWOPERFORMANT_EMAIL'] = 'user@example.com';
  process.env['TWOPERFORMANT_PASSWORD'] = 'hunter2';
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetSession();
  delete process.env['TWOPERFORMANT_EMAIL'];
  delete process.env['TWOPERFORMANT_PASSWORD'];
});

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

describe('2Performant transformers (status normalisation, raw preservation)', () => {
  it('maps commission status accepted|pending|rejected|paid → canonical', () => {
    const c = loadFixture('commissions.json') as { commissions: Array<Record<string, unknown>> };
    expect(_internals.toTransaction(c.commissions[0] as never).status).toBe('approved');
    expect(_internals.toTransaction(c.commissions[1] as never).status).toBe('pending');
    expect(_internals.toTransaction(c.commissions[2] as never).status).toBe('reversed');
    expect(_internals.toTransaction(c.commissions[3] as never).status).toBe('paid');
  });

  it('preserves the raw commission under rawNetworkData', () => {
    const raw = (loadFixture('commissions.json') as { commissions: Array<Record<string, unknown>> })
      .commissions[0];
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('surfaces reversalReason on reversed (rejected) commissions', () => {
    const raw = (loadFixture('commissions.json') as { commissions: Array<Record<string, unknown>> })
      .commissions[2];
    const out = _internals.toTransaction(raw as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Customer returned the item within 14 days');
  });

  it('maps programme affiliate-request status to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ affrequest: { status: 'accepted' } })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ affrequest: { status: 'pending' } })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ affrequest: { status: 'rejected' } })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ status: 'active' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'never-seen' })).toBe('unknown');
  });

  it('computes ageDays from created_at', () => {
    const now = new Date('2026-05-21T00:00:00Z');
    expect(_internals.computeAgeDays({ created_at: '2026-04-01T00:00:00Z' }, now)).toBe(50);
  });

  it('builds a comma-range filter[date] from from/to', () => {
    expect(_internals.buildDateFilter('2026-01-01T00:00:00Z', '2026-03-31T00:00:00Z')).toBe(
      '2026-01-01,2026-03-31',
    );
    expect(_internals.buildDateFilter(undefined, undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('2Performant.listProgrammes', () => {
  it('signs in then lists programmes, normalising status', async () => {
    mockFetchQueue([
      sessionResponse(SIGN_IN_BODY), // sign_in
      fakeResponse(loadFixture('programs.json')), // /affiliate/programs
    ]);
    const programmes = await twoPerformantAdapter.listProgrammes();
    expect(programmes.length).toBe(2);
    expect(programmes[0]?.network).toBe('2performant');
    expect(programmes[0]?.status).toBe('joined');
    expect(programmes[1]?.status).toBe('pending');
  });

  it('filters by canonical status client-side', async () => {
    mockFetchQueue([sessionResponse(SIGN_IN_BODY), fakeResponse(loadFixture('programs.json'))]);
    const joined = await twoPerformantAdapter.listProgrammes({ status: 'joined' });
    expect(joined.every((p) => p.status === 'joined')).toBe(true);
    expect(joined.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('2Performant.listTransactions', () => {
  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockFetchQueue([sessionResponse(SIGN_IN_BODY), fakeResponse(loadFixture('commissions.json'))]);
    const aged = await twoPerformantAdapter.listTransactions({ minAgeDays: 365 });
    for (const t of aged) expect(t.ageDays).toBeGreaterThanOrEqual(365);
    expect(aged.length).toBeGreaterThan(0); // the Jan 2025 paid one qualifies
  });

  it('includes reversed transactions with reason populated (§15.10)', async () => {
    mockFetchQueue([sessionResponse(SIGN_IN_BODY), fakeResponse(loadFixture('commissions.json'))]);
    const all = await twoPerformantAdapter.listTransactions({});
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toBe('Customer returned the item within 14 days');
  });

  it('emits a config_error envelope when credentials are missing', async () => {
    delete process.env['TWOPERFORMANT_PASSWORD'];
    await expect(twoPerformantAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('2Performant.getEarningsSummary', () => {
  it('aggregates commission by status and programme (client-side)', async () => {
    mockFetchQueue([sessionResponse(SIGN_IN_BODY), fakeResponse(loadFixture('commissions.json'))]);
    const summary = await twoPerformantAdapter.getEarningsSummary({
      from: '2025-01-01T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
    });
    expect(summary.network).toBe('2performant');
    expect(summary.currency).toBe('RON');
    // 42.50 + 12 + 30 + 100 = 184.50
    expect(summary.totalEarnings).toBeCloseTo(184.5, 2);
    expect(summary.byStatus.paid).toBeCloseTo(100, 2);
    expect(summary.byStatus.reversed).toBeCloseTo(30, 2);
    expect(summary.byProgramme.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 401 → single re-login + retry
// ---------------------------------------------------------------------------

describe('2Performant session auth: 401 triggers one re-login + retry', () => {
  it('re-logs in once and retries the data call after a 401', async () => {
    const spy = mockFetchQueue([
      sessionResponse(SIGN_IN_BODY, { session: { accessToken: 'tok-1', client: 'cli-1', uid: 'u' } }), // initial sign_in
      fakeResponse('{"errors":[{"title":"unauthorized"}]}', { status: 401 }), // data call 401
      sessionResponse(SIGN_IN_BODY, { session: { accessToken: 'tok-2', client: 'cli-2', uid: 'u' } }), // re-login
      fakeResponse(loadFixture('programs.json')), // retried data call succeeds
    ]);

    const programmes = await twoPerformantAdapter.listProgrammes();
    expect(programmes.length).toBe(2);
    // 4 calls total: sign_in, 401 data, re-login, retried data.
    expect(spy.mock.calls.length).toBe(4);

    // The retried data call must carry the rotated (fresh) access-token.
    const retriedInit = spy.mock.calls[3]?.[1] as RequestInit;
    const headers = retriedInit.headers as Record<string, string>;
    expect(headers['access-token']).toBe('tok-2');
  });

  it('does not loop: a second 401 surfaces as an auth_error envelope', async () => {
    mockFetchQueue([
      sessionResponse(SIGN_IN_BODY), // sign_in
      fakeResponse('nope', { status: 401, rawBody: 'nope' }), // data 401
      sessionResponse(SIGN_IN_BODY), // re-login
      fakeResponse('nope again', { status: 401, rawBody: 'nope again' }), // retry also 401
    ]);
    try {
      await twoPerformantAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).envelope.type).toBe('auth_error');
      expect((err as NetworkError).envelope.httpStatus).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// listClicks
// ---------------------------------------------------------------------------

describe('2Performant.listClicks', () => {
  it('throws NotImplementedError with the documented reason', async () => {
    await expect(twoPerformantAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await twoPerformantAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('does not expose click-level data');
    }
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — deterministic quicklink construction
// ---------------------------------------------------------------------------

describe('2Performant.generateTrackingLink', () => {
  it('constructs the quicklink with the affiliate code, programme code and encoded URL', async () => {
    // One sign-in to capture the affiliate unique code; no link API call.
    mockFetchQueue([sessionResponse(SIGN_IN_BODY)]);
    const link = await twoPerformantAdapter.generateTrackingLink({
      programmeId: 'abc123',
      destinationUrl: 'https://shop.example.ro/path?q=a b',
    });
    expect(link.trackingUrl).toContain('https://event.2performant.com/events/click');
    expect(link.trackingUrl).toContain('ad_type=quicklink');
    expect(link.trackingUrl).toContain('aff_code=aff999');
    expect(link.trackingUrl).toContain('unique=abc123');
    expect(link.trackingUrl).toContain('redirect_to=https%3A%2F%2Fshop.example.ro%2Fpath%3Fq%3Da%20b');
    expect(link.network).toBe('2performant');
  });

  it('throws a config_error envelope when programmeId is missing', async () => {
    await expect(
      twoPerformantAdapter.generateTrackingLink({ programmeId: '', destinationUrl: 'https://x.ro' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('2Performant.verifyAuth', () => {
  it('returns ok:true and identity when sign-in returns session headers', async () => {
    mockFetchQueue([sessionResponse(SIGN_IN_BODY)]);
    const r = await twoPerformantAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toContain('2performant/user@example.com');
  });

  it('returns ok:false on a 401 sign-in', async () => {
    mockFetchQueue([fakeResponse('{"error":"invalid"}', { status: 401 })]);
    const r = await twoPerformantAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/401|HTTP 401|invalid/i);
  });

  it('returns ok:false when sign-in 2xx but omits session headers', async () => {
    mockFetchQueue([fakeResponse(SIGN_IN_BODY)]); // no session headers
    const r = await twoPerformantAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('no access-token');
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('2Performant.validateCredential', () => {
  it('rejects malformed email and empty password', async () => {
    expect((await twoPerformantAdapter.validateCredential('TWOPERFORMANT_EMAIL', 'nope')).ok).toBe(false);
    expect((await twoPerformantAdapter.validateCredential('TWOPERFORMANT_PASSWORD', '')).ok).toBe(false);
  });

  it('accepts a well-formed email and password', async () => {
    expect(
      (await twoPerformantAdapter.validateCredential('TWOPERFORMANT_EMAIL', 'a@b.co')).ok,
    ).toBe(true);
    expect(
      (await twoPerformantAdapter.validateCredential('TWOPERFORMANT_PASSWORD', 'secret')).ok,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// error transparency
// ---------------------------------------------------------------------------

describe('error transparency', () => {
  it('surfaces the verbatim 2Performant response body on a 500', async () => {
    const body = '{"errors":[{"title":"upstream broke"}]}';
    mockFetchQueue([
      sessionResponse(SIGN_IN_BODY),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await twoPerformantAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('2performant');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream broke');
    }
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('2Performant.capabilitiesCheck', () => {
  it('records listClicks.supported = false with the known-limitation note', async () => {
    // sign_in, then listProgrammes, listTransactions, getEarningsSummary→listTransactions,
    // verifyAuth (which resets the session and signs in again).
    mockFetchQueue([
      sessionResponse(SIGN_IN_BODY), // initial sign-in (first probe triggers login)
      fakeResponse({ programs: [] }), // listProgrammes
      fakeResponse({ commissions: [], metadata: { totalpages: 0 } }), // listTransactions probe
      fakeResponse({ commissions: [], metadata: { totalpages: 0 } }), // getEarningsSummary → listTransactions
      sessionResponse(SIGN_IN_BODY), // verifyAuth re-login
    ]);
    const caps = await twoPerformantAdapter.capabilitiesCheck();
    expect(caps.network).toBe('2performant');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['listClicks']?.note).toContain('Click-level data');
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
