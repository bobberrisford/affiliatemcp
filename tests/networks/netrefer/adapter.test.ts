/**
 * NetRefer adapter — unit tests.
 *
 * Notes for future contributors:
 *   - NetRefer's client routes EVERY data call through a token-cache layer
 *     (OAuth2 password grant). Most tests therefore queue at least one
 *     token-exchange response in front of the data response.
 *   - We mock `globalThis.fetch` directly — same seam as the Awin/Rakuten tests.
 *   - All amounts/dates in the fixture are scrubbed; the `now` anchor is fixed
 *     so age assertions are deterministic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { netreferAdapter, _internals } from '../../../src/networks/netrefer/adapter.js';
import { _resetTokenCache } from '../../../src/networks/netrefer/auth.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'networks', 'netrefer', 'fixtures');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(body: unknown, init: { status?: number; rawBody?: string } = {}): Response {
  const status = init.status ?? 200;
  const text = init.rawBody ?? (typeof body === 'string' ? body : JSON.stringify(body));
  return new Response(text, { status, headers: { 'content-type': 'application/json' } });
}

/** Queue-driven fetch mock. Each call shifts the next response off the queue. */
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
  process.env['NETREFER_BASE_URL'] = 'https://asr.operator.netrefer.com';
  process.env['NETREFER_CLIENT_ID'] = 'test-client-id';
  process.env['NETREFER_CLIENT_SECRET'] = 'test-client-secret';
  process.env['NETREFER_USERNAME'] = 'test-user';
  process.env['NETREFER_PASSWORD'] = 'test-pass';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['NETREFER_BASE_URL'];
  delete process.env['NETREFER_CLIENT_ID'];
  delete process.env['NETREFER_CLIENT_SECRET'];
  delete process.env['NETREFER_USERNAME'];
  delete process.env['NETREFER_PASSWORD'];
  delete process.env['NETREFER_TOKEN_URL'];
  delete process.env['NETREFER_SCOPE'];
});

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

