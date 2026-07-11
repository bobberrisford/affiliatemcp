/**
 * Skimlinks listTransactions pagination — unit tests.
 *
 * Proves the #316 exclusion lift: on absent `limit` the adapter pages the
 * commissions endpoint with an explicit limit=600 (the documented maximum)
 * and offset until the response `count` total is reached, the MAX_PAGES
 * backstop stops the loop with a logged warning rather than silently, and an
 * explicit `limit` short-circuits once satisfied. Deterministic: mock fetch
 * queue, reset breakers + token cache, fake creds in env, fixtures from
 * tests/fixtures/skimlinks/.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { skimlinksAdapter, _internals } from '../../../src/networks/skimlinks/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { _resetTokenCache } from '../../../src/networks/skimlinks/auth.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'skimlinks');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Queue mock fetch responses and capture the URLs called. */
function mockFetchQueue(responses: Response[]): {
  spy: ReturnType<typeof vi.fn>;
  urls: string[];
} {
  const urls: string[] = [];
  const spy = vi.fn(async (input: string | URL | Request) => {
    urls.push(typeof input === 'string' ? input : input.toString());
    const r = responses.shift();
    if (!r) throw new Error('mock fetch queue exhausted');
    return r;
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return { spy, urls };
}

/**
 * A page whose `count` total claims far more commissions than any batch
 * delivers — the count-driven loop keeps requesting until MAX_PAGES trips.
 */
function neverEndingPage(): unknown {
  return {
    count: 1_000_000,
    commissions: [
      {
        commissionId: '99999',
        amount: 1.0,
        currency: 'GBP',
        status: 'pending',
        merchantId: '3999',
        merchantName: 'Filler Merchant',
        transactionDate: '2026-04-01T00:00:00Z',
      },
    ],
  };
}

const WINDOW = { from: '2026-03-01T00:00:00Z', to: '2026-05-01T00:00:00Z' };

beforeEach(() => {
  _resetBreakers();
  _resetTokenCache();
  process.env['SKIMLINKS_CLIENT_ID'] = 'test-client-id-please-ignore';
  process.env['SKIMLINKS_CLIENT_SECRET'] = 'test-client-secret-please-ignore';
  process.env['SKIMLINKS_PUBLISHER_ID'] = '123456';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['SKIMLINKS_CLIENT_ID'];
  delete process.env['SKIMLINKS_CLIENT_SECRET'];
  delete process.env['SKIMLINKS_PUBLISHER_ID'];
  _resetTokenCache();
});

describe('SkimlinksAdapter.listTransactions pagination', () => {
  it('pages to completion on absent limit, sending explicit limit=600 and advancing offset', async () => {
    // Page 1 carries 2 of the 4 commissions the `count` total reports; page 2
    // carries the rest. A single-page pull would return only half the window.
    const { spy, urls } = mockFetchQueue([
      fakeResponse(loadFixture('token.json')),
      fakeResponse(loadFixture('commissions-page1.json')),
      fakeResponse(loadFixture('commissions-page2.json')),
    ]);

    const r = await skimlinksAdapter.listTransactions(WINDOW);

    expect(r).toHaveLength(4);
    expect(r.map((t) => t.id)).toEqual(['20001', '20002', '20003', '20004']);
    // Commissions from page 2 are present — proof the loop continued.
    expect(r[3]?.status).toBe('paid');

    // Token exchange + two data requests, no phantom third page.
    expect(spy).toHaveBeenCalledTimes(3);
    // The explicit documented-maximum limit is always sent; never the server
    // default. Offset advances by the number of rows fetched.
    expect(urls[1]).toContain(`limit=${_internals.PAGE_SIZE}`);
    expect(urls[1]).toContain('offset=0');
    expect(urls[2]).toContain(`limit=${_internals.PAGE_SIZE}`);
    expect(urls[2]).toContain('offset=2');
  });

  it('stops after one page when count says the window is complete', async () => {
    // commissions.json reports count=4 and delivers all 4 rows — a second
    // fetch would exhaust the queue and throw.
    const { spy } = mockFetchQueue([
      fakeResponse(loadFixture('token.json')),
      fakeResponse(loadFixture('commissions.json')),
    ]);
    const r = await skimlinksAdapter.listTransactions(WINDOW);
    expect(r).toHaveLength(4);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('stops on an empty page without erroring', async () => {
    const { spy } = mockFetchQueue([
      fakeResponse(loadFixture('token.json')),
      fakeResponse(loadFixture('commissions_empty.json')),
    ]);
    const r = await skimlinksAdapter.listTransactions(WINDOW);
    expect(r).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('caps at MAX_PAGES with a logged warning when count never reconciles', async () => {
    const warn = vi.spyOn(_internals.log, 'warn').mockImplementation(() => undefined);
    const { spy } = mockFetchQueue([
      fakeResponse(loadFixture('token.json')),
      ...Array.from({ length: _internals.MAX_PAGES }, () => fakeResponse(neverEndingPage())),
    ]);

    const r = await skimlinksAdapter.listTransactions(WINDOW);

    // Token exchange + exactly MAX_PAGES data requests, then the backstop.
    expect(spy).toHaveBeenCalledTimes(1 + _internals.MAX_PAGES);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'listTransactions',
        cap: _internals.MAX_PAGES,
        fetched: _internals.MAX_PAGES,
      }),
      expect.stringContaining('MAX_PAGES cap'),
    );
    expect(r).toHaveLength(_internals.MAX_PAGES);
  });

  it('short-circuits once an explicit limit is satisfied', async () => {
    // limit=2 is satisfied by page 1's two rows even though count=4 says more
    // exist upstream — a second data fetch would exhaust the queue and throw.
    const { spy } = mockFetchQueue([
      fakeResponse(loadFixture('token.json')),
      fakeResponse(loadFixture('commissions-page1.json')),
    ]);
    const r = await skimlinksAdapter.listTransactions({ ...WINDOW, limit: 2 });
    expect(r).toHaveLength(2);
    expect(r.map((t) => t.id)).toEqual(['20001', '20002']);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('keeps paging under an explicit limit larger than the first page', async () => {
    const { spy } = mockFetchQueue([
      fakeResponse(loadFixture('token.json')),
      fakeResponse(loadFixture('commissions-page1.json')),
      fakeResponse(loadFixture('commissions-page2.json')),
    ]);
    const r = await skimlinksAdapter.listTransactions({ ...WINDOW, limit: 3 });
    expect(spy).toHaveBeenCalledTimes(3);
    expect(r).toHaveLength(3);
    expect(r.map((t) => t.id)).toEqual(['20001', '20002', '20003']);
  });
});
