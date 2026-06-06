/**
 * ShopMy adapter — unit tests.
 *
 * Mirrors the Awin test patterns:
 *   - Mock `globalThis.fetch` directly to exercise the full client + resilience
 *     + transformer stack with no live HTTP.
 *   - Each test stubs only the responses it needs.
 *
 * Notes specific to ShopMy:
 *   - listTransactions pages within each date slice until a short page; the
 *     order-report fixture is shorter than the 500-record page size, so a
 *     single fetch per slice ends pagination.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { shopmyAdapter, _internals } from '../../../src/networks/shopmy/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'shopmy');

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
  process.env['SHOPMY_API_TOKEN'] = 'test-token-please-ignore';
  process.env['SHOPMY_BRAND_NAME'] = 'Acme';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['SHOPMY_API_TOKEN'];
  delete process.env['SHOPMY_BRAND_NAME'];
});

// ---------------------------------------------------------------------------
// Transformation (status mapping + raw preservation + amount unit)
// ---------------------------------------------------------------------------

describe('ShopMy transformers', () => {
  it('maps ShopMy pending|locked|paid|cancelled → canonical statuses', () => {
    expect(_internals.mapTransactionStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'locked' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'paid' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ status: 'cancelled' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'returned' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'never-seen' })).toBe('other');
  });

  it('treats amounts as cents and divides by 100', () => {
    expect(_internals.centsToMajor(1800)).toBe(18);
    const t = _internals.toTransaction(
      { id: 'x', status: 'locked', order_amount: 12000, commission_amount: 1800 },
      'Acme',
      'Acme',
    );
    expect(t.amount).toBe(120);
    expect(t.commission).toBe(18);
    expect(t.currency).toBe('USD');
  });

  it('preserves the raw ShopMy order under rawNetworkData', () => {
    const raw = { id: 'x', status: 'paid', commission_amount: 1000 };
    const out = _internals.toTransaction(raw, 'Acme', 'Acme');
    expect(out.rawNetworkData).toBe(raw);
  });

  it('computes ageDays from locked_date (preferred) then transaction_date', () => {
    const now = new Date('2026-06-06T00:00:00Z');
    const age1 = _internals.computeAgeDays(
      { transaction_date: '2026-01-02T00:00:00Z', locked_date: '2026-02-05T00:00:00Z' },
      now,
    );
    expect(age1).toBe(121);
    const age2 = _internals.computeAgeDays({ transaction_date: '2026-05-07T00:00:00Z' }, now);
    expect(age2).toBe(30);
  });

  it('unwraps the order report envelope (orders / array)', () => {
    expect(_internals.unwrapOrders({ orders: [{ id: '1' }] }).length).toBe(1);
    expect(_internals.unwrapOrders([{ id: '1' }, { id: '2' }]).length).toBe(2);
    expect(_internals.unwrapOrders({}).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes / getProgramme — single synthetic brand
// ---------------------------------------------------------------------------

describe('ShopMy.listProgrammes / getProgramme', () => {
  it('returns the single configured brand as one joined programme', async () => {
    const spy = mockFetchQueue([]);
    const programmes = await shopmyAdapter.listProgrammes();
    expect(programmes.length).toBe(1);
    expect(programmes[0]?.status).toBe('joined');
    expect(programmes[0]?.name).toBe('Acme');
    // No network call — the brand is derived from credentials.
    expect(spy.mock.calls.length).toBe(0);
  });

  it('getProgramme returns the same configured brand', async () => {
    const p = await shopmyAdapter.getProgramme('anything');
    expect(p.network).toBe('shopmy');
    expect(p.id).toBe('Acme');
  });

  it('throws a NetworkError when the token is missing', async () => {
    delete process.env['SHOPMY_API_TOKEN'];
    await expect(shopmyAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('ShopMy.listTransactions', () => {
  it('maps order rows and filters by status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('order-report.json'))]);
    const reversed = await shopmyAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-28T00:00:00Z',
      status: ['reversed'],
    });
    // The single 27-day window means one fetch; the fixture is < 500 rows so
    // pagination ends after one page.
    expect(reversed.every((t) => t.status === 'reversed')).toBe(true);
  });

  it('applies minAgeDays after status mapping (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('order-report.json'))]);
    const aged = await shopmyAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-28T00:00:00Z',
      minAgeDays: 90,
    });
    for (const t of aged) {
      expect(t.ageDays).toBeGreaterThanOrEqual(90);
    }
  });

  it('chunks date ranges wider than 31 days into multiple calls', async () => {
    const spy = mockFetchQueue([fakeResponse([]), fakeResponse([]), fakeResponse([])]);
    await shopmyAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-03-31T00:00:00Z',
    });
    expect(spy.mock.calls.length).toBe(3);
  });

  it('emits an error envelope when the token is missing', async () => {
    delete process.env['SHOPMY_API_TOKEN'];
    await expect(shopmyAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('ShopMy.getEarningsSummary', () => {
  it('aggregates commission by status and surfaces oldest unpaid age', async () => {
    mockFetchQueue([fakeResponse(loadFixture('order-report.json'))]);
    const summary = await shopmyAdapter.getEarningsSummary({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-28T00:00:00Z',
    });
    expect(summary.network).toBe('shopmy');
    expect(summary.currency).toBe('USD');
    // Commission totals are in major units (cents / 100).
    expect(summary.totalEarnings).toBeGreaterThan(0);
    // The locked Jan order is approved-but-unpaid, so an unpaid age is recorded.
    expect(summary.oldestUnpaidAgeDays).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// listClicks / generateTrackingLink — NotImplemented
// ---------------------------------------------------------------------------

describe('ShopMy unsupported operations', () => {
  it('listClicks throws NotImplementedError with the documented reason', async () => {
    await expect(shopmyAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await shopmyAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click-level data');
    }
  });

  it('generateTrackingLink throws NotImplementedError citing the OAuth requirement', async () => {
    await expect(
      shopmyAdapter.generateTrackingLink({ programmeId: 'Acme', destinationUrl: 'https://x.example.com' }),
    ).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await shopmyAdapter.generateTrackingLink({
        programmeId: 'Acme',
        destinationUrl: 'https://x.example.com',
      });
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('write_links');
    }
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('ShopMy.verifyAuth', () => {
  it('returns ok:true with identity when the order report responds 200', async () => {
    mockFetchQueue([fakeResponse({ orders: [] })]);
    const r = await shopmyAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toContain('shopmy/Acme');
  });

  it('returns ok:false on 401', async () => {
    mockFetchQueue([fakeResponse('{"error":"invalid_token"}', { status: 401 })]);
    const r = await shopmyAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/401/);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('ShopMy.validateCredential', () => {
  it('validates SHOPMY_API_TOKEN by probing the order report', async () => {
    mockFetchQueue([fakeResponse({ orders: [] })]);
    const r = await shopmyAdapter.validateCredential('SHOPMY_API_TOKEN', 'fresh-token');
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with a hint when the token fails to validate', async () => {
    mockFetchQueue([fakeResponse('{"error":"bad"}', { status: 401 })]);
    const r = await shopmyAdapter.validateCredential('SHOPMY_API_TOKEN', 'bad-token');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('rejects an empty brand-name label but accepts a non-empty one', async () => {
    expect((await shopmyAdapter.validateCredential('SHOPMY_BRAND_NAME', '')).ok).toBe(false);
    expect((await shopmyAdapter.validateCredential('SHOPMY_BRAND_NAME', 'Acme')).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('ShopMy.capabilitiesCheck', () => {
  it('records listClicks and generateTrackingLink as unsupported', async () => {
    mockFetchQueue([
      fakeResponse({ orders: [] }), // listTransactions probe
      fakeResponse({ orders: [] }), // getEarningsSummary → listTransactions
      fakeResponse({ orders: [] }), // verifyAuth
    ]);
    const caps = await shopmyAdapter.capabilitiesCheck();
    expect(caps.network).toBe('shopmy');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency
// ---------------------------------------------------------------------------

describe('ShopMy error transparency', () => {
  it('surfaces the verbatim ShopMy response body on a 500', async () => {
    const body = '{"error":"upstream broke","trace":"abc"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await shopmyAdapter.listTransactions({
        from: '2026-05-01T00:00:00Z',
        to: '2026-05-10T00:00:00Z',
      });
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('shopmy');
      expect(env.operation).toBe('listTransactions');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream broke');
    }
  });

  it('classifies 401 as auth_error', async () => {
    mockFetchQueue([fakeResponse('forbidden', { status: 401, rawBody: 'forbidden' })]);
    try {
      await shopmyAdapter.listTransactions({
        from: '2026-05-01T00:00:00Z',
        to: '2026-05-10T00:00:00Z',
      });
      throw new Error('expected to throw');
    } catch (err) {
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('auth_error');
    }
  });
});
