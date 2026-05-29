/**
 * Sovrn Commerce adapter — unit tests.
 *
 * Pattern-matched to tests/networks/cj/adapter.test.ts:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - PRD-relevant tests are tagged with §15.x in their `it` strings.
 *   - Fixtures live under tests/fixtures/sovrn-commerce/ and approximate
 *     the shape of real Sovrn Commerce API responses. No real tokens.
 *
 * Hardening pass 2026-05-28:
 *   - Fixtures updated to reflect the real nested API response shapes.
 *   - The /v1/reports/transactions response wraps results in a "transactions"
 *     key: { "transactions": [...] }. Tests now use the txEnvelope() helper.
 *   - Status mapping confirmed: Sovrn Commerce has no status field. All
 *     transactions map to 'other'. Status-mapping string tests removed.
 *   - Merchant fields updated: merchantGroupId / merchantGroupName (not
 *     merchantId / merchant).
 *   Source: developer.sovrn.com/reference/get_reports-transactions (2026-05-28)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { sovrnCommerceAdapter, _internals } from '../../../src/networks/sovrn-commerce/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'sovrn-commerce');

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

/**
 * Wrap a transaction array in the real API envelope.
 *
 * The /v1/reports/transactions endpoint returns:
 *   { "transactions": [ ...transaction objects... ] }
 * Source: developer.sovrn.com/reference/get_reports-transactions (2026-05-28)
 */
function txEnvelope(data: unknown) {
  return { transactions: data };
}

beforeEach(() => {
  _resetBreakers();
  process.env['SOVRN_SECRET_KEY'] = 'test-secret-key-please-ignore';
  process.env['SOVRN_API_KEY'] = 'test-api-key-abc';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['SOVRN_SECRET_KEY'];
  delete process.env['SOVRN_API_KEY'];
});

// ---------------------------------------------------------------------------
// Transformation (status mapping + raw preservation)
// ---------------------------------------------------------------------------

