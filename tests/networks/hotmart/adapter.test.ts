/**
 * Hotmart adapter — unit tests.
 *
 * Pattern-matched to `tests/networks/skimlinks/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - Circuit breakers are reset in `beforeEach` so no test bleeds state.
 *   - Fake credentials are injected via `process.env` (obvious non-secret values).
 *   - Fixtures live under `tests/fixtures/hotmart/`.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { hotmartAdapter, _internals } from '../../../src/networks/hotmart/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';
import { _resetTokenCache } from '../../../src/networks/hotmart/auth.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'hotmart');

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

/**
 * Helper: mock a token exchange (first fetch) followed by the given data response.
 * Most adapter ops require a token first, then the data call.
 */
function mockWithToken(dataResponse: Response): ReturnType<typeof vi.fn> {
  return mockFetchQueue([fakeResponse(loadFixture('token.json')), dataResponse]);
}

beforeEach(() => {
  _resetBreakers();
  _resetTokenCache();
  process.env['HOTMART_CLIENT_ID'] = 'test-client-id-please-ignore';
  process.env['HOTMART_CLIENT_SECRET'] = 'test-client-secret-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['HOTMART_CLIENT_ID'];
  delete process.env['HOTMART_CLIENT_SECRET'];
  delete process.env['HOTMART_BASIC_TOKEN'];
  _resetTokenCache();
});

// ---------------------------------------------------------------------------
// Transformer unit tests (status normalisation + raw preservation)
// ---------------------------------------------------------------------------

