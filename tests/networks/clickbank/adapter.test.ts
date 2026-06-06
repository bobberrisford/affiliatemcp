/**
 * ClickBank adapter — unit tests.
 *
 * Mirrors the Awin test patterns:
 *   - We mock `globalThis.fetch` directly (the adapter ↔ network seam) so the
 *     full client + resilience + transformer stack runs with no live HTTP.
 *   - Each test stubs only the responses it needs.
 *
 * ClickBank specifics exercised here:
 *   - Custom `Authorization: DEV:CLERK` header (via the client).
 *   - `Page`-header pagination: `fetchOrders` walks pages until it sees an
 *     empty page, so the orders queue is [fixturePage, emptyPage] per slice.
 *   - Refunds (RFND) and chargebacks (CGBK) normalise to 'reversed'.
 *   - HopLink deterministic construction (no fetch).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { clickbankAdapter, _internals } from '../../../src/networks/clickbank/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'clickbank');

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

/** An empty orders page terminates `fetchOrders` pagination for a slice. */
function emptyOrdersPage(): Response {
  return fakeResponse({ orderData: [] });
}

beforeEach(() => {
  _resetBreakers();
  process.env['CLICKBANK_DEV_KEY'] = 'DEV-test-please-ignore';
  process.env['CLICKBANK_CLERK_KEY'] = 'API-test-please-ignore';
  process.env['CLICKBANK_NICKNAME'] = 'myacct';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['CLICKBANK_DEV_KEY'];
  delete process.env['CLICKBANK_CLERK_KEY'];
  delete process.env['CLICKBANK_NICKNAME'];
});

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