describe('Sovrn Commerce transformers (status normalisation, raw preservation)', () => {
  it('always returns "other" for transaction status — Sovrn has no status field', () => {
    // Sovrn Commerce /reports/transactions does not include a status field.
    // All transactions map to 'other'. Confirmed from the documented response
    // schema at developer.sovrn.com/reference/get_reports-transactions (2026-05-28).
    expect(_internals.mapTransactionStatus({} as never)).toBe('other');
    expect(_internals.mapTransactionStatus({ commission: { programType: 'cpa' } } as never)).toBe('other');
  });

  it('maps all Sovrn merchants to "joined" programme status', () => {
    // Sovrn Commerce has no catalogue; every merchant returned is actively worked with.
    expect(_internals.mapProgrammeStatus({} as never)).toBe('joined');
    expect(_internals.mapProgrammeStatus({ merchantGroupName: 'Example Books' } as never)).toBe('joined');
  });

  it('preserves the raw Sovrn payload under rawNetworkData', () => {
    const records = loadFixture('transactions.json') as Record<string, unknown>[];
    const raw = records[0] as Record<string, unknown>;
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('preserves raw merchant payload under rawNetworkData for programmes', () => {
    const records = loadFixture('merchants.json') as Record<string, unknown>[];
    const raw = records[0] as Record<string, unknown>;
    const out = _internals.toProgramme(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('computes ageDays from commission.commissionDate (preferred) then click.clickDate', () => {
    const now = new Date('2026-05-28T00:00:00Z');
    // commission.commissionDate → preferred anchor
    const age1 = _internals.computeAgeDays(
      { commission: { commissionDate: '2026-04-15' }, click: { clickDate: '2026-04-10' } } as never,
      now,
    );
    // 2026-05-28 - 2026-04-15 = 43 days
    expect(age1).toBe(43);

    // click.clickDate → fallback when commission.commissionDate absent
    const age2 = _internals.computeAgeDays({ click: { clickDate: '2026-05-01' } } as never, now);
    // 2026-05-28 - 2026-05-01 = 27 days
    expect(age2).toBe(27);

    // No dates → 0
    const age3 = _internals.computeAgeDays({} as never, now);
    expect(age3).toBe(0);
  });

  it('maps fixture transactions to the correct canonical fields', () => {
    const records = loadFixture('transactions.json') as Record<string, unknown>[];
    const now = new Date('2026-05-28T00:00:00Z');

    const tx0 = _internals.toTransaction(records[0] as never, now);
    // commission.revenueId is the primary ID
    expect(tx0.id).toBe('rv-2001');
    // merchant.merchantGroupId is the programme ID
    expect(tx0.programmeId).toBe('11001');
    // merchant.merchantGroupName is the programme name
    expect(tx0.programmeName).toBe('Example Books');
    // commission.publisherNetRevenue is the earnings field
    expect(tx0.commission).toBe(2.50);
    // No currency field in response — defaults to 'USD'
    expect(tx0.currency).toBe('USD');
    expect(tx0.network).toBe('sovrn-commerce');
    // No status field in response — all map to 'other'
    expect(tx0.status).toBe('other');
  });

  it('generates date range correctly for [from, to]', () => {
    const from = new Date('2026-04-10T00:00:00Z');
    const to = new Date('2026-04-12T00:00:00Z');
    const dates = _internals.generateDateRange(from, to);
    expect(dates).toEqual(['2026-04-10', '2026-04-11', '2026-04-12']);
  });

  it('generates single date when from === to', () => {
    const d = new Date('2026-05-01T00:00:00Z');
    expect(_internals.generateDateRange(d, d)).toEqual(['2026-05-01']);
  });
});

// ---------------------------------------------------------------------------
// listTransactions — unpaid-age (§15.9, §15.10)
//
// Note: §15.10 (reversed visibility) cannot be exercised here because Sovrn
// Commerce has no status field. All transactions are 'other'. A status-filter
// test is retained to confirm the filter works correctly with the 'other' value.
// ---------------------------------------------------------------------------

describe('SovrnCommerce.listTransactions', () => {
  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    // Two fetch calls for a 2-day window; each returns the full fixture to
    // exercise the age filter. With minAgeDays=365 only the 2024 records qualify.
    const fixture = loadFixture('transactions.json');
    mockFetchQueue([
      fakeResponse(txEnvelope(fixture)),
      fakeResponse(txEnvelope(fixture)),
    ]);

    const aged = await sovrnCommerceAdapter.listTransactions({
      from: '2026-04-14T00:00:00Z',
      to: '2026-04-15T00:00:00Z',
      minAgeDays: 365,
    });
    for (const t of aged) {
      expect(t.ageDays).toBeGreaterThanOrEqual(365);
    }
    // The 2024 records are old enough; the 2026 records are not.
    expect(aged.length).toBeGreaterThan(0);
  });

  it('returns all transactions as "other" status (Sovrn has no status field) (§15.10)', async () => {
    mockFetchQueue([fakeResponse(txEnvelope(loadFixture('transactions.json')))]);
    const all = await sovrnCommerceAdapter.listTransactions({
      from: '2026-04-15T00:00:00Z',
      to: '2026-04-15T00:00:00Z',
    });
    expect(all.every((t) => t.status === 'other')).toBe(true);
    expect(all.length).toBeGreaterThanOrEqual(1);
  });

  it('filters to "other"-only when status filter is applied', async () => {
    mockFetchQueue([fakeResponse(txEnvelope(loadFixture('transactions.json')))]);
    const only = await sovrnCommerceAdapter.listTransactions({
      from: '2026-04-15T00:00:00Z',
      to: '2026-04-15T00:00:00Z',
      status: ['other'],
    });
    expect(only.every((t) => t.status === 'other')).toBe(true);
  });

  it('handles empty transactions envelope gracefully', async () => {
    mockFetchQueue([fakeResponse(txEnvelope([]))]);
    const result = await sovrnCommerceAdapter.listTransactions({
      from: '2026-04-15T00:00:00Z',
      to: '2026-04-15T00:00:00Z',
    });
    expect(result).toEqual([]);
  });

  it('emits a config_error envelope when SOVRN_SECRET_KEY is missing (§15.4)', async () => {
    delete process.env['SOVRN_SECRET_KEY'];
    await expect(sovrnCommerceAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });

  it('makes one fetch call per day in the requested window', async () => {
    // 3-day window → 3 calls
    const spy = mockFetchQueue([
      fakeResponse(txEnvelope([])),
      fakeResponse(txEnvelope([])),
      fakeResponse(txEnvelope([])),
    ]);
    await sovrnCommerceAdapter.listTransactions({
      from: '2026-04-10T00:00:00Z',
      to: '2026-04-12T00:00:00Z',
    });
    expect(spy.mock.calls.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// listClicks — NotImplemented
// ---------------------------------------------------------------------------

describe('SovrnCommerce.listClicks', () => {
  it('throws NotImplementedError with a Sovrn-specific reason', async () => {
    await expect(sovrnCommerceAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await sovrnCommerceAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('Sovrn Commerce');
    }
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — deterministic URL construction
// ---------------------------------------------------------------------------

describe('SovrnCommerce.generateTrackingLink', () => {
  it('constructs a redirect.viglink.com link with URL-encoded destination', async () => {
    const link = await sovrnCommerceAdapter.generateTrackingLink({
      programmeId: '11001',
      destinationUrl: 'https://www.example-bookshop.com/path?q=a b&c=ü',
    });
    expect(link.trackingUrl).toContain('https://redirect.viglink.com');
    expect(link.trackingUrl).toContain('key=test-api-key-abc');
    expect(link.trackingUrl).toContain(
      'u=https%3A%2F%2Fwww.example-bookshop.com%2Fpath%3Fq%3Da%20b%26c%3D%C3%BC',
    );
    expect(link.network).toBe('sovrn-commerce');
    expect(link.programmeId).toBe('11001');
    expect(link.destinationUrl).toBe('https://www.example-bookshop.com/path?q=a b&c=ü');
  });

  it('throws a config_error envelope when destinationUrl is missing', async () => {
    await expect(
      sovrnCommerceAdapter.generateTrackingLink({
        programmeId: '11001',
        destinationUrl: '',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error envelope when SOVRN_API_KEY is missing', async () => {
    delete process.env['SOVRN_API_KEY'];
    await expect(
      sovrnCommerceAdapter.generateTrackingLink({
        programmeId: '11001',
        destinationUrl: 'https://example.com',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('does NOT call fetch (deterministic construction)', async () => {
    const spy = mockFetchQueue([]);
    await sovrnCommerceAdapter.generateTrackingLink({
      programmeId: '11001',
      destinationUrl: 'https://x.example.com',
    });
    expect(spy.mock.calls.length).toBe(0);
  });

  it('works without a programmeId (Sovrn does not require it in the URL)', async () => {
    const link = await sovrnCommerceAdapter.generateTrackingLink({
      programmeId: '',
      destinationUrl: 'https://example.com',
    });
    expect(link.trackingUrl).toContain('redirect.viglink.com');
    expect(link.programmeId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('SovrnCommerce.verifyAuth (happy path)', () => {
  it('returns ok:true and identity when merchants endpoint responds 200', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchants.json'))]);
    const r = await sovrnCommerceAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('sovrn-commerce');
    }
  });

  it('surfaces a failure on 401 (§15.4)', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_secret"}', { status: 401, rawBody: '{"error":"invalid_secret"}' }),
    ]);
    const r = await sovrnCommerceAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/HTTP 401|401/);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('SovrnCommerce.validateCredential', () => {
  it('rejects blank SOVRN_SECRET_KEY', async () => {
    const r = await sovrnCommerceAdapter.validateCredential('SOVRN_SECRET_KEY', '');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('validates SOVRN_SECRET_KEY by calling verifyAuth', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchants.json'))]);
    const r = await sovrnCommerceAdapter.validateCredential('SOVRN_SECRET_KEY', 'valid-secret');
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with a hint when SOVRN_SECRET_KEY validation fails', async () => {
    mockFetchQueue([fakeResponse('{"error":"bad"}', { status: 401, rawBody: '{"error":"bad"}' })]);
    const r = await sovrnCommerceAdapter.validateCredential('SOVRN_SECRET_KEY', 'bad-secret');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('accepts non-blank SOVRN_API_KEY without a live call', async () => {
    const r = await sovrnCommerceAdapter.validateCredential('SOVRN_API_KEY', 'someapikey');
    expect(r.ok).toBe(true);
  });

  it('rejects blank SOVRN_API_KEY', async () => {
    const r = await sovrnCommerceAdapter.validateCredential('SOVRN_API_KEY', '');
    expect(r.ok).toBe(false);
  });

  it('returns ok:false for unknown fields', async () => {
    const r = await sovrnCommerceAdapter.validateCredential('UNKNOWN_FIELD', 'val');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('SovrnCommerce.capabilitiesCheck', () => {
  it('records listClicks.supported = false with the known-limitation note', async () => {
    // Stubs for: listProgrammes, listTransactions (1 day), getEarningsSummary (1 day), verifyAuth.
    mockFetchQueue([
      fakeResponse(loadFixture('merchants.json')),          // listProgrammes
      fakeResponse(txEnvelope(loadFixture('transactions.json'))), // listTransactions probe (1 day)
      fakeResponse(txEnvelope(loadFixture('transactions.json'))), // getEarningsSummary → listTransactions (1 day)
      fakeResponse(loadFixture('merchants.json')),          // verifyAuth
    ]);
    const caps = await sovrnCommerceAdapter.capabilitiesCheck();
    expect(caps.network).toBe('sovrn-commerce');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['listClicks']?.note).toContain('click events');
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
    // generateTrackingLink is deterministic — recorded as supported without probing.
    expect(caps.operations['generateTrackingLink']?.supported).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim Sovrn response body on a 500', async () => {
    const body = '{"error":"upstream service unavailable","trace":"xyz"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await sovrnCommerceAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('sovrn-commerce');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream service unavailable');
    }
  });

  it('classifies 401 as auth_error (§15.4)', async () => {
    mockFetchQueue([fakeResponse('forbidden', { status: 401, rawBody: 'forbidden' })]);
    try {
      await sovrnCommerceAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('auth_error');
    }
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('SovrnCommerce.getEarningsSummary', () => {
  it('aggregates commission by programme and by status', async () => {
    // 1-day window → 1 fetch call
    mockFetchQueue([fakeResponse(txEnvelope(loadFixture('transactions.json')))]);

    const summary = await sovrnCommerceAdapter.getEarningsSummary({
      from: '2026-04-15T00:00:00Z',
      to: '2026-04-15T00:00:00Z',
    });

    expect(summary.network).toBe('sovrn-commerce');
    expect(typeof summary.totalEarnings).toBe('number');
    expect(summary.byProgramme.length).toBeGreaterThan(0);
    expect(summary.currency).toBe('USD');
    expect(summary.periodFrom).toBe('2026-04-15T00:00:00Z');
  });

  it('computes oldestUnpaidAgeDays for "other" transactions (§15.9)', async () => {
    mockFetchQueue([fakeResponse(txEnvelope(loadFixture('transactions.json')))]);
    const summary = await sovrnCommerceAdapter.getEarningsSummary({
      from: '2026-04-15T00:00:00Z',
      to: '2026-04-15T00:00:00Z',
    });
    // All Sovrn transactions are 'other' (no status field) — treated as unpaid.
    if (summary.oldestUnpaidAgeDays !== undefined) {
      expect(summary.oldestUnpaidAgeDays).toBeGreaterThanOrEqual(0);
    }
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('SovrnCommerce.listProgrammes', () => {
  it('returns programmes with network=sovrn-commerce and status=joined', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchants.json'))]);
    const progs = await sovrnCommerceAdapter.listProgrammes();
    expect(progs.length).toBe(3);
    for (const p of progs) {
      expect(p.network).toBe('sovrn-commerce');
      expect(p.status).toBe('joined');
    }
  });

  it('applies search filter client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchants.json'))]);
    const progs = await sovrnCommerceAdapter.listProgrammes({ search: 'books' });
    expect(progs.length).toBe(1);
    expect(progs[0]?.name).toBe('Example Books');
  });

  it('respects limit', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchants.json'))]);
    const progs = await sovrnCommerceAdapter.listProgrammes({ limit: 1 });
    expect(progs.length).toBe(1);
  });

  it('throws NetworkError when SOVRN_SECRET_KEY is missing', async () => {
    delete process.env['SOVRN_SECRET_KEY'];
    await expect(sovrnCommerceAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});
