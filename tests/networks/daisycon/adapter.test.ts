/**
 * Daisycon adapter — unit tests.
 *
 * Pattern-matched to `tests/networks/skimlinks/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - The OAuth token exchange is the FIRST fetch; the data call follows.
 *   - Circuit breakers are reset in `beforeEach` so no test bleeds state.
 *   - The token cache is reset via `_resetTokenCache`.
 *   - Fake credentials are injected via `process.env` (obvious non-secret values).
 *   - Fixtures live under `tests/fixtures/daisycon/`.
 *   - Tests inject a fixed `now` into transformers so they never drift with the date.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { daisyconAdapter, _internals } from '../../../src/networks/daisycon/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';
import { _resetTokenCache } from '../../../src/networks/daisycon/auth.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'daisycon');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(
  body: unknown,
  init: { status?: number; rawBody?: string; totalCount?: number } = {},
): Response {
  const status = init.status ?? 200;
  const text = init.rawBody ?? (typeof body === 'string' ? body : JSON.stringify(body));
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.totalCount !== undefined) headers['x-total-count'] = String(init.totalCount);
  return new Response(text, { status, headers });
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

/** Mock a token exchange (first fetch) followed by the given data response(s). */
function mockWithToken(...dataResponses: Response[]): ReturnType<typeof vi.fn> {
  return mockFetchQueue([fakeResponse(loadFixture('token.json')), ...dataResponses]);
}

beforeEach(() => {
  _resetBreakers();
  _resetTokenCache();
  process.env['DAISYCON_CLIENT_ID'] = 'test-client-id-please-ignore';
  process.env['DAISYCON_CLIENT_SECRET'] = 'test-client-secret-please-ignore';
  process.env['DAISYCON_REFRESH_TOKEN'] = 'test-refresh-token-please-ignore';
  process.env['DAISYCON_PUBLISHER_ID'] = '123456';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['DAISYCON_CLIENT_ID'];
  delete process.env['DAISYCON_CLIENT_SECRET'];
  delete process.env['DAISYCON_REFRESH_TOKEN'];
  delete process.env['DAISYCON_PUBLISHER_ID'];
  _resetTokenCache();
});

// ---------------------------------------------------------------------------
// Transformer unit tests (status normalisation + raw preservation)
// ---------------------------------------------------------------------------

