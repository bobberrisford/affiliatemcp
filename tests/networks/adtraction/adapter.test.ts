/**
 * Adtraction adapter — unit tests.
 *
 * Pattern-matched to `tests/networks/skimlinks/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - Circuit breakers are reset in `beforeEach` so no test bleeds state.
 *   - Fake credentials are injected via `process.env` (obvious non-secret values).
 *   - Fixtures live under `tests/fixtures/adtraction/`.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 *
 * NOTE: Adtraction requests are POST-with-JSON-body and the token is a query
 * parameter. The "sends the right method/body/token" test asserts that shape.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { adtractionAdapter, _internals } from '../../../src/networks/adtraction/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'adtraction');

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

beforeEach(() => {
  _resetBreakers();
  process.env['ADTRACTION_API_TOKEN'] = 'test-adtraction-token-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['ADTRACTION_API_TOKEN'];
});

// ---------------------------------------------------------------------------
// Transformer unit tests (status normalisation + raw preservation)
// ---------------------------------------------------------------------------

describe('Adtraction transformers (status normalisation, raw preservation)', () => {
  it('maps numeric Adtraction status codes to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ transactionStatus: 1 })).toBe('approved');
    expect(_internals.mapTransactionStatus({ transactionStatus: 2 })).toBe('pending');
    expect(_internals.mapTransactionStatus({ transactionStatus: 4 })).toBe('pending');
    expect(_internals.mapTransactionStatus({ transactionStatus: 5 })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ transactionStatus: 99 })).toBe('other');
  });

  it('maps string Adtraction status labels to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ transactionStatus: 'approved' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ transactionStatus: 'pending' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ transactionStatus: 'rejected' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ transactionStatus: 'paid' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ transactionStatus: 'something-new' })).toBe('other');
    expect(_internals.mapTransactionStatus({})).toBe('other');
  });

  it('maps Adtraction programme statuses to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ approvalStatus: 'approved' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ approvalStatus: 'active' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ approvalStatus: 'pending' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ approvalStatus: 'rejected' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ approvalStatus: 'available' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ approvalStatus: 'paused' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ approvalStatus: 'something-new' })).toBe('unknown');
    expect(_internals.mapProgrammeStatus({})).toBe('unknown');
  });

  it('preserves the raw Adtraction payload in rawNetworkData', () => {
    const fixture = (loadFixture('transactions.json') as { transactions: unknown[] }).transactions;
    const raw = fixture[0] as Record<string, unknown>;
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('reads currency per row, never hardcoded', () => {
    const fixture = (loadFixture('transactions.json') as { transactions: Array<Record<string, unknown>> })
      .transactions;
    const sek = _internals.toTransaction(fixture[0] as never);
    const eur = _internals.toTransaction(fixture[2] as never);
    expect(sek.currency).toBe('SEK');
    expect(eur.currency).toBe('EUR');
  });

  it('surfaces reversalReason from rejectionReason on reversed transactions (§15.10)', () => {
    const fixture = (loadFixture('transactions.json') as { transactions: unknown[] }).transactions;
    const rejected = fixture[2] as Record<string, unknown>;
    const out = _internals.toTransaction(rejected as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Order cancelled by the customer');
  });

  it('computes ageDays from validated date (preferred), then conversion date', () => {
    const now = new Date('2026-06-04T00:00:00Z');
    // validated = 2026-05-25 → 10 days
    const age1 = _internals.computeAgeDays(
      { validated: '2026-05-25T00:00:00Z', transactionTime: '2026-05-01T00:00:00Z' },
      now,
    );
    expect(age1).toBe(10);
    // No validated → falls back to transactionTime = 2026-05-15 → 20 days
    const age2 = _internals.computeAgeDays({ transactionTime: '2026-05-15T00:00:00Z' }, now);
    expect(age2).toBe(20);
  });

  it('normalises string and number commission amounts', () => {
    expect(_internals.toAmount(5.5)).toBe(5.5);
    expect(_internals.toAmount('12.75')).toBe(12.75);
    expect(_internals.toAmount(undefined)).toBe(0);
    expect(_internals.toAmount('not-a-number')).toBe(0);
  });

  it('maps canonical status to a single Adtraction numeric filter code', () => {
    expect(_internals.mapCanonicalToAdtractionStatus(['approved'])).toBe(1);
    expect(_internals.mapCanonicalToAdtractionStatus(['pending'])).toBe(2);
    expect(_internals.mapCanonicalToAdtractionStatus(['reversed'])).toBe(5);
    expect(_internals.mapCanonicalToAdtractionStatus(['paid'])).toBeUndefined();
    expect(_internals.mapCanonicalToAdtractionStatus(['approved', 'pending'])).toBeUndefined();
    expect(_internals.mapCanonicalToAdtractionStatus(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listTransactions — request shape, filters, unpaid-age, reversed visibility
// ---------------------------------------------------------------------------

describe('AdtractionAdapter.listTransactions', () => {
  it('sends a POST with the token as a query parameter and dates in the JSON body', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    await adtractionAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(url).toContain('/v3/affiliate/transactions/');
    // Token travels as a query parameter, not a header.
    expect(url).toContain('token=test-adtraction-token-please-ignore');
    const body = JSON.parse(String(init.body));
    expect(body.fromDate).toBe('2026-01-01');
    expect(body.toDate).toBe('2026-06-04');
  });

  it('sends the numeric transactionStatus filter when a single status is requested', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    await adtractionAdapter.listTransactions({ status: ['approved'] });
    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.transactionStatus).toBe(1);
  });

  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const aged = await adtractionAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
      minAgeDays: 365,
    });
    expect(aged.length).toBeGreaterThan(0);
    for (const t of aged) {
      expect(t.ageDays).toBeGreaterThanOrEqual(365);
    }
  });

  it('includes reversed transactions with their reason (§15.10)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const all = await adtractionAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toBe('Order cancelled by the customer');
  });

  it('filters by canonical status client-side when caller passes status[]', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const only = await adtractionAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('respects limit after all other filters are applied', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const limited = await adtractionAdapter.listTransactions({ limit: 2 });
    expect(limited.length).toBeLessThanOrEqual(2);
  });

  it('emits a NetworkError when ADTRACTION_API_TOKEN is missing', async () => {
    delete process.env['ADTRACTION_API_TOKEN'];
    await expect(adtractionAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes / getProgramme
// ---------------------------------------------------------------------------

describe('AdtractionAdapter.listProgrammes', () => {
  it('returns normalised programmes from the approved-programmes endpoint', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programs.json'))]);
    const programmes = await adtractionAdapter.listProgrammes();
    expect(programmes.length).toBe(3);
    expect(programmes[0]?.network).toBe('adtraction');
    expect(programmes[0]?.status).toBe('joined');
    expect(programmes[0]?.currency).toBe('SEK');
    expect(programmes[1]?.status).toBe('pending');
    expect(programmes[2]?.status).toBe('declined');
  });

  it('applies the client-side status filter', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programs.json'))]);
    const joined = await adtractionAdapter.listProgrammes({ status: 'joined' });
    expect(joined.length).toBe(1);
    expect(joined[0]?.status).toBe('joined');
  });

  it('applies the client-side search filter', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programs.json'))]);
    const found = await adtractionAdapter.listProgrammes({ search: 'electronics' });
    expect(found.length).toBe(1);
    expect(found[0]?.name).toContain('Electronics');
  });

  it('emits a NetworkError when ADTRACTION_API_TOKEN is missing', async () => {
    delete process.env['ADTRACTION_API_TOKEN'];
    await expect(adtractionAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('AdtractionAdapter.getProgramme', () => {
  it('returns the matching programme by id', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programs.json'))]);
    const programme = await adtractionAdapter.getProgramme('3002');
    expect(programme.id).toBe('3002');
    expect(programme.name).toContain('Electronics');
    expect(programme.currency).toBe('EUR');
  });

  it('throws a NetworkError when no programme matches the id', async () => {
    mockFetchQueue([fakeResponse({ programs: [] })]);
    await expect(adtractionAdapter.getProgramme('999999')).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listClicks — not exposed by the affiliate API
// ---------------------------------------------------------------------------

describe('AdtractionAdapter.listClicks', () => {
  it('throws NotImplementedError with an Adtraction-specific reason', async () => {
    await expect(adtractionAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await adtractionAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click-level data');
    }
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — not deterministically constructible
// ---------------------------------------------------------------------------

describe('AdtractionAdapter.generateTrackingLink', () => {
  it('throws NotImplementedError pointing to the per-programme trackingURL', async () => {
    await expect(
      adtractionAdapter.generateTrackingLink({
        programmeId: '3001',
        destinationUrl: 'https://www.nordicbooks.test/product/1',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await adtractionAdapter.generateTrackingLink({
        programmeId: '3001',
        destinationUrl: 'https://www.nordicbooks.test/product/1',
      });
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('trackingURL');
    }
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary — derived from listTransactions
// ---------------------------------------------------------------------------

describe('AdtractionAdapter.getEarningsSummary', () => {
  it('aggregates commissions correctly from fixture data', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const summary = await adtractionAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    expect(summary.network).toBe('adtraction');
    expect(summary.totalEarnings).toBeCloseTo(27.5 + 63.75 + 4.5 + 8.0, 2);
    expect(summary.byStatus.pending).toBeCloseTo(27.5, 2);
    expect(summary.byStatus.approved).toBeCloseTo(63.75, 2);
    expect(summary.byStatus.reversed).toBeCloseTo(4.5, 2);
    expect(summary.byStatus.paid).toBeCloseTo(8.0, 2);
    expect(summary.byProgramme.length).toBe(2);
  });

  it('sets oldestUnpaidAgeDays from the longest-pending unpaid transaction (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const summary = await adtractionAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    // TX-90002 was validated on 2024-01-20 and is still unpaid — oldest.
    expect(summary.oldestUnpaidAgeDays).toBeDefined();
    expect(summary.oldestUnpaidAgeDays ?? 0).toBeGreaterThan(365);
  });

  it('does not pass limit through to the underlying transactions query', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    await adtractionAdapter.getEarningsSummary({ limit: 1 });
    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    // The body never carries a limit; the summary aggregates the full result set.
    expect(body.limit).toBeUndefined();
  });

  it('returns an empty summary when no transactions match the window', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions_empty.json'))]);
    const summary = await adtractionAdapter.getEarningsSummary({});
    expect(summary.totalEarnings).toBe(0);
    expect(summary.byProgramme).toHaveLength(0);
    expect(summary.oldestUnpaidAgeDays).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// verifyAuth — happy + failure paths
// ---------------------------------------------------------------------------

describe('AdtractionAdapter.verifyAuth', () => {
  it('returns ok:true and a masked-token identity on a successful probe', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programs.json'))]);
    const r = await adtractionAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('adtraction/token:');
      // The full token must never be echoed back.
      expect(r.identity).not.toContain('test-adtraction-token-please-ignore');
    }
  });

  it('returns ok:false (does not throw) on a 401 from the API (§15.4)', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_token"}', {
        status: 401,
        rawBody: '{"error":"invalid_token"}',
      }),
    ]);
    const r = await adtractionAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/401|invalid_token|auth/i);
    }
  });

  it('returns ok:false when the token is missing entirely', async () => {
    delete process.env['ADTRACTION_API_TOKEN'];
    await expect(adtractionAdapter.verifyAuth()).resolves.toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('AdtractionAdapter.validateCredential', () => {
  it('validates ADTRACTION_API_TOKEN via a live probe', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programs.json'))]);
    const r = await adtractionAdapter.validateCredential(
      'ADTRACTION_API_TOKEN',
      'some-other-token-please-ignore',
    );
    expect(r.ok).toBe(true);
  });

  it('rejects an empty ADTRACTION_API_TOKEN without an API call', async () => {
    const r = await adtractionAdapter.validateCredential('ADTRACTION_API_TOKEN', '');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('returns ok:false with a hint when the token is rejected', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_token"}', {
        status: 401,
        rawBody: '{"error":"invalid_token"}',
      }),
    ]);
    const r = await adtractionAdapter.validateCredential('ADTRACTION_API_TOKEN', 'bad-token');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('returns ok:false for unknown credential fields', async () => {
    const r = await adtractionAdapter.validateCredential('ADTRACTION_UNKNOWN_FIELD', 'value');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim response body on a 500', async () => {
    const body = '{"error":"upstream exploded","trace":"xyz"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await adtractionAdapter.listTransactions({});
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('adtraction');
      expect(env.operation).toBe('listTransactions');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream exploded');
    }
  });

  it('classifies a 401 on a data endpoint as auth_error', async () => {
    mockFetchQueue([fakeResponse('Forbidden', { status: 401, rawBody: 'Forbidden' })]);
    try {
      await adtractionAdapter.listTransactions({});
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

describe('AdtractionAdapter.capabilitiesCheck', () => {
  it('records listClicks and generateTrackingLink as not supported', async () => {
    // capabilitiesCheck probes (each is a single POST):
    //   verifyAuth, listProgrammes, listTransactions, getEarningsSummary.
    mockFetchQueue([
      fakeResponse(loadFixture('programs.json')), // verifyAuth probe
      fakeResponse(loadFixture('programs.json')), // listProgrammes
      fakeResponse(loadFixture('transactions_empty.json')), // listTransactions
      fakeResponse(loadFixture('transactions_empty.json')), // getEarningsSummary
    ]);
    const caps = await adtractionAdapter.capabilitiesCheck();
    expect(caps.network).toBe('adtraction');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
    expect(caps.operations['listProgrammes']?.supported).toBe(true);
    expect(caps.operations['listTransactions']?.supported).toBe(true);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
