/**
 * Rakuten adapter — unit tests.
 *
 * Notes for future contributors:
 *   - Rakuten's client routes EVERY data call through a token-cache layer.
 *     Most tests therefore have to queue at least one token-exchange response
 *     in front of the data response. The first test in `Rakuten token cache`
 *     exercises the cache happy path; subsequent tests reset the cache so
 *     ordering is explicit.
 *   - We mock `globalThis.fetch` directly — same seam as the Awin tests.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { rakutenAdapter, _internals } from '../../../src/networks/rakuten/adapter.js';
import { _resetTokenCache } from '../../../src/networks/rakuten/auth.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'rakuten');

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

/**
 * Queue-driven fetch mock. Each call shifts the next response off the queue.
 */
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
  _resetTokenCache();
  process.env['RAKUTEN_CLIENT_ID'] = 'test-client-id';
  process.env['RAKUTEN_CLIENT_SECRET'] = 'test-client-secret';
  process.env['RAKUTEN_SID'] = '4567890';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['RAKUTEN_CLIENT_ID'];
  delete process.env['RAKUTEN_CLIENT_SECRET'];
  delete process.env['RAKUTEN_SID'];
  delete process.env['RAKUTEN_TOKEN_URL'];
});

// ---------------------------------------------------------------------------
// Transformation
// ---------------------------------------------------------------------------