describe('ClickBank transformers (status normalisation, raw preservation)', () => {
  it('maps SALE/BILL → approved and RFND/CGBK → reversed', () => {
    expect(_internals.mapTransactionStatus({ transactionType: 'SALE' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ transactionType: 'BILL' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ transactionType: 'RFND' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ transactionType: 'CGBK' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ transactionType: 'FEE' })).toBe('other');
    expect(_internals.mapTransactionStatus({ transactionType: 'TEST_SALE' })).toBe('other');
    expect(_internals.mapTransactionStatus({})).toBe('other');
  });

  it('preserves the raw ClickBank order under rawNetworkData', () => {
    const orders = (loadFixture('orders.json') as { orderData: Array<Record<string, unknown>> })
      .orderData;
    const out = _internals.toTransaction(orders[0] as never);
    expect(out.rawNetworkData).toBe(orders[0]);
  });

  it('surfaces a reversal reason carrying the raw transaction type', () => {
    const out = _internals.toTransaction({
      receipt: 'X1',
      transactionType: 'RFND',
      transactionTime: '2025-08-01T09:30:00Z',
      vendor: 'atollsbooks',
    } as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toContain('RFND');
  });

  it('computes ageDays from transactionTime', () => {
    const now = new Date('2026-06-05T00:00:00Z');
    const age = _internals.computeAgeDays({ transactionTime: '2026-05-06T00:00:00Z' }, now);
    expect(age).toBe(30);
  });

  it('reads orderData arrays and bare arrays alike', () => {
    expect(_internals.ordersOf({ orderData: [{ receipt: 'a' }] }).length).toBe(1);
    expect(_internals.ordersOf([{ receipt: 'a' }, { receipt: 'b' }] as never).length).toBe(2);
    expect(_internals.ordersOf(undefined).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('ClickBank.listTransactions', () => {
  it('returns transactions across vendors with refunds/chargebacks reversed (§15.10)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('orders.json')), emptyOrdersPage()]);
    const all = await clickbankAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2024-03-01T00:00:00Z',
    });
    expect(all.length).toBe(5);
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(2); // RFND + CGBK
    expect(reversed.every((t) => (t.reversalReason ?? '').length > 0)).toBe(true);
  });

  it('filters by vendor (programmeId) client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('orders.json')), emptyOrdersPage()]);
    const only = await clickbankAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2024-03-01T00:00:00Z',
      programmeId: 'reefvendor',
    });
    expect(only.length).toBe(2);
    expect(only.every((t) => t.programmeId === 'reefvendor')).toBe(true);
  });

  it('applies minAgeDays after status filtering (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('orders.json')), emptyOrdersPage()]);
    const aged = await clickbankAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2024-03-01T00:00:00Z',
      status: ['approved'],
      minAgeDays: 365,
    });
    expect(aged.length).toBeGreaterThan(0);
    expect(aged.every((t) => t.status === 'approved' && t.ageDays >= 365)).toBe(true);
  });

  it('emits a NetworkError when a key is missing (§15.4)', async () => {
    delete process.env['CLICKBANK_CLERK_KEY'];
    await expect(clickbankAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes / getProgramme (synthesised from order history)
// ---------------------------------------------------------------------------

describe('ClickBank.listProgrammes (synthesised per vendor)', () => {
  it('synthesises one joined programme per distinct vendor', async () => {
    mockFetchQueue([fakeResponse(loadFixture('orders.json')), emptyOrdersPage()]);
    const programmes = await clickbankAdapter.listProgrammes();
    const ids = programmes.map((p) => p.id).sort();
    expect(ids).toEqual(['atollsbooks', 'reefvendor']);
    expect(programmes.every((p) => p.status === 'joined')).toBe(true);
    expect(programmes.every((p) => p.network === 'clickbank')).toBe(true);
  });

  it('rejects a malformed vendor nickname in getProgramme', async () => {
    await expect(clickbankAdapter.getProgramme('not a nickname!')).rejects.toBeInstanceOf(
      NetworkError,
    );
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('ClickBank.getEarningsSummary', () => {
  it('aggregates commission by status and by programme', async () => {
    mockFetchQueue([fakeResponse(loadFixture('orders.json')), emptyOrdersPage()]);
    const summary = await clickbankAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2024-03-01T00:00:00Z',
    });
    expect(summary.network).toBe('clickbank');
    // approved: 24.5 + 12.0 + 40.0 = 76.5 ; reversed: -30.0 + -18.0 = -48.0
    expect(summary.byStatus.approved).toBeCloseTo(76.5, 5);
    expect(summary.byStatus.reversed).toBeCloseTo(-48.0, 5);
    expect(summary.byProgramme.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// listClicks
// ---------------------------------------------------------------------------

describe('ClickBank.listClicks', () => {
  it('throws NotImplementedError with the documented reason', async () => {
    await expect(clickbankAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await clickbankAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('does not expose click-level data');
    }
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — deterministic HopLink
// ---------------------------------------------------------------------------

describe('ClickBank.generateTrackingLink', () => {
  it('constructs a HopLink host from affiliate + vendor and does not call fetch', async () => {
    const spy = mockFetchQueue([]);
    const link = await clickbankAdapter.generateTrackingLink({
      programmeId: 'reefvendor',
      destinationUrl: 'https://reef.example.com/course?q=a b',
    });
    expect(link.trackingUrl).toContain('https://myacct.reefvendor.hop.clickbank.net');
    // destination is URL-encoded onto the url parameter
    expect(link.trackingUrl).toContain('url=https%3A%2F%2Freef.example.com%2Fcourse%3Fq%3Da%20b');
    expect(link.network).toBe('clickbank');
    expect(link.programmeId).toBe('reefvendor');
    expect(spy.mock.calls.length).toBe(0);
  });

  it('throws a config_error when the vendor (programmeId) is missing', async () => {
    await expect(
      clickbankAdapter.generateTrackingLink({ programmeId: '', destinationUrl: 'https://x.example.com' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error when the affiliate nickname is not configured', async () => {
    delete process.env['CLICKBANK_NICKNAME'];
    await expect(
      clickbankAdapter.generateTrackingLink({
        programmeId: 'reefvendor',
        destinationUrl: 'https://x.example.com',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('ClickBank.verifyAuth', () => {
  it('returns ok:true and a nickname identity when quickstats responds 200', async () => {
    mockFetchQueue([fakeResponse(loadFixture('quickstats-count.json'))]);
    const r = await clickbankAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toContain('clickbank/myacct');
  });

  it('returns ok:false on a 401', async () => {
    mockFetchQueue([fakeResponse('{"error":"unauthorized"}', { status: 401 })]);
    const r = await clickbankAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/401/);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('ClickBank.validateCredential', () => {
  it('rejects malformed nicknames', async () => {
    const r = await clickbankAdapter.validateCredential('CLICKBANK_NICKNAME', 'Has Space!');
    expect(r.ok).toBe(false);
  });

  it('accepts a well-formed nickname', async () => {
    const r = await clickbankAdapter.validateCredential('CLICKBANK_NICKNAME', 'myacct');
    expect(r.ok).toBe(true);
  });

  it('validates a key by calling quickstats', async () => {
    mockFetchQueue([fakeResponse(loadFixture('quickstats-count.json'))]);
    const r = await clickbankAdapter.validateCredential('CLICKBANK_DEV_KEY', 'DEV-fresh');
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with a hint when a key fails to validate', async () => {
    mockFetchQueue([fakeResponse('{"error":"bad"}', { status: 401 })]);
    const r = await clickbankAdapter.validateCredential('CLICKBANK_CLERK_KEY', 'API-bad');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('ClickBank.capabilitiesCheck', () => {
  it('records listClicks.supported = false with the known-limitation note', async () => {
    // Probes: listProgrammes (2 fetches: page+empty), listTransactions (2),
    // getEarningsSummary → listTransactions (2), verifyAuth (1).
    mockFetchQueue([
      fakeResponse({ orderData: [] }),
      fakeResponse({ orderData: [] }),
      fakeResponse({ orderData: [] }),
      fakeResponse({ orderData: [] }),
      fakeResponse({ orderData: [] }),
      fakeResponse({ orderData: [] }),
      fakeResponse(loadFixture('quickstats-count.json')),
    ]);
    const caps = await clickbankAdapter.capabilitiesCheck();
    expect(caps.network).toBe('clickbank');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['listClicks']?.note).toContain('click-level data');
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim ClickBank body on a 500', async () => {
    const body = '{"error":"upstream broke","trace":"xyz"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await clickbankAdapter.listTransactions({ from: '2024-01-01', to: '2024-02-01' });
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('clickbank');
      expect(env.operation).toBe('listTransactions');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream broke');
    }
  });

  it('classifies 401 as auth_error', async () => {
    mockFetchQueue([fakeResponse('forbidden', { status: 401, rawBody: 'forbidden' })]);
    try {
      await clickbankAdapter.listTransactions({ from: '2024-01-01', to: '2024-02-01' });
      throw new Error('expected to throw');
    } catch (err) {
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('auth_error');
    }
  });
});