describe('NetRefer transformers (metric reading, raw preservation)', () => {
  it('reads {Result, Adjustment} metrics and sums them net', () => {
    const rows = (loadFixture('daily-activity.json') as { Report: Record<string, unknown>[] })
      .Report;
    const txn = _internals.toTransaction(rows[0] as never);
    // CPA net = 800, RevShare net = 150.5 - 10.5 = 140 → commission 940.
    expect(txn.commission).toBeCloseTo(940.0);
    // Deposits net = 5000 - 250 = 4750 → amount.
    expect(txn.amount).toBeCloseTo(4750.0);
    expect(txn.currency).toBe('EUR');
  });

  it('reads lowercase plain-number metrics too', () => {
    const rows = (loadFixture('daily-activity.json') as { Report: Record<string, unknown>[] })
      .Report;
    const txn = _internals.toTransaction(rows[2] as never);
    // cpa 90 + revShare 12 = 102.
    expect(txn.commission).toBeCloseTo(102.0);
    expect(txn.amount).toBeCloseTo(600.0);
    expect(txn.programmeName).toBe('Atolls Sports');
  });

  it('preserves the raw ASR row under rawNetworkData', () => {
    const rows = (loadFixture('daily-activity.json') as { Report: Record<string, unknown>[] })
      .Report;
    const out = _internals.toTransaction(rows[0] as never);
    expect(out.rawNetworkData).toBe(rows[0]);
  });

  it('maps aggregate rows to canonical status approved', () => {
    const rows = (loadFixture('daily-activity.json') as { Report: Record<string, unknown>[] })
      .Report;
    expect(_internals.toTransaction(rows[0] as never).status).toBe('approved');
  });

  it('builds a stable composite id from date:brand:tracker', () => {
    const rows = (loadFixture('daily-activity.json') as { Report: Record<string, unknown>[] })
      .Report;
    const id = _internals.rowId(rows[0] as never);
    expect(id).toContain('BR-100');
    expect(id).toContain('TR-1');
  });

  it('computes ageDays from the report date', () => {
    const now = new Date('2026-06-05T00:00:00Z');
    expect(_internals.computeAgeDays({ Date: '2026-06-01T00:00:00Z' }, now)).toBe(4);
    expect(_internals.computeAgeDays({ Date: '2026-03-01T00:00:00Z' }, now)).toBe(96);
  });

  it('formats ASR dates as YYYY-MM-DD (no time component)', () => {
    expect(_internals.formatAsrDate(new Date('2026-06-05T15:30:00Z'))).toBe('2026-06-05');
  });

  it('extracts rows from several documented envelope shapes', () => {
    expect(_internals.extractRows({ Report: [{ Date: 'x' }] }).length).toBe(1);
    expect(_internals.extractRows({ data: [{ date: 'y' }] }).length).toBe(1);
    expect(_internals.extractRows([{ Date: 'z' }]).length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Token cache — happy path + 401 refresh + retry
// ---------------------------------------------------------------------------

describe('NetRefer token cache', () => {
  it('exchanges credentials for a token on first call, then reuses', async () => {
    const spy = mockFetchQueue([
      fakeResponse(loadFixture('token-response.json')),
      fakeResponse(loadFixture('daily-activity.json')),
      fakeResponse(loadFixture('daily-activity.json')),
    ]);

    await netreferAdapter.listProgrammes({ limit: 1 });
    await netreferAdapter.listProgrammes({ limit: 1 });

    // 1 token exchange + 2 data calls.
    expect(spy.mock.calls.length).toBe(3);

    const firstUrl = String(spy.mock.calls[0]?.[0]);
    expect(firstUrl).toContain('/oauth2/v2.0/token');

    // Data calls hit the per-operator base URL with bearer auth.
    const secondUrl = String(spy.mock.calls[1]?.[0]);
    expect(secondUrl).toContain('asr.operator.netrefer.com');
    const secondInit = spy.mock.calls[1]?.[1] as RequestInit;
    const auth = (secondInit?.headers as Record<string, string>)?.['Authorization'];
    expect(auth).toBe('Bearer fake-netrefer-access-token-AAA111');
  });

  it('sends grant_type=password and the documented scope to the token endpoint', async () => {
    const spy = mockFetchQueue([
      fakeResponse(loadFixture('token-response.json')),
      fakeResponse(loadFixture('daily-activity.json')),
    ]);
    await netreferAdapter.listProgrammes({ limit: 1 });
    const tokenInit = spy.mock.calls[0]?.[1] as RequestInit;
    const body = String(tokenInit.body);
    expect(body).toContain('grant_type=password');
    expect(body).toContain('username=test-user');
    expect(body).toContain('scope=');
  });

  it('on 401 from a data endpoint, refreshes token and retries once', async () => {
    const spy = mockFetchQueue([
      fakeResponse(loadFixture('token-response.json')),
      fakeResponse('{"error":"token_expired"}', { status: 401 }),
      fakeResponse({ access_token: 'netrefer-fresh-BBB222', token_type: 'Bearer', expires_in: 3600 }),
      fakeResponse(loadFixture('daily-activity.json')),
    ]);

    const out = await netreferAdapter.listProgrammes({ limit: 1 });
    expect(out.length).toBeGreaterThan(0);
    expect(spy.mock.calls.length).toBe(4);

    const retryInit = spy.mock.calls[3]?.[1] as RequestInit;
    const auth = (retryInit?.headers as Record<string, string>)?.['Authorization'];
    expect(auth).toBe('Bearer netrefer-fresh-BBB222');
  });

  it('two consecutive 401s surface as a NetworkError', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('token-response.json')),
      fakeResponse('{"error":"invalid"}', { status: 401 }),
      fakeResponse(loadFixture('token-response.json')),
      fakeResponse('{"error":"invalid"}', { status: 401 }),
    ]);
    await expect(netreferAdapter.listProgrammes({ limit: 1 })).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// Per-operator base URL
// ---------------------------------------------------------------------------

describe('NetRefer per-operator base URL', () => {
  it('emits a config_error envelope when NETREFER_BASE_URL is missing', async () => {
    delete process.env['NETREFER_BASE_URL'];
    await expect(netreferAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });

  it('emits a config_error envelope when NETREFER_BASE_URL is not a URL', async () => {
    process.env['NETREFER_BASE_URL'] = 'not a url';
    try {
      await netreferAdapter.listTransactions({});
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).envelope.type).toBe('config_error');
    }
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('NetRefer.listTransactions', () => {
  it('maps Daily Activity rows to transactions', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('token-response.json')),
      fakeResponse(loadFixture('daily-activity.json')),
    ]);
    const txns = await netreferAdapter.listTransactions({
      from: '2026-05-20T00:00:00Z',
      to: '2026-06-05T00:00:00Z',
    });
    expect(txns.length).toBe(3);
    expect(txns.every((t) => t.network === 'netrefer')).toBe(true);
  });

  it('filters by programmeId (brand) client-side', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('token-response.json')),
      fakeResponse(loadFixture('daily-activity.json')),
    ]);
    const only = await netreferAdapter.listTransactions({
      from: '2026-05-20T00:00:00Z',
      to: '2026-06-05T00:00:00Z',
      programmeId: 'BR-200',
    });
    expect(only.every((t) => t.programmeId === 'BR-200')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('applies minAgeDays after status filtering (§15.9)', async () => {
    // Window > 31 days forces chunking; queue the fixture for the first slice
    // and empty payloads for the remaining slices.
    mockFetchQueue([
      fakeResponse(loadFixture('token-response.json')),
      fakeResponse(loadFixture('daily-activity.json')),
      fakeResponse({ Report: [] }),
      fakeResponse({ Report: [] }),
      fakeResponse({ Report: [] }),
      fakeResponse({ Report: [] }),
    ]);
    const aged = await netreferAdapter.listTransactions({
      from: '2026-02-01T00:00:00Z',
      to: '2026-06-05T00:00:00Z',
      minAgeDays: 60,
    });
    for (const t of aged) expect(t.ageDays).toBeGreaterThanOrEqual(60);
    // Only the 2026-03-01 row is older than 60 days relative to a recent now.
    expect(aged.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes / getProgramme (synthesised)
// ---------------------------------------------------------------------------

describe('NetRefer.listProgrammes (synthesised from report brands)', () => {
  it('returns one programme per distinct brand', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('token-response.json')),
      fakeResponse(loadFixture('daily-activity.json')),
    ]);
    const programmes = await netreferAdapter.listProgrammes();
    const ids = programmes.map((p) => p.id).sort();
    expect(ids).toEqual(['BR-100', 'BR-200']);
    expect(programmes.every((p) => p.status === 'joined')).toBe(true);
  });

  it('getProgramme returns a known brand and throws for an unknown one', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('token-response.json')),
      fakeResponse(loadFixture('daily-activity.json')),
    ]);
    const p = await netreferAdapter.getProgramme('BR-100');
    expect(p.name).toBe('Atolls Casino');

    mockFetchQueue([
      fakeResponse(loadFixture('token-response.json')),
      fakeResponse(loadFixture('daily-activity.json')),
    ]);
    await expect(netreferAdapter.getProgramme('BR-999')).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('NetRefer.getEarningsSummary', () => {
  it('aggregates commission by status and programme', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('token-response.json')),
      fakeResponse(loadFixture('daily-activity.json')),
    ]);
    const summary = await netreferAdapter.getEarningsSummary({
      from: '2026-05-20T00:00:00Z',
      to: '2026-06-05T00:00:00Z',
    });
    expect(summary.network).toBe('netrefer');
    // commissions: 940 + 200 + 102 = 1242, all 'approved'.
    expect(summary.byStatus.approved).toBeCloseTo(1242.0);
    expect(summary.totalEarnings).toBeCloseTo(1242.0);
    expect(summary.byProgramme.length).toBe(2);
    expect(summary.oldestUnpaidAgeDays).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Unsupported ops
// ---------------------------------------------------------------------------

describe('NetRefer unsupported operations', () => {
  it('listClicks throws NotImplementedError mentioning the aggregate', async () => {
    await expect(netreferAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await netreferAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('aggregate');
    }
  });

  it('generateTrackingLink throws NotImplementedError', async () => {
    await expect(
      netreferAdapter.generateTrackingLink({ programmeId: 'BR-100', destinationUrl: 'https://x.example.com' }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('listPublishers / listPublisherSectors throw NotImplementedError', async () => {
    await expect(netreferAdapter.listPublishers()).rejects.toBeInstanceOf(NotImplementedError);
    await expect(netreferAdapter.listPublisherSectors()).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('NetRefer.verifyAuth', () => {
  it('returns ok:true when the token exchange succeeds', async () => {
    mockFetchQueue([fakeResponse(loadFixture('token-response.json'))]);
    const r = await netreferAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toContain('netrefer');
  });

  it('surfaces a failure when the token exchange returns 401', async () => {
    mockFetchQueue([fakeResponse('{"error":"invalid_client"}', { status: 401 })]);
    const r = await netreferAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/401|invalid|token/i);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('NetRefer.validateCredential', () => {
  it('rejects an empty / non-URL base URL and accepts a valid one', async () => {
    expect((await netreferAdapter.validateCredential('NETREFER_BASE_URL', '')).ok).toBe(false);
    expect((await netreferAdapter.validateCredential('NETREFER_BASE_URL', 'nope')).ok).toBe(false);
    expect(
      (await netreferAdapter.validateCredential('NETREFER_BASE_URL', 'https://asr.x.netrefer.com')).ok,
    ).toBe(true);
  });

  it('flags whitespace in the client secret as a likely copy/paste error', async () => {
    const r = await netreferAdapter.validateCredential('NETREFER_CLIENT_SECRET', 'has space');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('rejects empty username / password', async () => {
    expect((await netreferAdapter.validateCredential('NETREFER_USERNAME', '')).ok).toBe(false);
    expect((await netreferAdapter.validateCredential('NETREFER_PASSWORD', '')).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim NetRefer response body on a 500', async () => {
    const body = '{"error":"netrefer upstream failure","trace":"def-456"}';
    mockFetchQueue([
      fakeResponse(loadFixture('token-response.json')),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await netreferAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('netrefer');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('netrefer upstream failure');
    }
  });
});

// ---------------------------------------------------------------------------
// manifest
// ---------------------------------------------------------------------------

describe('NetRefer network.json', () => {
  it('conforms to the canonical schema', async () => {
    const { NetworkJsonSchema } = await import('../../../scripts/validate-network-json.js');
    const raw = JSON.parse(
      readFileSync(path.join(process.cwd(), 'src', 'networks', 'netrefer', 'network.json'), 'utf8'),
    );
    const r = NetworkJsonSchema.safeParse(raw);
    expect(r.success).toBe(true);
    if (!r.success) throw new Error(JSON.stringify(r.error.issues, null, 2));
  });
});