describe('Rakuten transformers (status normalisation, raw preservation)', () => {
  it('maps Rakuten pending|locked|paid|reversed → canonical statuses', () => {
    const raw = (loadFixture('transactions.json') as { transactions: Record<string, unknown>[] })
      .transactions;
    expect(_internals.toTransaction(raw[0] as never).status).toBe('approved'); // locked
    expect(_internals.toTransaction(raw[1] as never).status).toBe('pending');
    expect(_internals.toTransaction(raw[2] as never).status).toBe('reversed');
    expect(_internals.toTransaction(raw[3] as never).status).toBe('paid');
  });

  it('preserves the raw Rakuten response under rawNetworkData', () => {
    const raw = (loadFixture('transactions.json') as { transactions: Record<string, unknown>[] })
      .transactions[0];
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('surfaces reversalReason on reversed transactions (§15.10)', () => {
    const raw = (loadFixture('transactions.json') as { transactions: Record<string, unknown>[] })
      .transactions[2];
    const out = _internals.toTransaction(raw as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Customer returned the item within 30 days');
  });

  it('maps programme application_status to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ application_status: 'approved' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ application_status: 'pending' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ application_status: 'rejected' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ application_status: '', status: 'inactive' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ application_status: '', status: 'active' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ application_status: 'never-seen-before' })).toBe('unknown');
  });

  it('computes ageDays from process_date (preferred) or transaction_date', () => {
    const now = new Date('2026-05-21T00:00:00Z');
    const age1 = _internals.computeAgeDays(
      { process_date: '2026-01-01T00:00:00Z' },
      now,
    );
    expect(age1).toBe(140);
    const age2 = _internals.computeAgeDays(
      { transaction_date: '2026-04-01T00:00:00Z' },
      now,
    );
    expect(age2).toBe(50);
  });

  it('formats Rakuten dates as YYYY-MM-DD (no time component)', () => {
    expect(_internals.formatRakutenDate(new Date('2026-05-21T15:30:00Z'))).toBe('2026-05-21');
  });
});

// ---------------------------------------------------------------------------
// Token cache — happy path + 401 refresh + retry
// ---------------------------------------------------------------------------

describe('Rakuten token cache', () => {
  it('exchanges credentials for a token on first call, then reuses', async () => {
    const spy = mockFetchQueue([
      // Token exchange
      fakeResponse(loadFixture('token-response.json')),
      // Data call 1
      fakeResponse(loadFixture('programmes.json')),
      // Data call 2 — reuses the cached token, NO new token exchange.
      fakeResponse(loadFixture('programmes.json')),
    ]);

    await rakutenAdapter.listProgrammes({ limit: 1 });
    await rakutenAdapter.listProgrammes({ limit: 1 });

    // Three fetch calls total: 1 token exchange + 2 data calls.
    expect(spy.mock.calls.length).toBe(3);

    // Confirm the first call hit the token endpoint.
    const firstUrl = String(spy.mock.calls[0]?.[0]);
    expect(firstUrl).toContain('/token');

    // Second and third calls hit the data endpoint with bearer auth.
    const secondInit = spy.mock.calls[1]?.[1] as RequestInit;
    const auth = (secondInit?.headers as Record<string, string>)?.['Authorization'];
    expect(auth).toBe('Bearer fake-rakuten-access-token-AAA111');
  });

  it('on 401 from a data endpoint, refreshes token and retries once', async () => {
    const spy = mockFetchQueue([
      // Initial token exchange.
      fakeResponse(loadFixture('token-response.json')),
      // First data call → 401 with stale token.
      fakeResponse('{"error":"token_expired"}', { status: 401 }),
      // Forced token refresh.
      fakeResponse({
        access_token: 'rakuten-fresh-token-BBB222',
        token_type: 'Bearer',
        expires_in: 3600,
      }),
      // Retried data call succeeds.
      fakeResponse(loadFixture('programmes.json')),
    ]);

    const out = await rakutenAdapter.listProgrammes({ limit: 1 });
    expect(out.length).toBeGreaterThan(0);

    // 4 calls: token, 401, refresh, retry.
    expect(spy.mock.calls.length).toBe(4);

    // Retry used the fresh bearer token.
    const retryInit = spy.mock.calls[3]?.[1] as RequestInit;
    const auth = (retryInit?.headers as Record<string, string>)?.['Authorization'];
    expect(auth).toBe('Bearer rakuten-fresh-token-BBB222');
  });

  it('two consecutive 401s surface as an auth_error envelope', async () => {
    mockFetchQueue([
      // Initial token exchange.
      fakeResponse(loadFixture('token-response.json')),
      // First data call → 401.
      fakeResponse('{"error":"invalid_credentials"}', { status: 401 }),
      // Refresh.
      fakeResponse(loadFixture('token-response.json')),
      // Retry → still 401.
      fakeResponse('{"error":"invalid_credentials"}', { status: 401 }),
    ]);

    await expect(rakutenAdapter.listProgrammes({ limit: 1 })).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listTransactions — §15.9 unpaid-age + §15.10 reversed visibility
// ---------------------------------------------------------------------------

describe('Rakuten.listTransactions', () => {
  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('token-response.json')),
      fakeResponse(loadFixture('transactions.json')),
    ]);

    const recent = await rakutenAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
      minAgeDays: 365,
    });
    for (const t of recent) {
      expect(t.ageDays).toBeGreaterThanOrEqual(365);
    }
    // The fixture has TXN-9001 (Sep 2024 → ~600d) and TXN-9004 (Jan 2024 → ~850d)
    // and TXN-9003 (Aug 2025 → ~280d). With minAgeDays=365, expect 2.
    expect(recent.length).toBe(2);
  });

  it('includes reversed transactions with reason populated (§15.10)', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('token-response.json')),
      fakeResponse(loadFixture('transactions.json')),
    ]);

    const all = await rakutenAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
    });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toBe('Customer returned the item within 30 days');
  });

  it('maps locked → approved so the unpaid-age affordance works (§15.9 mapping note)', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('token-response.json')),
      fakeResponse(loadFixture('transactions.json')),
    ]);
    const all = await rakutenAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
    });
    // TXN-9001 is "locked" in Rakuten's vocabulary → "approved" canonical.
    const approved = all.filter((t) => t.status === 'approved');
    expect(approved.length).toBeGreaterThanOrEqual(1);
  });

  it('filters by status when caller passes status[]', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('token-response.json')),
      fakeResponse(loadFixture('transactions.json')),
    ]);
    const only = await rakutenAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('emits a config_error envelope when the SID is missing (§15.4)', async () => {
    delete process.env['RAKUTEN_SID'];
    // Token exchange is also required first — but the SID requirement at the
    // start of listTransactions trips before we even attempt the token call.
    await expect(rakutenAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listClicks
// ---------------------------------------------------------------------------

describe('Rakuten.listClicks', () => {
  it('throws NotImplementedError with the documented reason', async () => {
    await expect(rakutenAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await rakutenAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('paid Rakuten tier');
    }
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink
// ---------------------------------------------------------------------------

describe('Rakuten.generateTrackingLink', () => {
  it('constructs the click.linksynergy.com deeplink with URL-encoded destination', async () => {
    const link = await rakutenAdapter.generateTrackingLink({
      programmeId: '50001',
      destinationUrl: 'https://www.atolls-bookshop-us.example.com/path?q=a b&c=ü',
    });
    expect(link.trackingUrl).toContain('https://click.linksynergy.com/deeplink?id=4567890');
    expect(link.trackingUrl).toContain('mid=50001');
    expect(link.trackingUrl).toContain('u=https%3A%2F%2Fwww.atolls-bookshop-us.example.com%2Fpath%3Fq%3Da%20b%26c%3D%C3%BC');
    expect(link.network).toBe('rakuten');
    expect(link.programmeId).toBe('50001');
  });

  it('throws a config_error envelope when programmeId is missing', async () => {
    await expect(
      rakutenAdapter.generateTrackingLink({
        programmeId: '',
        destinationUrl: 'https://x.example.com',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('does NOT call fetch (deterministic construction)', async () => {
    const spy = mockFetchQueue([]);
    await rakutenAdapter.generateTrackingLink({
      programmeId: '50001',
      destinationUrl: 'https://x.example.com',
    });
    expect(spy.mock.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('Rakuten.verifyAuth', () => {
  it('returns ok:true when the token exchange succeeds', async () => {
    mockFetchQueue([fakeResponse(loadFixture('token-response.json'))]);
    const r = await rakutenAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('rakuten');
    }
  });

  it('surfaces a failure when the token exchange returns 401', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_client"}', { status: 401 }),
    ]);
    const r = await rakutenAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/401|invalid|token/i);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('Rakuten.validateCredential', () => {
  it('rejects malformed SID', async () => {
    const r1 = await rakutenAdapter.validateCredential('RAKUTEN_SID', 'abc');
    expect(r1.ok).toBe(false);
  });
  it('accepts well-formed SID', async () => {
    const r = await rakutenAdapter.validateCredential('RAKUTEN_SID', '4567890');
    expect(r.ok).toBe(true);
  });
  it('rejects empty client id / secret', async () => {
    const r1 = await rakutenAdapter.validateCredential('RAKUTEN_CLIENT_ID', '');
    expect(r1.ok).toBe(false);
    const r2 = await rakutenAdapter.validateCredential('RAKUTEN_CLIENT_SECRET', '');
    expect(r2.ok).toBe(false);
  });
  it('flags whitespace in secret as likely copy/paste error', async () => {
    const r = await rakutenAdapter.validateCredential('RAKUTEN_CLIENT_SECRET', 'has space');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Error transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim Rakuten response body on a 500', async () => {
    const body = '{"error":"rakuten upstream failure","trace":"def-456"}';
    mockFetchQueue([
      // Token exchange.
      fakeResponse(loadFixture('token-response.json')),
      // Data calls fail 500 — resilience layer retries.
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await rakutenAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('rakuten');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('rakuten upstream failure');
    }
  });

  it('classifies 403 from a gated endpoint as auth_error', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('token-response.json')),
      fakeResponse('access denied', { status: 403, rawBody: 'access denied' }),
    ]);
    try {
      await rakutenAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('auth_error');
      expect(env.networkErrorBody).toBe('access denied');
    }
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('Rakuten.getEarningsSummary', () => {
  it('aggregates by status and surfaces oldestUnpaidAgeDays from pending+approved', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('token-response.json')),
      fakeResponse(loadFixture('transactions.json')),
    ]);
    const summary = await rakutenAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
    });
    expect(summary.network).toBe('rakuten');
    // Pending (TXN-9002, $3.6) + Approved (TXN-9001 locked, $9.6) +
    // Paid (TXN-9004, $6.0) + Reversed (TXN-9003, $0)
    expect(summary.byStatus.pending).toBeCloseTo(3.6);
    expect(summary.byStatus.approved).toBeCloseTo(9.6);
    expect(summary.byStatus.paid).toBeCloseTo(6.0);
    expect(summary.byStatus.reversed).toBeCloseTo(0);
    expect(summary.oldestUnpaidAgeDays).toBeGreaterThanOrEqual(365);
  });
});
