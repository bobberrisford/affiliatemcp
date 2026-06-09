/**
 * Involve Asia adapter — unit tests.
 *
 * Notes for future contributors:
 *   - Involve Asia routes EVERY data call through a token-cache layer (key +
 *     secret → short-lived bearer token). Tests that hit a data endpoint must
 *     therefore queue a token-exchange (`/authenticate`) response in front of
 *     the data response(s). We mock `globalThis.fetch` directly — the same seam
 *     the Awin and Rakuten tests use.
 *   - Data endpoints are page-based. A single-page fixture sets
 *     `data.nextPage: null` so `pageThrough` stops after one call.
 *   - listTransactions chunks the window into <=31-day slices. Tests that
 *     exercise the fetch path use a single <=31-day window so exactly one
 *     conversion-report call is issued per token exchange.
 *   - No live calls: every fetch is mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { involveAsiaAdapter, _internals } from '../../../src/networks/involve-asia/adapter.js';
import { _resetTokenCache } from '../../../src/networks/involve-asia/auth.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';
import { NetworkJsonSchema } from '../../../scripts/validate-network-json.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'networks', 'involve-asia', 'fixtures');

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

type ConversionRow = Record<string, unknown>;
function conversionRows(): ConversionRow[] {
  return ((loadFixture('conversions.json') as { data: { data: ConversionRow[] } }).data.data);
}

beforeEach(() => {
  _resetBreakers();
  _resetTokenCache();
  process.env['INVOLVE_ASIA_API_KEY'] = 'test-key';
  process.env['INVOLVE_ASIA_API_SECRET'] = 'test-secret';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['INVOLVE_ASIA_API_KEY'];
  delete process.env['INVOLVE_ASIA_API_SECRET'];
});

// ---------------------------------------------------------------------------
// Transformers (pure — no fetch)
// ---------------------------------------------------------------------------

describe('Involve Asia transformers (status normalisation, raw preservation)', () => {
  it('maps approved|pending|rejected|paid → canonical statuses', () => {
    const rows = conversionRows();
    expect(_internals.toTransaction(rows[0] as never).status).toBe('approved');
    expect(_internals.toTransaction(rows[1] as never).status).toBe('pending');
    expect(_internals.toTransaction(rows[2] as never).status).toBe('reversed'); // rejected
    expect(_internals.toTransaction(rows[3] as never).status).toBe('paid');
  });

  it('maps an unknown conversion status to "other" rather than guessing', () => {
    expect(_internals.mapTransactionStatus({ conversion_status: 'frozen' } as never)).toBe('other');
  });

  it('preserves the raw conversion under rawNetworkData', () => {
    const raw = conversionRows()[0];
    expect(_internals.toTransaction(raw as never).rawNetworkData).toBe(raw);
  });

  it('surfaces reversalReason on rejected conversions (§15.10)', () => {
    const out = _internals.toTransaction(conversionRows()[2] as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Order cancelled by customer');
  });

  it('parses amounts as major currency units (sale_amount / payout)', () => {
    const out = _internals.toTransaction(conversionRows()[0] as never);
    expect(out.amount).toBeCloseTo(120.5);
    expect(out.commission).toBeCloseTo(9.64);
    expect(out.currency).toBe('MYR');
  });

  it('parseAmount tolerates thousands separators and non-numeric input', () => {
    expect(_internals.parseAmount('1,234.56')).toBeCloseTo(1234.56);
    expect(_internals.parseAmount(undefined)).toBe(0);
    expect(_internals.parseAmount('n/a')).toBe(0);
  });

  it('maps offer status → canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ status: 'active' } as never)).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'paused' } as never)).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'pending' } as never)).toBe('pending');
    expect(_internals.mapProgrammeStatus({ status: 'mystery' } as never)).toBe('unknown');
  });

  it('computes ageDays from datetime_validated (preferred) or datetime_conversion', () => {
    const now = new Date('2026-05-21T00:00:00Z');
    expect(_internals.computeAgeDays({ datetime_validated: '2026-01-20T00:00:00Z' } as never, now)).toBe(121);
    expect(_internals.computeAgeDays({ datetime_conversion: '2026-05-01T00:00:00Z' } as never, now)).toBe(20);
  });

  it('formats conversion dates as YYYY-MM-DD', () => {
    expect(_internals.formatDate(new Date('2026-05-21T15:30:00Z'))).toBe('2026-05-21');
  });

  it('chunks a wide date range into <=31-day slices', () => {
    const slices = _internals.chunkDateRange(
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-04-01T00:00:00Z'),
      31,
    );
    expect(slices.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Token exchange — happy path, reuse, 401 refresh + retry
// ---------------------------------------------------------------------------

describe('Involve Asia token cache', () => {
  it('exchanges key+secret for a token on first call, then reuses it', async () => {
    const spy = mockFetchQueue([
      fakeResponse(loadFixture('authenticate.json')),
      fakeResponse(loadFixture('offers.json')),
      fakeResponse(loadFixture('offers.json')),
    ]);

    await involveAsiaAdapter.listProgrammes({ limit: 1 });
    await involveAsiaAdapter.listProgrammes({ limit: 1 });

    // 1 token exchange + 2 data calls (token reused on the second).
    expect(spy.mock.calls.length).toBe(3);
    expect(String(spy.mock.calls[0]?.[0])).toContain('/authenticate');

    const dataInit = spy.mock.calls[1]?.[1] as RequestInit;
    const auth = (dataInit?.headers as Record<string, string>)?.['Authorization'];
    expect(auth).toBe('Bearer fake-involve-asia-token-AAA111');
  });

  it('sends key+secret form-encoded to the authenticate endpoint', async () => {
    const spy = mockFetchQueue([
      fakeResponse(loadFixture('authenticate.json')),
      fakeResponse(loadFixture('offers.json')),
    ]);
    await involveAsiaAdapter.listProgrammes({ limit: 1 });
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    expect(String(init.body)).toContain('key=test-key');
    expect(String(init.body)).toContain('secret=test-secret');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
  });

  it('on 401 from a data endpoint, refreshes token and retries once', async () => {
    const spy = mockFetchQueue([
      // Initial token exchange.
      fakeResponse(loadFixture('authenticate.json')),
      // First data call → 401 (token expired early).
      fakeResponse('{"error":"token_expired"}', { status: 401 }),
      // Forced refresh returns a fresh token.
      fakeResponse({ status: 'success', data: { token: 'involve-fresh-token-BBB222' } }),
      // Retried data call succeeds.
      fakeResponse(loadFixture('offers.json')),
    ]);

    const out = await involveAsiaAdapter.listProgrammes({ limit: 1 });
    expect(out.length).toBeGreaterThan(0);

    // 4 calls: token, 401, refresh, retry.
    expect(spy.mock.calls.length).toBe(4);
    const retryInit = spy.mock.calls[3]?.[1] as RequestInit;
    const auth = (retryInit?.headers as Record<string, string>)?.['Authorization'];
    expect(auth).toBe('Bearer involve-fresh-token-BBB222');
  });

  it('two consecutive 401s surface as a NetworkError', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('authenticate.json')),
      fakeResponse('{"error":"invalid"}', { status: 401 }),
      fakeResponse(loadFixture('authenticate.json')),
      fakeResponse('{"error":"invalid"}', { status: 401 }),
    ]);
    await expect(involveAsiaAdapter.listProgrammes({ limit: 1 })).rejects.toBeInstanceOf(
      NetworkError,
    );
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('Involve Asia.listProgrammes', () => {
  it('maps offers to programmes and applies a search filter', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('authenticate.json')),
      fakeResponse(loadFixture('offers.json')),
    ]);
    const out = await involveAsiaAdapter.listProgrammes({ search: 'shopee' });
    expect(out.length).toBe(1);
    expect(out[0]?.name).toBe('Shopee Malaysia');
    expect(out[0]?.network).toBe('involve-asia');
    expect(out[0]?.status).toBe('joined');
  });

  it('respects limit', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('authenticate.json')),
      fakeResponse(loadFixture('offers.json')),
    ]);
    const out = await involveAsiaAdapter.listProgrammes({ limit: 2 });
    expect(out.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// getProgramme
// ---------------------------------------------------------------------------

describe('Involve Asia.getProgramme', () => {
  it('selects an offer by id', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('authenticate.json')),
      fakeResponse(loadFixture('offers.json')),
    ]);
    const p = await involveAsiaAdapter.getProgramme('7002');
    expect(p.name).toBe('Lazada Singapore');
    expect(p.status).toBe('suspended');
  });

  it('throws a config_error envelope for an empty id', async () => {
    await expect(involveAsiaAdapter.getProgramme('')).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a network_api_error envelope for an unknown id', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('authenticate.json')),
      fakeResponse(loadFixture('offers.json')),
    ]);
    await expect(involveAsiaAdapter.getProgramme('999999')).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('Involve Asia.listTransactions', () => {
  it('fetches conversions for a single <=31-day window (one report call)', async () => {
    const spy = mockFetchQueue([
      fakeResponse(loadFixture('authenticate.json')),
      fakeResponse(loadFixture('conversions.json')),
    ]);
    const out = await involveAsiaAdapter.listTransactions({
      from: '2026-04-01T00:00:00Z',
      to: '2026-04-20T00:00:00Z',
    });
    expect(out.length).toBe(4);
    // token + one conversions call.
    expect(spy.mock.calls.length).toBe(2);
    expect(String(spy.mock.calls[1]?.[0])).toContain('/conversions/range');
  });

  it('filters by status', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('authenticate.json')),
      fakeResponse(loadFixture('conversions.json')),
    ]);
    const only = await involveAsiaAdapter.listTransactions({
      from: '2026-04-01T00:00:00Z',
      to: '2026-04-20T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.length).toBe(1);
    expect(only[0]?.reversalReason).toBe('Order cancelled by customer');
  });

  it('filters by programmeId', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('authenticate.json')),
      fakeResponse(loadFixture('conversions.json')),
    ]);
    const only = await involveAsiaAdapter.listTransactions({
      from: '2026-04-01T00:00:00Z',
      to: '2026-04-20T00:00:00Z',
      programmeId: '7001',
    });
    expect(only.every((t) => t.programmeId === '7001')).toBe(true);
    expect(only.length).toBe(2);
  });

  it('issues one conversion-report call per 31-day slice', async () => {
    const spy = mockFetchQueue([
      fakeResponse(loadFixture('authenticate.json')),
      // Three slices for a ~90-day window — each returns a single empty page.
      fakeResponse({ status: 'success', data: { nextPage: null, data: [] } }),
      fakeResponse({ status: 'success', data: { nextPage: null, data: [] } }),
      fakeResponse({ status: 'success', data: { nextPage: null, data: [] } }),
    ]);
    await involveAsiaAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-04-01T00:00:00Z',
    });
    // 1 token exchange + 3 slice calls.
    expect(spy.mock.calls.length).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('Involve Asia.getEarningsSummary', () => {
  it('aggregates by status and surfaces oldestUnpaidAgeDays', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('authenticate.json')),
      fakeResponse(loadFixture('conversions.json')),
    ]);
    const summary = await involveAsiaAdapter.getEarningsSummary({
      from: '2026-04-01T00:00:00Z',
      to: '2026-04-20T00:00:00Z',
    });
    expect(summary.network).toBe('involve-asia');
    expect(summary.byStatus.approved).toBeCloseTo(9.64);
    expect(summary.byStatus.pending).toBeCloseTo(3.6);
    expect(summary.byStatus.paid).toBeCloseTo(6.0);
    expect(summary.byStatus.reversed).toBeCloseTo(10.0);
    // pending + approved present → oldestUnpaidAgeDays defined.
    expect(summary.oldestUnpaidAgeDays).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// listClicks — unsupported
// ---------------------------------------------------------------------------

describe('Involve Asia.listClicks', () => {
  it('throws NotImplementedError with the documented reason', async () => {
    await expect(involveAsiaAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await involveAsiaAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click-level data');
    }
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — API round-trip
// ---------------------------------------------------------------------------

describe('Involve Asia.generateTrackingLink', () => {
  it('mints a link via POST /offers/links and returns the tracking URL', async () => {
    const spy = mockFetchQueue([
      fakeResponse(loadFixture('authenticate.json')),
      fakeResponse(loadFixture('tracking-link.json')),
    ]);
    const link = await involveAsiaAdapter.generateTrackingLink({
      programmeId: '7001',
      destinationUrl: 'https://shopee.com.my/product',
    });
    expect(link.trackingUrl).toContain('invol.co');
    expect(link.programmeId).toBe('7001');
    expect(link.network).toBe('involve-asia');
    expect(String(spy.mock.calls[1]?.[0])).toContain('/offers/links');
    const init = spy.mock.calls[1]?.[1] as RequestInit;
    expect(String(init.body)).toContain('offer_id=7001');
  });

  it('throws a config_error envelope when programmeId is missing', async () => {
    await expect(
      involveAsiaAdapter.generateTrackingLink({
        programmeId: '',
        destinationUrl: 'https://x.example.com',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error envelope when destinationUrl is missing', async () => {
    await expect(
      involveAsiaAdapter.generateTrackingLink({ programmeId: '7001', destinationUrl: '' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('Involve Asia.verifyAuth', () => {
  it('returns ok:true when the token exchange succeeds', async () => {
    mockFetchQueue([fakeResponse(loadFixture('authenticate.json'))]);
    const r = await involveAsiaAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toContain('involve-asia');
  });

  it('surfaces a failure when the authenticate call returns 401', async () => {
    mockFetchQueue([fakeResponse('{"error":"invalid_credentials"}', { status: 401 })]);
    const r = await involveAsiaAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/401|invalid|token/i);
  });

  it('surfaces a failure when authenticate returns 200 with no token', async () => {
    mockFetchQueue([fakeResponse({ status: 'success', data: {} })]);
    const r = await involveAsiaAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('Involve Asia.validateCredential', () => {
  it('rejects an empty API key', async () => {
    const r = await involveAsiaAdapter.validateCredential('INVOLVE_ASIA_API_KEY', '');
    expect(r.ok).toBe(false);
  });

  it('flags whitespace in the key as a likely copy/paste error', async () => {
    const r = await involveAsiaAdapter.validateCredential('INVOLVE_ASIA_API_KEY', 'has space');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('runs the full exchange when the secret is entered', async () => {
    mockFetchQueue([fakeResponse(loadFixture('authenticate.json'))]);
    const r = await involveAsiaAdapter.validateCredential('INVOLVE_ASIA_API_SECRET', 'good-secret');
    expect(r.ok).toBe(true);
  });

  it('rejects an unknown credential field', async () => {
    const r = await involveAsiaAdapter.validateCredential('NOPE', 'x');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim Involve Asia response body on a 500', async () => {
    const body = '{"error":"involve upstream failure","trace":"abc-123"}';
    mockFetchQueue([
      fakeResponse(loadFixture('authenticate.json')),
      // 500s — the resilience layer retries up to the configured count.
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await involveAsiaAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('involve-asia');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('involve upstream failure');
    }
  });
});

// ---------------------------------------------------------------------------
// network.json schema conformance
// ---------------------------------------------------------------------------

describe('Involve Asia network.json', () => {
  it('conforms to the canonical schema', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'src', 'networks', 'involve-asia', 'network.json'),
        'utf8',
      ),
    );
    const r = NetworkJsonSchema.safeParse(raw);
    expect(r.success).toBe(true);
    if (!r.success) throw new Error(JSON.stringify(r.error.issues, null, 2));
  });

  it('declares the publisher / single-brand / custom / experimental contract', () => {
    const raw = JSON.parse(
      readFileSync(
        path.join(process.cwd(), 'src', 'networks', 'involve-asia', 'network.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(raw['side']).toBe('publisher');
    expect(raw['credential_scope']).toBe('single-brand');
    expect(raw['auth_model']).toBe('custom');
    expect(raw['claim_status']).toBe('experimental');
    expect(raw['env_vars']).toEqual(['INVOLVE_ASIA_API_KEY', 'INVOLVE_ASIA_API_SECRET']);
  });
});
