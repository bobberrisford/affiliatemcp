/**
 * Flipkart Affiliate adapter — unit tests.
 *
 * Mirrors the Awin test patterns:
 *   - We mock `globalThis.fetch` directly (the adapter↔network seam), so the
 *     full client + resilience + transformer stack runs with no live HTTP.
 *   - Each test queues only the fetch responses it needs.
 *
 * Flipkart's orders report is offset-paginated: the adapter keeps fetching
 * pages until a page returns an empty `orderList`. So a single window needs the
 * fixture page followed by an empty page to terminate the loop.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { flipkartAdapter, _internals } from '../../../src/networks/flipkart/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'flipkart');

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

/** An empty orders page terminates the offset-pagination loop for one slice. */
const EMPTY_ORDERS = { orderList: [] };

beforeEach(() => {
  _resetBreakers();
  process.env['FLIPKART_AFFILIATE_ID'] = 'exampleid';
  process.env['FLIPKART_AFFILIATE_TOKEN'] = 'test-token-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['FLIPKART_AFFILIATE_ID'];
  delete process.env['FLIPKART_AFFILIATE_TOKEN'];
});

// ---------------------------------------------------------------------------
// Transformers (status normalisation + raw preservation + ageDays)
// ---------------------------------------------------------------------------

describe('Flipkart transformers', () => {
  it('maps order status pending|tentative|approved|cancelled → canonical', () => {
    expect(_internals.mapOrderStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapOrderStatus({ status: 'tentative' })).toBe('pending');
    expect(_internals.mapOrderStatus({ status: 'approved' })).toBe('approved');
    // cancelled is the user-facing "reversed" state.
    expect(_internals.mapOrderStatus({ status: 'cancelled' })).toBe('reversed');
    expect(_internals.mapOrderStatus({ status: 'something-new' })).toBe('other');
  });

  it('preserves the raw Flipkart order under rawNetworkData', () => {
    const raw = (loadFixture('orders.json') as { orderList: Array<Record<string, unknown>> })
      .orderList[0];
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('reads commission and sale amounts and defaults currency to INR', () => {
    const out = _internals.toTransaction({
      affiliateOrderItemId: 'X',
      status: 'approved',
      sales: { amount: 100 },
      tentativeCommission: { amount: 5 },
      orderDate: '2026-01-01',
    });
    expect(out.amount).toBe(100);
    expect(out.commission).toBe(5);
    expect(out.currency).toBe('INR');
    expect(out.programmeId).toBe(_internals.FLIPKART_PROGRAMME_ID);
  });

  it('computes ageDays from orderDate', () => {
    const now = new Date('2026-05-21T00:00:00Z');
    expect(_internals.computeAgeDays({ orderDate: '2026-01-01' }, now)).toBe(140);
    // No orderDate → 0 (never fabricate an age).
    expect(_internals.computeAgeDays({}, now)).toBe(0);
  });

  it('maps a single canonical status to the Flipkart server-side status param', () => {
    expect(_internals.pickFlipkartStatus(['approved'])).toBe('approved');
    expect(_internals.pickFlipkartStatus(['pending'])).toBe('pending');
    expect(_internals.pickFlipkartStatus(['reversed'])).toBe('cancelled');
    // Mixed or unmappable → no server-side filter (client-side instead).
    expect(_internals.pickFlipkartStatus(['approved', 'pending'])).toBeUndefined();
    expect(_internals.pickFlipkartStatus(['paid'])).toBeUndefined();
    expect(_internals.pickFlipkartStatus(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listProgrammes / getProgramme — single synthetic programme
// ---------------------------------------------------------------------------

describe('Flipkart.listProgrammes', () => {
  it('returns one programme seeded with feed-listing categories', async () => {
    mockFetchQueue([fakeResponse(loadFixture('feed-listing.json'))]);
    const programmes = await flipkartAdapter.listProgrammes();
    expect(programmes.length).toBe(1);
    expect(programmes[0]?.id).toBe('flipkart');
    expect(programmes[0]?.status).toBe('joined');
    expect(programmes[0]?.categories).toEqual(expect.arrayContaining(['mobiles', 'audio', 'books']));
  });

  it('filters by category client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('feed-listing.json'))]);
    const programmes = await flipkartAdapter.listProgrammes({ categories: ['mobiles'] });
    expect(programmes.length).toBe(1);
  });

  it('returns nothing when a status filter excludes the joined programme', async () => {
    mockFetchQueue([fakeResponse(loadFixture('feed-listing.json'))]);
    const programmes = await flipkartAdapter.listProgrammes({ status: 'available' });
    expect(programmes.length).toBe(0);
  });
});

describe('Flipkart.getProgramme', () => {
  it('returns the programme for the canonical id', async () => {
    mockFetchQueue([fakeResponse(loadFixture('feed-listing.json'))]);
    const programme = await flipkartAdapter.getProgramme('flipkart');
    expect(programme.id).toBe('flipkart');
    expect(programme.name).toBe('Flipkart Affiliate');
  });

  it('throws a config_error envelope for an unknown id', async () => {
    await expect(flipkartAdapter.getProgramme('12345')).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listTransactions — pagination, status mapping, age filter (§15.9)
// ---------------------------------------------------------------------------

describe('Flipkart.listTransactions', () => {
  it('returns transactions from the orders report and terminates on an empty page', async () => {
    mockFetchQueue([fakeResponse(loadFixture('orders.json')), fakeResponse(EMPTY_ORDERS)]);
    const txns = await flipkartAdapter.listTransactions({
      from: '2026-03-15T00:00:00Z',
      to: '2026-05-31T00:00:00Z',
    });
    expect(txns.length).toBe(4);
    expect(txns.map((t) => t.status)).toEqual(
      expect.arrayContaining(['approved', 'pending', 'reversed', 'pending']),
    );
  });

  it('pushes a single mappable status filter to the server param', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('orders.json')), fakeResponse(EMPTY_ORDERS)]);
    await flipkartAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-31T00:00:00Z',
      status: ['approved'],
    });
    const firstUrl = String(spy.mock.calls[0]?.[0]);
    expect(firstUrl).toContain('status=approved');
  });

  it('filters by reversed status client-side and surfaces cancelled orders', async () => {
    mockFetchQueue([fakeResponse(loadFixture('orders.json')), fakeResponse(EMPTY_ORDERS)]);
    const reversed = await flipkartAdapter.listTransactions({
      from: '2026-03-15T00:00:00Z',
      to: '2026-05-31T00:00:00Z',
      status: ['reversed'],
    });
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.status).toBe('reversed');
  });

  it('chunks date ranges wider than 90 days into multiple windows', async () => {
    // ~270 days → 3 slices; each slice terminates on its empty page.
    const spy = mockFetchQueue([
      fakeResponse(EMPTY_ORDERS),
      fakeResponse(EMPTY_ORDERS),
      fakeResponse(EMPTY_ORDERS),
    ]);
    await flipkartAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-09-27T00:00:00Z',
    });
    expect(spy.mock.calls.length).toBe(3);
  });

  it('emits an error envelope when a credential is missing', async () => {
    delete process.env['FLIPKART_AFFILIATE_TOKEN'];
    await expect(flipkartAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary — derived client-side
// ---------------------------------------------------------------------------

describe('Flipkart.getEarningsSummary', () => {
  it('aggregates commission by status and programme', async () => {
    mockFetchQueue([fakeResponse(loadFixture('orders.json')), fakeResponse(EMPTY_ORDERS)]);
    const summary = await flipkartAdapter.getEarningsSummary({
      from: '2026-03-15T00:00:00Z',
      to: '2026-05-31T00:00:00Z',
    });
    expect(summary.network).toBe('flipkart');
    expect(summary.currency).toBe('INR');
    // Commission totals: approved 759.96, pending 179.88 + 174.95, reversed 39.92.
    expect(summary.byStatus.approved).toBeCloseTo(759.96, 2);
    expect(summary.byStatus.pending).toBeCloseTo(354.83, 2);
    expect(summary.byStatus.reversed).toBeCloseTo(39.92, 2);
    expect(summary.byProgramme.length).toBe(1);
    expect(summary.byProgramme[0]?.programmeId).toBe('flipkart');
  });
});

// ---------------------------------------------------------------------------
// listClicks — unsupported
// ---------------------------------------------------------------------------

describe('Flipkart.listClicks', () => {
  it('throws NotImplementedError with the documented reason', async () => {
    await expect(flipkartAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await flipkartAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('does not expose click-level data');
    }
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — deterministic affid construction
// ---------------------------------------------------------------------------

describe('Flipkart.generateTrackingLink', () => {
  it('appends affid to the destination URL', async () => {
    const link = await flipkartAdapter.generateTrackingLink({
      programmeId: 'flipkart',
      destinationUrl: 'https://www.flipkart.com/example-product/p/itm123?pid=ABC',
    });
    expect(link.trackingUrl).toContain('affid=exampleid');
    expect(link.trackingUrl).toContain('pid=ABC');
    expect(link.network).toBe('flipkart');
    expect(link.programmeId).toBe('flipkart');
  });

  it('does NOT call fetch (deterministic construction)', async () => {
    const spy = mockFetchQueue([]);
    await flipkartAdapter.generateTrackingLink({
      programmeId: 'flipkart',
      destinationUrl: 'https://www.flipkart.com/x',
    });
    expect(spy.mock.calls.length).toBe(0);
  });

  it('throws a config_error envelope for a stray programmeId', async () => {
    await expect(
      flipkartAdapter.generateTrackingLink({
        programmeId: '999',
        destinationUrl: 'https://www.flipkart.com/x',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error envelope for an invalid destination URL', async () => {
    await expect(
      flipkartAdapter.generateTrackingLink({ programmeId: 'flipkart', destinationUrl: 'not-a-url' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth + validateCredential
// ---------------------------------------------------------------------------

describe('Flipkart.verifyAuth', () => {
  it('returns ok:true and identity when the feed listing responds 200', async () => {
    mockFetchQueue([fakeResponse(loadFixture('feed-listing.json'))]);
    const r = await flipkartAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toContain('flipkart/exampleid');
  });

  it('returns ok:false on a 401 without throwing', async () => {
    mockFetchQueue([fakeResponse('{"error":"unauthorised"}', { status: 401 })]);
    const r = await flipkartAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/401/);
  });
});

describe('Flipkart.validateCredential', () => {
  it('rejects an empty tracking ID', async () => {
    const r = await flipkartAdapter.validateCredential('FLIPKART_AFFILIATE_ID', '   ');
    expect(r.ok).toBe(false);
  });

  it('accepts a well-formed tracking ID', async () => {
    const r = await flipkartAdapter.validateCredential('FLIPKART_AFFILIATE_ID', 'exampleid');
    expect(r.ok).toBe(true);
  });

  it('validates the token against the tracking ID via the feed listing', async () => {
    mockFetchQueue([fakeResponse(loadFixture('feed-listing.json'))]);
    const r = await flipkartAdapter.validateCredential('FLIPKART_AFFILIATE_TOKEN', 'fresh-token');
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with a hint when token validation fails', async () => {
    mockFetchQueue([fakeResponse('{"error":"bad"}', { status: 401 })]);
    const r = await flipkartAdapter.validateCredential('FLIPKART_AFFILIATE_TOKEN', 'bad-token');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim Flipkart response body on a 500', async () => {
    const body = '{"error":"report engine unavailable","trace":"xyz"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await flipkartAdapter.listTransactions({
        from: '2026-01-01T00:00:00Z',
        to: '2026-01-31T00:00:00Z',
      });
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('flipkart');
      expect(env.operation).toBe('listTransactions');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('report engine unavailable');
    }
  });

  it('classifies 401 as auth_error', async () => {
    mockFetchQueue([fakeResponse('forbidden', { status: 401, rawBody: 'forbidden' })]);
    try {
      await flipkartAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('auth_error');
    }
  });
});
