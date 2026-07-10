/**
 * FlexOffers adapter — pagination tests (#316: lift the offset-paging exclusion).
 *
 * Proves the contract points required to remove flexoffers from
 * `src/tools/paging-exclusions.ts`:
 *
 *   1. an absent `limit` pulls the COMPLETE result set across pages, sending
 *      an explicit 1-based `page` and `pageSize=500` on every request (never
 *      relying on the unconfirmed server default) and stopping on the first
 *      short page;
 *   2. the MAX_PAGES backstop stops a runaway loop and logs a stderr warning
 *      so a truncated pull is never silent;
 *   3. a present `limit` short-circuits as soon as enough matching rows are
 *      collected — one request when page one satisfies it, more pages when a
 *      client-side filter leaves it unsatisfied.
 *
 * Same mocking pattern as `adapter.test.ts`: `globalThis.fetch` is replaced so
 * the full client + resilience + transformer stack runs with no live HTTP.
 * Fixtures are scrubbed synthetic /allsales pages under
 * `tests/fixtures/flexoffers/` — page one carries exactly PAGE_SIZE (500) rows
 * so the short-page stop condition sees a full page and continues.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { flexoffersAdapter, _internals } from '../../../src/networks/flexoffers/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'flexoffers');

const PAGE_SIZE = _internals.PAGE_SIZE;
const MAX_PAGES = _internals.MAX_PAGES;

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Queue mock fetch responses and record each request URL so tests can assert
 * which `page` / `pageSize` each call actually sent.
 */