describe('Hotmart transformers (status normalisation, raw preservation)', () => {
  it('maps Hotmart status strings to canonical TransactionStatus', () => {
    const m = (status: string) => _internals.mapTransactionStatus({ purchase: { status } });
    expect(m('APPROVED')).toBe('approved');
    expect(m('COMPLETE')).toBe('paid');
    expect(m('WAITING_PAYMENT')).toBe('pending');
    expect(m('STARTED')).toBe('pending');
    expect(m('PROCESSING_TRANSACTION')).toBe('pending');
    expect(m('UNDER_ANALISYS')).toBe('pending');
    expect(m('OVERDUE')).toBe('pending');
    expect(m('REFUNDED')).toBe('reversed');
    expect(m('PARTIALLY_REFUNDED')).toBe('reversed');
    expect(m('CHARGEBACK')).toBe('reversed');
    expect(m('CANCELLED')).toBe('reversed');
    expect(m('EXPIRED')).toBe('reversed');
    expect(m('SOME_FUTURE_STATUS')).toBe('other');
    expect(_internals.mapTransactionStatus({})).toBe('other');
  });

  it('maps derived Hotmart programme statuses to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ status: 'joined' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'active' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'something-new' })).toBe('unknown');
    expect(_internals.mapProgrammeStatus({})).toBe('unknown');
  });

  it('preserves raw Hotmart payload in rawNetworkData', () => {
    const items = (loadFixture('sales_history.json') as { items: unknown[] }).items;
    const raw = items[0] as Record<string, unknown>;
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('surfaces reversalReason from upstream status on reversed transactions (§15.10)', () => {
    const items = (loadFixture('sales_history.json') as { items: unknown[] }).items;
    // Fixture index 2 is the REFUNDED sale.
    const refunded = items[2] as Record<string, unknown>;
    const out = _internals.toTransaction(refunded as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('REFUNDED');
  });

  it('computes ageDays from approved_date (preferred), then order_date', () => {
    const now = new Date('2026-05-28T00:00:00Z');
    // approved_date = 2024-01-20 → 858 days
    const age1 = _internals.computeAgeDays(
      { purchase: { approved_date: 1705752000000, order_date: 1705307400000 } },
      now,
    );
    expect(age1).toBe(858);
    // No approved_date → falls back to order_date = 2026-04-01 → 56 days
    const age2 = _internals.computeAgeDays(
      { purchase: { order_date: 1775037600000 } },
      now,
    );
    expect(age2).toBe(56);
    // No anchors → 0
    expect(_internals.computeAgeDays({ purchase: {} }, now)).toBe(0);
  });

  it('sums commission lines and reads the commission currency', () => {
    const raw = {
      commissions: [
        { source: 'AFFILIATE', value: 5.5, currency_code: 'BRL' },
        { source: 'COPRODUCER', value: 2.5, currency_code: 'BRL' },
      ],
    };
    expect(_internals.sumCommission(raw)).toBeCloseTo(8.0, 2);
    expect(_internals.commissionCurrency(raw)).toBe('BRL');
    expect(_internals.sumCommission({})).toBe(0);
  });

  it('normalises string and number amounts', () => {
    expect(_internals.toAmount(5.5)).toBe(5.5);
    expect(_internals.toAmount('12.75')).toBe(12.75);
    expect(_internals.toAmount(undefined)).toBe(0);
    expect(_internals.toAmount('not-a-number')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// listTransactions — filters, unpaid-age + reversed visibility (§15.9, §15.10)
// ---------------------------------------------------------------------------

describe('HotmartAdapter.listTransactions', () => {
  it('returns all four sales with normalised statuses', async () => {
    mockWithToken(fakeResponse(loadFixture('sales_history.json')));
    const all = await hotmartAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
    });
    expect(all.length).toBe(4);
    const statuses = all.map((t) => t.status).sort();
    expect(statuses).toEqual(['approved', 'paid', 'pending', 'reversed']);
    // Transaction id comes from purchase.transaction.
    expect(all.find((t) => t.id === 'HP10000001')?.status).toBe('pending');
  });

  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockWithToken(fakeResponse(loadFixture('sales_history.json')));
    const aged = await hotmartAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
      minAgeDays: 365,
    });
    for (const t of aged) {
      expect(t.ageDays).toBeGreaterThanOrEqual(365);
    }
    expect(aged.length).toBeGreaterThan(0);
  });

  it('includes reversed transactions with reason (§15.10)', async () => {
    mockWithToken(fakeResponse(loadFixture('sales_history.json')));
    const all = await hotmartAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
    });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toBe('REFUNDED');
  });

  it('filters by canonical status when caller passes status[]', async () => {
    mockWithToken(fakeResponse(loadFixture('sales_history.json')));
    const only = await hotmartAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('respects limit after all other filters are applied', async () => {
    mockWithToken(fakeResponse(loadFixture('sales_history.json')));
    const limited = await hotmartAdapter.listTransactions({ limit: 2 });
    expect(limited.length).toBeLessThanOrEqual(2);
  });

  it('emits a NetworkError when HOTMART_CLIENT_ID is missing', async () => {
    delete process.env['HOTMART_CLIENT_ID'];
    await expect(hotmartAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes / getProgramme — derived from Sales History
// ---------------------------------------------------------------------------

describe('HotmartAdapter.listProgrammes', () => {
  it('derives distinct programmes from sales history', async () => {
    mockWithToken(fakeResponse(loadFixture('sales_history.json')));
    const programmes = await hotmartAdapter.listProgrammes();
    expect(programmes.length).toBe(2);
    const ids = programmes.map((p) => p.id).sort();
    expect(ids).toEqual(['2001', '2002']);
    expect(programmes.every((p) => p.status === 'joined')).toBe(true);
    expect(programmes.every((p) => p.network === 'hotmart')).toBe(true);
  });

  it('applies a search filter against the derived list', async () => {
    mockWithToken(fakeResponse(loadFixture('sales_history.json')));
    const programmes = await hotmartAdapter.listProgrammes({ search: 'e-book' });
    expect(programmes.length).toBe(1);
    expect(programmes[0]?.id).toBe('2002');
  });
});

describe('HotmartAdapter.getProgramme', () => {
  it('resolves a single programme by product id', async () => {
    mockWithToken(fakeResponse(loadFixture('sales_history.json')));
    const programme = await hotmartAdapter.getProgramme('2001');
    expect(programme.id).toBe('2001');
    expect(programme.name).toContain('Marketing');
    expect(programme.status).toBe('joined');
  });

  it('throws when the product is not found in the window', async () => {
    mockWithToken(fakeResponse(loadFixture('sales_history_empty.json')));
    await expect(hotmartAdapter.getProgramme('9999')).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// listClicks / generateTrackingLink — not supported, must throw
// ---------------------------------------------------------------------------

describe('HotmartAdapter.listClicks', () => {
  it('throws NotImplementedError with a Hotmart-specific reason', async () => {
    await expect(hotmartAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await hotmartAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click-level data');
    }
  });
});

describe('HotmartAdapter.generateTrackingLink', () => {
  it('throws NotImplementedError because hotlinks cannot be constructed', async () => {
    await expect(
      hotmartAdapter.generateTrackingLink({
        programmeId: '2001',
        destinationUrl: 'https://example.test/',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await hotmartAdapter.generateTrackingLink({
        programmeId: '2001',
        destinationUrl: 'https://example.test/',
      });
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('hotlink');
    }
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary — derived from listTransactions
// ---------------------------------------------------------------------------

describe('HotmartAdapter.getEarningsSummary', () => {
  it('aggregates commissions correctly from fixture data', async () => {
    mockWithToken(fakeResponse(loadFixture('sales_history.json')));
    const summary = await hotmartAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
    });
    expect(summary.network).toBe('hotmart');
    expect(summary.totalEarnings).toBeCloseTo(5.5 + 12.75 + 3.2 + 8.0, 2);
    expect(summary.byStatus.pending).toBeCloseTo(5.5, 2);
    expect(summary.byStatus.approved).toBeCloseTo(12.75, 2);
    expect(summary.byStatus.reversed).toBeCloseTo(3.2, 2);
    expect(summary.byStatus.paid).toBeCloseTo(8.0, 2);
    expect(summary.byProgramme.length).toBe(2);
    expect(summary.currency).toBe('BRL');
  });

  it('sets oldestUnpaidAgeDays from the longest-pending unsettled transaction (§15.9)', async () => {
    mockWithToken(fakeResponse(loadFixture('sales_history.json')));
    const summary = await hotmartAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
    });
    // The APPROVED sale (approved 2024-01-20) is the oldest unsettled — > 365 days.
    expect(summary.oldestUnpaidAgeDays).toBeDefined();
    expect(summary.oldestUnpaidAgeDays ?? 0).toBeGreaterThan(365);
  });

  it('returns an empty summary when no sales match the window', async () => {
    mockWithToken(fakeResponse(loadFixture('sales_history_empty.json')));
    const summary = await hotmartAdapter.getEarningsSummary({});
    expect(summary.totalEarnings).toBe(0);
    expect(summary.byProgramme).toHaveLength(0);
    expect(summary.oldestUnpaidAgeDays).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// verifyAuth — happy + failure paths
// ---------------------------------------------------------------------------

describe('HotmartAdapter.verifyAuth', () => {
  it('returns ok:true and identity when token exchange succeeds', async () => {
    mockFetchQueue([fakeResponse(loadFixture('token.json'))]);
    const r = await hotmartAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('hotmart/client:');
    }
  });

  it('surfaces NetworkErrorEnvelope shape on 401 from token endpoint (§15.4)', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_client"}', {
        status: 401,
        rawBody: '{"error":"invalid_client"}',
      }),
    ]);
    const r = await hotmartAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/HTTP 401|401|invalid_client|auth/i);
    }
  });

  it('returns ok:false (does not throw) on auth failure', async () => {
    mockFetchQueue([fakeResponse('Unauthorized', { status: 401, rawBody: 'Unauthorized' })]);
    await expect(hotmartAdapter.verifyAuth()).resolves.toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('HotmartAdapter.validateCredential', () => {
  it('accepts a non-empty HOTMART_CLIENT_ID without an API call', async () => {
    const r = await hotmartAdapter.validateCredential('HOTMART_CLIENT_ID', 'any-id');
    expect(r.ok).toBe(true);
  });

  it('rejects an empty HOTMART_CLIENT_ID', async () => {
    const r = await hotmartAdapter.validateCredential('HOTMART_CLIENT_ID', '');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('validates HOTMART_CLIENT_SECRET via live token exchange', async () => {
    mockFetchQueue([fakeResponse(loadFixture('token.json'))]);
    const r = await hotmartAdapter.validateCredential(
      'HOTMART_CLIENT_SECRET',
      'test-secret-please-ignore',
    );
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with hint when HOTMART_CLIENT_SECRET is wrong', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_client"}', {
        status: 401,
        rawBody: '{"error":"invalid_client"}',
      }),
    ]);
    const r = await hotmartAdapter.validateCredential('HOTMART_CLIENT_SECRET', 'bad-secret');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('treats HOTMART_BASIC_TOKEN as an optional format-only field', async () => {
    const ok = await hotmartAdapter.validateCredential('HOTMART_BASIC_TOKEN', 'YTpi');
    expect(ok.ok).toBe(true);
    const empty = await hotmartAdapter.validateCredential('HOTMART_BASIC_TOKEN', '');
    expect(empty.ok).toBe(false);
  });

  it('returns ok:false for unknown credential fields', async () => {
    const r = await hotmartAdapter.validateCredential('HOTMART_UNKNOWN_FIELD', 'value');
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
    ]);
    try {
      await hotmartAdapter.listTransactions({});
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('hotmart');
      expect(env.operation).toBe('listTransactions');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream exploded');
    }
  });

  it('classifies 401 on the data API as auth_error', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('token.json')),
      fakeResponse('Forbidden', { status: 401, rawBody: 'Forbidden' }),
    ]);
    try {
      await hotmartAdapter.listTransactions({});
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

describe('HotmartAdapter.capabilitiesCheck', () => {
  it('records listClicks and generateTrackingLink as not supported', async () => {
    // capabilitiesCheck probes verifyAuth first, which force-refreshes and caches
    // a 24h token. Every subsequent data probe (listProgrammes, listTransactions,
    // getEarningsSummary) reuses that cached token, so only ONE token fetch
    // happens; the remaining queue entries are the three data responses.
    mockFetchQueue([
      fakeResponse(loadFixture('token.json')), // verifyAuth force-refresh → cached
      fakeResponse(loadFixture('sales_history_empty.json')), // listProgrammes data
      fakeResponse(loadFixture('sales_history_empty.json')), // listTransactions data
      fakeResponse(loadFixture('sales_history_empty.json')), // getEarningsSummary data
    ]);
    const caps = await hotmartAdapter.capabilitiesCheck();
    expect(caps.network).toBe('hotmart');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
    expect(caps.operations['listProgrammes']?.supported).toBe(true);
    expect(caps.operations['listTransactions']?.supported).toBe(true);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
