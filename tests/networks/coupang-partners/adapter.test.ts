/**
 * Coupang Partners adapter — unit tests.
 *
 * Pattern-matched to `tests/networks/skimlinks/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - Circuit breakers are reset in `beforeEach` so no test bleeds state.
 *   - Fake credentials are injected via `process.env` (obvious non-secret values).
 *   - Fixtures live under `tests/fixtures/coupang-partners/`.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 *
 * Coupang Partners signs each request afresh (no token cache), so the mock
 * queue holds only data responses — there is no separate token-exchange call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHmac } from 'node:crypto';

import {
  coupangPartnersAdapter,
  _internals,
} from '../../../src/networks/coupang-partners/adapter.js';
import {
  buildAuthorizationHeader,
  formatSignedDate,
} from '../../../src/networks/coupang-partners/auth.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'coupang-partners');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(
  body: unknown,
  init: { status?: number; rawBody?: string } = {},
): Response {
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

const ACCESS_KEY = 'test-access-key-please-ignore';
const SECRET_KEY = 'test-secret-key-please-ignore';

beforeEach(() => {
  _resetBreakers();
  process.env['COUPANG_PARTNERS_ACCESS_KEY'] = ACCESS_KEY;
  process.env['COUPANG_PARTNERS_SECRET_KEY'] = SECRET_KEY;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['COUPANG_PARTNERS_ACCESS_KEY'];
  delete process.env['COUPANG_PARTNERS_SECRET_KEY'];
});

// ---------------------------------------------------------------------------
// HMAC signing — the load-bearing, deterministic core (verified against the
// CEA scheme + public reference clients).
// ---------------------------------------------------------------------------

describe('Coupang Partners HMAC signing', () => {
  it('formats the signed-date as yyMMddTHHmmssZ in GMT', () => {
    const d = new Date('2026-06-04T09:15:07Z');
    expect(formatSignedDate(d)).toBe('260604T091507Z');
  });

  it('builds the Authorization header deterministically for a fixed input + date', () => {
    const signedDate = '260604T091507Z';
    const method = 'GET';
    const reqPath = '/v2/providers/affiliate_open_api/apis/openapi/v1/reports/commission';
    const query = 'startDate=20260604&endDate=20260604&page=0';

    // Independently recompute the expected signature exactly as the docs specify:
    // message = signedDate + METHOD + path + query, HMAC-SHA256 hex keyed by secret.
    const message = `${signedDate}${method}${reqPath}${query}`;
    const expectedSig = createHmac('sha256', SECRET_KEY).update(message).digest('hex');

    const { authorization, signedDate: usedDate } = buildAuthorizationHeader({
      method,
      path: reqPath,
      query,
      accessKey: ACCESS_KEY,
      secretKey: SECRET_KEY,
      signedDate,
    });

    expect(usedDate).toBe(signedDate);
    expect(authorization).toBe(
      `CEA algorithm=HmacSHA256, access-key=${ACCESS_KEY}, signed-date=${signedDate}, signature=${expectedSig}`,
    );
    // Sanity: the header starts with the CEA scheme keyword.
    expect(authorization.startsWith('CEA algorithm=HmacSHA256,')).toBe(true);
  });

  it('produces a different signature when the signed-date changes', () => {
    const base = {
      method: 'GET',
      path: '/v2/providers/affiliate_open_api/apis/openapi/v1/reports/commission',
      query: 'startDate=20260604&endDate=20260604&page=0',
      accessKey: ACCESS_KEY,
      secretKey: SECRET_KEY,
    };
    const a = buildAuthorizationHeader({ ...base, signedDate: '260604T091507Z' });
    const b = buildAuthorizationHeader({ ...base, signedDate: '260604T091508Z' });
    expect(a.authorization).not.toBe(b.authorization);
  });

  it('the client sends the CEA Authorization header on requests', async () => {
    const spy = mockFetchQueue([
      fakeResponse(loadFixture('reports_empty.json')),
    ]);
    await coupangPartnersAdapter.listTransactions({ limit: 1 });
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers['Authorization']).toMatch(/^CEA algorithm=HmacSHA256, access-key=/);
    expect(headers['X-Requested-By']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Transformer unit tests (status normalisation, date parsing, raw preservation)
// ---------------------------------------------------------------------------

describe('Coupang Partners transformers', () => {
  it('normalises every commission row to status "other" (no settlement status in payload)', () => {
    expect(_internals.mapTransactionStatus({ date: '2026-06-01', commission: 100 })).toBe('other');
    expect(_internals.mapTransactionStatus({})).toBe('other');
  });

  it('parses both YYYY-MM-DD and compact YYYYMMDD report dates', () => {
    expect(_internals.parseCoupangDate('2026-06-03')).toBe('2026-06-03T00:00:00.000Z');
    expect(_internals.parseCoupangDate('20260603')).toBe('2026-06-03T00:00:00.000Z');
    expect(_internals.parseCoupangDate(undefined)).toBeUndefined();
    expect(_internals.parseCoupangDate('not-a-date')).toBeUndefined();
  });

  it('normalises string and number amounts', () => {
    expect(_internals.toAmount(16200)).toBe(16200);
    expect(_internals.toAmount('3870')).toBe(3870);
    expect(_internals.toAmount(undefined)).toBe(0);
    expect(_internals.toAmount('not-a-number')).toBe(0);
  });

  it('preserves the raw Coupang row in rawNetworkData', () => {
    const rows = (loadFixture('reports_commission.json') as { data: unknown[] }).data;
    const raw = rows[0] as Record<string, unknown>;
    const out = _internals.toTransaction(raw as never, 0);
    expect(out.rawNetworkData).toBe(raw);
    expect(out.currency).toBe('KRW');
    expect(out.commission).toBe(16200);
    expect(out.amount).toBe(540000);
    expect(out.programmeId).toBe('coupang');
  });

  it('computes ageDays from the report date with an injectable now (§15.9)', () => {
    const now = new Date('2026-06-04T00:00:00Z');
    // 2026-06-01 → 3 days before now.
    expect(_internals.computeAgeDays({ date: '2026-06-01' }, now)).toBe(3);
    // Missing date → 0.
    expect(_internals.computeAgeDays({}, now)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('CoupangPartnersAdapter.listTransactions', () => {
  it('maps commission rows to transactions and page-walks until an empty page', async () => {
    // Page 0 has rows, page 1 is empty → walk stops after 2 calls.
    mockFetchQueue([
      fakeResponse(loadFixture('reports_commission.json')),
      fakeResponse(loadFixture('reports_empty.json')),
    ]);
    const txns = await coupangPartnersAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    expect(txns.length).toBe(3);
    expect(txns.every((t) => t.network === 'coupang-partners')).toBe(true);
    expect(txns.every((t) => t.status === 'other')).toBe(true);
  });

  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('reports_commission.json')),
      fakeResponse(loadFixture('reports_empty.json')),
    ]);
    const aged = await coupangPartnersAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
      minAgeDays: 365,
    });
    expect(aged.length).toBeGreaterThan(0);
    for (const t of aged) {
      expect(t.ageDays).toBeGreaterThanOrEqual(365);
    }
  });

  it('filters by canonical status (only "other" matches; "paid" yields none)', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('reports_commission.json')),
      fakeResponse(loadFixture('reports_empty.json')),
    ]);
    const none = await coupangPartnersAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
      status: ['paid'],
    });
    expect(none.length).toBe(0);

    _resetBreakers();
    mockFetchQueue([
      fakeResponse(loadFixture('reports_commission.json')),
      fakeResponse(loadFixture('reports_empty.json')),
    ]);
    const other = await coupangPartnersAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
      status: 'other',
    });
    expect(other.length).toBe(3);
  });

  it('respects limit after all other filters are applied', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('reports_commission.json')),
      fakeResponse(loadFixture('reports_empty.json')),
    ]);
    const limited = await coupangPartnersAdapter.listTransactions({ limit: 2 });
    expect(limited.length).toBeLessThanOrEqual(2);
  });

  it('emits a NetworkError when COUPANG_PARTNERS_ACCESS_KEY is missing', async () => {
    delete process.env['COUPANG_PARTNERS_ACCESS_KEY'];
    await expect(coupangPartnersAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });

  it('emits a NetworkError when COUPANG_PARTNERS_SECRET_KEY is missing', async () => {
    delete process.env['COUPANG_PARTNERS_SECRET_KEY'];
    await expect(coupangPartnersAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes / getProgramme — not exposed
// ---------------------------------------------------------------------------

describe('CoupangPartnersAdapter.listProgrammes / getProgramme', () => {
  it('listProgrammes throws NotImplementedError (single-merchant network)', async () => {
    await expect(coupangPartnersAdapter.listProgrammes()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    try {
      await coupangPartnersAdapter.listProgrammes();
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('single-merchant');
    }
  });

  it('getProgramme throws NotImplementedError', async () => {
    await expect(coupangPartnersAdapter.getProgramme('coupang')).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });
});

// ---------------------------------------------------------------------------
// listClicks — not exposed
// ---------------------------------------------------------------------------

describe('CoupangPartnersAdapter.listClicks', () => {
  it('throws NotImplementedError with a Coupang-specific reason', async () => {
    await expect(coupangPartnersAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await coupangPartnersAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click-level data');
    }
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — REAL API call
// ---------------------------------------------------------------------------

describe('CoupangPartnersAdapter.generateTrackingLink', () => {
  it('calls the deeplink API and returns the shortenUrl', async () => {
    mockFetchQueue([fakeResponse(loadFixture('deeplink.json'))]);
    const link = await coupangPartnersAdapter.generateTrackingLink({
      programmeId: 'coupang',
      destinationUrl: 'https://www.coupang.com/vp/products/123456789',
    });
    expect(link.network).toBe('coupang-partners');
    expect(link.trackingUrl).toBe('https://link.coupang.com/a/abc123');
    expect(link.destinationUrl).toBe('https://www.coupang.com/vp/products/123456789');
    expect(link.programmeId).toBe('coupang');
  });

  it('POSTs coupangUrls as the request body', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('deeplink.json'))]);
    await coupangPartnersAdapter.generateTrackingLink({
      programmeId: 'coupang',
      destinationUrl: 'https://www.coupang.com/np/categories/1234',
    });
    const init = spy.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.coupangUrls).toEqual(['https://www.coupang.com/np/categories/1234']);
  });

  it('throws config_error when destinationUrl is empty', async () => {
    await expect(
      coupangPartnersAdapter.generateTrackingLink({ programmeId: 'coupang', destinationUrl: '' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws when the deeplink API returns no usable URL', async () => {
    mockFetchQueue([fakeResponse({ rCode: '0', data: [{}] })]);
    await expect(
      coupangPartnersAdapter.generateTrackingLink({
        programmeId: 'coupang',
        destinationUrl: 'https://www.coupang.com/',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws NetworkError when credentials are missing', async () => {
    delete process.env['COUPANG_PARTNERS_SECRET_KEY'];
    await expect(
      coupangPartnersAdapter.generateTrackingLink({
        programmeId: 'coupang',
        destinationUrl: 'https://www.coupang.com/',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary — derived from listTransactions
// ---------------------------------------------------------------------------

describe('CoupangPartnersAdapter.getEarningsSummary', () => {
  it('aggregates commission rows correctly from fixture data', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('reports_commission.json')),
      fakeResponse(loadFixture('reports_empty.json')),
    ]);
    const summary = await coupangPartnersAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    expect(summary.network).toBe('coupang-partners');
    expect(summary.currency).toBe('KRW');
    // 16200 + 3870 + 0
    expect(summary.totalEarnings).toBeCloseTo(20070, 2);
    // Every row is 'other'.
    expect(summary.byStatus.other).toBeCloseTo(20070, 2);
    expect(summary.byStatus.pending).toBe(0);
    expect(summary.byStatus.paid).toBe(0);
    // Single merchant → one programme bucket.
    expect(summary.byProgramme.length).toBe(1);
    expect(summary.byProgramme[0]?.programmeId).toBe('coupang');
  });

  it('does not invent an unpaid age (Coupang exposes no settlement status)', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('reports_commission.json')),
      fakeResponse(loadFixture('reports_empty.json')),
    ]);
    const summary = await coupangPartnersAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    expect(summary.oldestUnpaidAgeDays).toBeUndefined();
  });

  it('returns an empty summary when no rows match the window', async () => {
    mockFetchQueue([fakeResponse(loadFixture('reports_empty.json'))]);
    const summary = await coupangPartnersAdapter.getEarningsSummary({});
    expect(summary.totalEarnings).toBe(0);
    expect(summary.byProgramme).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth — happy + failure paths
// ---------------------------------------------------------------------------

describe('CoupangPartnersAdapter.verifyAuth', () => {
  it('returns ok:true and identity when the signed report call succeeds', async () => {
    mockFetchQueue([fakeResponse(loadFixture('reports_empty.json'))]);
    const r = await coupangPartnersAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('coupang-partners/access-key:');
    }
  });

  it('returns ok:false (does not throw) on a 401', async () => {
    mockFetchQueue([fakeResponse('Unauthorized', { status: 401, rawBody: 'Unauthorized' })]);
    await expect(coupangPartnersAdapter.verifyAuth()).resolves.toMatchObject({ ok: false });
  });

  it('returns ok:false when credentials are missing', async () => {
    delete process.env['COUPANG_PARTNERS_ACCESS_KEY'];
    const r = await coupangPartnersAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('CoupangPartnersAdapter.validateCredential', () => {
  it('accepts a non-empty Access Key without an API call', async () => {
    const r = await coupangPartnersAdapter.validateCredential(
      'COUPANG_PARTNERS_ACCESS_KEY',
      'some-access-key',
    );
    expect(r.ok).toBe(true);
  });

  it('rejects an empty Access Key', async () => {
    const r = await coupangPartnersAdapter.validateCredential('COUPANG_PARTNERS_ACCESS_KEY', '');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('validates the Secret Key via a live signed call', async () => {
    mockFetchQueue([fakeResponse(loadFixture('reports_empty.json'))]);
    const r = await coupangPartnersAdapter.validateCredential(
      'COUPANG_PARTNERS_SECRET_KEY',
      'some-secret-key',
    );
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with a hint when the Secret Key is rejected', async () => {
    mockFetchQueue([fakeResponse('Unauthorized', { status: 401, rawBody: 'Unauthorized' })]);
    const r = await coupangPartnersAdapter.validateCredential(
      'COUPANG_PARTNERS_SECRET_KEY',
      'bad-secret',
    );
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('returns ok:false for unknown credential fields', async () => {
    const r = await coupangPartnersAdapter.validateCredential('COUPANG_PARTNERS_UNKNOWN', 'x');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim response body on a 500', async () => {
    const body = '{"rCode":"ERROR","rMessage":"upstream exploded"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await coupangPartnersAdapter.listTransactions({});
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('coupang-partners');
      expect(env.operation).toBe('listTransactions');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream exploded');
    }
  });

  it('classifies a 429 as rate_limit (§strict rate limits)', async () => {
    // 429 is retried per the shared policy; exhaust the retries.
    const body = '{"rCode":"ERROR","rMessage":"too many requests"}';
    mockFetchQueue([
      fakeResponse(body, { status: 429, rawBody: body }),
      fakeResponse(body, { status: 429, rawBody: body }),
      fakeResponse(body, { status: 429, rawBody: body }),
    ]);
    try {
      await coupangPartnersAdapter.listTransactions({});
      throw new Error('expected to throw');
    } catch (err) {
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('rate_limit');
    }
  });

  it('classifies a 401 as auth_error', async () => {
    mockFetchQueue([fakeResponse('Forbidden', { status: 401, rawBody: 'Forbidden' })]);
    try {
      await coupangPartnersAdapter.listTransactions({});
      throw new Error('expected to throw');
    } catch (err) {
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('auth_error');
    }
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('CoupangPartnersAdapter.capabilitiesCheck', () => {
  it('records listProgrammes, getProgramme, listClicks as not supported', async () => {
    // Probes: verifyAuth (1 call), listTransactions (data + empty page = 2 calls),
    // getEarningsSummary → listTransactions (data + empty page = 2 calls),
    // generateTrackingLink (1 call).
    mockFetchQueue([
      fakeResponse(loadFixture('reports_empty.json')), // verifyAuth
      fakeResponse(loadFixture('reports_empty.json')), // listTransactions page 0 (empty)
      fakeResponse(loadFixture('reports_empty.json')), // getEarningsSummary → listTransactions page 0
      fakeResponse(loadFixture('deeplink.json')), // generateTrackingLink
    ]);
    const caps = await coupangPartnersAdapter.capabilitiesCheck();
    expect(caps.network).toBe('coupang-partners');
    expect(caps.operations['listProgrammes']?.supported).toBe(false);
    expect(caps.operations['getProgramme']?.supported).toBe(false);
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['verifyAuth']?.supported).toBe(true);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(true);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