function mockFetchQueue(responses: Response[]): { calls: string[] } {
  const calls: string[] = [];
  const spy = vi.fn(async (url: unknown) => {
    calls.push(String(url));
    const r = responses.shift();
    if (!r) throw new Error('mock fetch queue exhausted');
    return r;
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return { calls };
}

/** Extract a query parameter from a recorded request URL. */
function param(url: string | undefined, name: string): string | null {
  return new URL(String(url)).searchParams.get(name);
}

/** One synthetic /allsales page with `n` rows, all in the given status. */
function salesPage(prefix: string, n: number, status = 'pending'): unknown {
  return {
    totalCount: 999_999,
    sales: Array.from({ length: n }, (_, i) => ({
      saleId: `FO-${prefix}-${i + 1}`,
      advertiserId: '5001',
      advertiserName: 'Example Outdoors Inc',
      status,
      saleAmount: '20.00',
      commission: '1.00',
      currency: 'USD',
      clickDate: '2026-02-01T09:00:00Z',
      saleDate: '2026-02-01T09:30:00Z',
    })),
  };
}

const WINDOW = { from: '2026-01-01T00:00:00Z', to: '2026-06-04T00:00:00Z' };

beforeEach(() => {
  _resetBreakers();
  process.env['FLEXOFFERS_API_KEY'] = 'test-api-key-please-ignore';
  process.env['FLEXOFFERS_ACCOUNT_ID'] = '123456';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['FLEXOFFERS_API_KEY'];
  delete process.env['FLEXOFFERS_ACCOUNT_ID'];
});

// ---------------------------------------------------------------------------
// Full pull across pages when `limit` is absent
// ---------------------------------------------------------------------------

describe('FlexoffersAdapter.listTransactions pagination — full pull on absent limit', () => {
  it('pulls the complete sales list across pages, stopping on the short page', async () => {
    const { calls } = mockFetchQueue([
      fakeResponse(loadFixture('sales-page1.json')), // 500 rows — full page
      fakeResponse(loadFixture('sales-page2.json')), // 3 rows — short page ends the loop
    ]);

    const txns = await flexoffersAdapter.listTransactions(WINDOW);

    expect(txns).toHaveLength(503);
    expect(txns[0]?.id).toBe('FO-P1-0001');
    expect(txns[499]?.id).toBe('FO-P1-0500');
    expect(txns[502]?.id).toBe('FO-P2-0003');
    expect(calls).toHaveLength(2);
    // Explicit 1-based page and pageSize=500 on EVERY request — the pull never
    // relies on the unconfirmed server default page size.
    expect(param(calls[0], 'page')).toBe('1');
    expect(param(calls[0], 'pageSize')).toBe(String(PAGE_SIZE));
    expect(param(calls[1], 'page')).toBe('2');
    expect(param(calls[1], 'pageSize')).toBe(String(PAGE_SIZE));
    // Every page keeps the date window.
    expect(param(calls[1], 'startDate')).toBe('2026-01-01');
    expect(param(calls[1], 'endDate')).toBe('2026-06-04');
    expect(param(calls[1], 'reportType')).toBe('details');
  });

  it('stops after one request when the first page is short', async () => {
    // The original 4-row fixture is well under PAGE_SIZE, so the report is
    // exhausted after a single request.
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('sales.json'))]);
    const txns = await flexoffersAdapter.listTransactions(WINDOW);
    expect(txns).toHaveLength(4);
    expect(calls).toHaveLength(1);
    expect(param(calls[0], 'page')).toBe('1');
    expect(param(calls[0], 'pageSize')).toBe(String(PAGE_SIZE));
  });

  it('applies client-side filters across the whole multi-page pull', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('sales-page1.json')),
      fakeResponse(loadFixture('sales-page2.json')),
    ]);
    // Page one cycles pending/approved/paid/canceled, so a quarter of its 500
    // rows are canceled → 'reversed'; page two (P2 rows 1-3) adds one more.
    const reversed = await flexoffersAdapter.listTransactions({
      ...WINDOW,
      status: ['reversed'],
    });
    expect(reversed.length).toBeGreaterThan(100);
    expect(reversed.every((t) => t.status === 'reversed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Caller-supplied `limit` short-circuits
// ---------------------------------------------------------------------------

describe('FlexoffersAdapter.listTransactions pagination — limit short-circuits', () => {
  it('stops after the first page once the limit is satisfied', async () => {
    // A second request would exhaust the single-response queue and fail.
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('sales-page1.json'))]);
    const txns = await flexoffersAdapter.listTransactions({ ...WINDOW, limit: 10 });
    expect(txns).toHaveLength(10);
    expect(calls).toHaveLength(1);
    // The explicit pageSize is still sent — never the server default.
    expect(param(calls[0], 'pageSize')).toBe(String(PAGE_SIZE));
  });

  it('keeps paging when the limit is not yet satisfied by page one', async () => {
    const { calls } = mockFetchQueue([
      fakeResponse(loadFixture('sales-page1.json')),
      fakeResponse(loadFixture('sales-page2.json')),
    ]);
    const txns = await flexoffersAdapter.listTransactions({ ...WINDOW, limit: 502 });
    expect(txns).toHaveLength(502);
    expect(calls).toHaveLength(2);
  });

  it('keeps paging when a client-side filter leaves the limit unsatisfied', async () => {
    // Page one is full but contains no paid rows; the matching row only
    // appears on the short page two. A raw-row short-circuit would have
    // stopped after page one and returned nothing.
    const { calls } = mockFetchQueue([
      fakeResponse(salesPage('FULL', PAGE_SIZE, 'pending')),
      fakeResponse(salesPage('TAIL', 2, 'paid')),
    ]);
    const txns = await flexoffersAdapter.listTransactions({
      ...WINDOW,
      status: ['paid'],
      limit: 1,
    });
    expect(txns).toHaveLength(1);
    expect(txns[0]?.status).toBe('paid');
    expect(calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// MAX_PAGES backstop
// ---------------------------------------------------------------------------

describe('FlexoffersAdapter.listTransactions pagination — MAX_PAGES backstop', () => {
  it('caps a runaway pull at MAX_PAGES and logs a warning, never silently', async () => {
    const warnSpy = vi.spyOn(_internals.log, 'warn').mockImplementation(() => undefined);
    // Every page comes back full, so the loop would run forever without the
    // cap. Queue exactly MAX_PAGES responses: a further request would exhaust
    // the mock queue and fail the test.
    const { calls } = mockFetchQueue(
      Array.from({ length: MAX_PAGES }, (_, i) => fakeResponse(salesPage(`C${i + 1}`, PAGE_SIZE))),
    );

    const txns = await flexoffersAdapter.listTransactions(WINDOW);

    expect(calls).toHaveLength(MAX_PAGES);
    expect(txns).toHaveLength(MAX_PAGES * PAGE_SIZE);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [bindings, message] = warnSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(bindings['operation']).toBe('listTransactions');
    expect(bindings['cap']).toBe(MAX_PAGES);
    expect(bindings['fetched']).toBe(MAX_PAGES * PAGE_SIZE);
    expect(message).toMatch(/MAX_PAGES cap.*truncated/);
  });
});
