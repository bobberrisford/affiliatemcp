/**
 * CAKE listProgrammes pagination — unit tests.
 *
 * The OfferFeed paginates with start_at_row + row_limit. These tests prove the
 * behaviour required to lift the (cake, listProgrammes) offset-paging exclusion
 * (issue #316):
 *   - no `limit` → the adapter steps start_at_row until a short page and
 *     returns the complete feed;
 *   - a full page on every fetch → the MAX_PAGES backstop stops the pull and
 *     logs a warning (truncation is never silent);
 *   - `limit` present → the pull short-circuits after a single fetch, matching
 *     the previous single-fetch behaviour.
 *
 * Fixtures: tests/fixtures/cake/offerfeed-page1.xml (a full page of
 * OFFERFEED_PAGE_SIZE offers) and offerfeed-page2.xml (a short 3-offer page).
 * All values are synthetic; no real instance hosts, keys, or IDs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { cakeAdapter, _internals } from '../../../src/networks/cake/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { supportsOffsetPaging } from '../../../src/tools/paging-exclusions.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'cake');

function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8');
}

/** Mint a fake XML `Response`. */
function fakeResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/xml' } });
}

/**
 * Mock `globalThis.fetch` with a queue of XML bodies. Once the queue drains,
 * subsequent calls return `fallback` (default: the short page-2 fixture, so an
 * unbounded loop would terminate loudly via the call-count assertions rather
 * than hang). Records each requested URL for start_at_row/row_limit assertions.
 */
function mockFetchQueue(
  bodies: string[],
  fallback?: string,
): { spy: ReturnType<typeof vi.fn>; urls: string[] } {
  const urls: string[] = [];
  const spy = vi.fn(async (url: unknown) => {
    urls.push(String(url));
    const body = bodies.shift() ?? fallback ?? loadFixture('offerfeed-page2.xml');
    return fakeResponse(body);
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return { spy, urls };
}

beforeEach(() => {
  _resetBreakers();
  process.env['CAKE_BASE_URL'] = 'https://test-instance.example.com';
  process.env['CAKE_API_KEY'] = 'test-api-key-please-ignore';
  process.env['CAKE_AFFILIATE_ID'] = '12345';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['CAKE_BASE_URL'];
  delete process.env['CAKE_API_KEY'];
  delete process.env['CAKE_AFFILIATE_ID'];
});

describe('CAKE.listProgrammes pagination', () => {
  it('pulls the complete feed across multiple pages when no limit is set', async () => {
    const page1 = loadFixture('offerfeed-page1.xml');
    const page2 = loadFixture('offerfeed-page2.xml');
    const { spy, urls } = mockFetchQueue([page1, page2]);

    const programmes = await cakeAdapter.listProgrammes();

    // Page 1 is a full OFFERFEED_PAGE_SIZE page; page 2 is short (3 offers).
    expect(programmes.length).toBe(_internals.OFFERFEED_PAGE_SIZE + 3);
    expect(spy.mock.calls.length).toBe(2);
    // start_at_row steps by the page size; row_limit stays the page size.
    expect(urls[0]).toContain('start_at_row=1');
    expect(urls[0]).toContain(`row_limit=${_internals.OFFERFEED_PAGE_SIZE}`);
    expect(urls[1]).toContain(`start_at_row=${1 + _internals.OFFERFEED_PAGE_SIZE}`);
    expect(urls[1]).toContain(`row_limit=${_internals.OFFERFEED_PAGE_SIZE}`);
    // Rows from both pages are present.
    expect(programmes.find((p) => p.id === '2001')).toBeDefined();
    expect(programmes.find((p) => p.id === '2103')).toBeDefined();
  });

  it('stops at the MAX_PAGES backstop with a logged warning when every page is full', async () => {
    const page1 = loadFixture('offerfeed-page1.xml');
    // Every fetch returns a full page — the feed never signals an end.
    const { spy } = mockFetchQueue([], page1);
    const warnSpy = vi.spyOn(_internals.log, 'warn').mockImplementation(() => undefined);

    const programmes = await cakeAdapter.listProgrammes();

    expect(spy.mock.calls.length).toBe(_internals.MAX_PAGES);
    expect(programmes.length).toBe(_internals.MAX_PAGES * _internals.OFFERFEED_PAGE_SIZE);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toMatchObject({
      operation: 'listProgrammes',
      cap: _internals.MAX_PAGES,
    });
    expect(String(warnSpy.mock.calls[0]?.[1])).toContain('MAX_PAGES');
  });

  it('short-circuits to a single fetch when a limit is set (backward compatible)', async () => {
    const page1 = loadFixture('offerfeed-page1.xml');
    const { spy, urls } = mockFetchQueue([page1]);
    const warnSpy = vi.spyOn(_internals.log, 'warn').mockImplementation(() => undefined);

    const programmes = await cakeAdapter.listProgrammes({ limit: 5 });

    expect(spy.mock.calls.length).toBe(1);
    // The single fetch requests exactly the old row_limit of min(limit, 500).
    expect(urls[0]).toContain('start_at_row=1');
    expect(urls[0]).toContain('row_limit=5');
    expect(programmes.length).toBe(5);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('keeps paging until a limit beyond one page is satisfied', async () => {
    // limit 600 exceeds the 500-row per-request cap, so the adapter pages in
    // 500-row steps. Build full synthetic pages in-line (a committed 500-row
    // fixture would add noise without adding shape coverage).
    const fullPage = (count: number, startId: number): string => {
      let rows = '';
      for (let i = 0; i < count; i++) {
        const id = startId + i;
        rows += `<offer><offer_id>${id}</offer_id><offer_name>Bulk Offer ${id}</offer_name><offer_status>active</offer_status></offer>`;
      }
      return (
        '<?xml version="1.0" encoding="utf-8"?>' +
        `<offer_feed_response><success>true</success><row_count>${count}</row_count>` +
        `<offers>${rows}</offers></offer_feed_response>`
      );
    };
    const { spy, urls } = mockFetchQueue([fullPage(500, 1), fullPage(500, 501)]);

    const programmes = await cakeAdapter.listProgrammes({ limit: 600 });

    // Two 500-row pages satisfy the limit; no third fetch happens.
    expect(spy.mock.calls.length).toBe(2);
    expect(urls[0]).toContain('start_at_row=1');
    expect(urls[0]).toContain('row_limit=500');
    expect(urls[1]).toContain('start_at_row=501');
    expect(programmes.length).toBe(600);
  });

  it('is no longer excluded from tool-layer offset paging', () => {
    expect(supportsOffsetPaging('cake', 'listProgrammes')).toBe(true);
  });
});
