/**
 * financeAds adapter — unit tests.
 *
 * Pattern matched to `tests/networks/awin/adapter.test.ts` and
 * `tests/networks/everflow/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly, exercising the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 *   - Fixtures live under `tests/fixtures/financeads/`. No real credentials,
 *     no real data. The financeAds API shape is partly dashboard-gated; these
 *     fixtures approximate it defensively (see the adapter's UNVERIFIED notes).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { financeadsAdapter, _internals } from '../../../src/networks/financeads/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'financeads');

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

beforeEach(() => {
  _resetBreakers();
  process.env['FINANCEADS_API_KEY'] = 'test-api-key-please-ignore';
  process.env['FINANCEADS_USER_ID'] = '123456';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['FINANCEADS_API_KEY'];
  delete process.env['FINANCEADS_USER_ID'];
});

// ---------------------------------------------------------------------------
// Transformers (status normalisation, raw preservation, number parsing)
// ---------------------------------------------------------------------------

describe('financeAds transformers', () => {
  it('maps programme statuses (incl. German aliases) to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ partnership: 'active' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ partnership: 'bestätigt' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ partnership: 'pending' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ partnership: 'rejected' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ status: 'offen' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ status: 'pausiert' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'never-seen-before' })).toBe('unknown');
  });

  it('maps sale/lead statuses (open|confirmed|cancelled + German) to canonical', () => {
    expect(_internals.mapTransactionStatus({ status: 'open' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'offen' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'confirmed' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'bestätigt' })).toBe('approved');
    // §15.4: cancelled must map to 'reversed' (the user-facing intent).
    expect(_internals.mapTransactionStatus({ status: 'cancelled' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'storniert' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'paid' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ status: 'mystery' })).toBe('other');
  });

  it('parses German comma-decimal commission strings', () => {
    expect(_internals.toNumber('45,00')).toBeCloseTo(45.0, 2);
    expect(_internals.toNumber('1.234,56')).toBeCloseTo(1234.56, 2);
    expect(_internals.toNumber(30)).toBe(30);
    expect(_internals.toNumber(undefined)).toBe(0);
  });

  it('preserves the raw financeAds payload under rawNetworkData', () => {
    const raw = (loadFixture('sales.json') as { sales: Record<string, unknown>[] }).sales[0];
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('surfaces reversalReason on cancelled transactions (§15.10)', () => {
    const cancelled = (loadFixture('sales.json') as { sales: Record<string, unknown>[] })
      .sales[2];
    const out = _internals.toTransaction(cancelled as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toContain('Application withdrawn');
  });

  it('computes ageDays from the confirmation date against a fixed now (§15.9)', () => {
    const now = new Date('2026-06-05T00:00:00Z');
    const age = _internals.computeAgeDays(
      { confirmed_date: '2026-01-20 11:00:00' } as never,
      now,
    );
    expect(age).toBeGreaterThan(130);
  });

  it('defaults currency to EUR when no currency field is present', () => {
    const out = _internals.toTransaction({ sale_id: 'x', commission: '10,00' } as never);
    expect(out.currency).toBe('EUR');
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('financeAds.listProgrammes', () => {
  it('maps merchants from the fixture with status normalisation', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchants.json'))]);
    const programmes = await financeadsAdapter.listProgrammes();
    expect(programmes.length).toBe(4);
    expect(programmes.find((p) => p.id === '1001')?.status).toBe('joined');
    expect(programmes.find((p) => p.id === '1002')?.status).toBe('pending');
    expect(programmes.find((p) => p.id === '1003')?.status).toBe('declined');
    expect(programmes.find((p) => p.id === '1004')?.status).toBe('available');
  });

  it('filters by status client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchants.json'))]);
    const only = await financeadsAdapter.listProgrammes({ status: 'joined' });
    expect(only.every((p) => p.status === 'joined')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('applies a search filter client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchants.json'))]);
    const results = await financeadsAdapter.listProgrammes({ search: 'insurance' });
    expect(results.length).toBe(1);
    expect(results[0]?.id).toBe('1002');
  });

  it('throws a NetworkError when a credential is missing', async () => {
    delete process.env['FINANCEADS_API_KEY'];
    await expect(financeadsAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getProgramme
// ---------------------------------------------------------------------------

describe('financeAds.getProgramme', () => {
  it('returns the matching programme from the merchants list', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchants.json'))]);
    const prog = await financeadsAdapter.getProgramme('1001');
    expect(prog.id).toBe('1001');
    expect(prog.network).toBe('financeads');
  });

  it('throws a config_error envelope for a non-numeric id', async () => {
    await expect(financeadsAdapter.getProgramme('not-a-number')).rejects.toBeInstanceOf(
      NetworkError,
    );
  });

  it('throws a network_api_error envelope when no programme matches', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchants.json'))]);
    await expect(financeadsAdapter.getProgramme('9999')).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('financeAds.listTransactions', () => {
  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    // The window spans > 90 days, so the adapter chunks into 3 slices. We put
    // the full fixture on the first slice and empty arrays on the rest.
    mockFetchQueue([
      fakeResponse(loadFixture('sales.json')),
      fakeResponse({ sales: [] }),
      fakeResponse({ sales: [] }),
    ]);
    const aged = await financeadsAdapter.listTransactions({
      from: '2025-11-01T00:00:00Z',
      to: '2026-06-05T00:00:00Z',
      minAgeDays: 100,
    });
    for (const t of aged) {
      expect(t.ageDays).toBeGreaterThanOrEqual(100);
    }
    expect(aged.length).toBeGreaterThan(0);
  });

  it('includes reversed transactions with reason populated (§15.10)', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('sales.json')),
      fakeResponse({ sales: [] }),
    ]);
    const all = await financeadsAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-06-05T00:00:00Z',
    });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toContain('Application withdrawn');
  });

  it('filters by status when caller passes status[]', async () => {
    mockFetchQueue([fakeResponse(loadFixture('sales.json')), fakeResponse({ sales: [] })]);
    const only = await financeadsAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-06-05T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('chunks date ranges wider than 90 days into multiple calls', async () => {
    const spy = mockFetchQueue([
      fakeResponse({ sales: [] }),
      fakeResponse({ sales: [] }),
      fakeResponse({ sales: [] }),
    ]);
    await financeadsAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-08-01T00:00:00Z', // ~212 days → 3 slices (90 + 90 + 32)
    });
    expect(spy.mock.calls.length).toBe(3);
  });

  it('emits a NetworkError when a credential is missing (§15.4)', async () => {
    delete process.env['FINANCEADS_USER_ID'];
    await expect(financeadsAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('financeAds.getEarningsSummary', () => {
  it('derives the summary from listTransactions', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('sales.json')),
      fakeResponse({ sales: [] }),
      fakeResponse({ sales: [] }),
    ]);
    const summary = await financeadsAdapter.getEarningsSummary({
      from: '2025-11-01T00:00:00Z',
      to: '2026-06-05T00:00:00Z',
    });
    expect(summary.network).toBe('financeads');
    expect(summary.currency).toBe('EUR');
    // confirmed 45 + open 45 + cancelled 30 + paid 45 = 165 total commission.
    expect(summary.totalEarnings).toBeCloseTo(165.0, 2);
    expect(summary.byStatus.approved).toBeCloseTo(45.0, 2);
    expect(summary.byStatus.pending).toBeCloseTo(45.0, 2);
    expect(summary.byStatus.reversed).toBeCloseTo(30.0, 2);
    expect(summary.byStatus.paid).toBeCloseTo(45.0, 2);
    expect(summary.oldestUnpaidAgeDays).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// listClicks
// ---------------------------------------------------------------------------

describe('financeAds.listClicks', () => {
  it('throws NotImplementedError with the documented reason', async () => {
    await expect(financeadsAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await financeadsAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('does not expose click-level data');
    }
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — deterministic construction
// ---------------------------------------------------------------------------

describe('financeAds.generateTrackingLink', () => {
  it('constructs the tc.php deep link with a URL-encoded destination', async () => {
    const link = await financeadsAdapter.generateTrackingLink({
      programmeId: '123C123T',
      destinationUrl: 'https://www.atolls-bank.example.com/path?q=a b',
    });
    expect(link.trackingUrl).toContain('https://www.financeads.net/tc.php?t=123C123T');
    expect(link.trackingUrl).toContain('deep=https%3A%2F%2Fwww.atolls-bank.example.com%2Fpath%3Fq%3Da%20b');
    expect(link.network).toBe('financeads');
    expect(link.programmeId).toBe('123C123T');
  });

  it('throws a config_error envelope when programmeId is missing', async () => {
    await expect(
      financeadsAdapter.generateTrackingLink({
        programmeId: '',
        destinationUrl: 'https://x.example.com',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('does NOT call fetch (deterministic construction)', async () => {
    const spy = mockFetchQueue([]);
    await financeadsAdapter.generateTrackingLink({
      programmeId: '123C123T',
      destinationUrl: 'https://x.example.com',
    });
    expect(spy.mock.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('financeAds.verifyAuth', () => {
  it('returns ok:true with an identity when the probe responds 200', async () => {
    mockFetchQueue([fakeResponse({ data: [] })]);
    const r = await financeadsAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toContain('financeads/user/123456');
  });

  it('surfaces a NetworkErrorEnvelope shape on 401 (§15.4)', async () => {
    mockFetchQueue([fakeResponse('{"error":"invalid_key"}', { status: 401 })]);
    const r = await financeadsAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/HTTP 401|401/);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('financeAds.validateCredential', () => {
  it('rejects malformed user IDs', async () => {
    expect((await financeadsAdapter.validateCredential('FINANCEADS_USER_ID', 'abc')).ok).toBe(false);
    expect((await financeadsAdapter.validateCredential('FINANCEADS_USER_ID', '-5')).ok).toBe(false);
    expect((await financeadsAdapter.validateCredential('FINANCEADS_USER_ID', '0')).ok).toBe(false);
  });

  it('accepts well-formed user IDs', async () => {
    expect((await financeadsAdapter.validateCredential('FINANCEADS_USER_ID', '123456')).ok).toBe(
      true,
    );
  });

  it('validates the API key against the probe endpoint when the user ID is set', async () => {
    mockFetchQueue([fakeResponse({ data: [] })]);
    const r = await financeadsAdapter.validateCredential('FINANCEADS_API_KEY', 'fresh-key');
    expect(r.ok).toBe(true);
  });

  it('returns a hint when API-key validation fails', async () => {
    mockFetchQueue([fakeResponse('{"error":"bad"}', { status: 401 })]);
    const r = await financeadsAdapter.validateCredential('FINANCEADS_API_KEY', 'bad-key');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// admin ops
// ---------------------------------------------------------------------------

describe('financeAds admin operations (not implemented at v0.1)', () => {
  it('listPublishers throws NotImplementedError', async () => {
    await expect(financeadsAdapter.listPublishers()).rejects.toBeInstanceOf(NotImplementedError);
  });
  it('listPublisherSectors throws NotImplementedError', async () => {
    await expect(financeadsAdapter.listPublisherSectors()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim financeAds response body on a 500', async () => {
    const body = '{"error":"upstream broke","trace":"xyz"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await financeadsAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('financeads');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream broke');
    }
  });

  it('classifies 401 as auth_error', async () => {
    mockFetchQueue([fakeResponse('forbidden', { status: 401, rawBody: 'forbidden' })]);
    try {
      await financeadsAdapter.listProgrammes();
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

describe('financeAds.capabilitiesCheck', () => {
  it('records listClicks.supported = false with the known-limitation note', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('merchants.json')), // listProgrammes
      fakeResponse(loadFixture('sales.json')), // listTransactions probe
      fakeResponse(loadFixture('sales.json')), // getEarningsSummary → listTransactions
      fakeResponse({ data: [] }), // verifyAuth
    ]);
    const caps = await financeadsAdapter.capabilitiesCheck();
    expect(caps.network).toBe('financeads');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['listClicks']?.note).toContain('click-level data');
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