describe('Daisycon transformers (status normalisation, raw preservation)', () => {
  it('maps Daisycon transaction statuses to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ status: 'open' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'approved' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'paid' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ status: 'disapproved' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'declined' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'unknown_future_status' })).toBe('other');
    expect(_internals.mapTransactionStatus({})).toBe('other');
  });

  it('maps Daisycon programme statuses to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ media_subscription_status: 'subscribed' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'active' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ status: 'declined' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ status: 'available' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ status: 'suspended' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'something-new' })).toBe('unknown');
    expect(_internals.mapProgrammeStatus({})).toBe('unknown');
  });

  it('maps canonical statuses to Daisycon query values', () => {
    expect(_internals.mapCanonicalToDaisyconStatus(['pending'])).toBe('open');
    expect(_internals.mapCanonicalToDaisyconStatus(['approved'])).toBe('approved');
    expect(_internals.mapCanonicalToDaisyconStatus(['reversed'])).toBe('disapproved');
    expect(_internals.mapCanonicalToDaisyconStatus(['paid'])).toBe('paid');
    expect(_internals.mapCanonicalToDaisyconStatus(['other'])).toBeUndefined();
    // Multiple statuses → client-side filtering.
    expect(_internals.mapCanonicalToDaisyconStatus(['pending', 'paid'])).toBeUndefined();
  });

  it('preserves raw Daisycon payload in rawNetworkData', () => {
    const rows = loadFixture('transactions.json') as Array<Record<string, unknown>>;
    const out = _internals.toTransaction(rows[0] as never);
    expect(out.rawNetworkData).toBe(rows[0]);
  });

  it('reads currency per row (multi-currency)', () => {
    const rows = loadFixture('transactions.json') as Array<Record<string, unknown>>;
    expect(_internals.toTransaction(rows[0] as never).currency).toBe('EUR');
    expect(_internals.toTransaction(rows[2] as never).currency).toBe('GBP');
  });

  it('surfaces reversalReason from disapproved_reason on reversed transactions (§15.10)', () => {
    const rows = loadFixture('transactions.json') as Array<Record<string, unknown>>;
    const out = _internals.toTransaction(rows[2] as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Order cancelled by the customer');
  });

  it('computes ageDays from the conversion date', () => {
    const now = new Date('2026-06-04T00:00:00Z');
    // date = 2026-05-25 → 10 days
    const age = _internals.computeAgeDays({ date: '2026-05-25T00:00:00Z' }, now);
    expect(age).toBe(10);
    // missing dates → 0
    expect(_internals.computeAgeDays({}, now)).toBe(0);
  });

  it('normalises string and number commission amounts', () => {
    expect(_internals.toAmount(5.5)).toBe(5.5);
    expect(_internals.toAmount('12.75')).toBe(12.75);
    expect(_internals.toAmount(undefined)).toBe(0);
    expect(_internals.toAmount('not-a-number')).toBe(0);
  });

  it('builds a Programme with categories and commission rate', () => {
    const rows = loadFixture('programs.json') as Array<Record<string, unknown>>;
    const p = _internals.toProgramme(rows[0] as never);
    expect(p.id).toBe('3001');
    expect(p.status).toBe('joined');
    expect(p.categories).toEqual(['Travel', 'Holidays']);
    expect(p.commissionRate).toBe('8% of order value');
    expect(p.advertiserUrl).toBe('https://www.exampletravel.test/');
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('DaisyconAdapter.listTransactions', () => {
  it('returns transactions across the window with raw + normalised status', async () => {
    mockWithToken(fakeResponse(loadFixture('transactions.json')));
    const all = await daisyconAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    expect(all.length).toBe(4);
    expect(all.map((t) => t.status).sort()).toEqual(['approved', 'paid', 'pending', 'reversed']);
  });

  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockWithToken(fakeResponse(loadFixture('transactions.json')));
    const aged = await daisyconAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
      minAgeDays: 365,
    });
    for (const t of aged) {
      expect(t.ageDays).toBeGreaterThanOrEqual(365);
    }
    expect(aged.length).toBeGreaterThan(0);
  });

  it('filters by status when caller passes status[]', async () => {
    mockWithToken(fakeResponse(loadFixture('transactions.json')));
    const only = await daisyconAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
    expect(only[0]?.reversalReason).toBe('Order cancelled by the customer');
  });

  it('respects limit after all other filters are applied', async () => {
    mockWithToken(fakeResponse(loadFixture('transactions.json')));
    const limited = await daisyconAdapter.listTransactions({ limit: 2 });
    expect(limited.length).toBe(2);
  });

  it('paginates using the x-total-count header', async () => {
    // Two pages: total=4, each page returns 2 rows. PER_PAGE is 200 so the
    // partial-page short-circuit does not trigger; the header drives paging.
    const rows = loadFixture('transactions.json') as unknown[];
    mockWithToken(
      fakeResponse(rows.slice(0, 2), { totalCount: 4 }),
      fakeResponse(rows.slice(2, 4), { totalCount: 4 }),
    );
    const all = await daisyconAdapter.listTransactions({});
    expect(all.length).toBe(4);
  });

  it('emits a NetworkError when DAISYCON_PUBLISHER_ID is missing', async () => {
    delete process.env['DAISYCON_PUBLISHER_ID'];
    await expect(daisyconAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });

  it('emits a NetworkError when DAISYCON_CLIENT_ID is missing', async () => {
    delete process.env['DAISYCON_CLIENT_ID'];
    await expect(daisyconAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes / getProgramme
// ---------------------------------------------------------------------------

describe('DaisyconAdapter.listProgrammes', () => {
  it('lists programmes and applies a search filter', async () => {
    mockWithToken(fakeResponse(loadFixture('programs.json')));
    const all = await daisyconAdapter.listProgrammes();
    expect(all.length).toBe(3);

    _resetTokenCache();
    mockWithToken(fakeResponse(loadFixture('programs.json')));
    const filtered = await daisyconAdapter.listProgrammes({ search: 'travel' });
    expect(filtered.length).toBe(1);
    expect(filtered[0]?.id).toBe('3001');
  });

  it('filters programmes by status', async () => {
    mockWithToken(fakeResponse(loadFixture('programs.json')));
    const pending = await daisyconAdapter.listProgrammes({ status: 'pending' });
    expect(pending.length).toBe(1);
    expect(pending[0]?.id).toBe('3003');
  });
});

describe('DaisyconAdapter.getProgramme', () => {
  it('returns the matching programme by id', async () => {
    mockWithToken(fakeResponse(loadFixture('programs.json')));
    const p = await daisyconAdapter.getProgramme('3002');
    expect(p.id).toBe('3002');
    expect(p.name).toBe('Test Electronics GmbH');
  });

  it('throws NotImplementedError when the programme id is not found', async () => {
    mockWithToken(fakeResponse(loadFixture('programs.json')));
    await expect(daisyconAdapter.getProgramme('9999')).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// listClicks / generateTrackingLink — NotImplemented
// ---------------------------------------------------------------------------

describe('DaisyconAdapter.listClicks', () => {
  it('throws NotImplementedError with a Daisycon-specific reason', async () => {
    await expect(daisyconAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await daisyconAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click-level data');
    }
  });
});

describe('DaisyconAdapter.generateTrackingLink', () => {
  it('throws NotImplementedError because click URLs are not credential-constructible', async () => {
    await expect(
      daisyconAdapter.generateTrackingLink({
        programmeId: '3001',
        destinationUrl: 'https://example.test/',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await daisyconAdapter.generateTrackingLink({
        programmeId: '3001',
        destinationUrl: 'https://example.test/',
      });
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('programme/media binding');
    }
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary — derived from listTransactions
// ---------------------------------------------------------------------------

describe('DaisyconAdapter.getEarningsSummary', () => {
  it('aggregates commissions correctly from fixture data', async () => {
    mockWithToken(fakeResponse(loadFixture('transactions.json')));
    const summary = await daisyconAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    expect(summary.network).toBe('daisycon');
    expect(summary.totalEarnings).toBeCloseTo(9.6 + 20.0 + 3.2 + 8.0, 2);
    expect(summary.byStatus.pending).toBeCloseTo(9.6, 2);
    expect(summary.byStatus.approved).toBeCloseTo(20.0, 2);
    expect(summary.byStatus.reversed).toBeCloseTo(3.2, 2);
    expect(summary.byStatus.paid).toBeCloseTo(8.0, 2);
    expect(summary.byProgramme.length).toBe(2);
    expect(summary.currency).toBe('EUR');
  });

  it('sets oldestUnpaidAgeDays from the longest-pending unpaid transaction (§15.9)', async () => {
    mockWithToken(fakeResponse(loadFixture('transactions.json')));
    const summary = await daisyconAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    // Transaction 70002 converted on 2024-01-15 and is still approved/unpaid.
    expect(summary.oldestUnpaidAgeDays).toBeDefined();
    expect(summary.oldestUnpaidAgeDays ?? 0).toBeGreaterThan(365);
  });

  it('returns an empty summary when no transactions match the window', async () => {
    mockWithToken(fakeResponse(loadFixture('transactions_empty.json')));
    const summary = await daisyconAdapter.getEarningsSummary({});
    expect(summary.totalEarnings).toBe(0);
    expect(summary.byProgramme).toHaveLength(0);
    expect(summary.oldestUnpaidAgeDays).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// verifyAuth — happy + failure paths
// ---------------------------------------------------------------------------

describe('DaisyconAdapter.verifyAuth', () => {
  it('returns ok:true and identity when token exchange succeeds', async () => {
    mockFetchQueue([fakeResponse(loadFixture('token.json'))]);
    const r = await daisyconAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('daisycon/publisher:123456');
    }
  });

  it('returns ok:false (does not throw) on auth failure', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_grant"}', {
        status: 401,
        rawBody: '{"error":"invalid_grant"}',
      }),
    ]);
    const r = await daisyconAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/HTTP 401|401|invalid_grant|auth/i);
    }
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('DaisyconAdapter.validateCredential', () => {
  it('accepts a non-empty DAISYCON_CLIENT_ID without an API call', async () => {
    const r = await daisyconAdapter.validateCredential('DAISYCON_CLIENT_ID', 'any-id');
    expect(r.ok).toBe(true);
  });

  it('rejects an empty DAISYCON_CLIENT_ID', async () => {
    const r = await daisyconAdapter.validateCredential('DAISYCON_CLIENT_ID', '');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('validates DAISYCON_REFRESH_TOKEN via live token exchange', async () => {
    mockFetchQueue([fakeResponse(loadFixture('token.json'))]);
    const r = await daisyconAdapter.validateCredential(
      'DAISYCON_REFRESH_TOKEN',
      'test-refresh-token-please-ignore',
    );
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with hint when DAISYCON_CLIENT_SECRET is wrong', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_client"}', {
        status: 401,
        rawBody: '{"error":"invalid_client"}',
      }),
    ]);
    const r = await daisyconAdapter.validateCredential('DAISYCON_CLIENT_SECRET', 'bad-secret');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('accepts a positive integer DAISYCON_PUBLISHER_ID', async () => {
    const r = await daisyconAdapter.validateCredential('DAISYCON_PUBLISHER_ID', '123456');
    expect(r.ok).toBe(true);
  });

  it('rejects a non-numeric DAISYCON_PUBLISHER_ID', async () => {
    const r1 = await daisyconAdapter.validateCredential('DAISYCON_PUBLISHER_ID', 'abc');
    expect(r1.ok).toBe(false);
    const r2 = await daisyconAdapter.validateCredential('DAISYCON_PUBLISHER_ID', '0');
    expect(r2.ok).toBe(false);
  });

  it('returns ok:false for unknown credential fields', async () => {
    const r = await daisyconAdapter.validateCredential('DAISYCON_UNKNOWN_FIELD', 'value');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces verbatim response body on a 500', async () => {
    const body = '{"error":"upstream exploded","trace":"xyz"}';
    mockFetchQueue([
      fakeResponse(loadFixture('token.json')),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await daisyconAdapter.listTransactions({});
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('daisycon');
      expect(env.operation).toBe('listTransactions');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream exploded');
    }
  });

  it('classifies 401 on the services API as auth_error', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('token.json')),
      fakeResponse('Forbidden', { status: 401, rawBody: 'Forbidden' }),
    ]);
    try {
      await daisyconAdapter.listTransactions({});
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

describe('DaisyconAdapter.capabilitiesCheck', () => {
  it('records listClicks and generateTrackingLink as not supported', async () => {
    // Probes: verifyAuth (token), listProgrammes (token+data), listTransactions
    // (token+data), getEarningsSummary (token+data), getProgramme (token+data).
    mockFetchQueue([
      fakeResponse(loadFixture('token.json')), // verifyAuth token
      fakeResponse(loadFixture('token.json')), // listProgrammes token
      fakeResponse(loadFixture('programs.json')), // listProgrammes data
      fakeResponse(loadFixture('token.json')), // listTransactions token
      fakeResponse(loadFixture('transactions_empty.json')), // listTransactions data
      fakeResponse(loadFixture('token.json')), // getEarningsSummary → listTransactions token
      fakeResponse(loadFixture('transactions_empty.json')), // getEarningsSummary data
      fakeResponse(loadFixture('token.json')), // getProgramme → listProgrammes token
      fakeResponse(loadFixture('programs.json')), // getProgramme data
    ]);
    const caps = await daisyconAdapter.capabilitiesCheck();
    expect(caps.network).toBe('daisycon');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
    expect(caps.operations['listTransactions']?.supported).toBe(true);
    expect(caps.operations['listProgrammes']?.supported).toBe(true);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
