/**
 * ValueCommerce pagination — limit/offset paging to completion (#316).
 *
 * The affiliate Order Report API pages with ?limit=N&offset=N (limit capped at
 * the documented 1000) and exposes no confirmed total-count field, so a page
 * shorter than the requested page size is the termination rule. These tests
 * prove the three contract points required to remove value-commerce from
 * `src/tools/paging-exclusions.ts`:
 *
 *   1. an absent `limit` pulls the COMPLETE result set across pages
 *      (limit=1000, offset stepped by 1000, stopping on the short page);
 *   2. the MAX_PAGES backstop stops a never-ending upstream and logs a
 *      warning (stderr), so a truncated pull is never silent;
 *   3. a present `limit` short-circuits once satisfied — normally the same
 *      single request the pre-pagination adapter sent.
 *
 * Same mocking pattern as `adapter.test.ts`: `globalThis.fetch` is replaced so
 * the full client + resilience + XML parser stack runs with no live HTTP. The
 * token call (JSON) always comes first; data responses are XML. Fixtures under
 * `tests/fixtures/value-commerce/`: transactions-page1.json is a full
 * 1000-row page (signalling a continuation); transactions-page2.json is a
 * short page introducing merchant 3003, which never appears on page 1.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { valueCommerceAdapter, _internals } from '../../../src/networks/value-commerce/adapter.js';
import { _resetTokenCache } from '../../../src/networks/value-commerce/auth.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'value-commerce');

function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function loadXml(name: string): string {
  return (loadJson(name) as { xml: string }).xml;
}

function xmlResponse(rawBody: string): Response {
  return new Response(rawBody, {
    status: 200,
    headers: { 'content-type': 'application/xml' },
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Queue-backed fetch mock that records each requested URL. */
function mockFetchQueue(responses: Response[]): { urls: string[] } {
  const urls: string[] = [];
  const spy = vi.fn(async (input: string | URL | Request) => {
    urls.push(typeof input === 'string' ? input : input.toString());
    const r = responses.shift();
    if (!r) throw new Error('mock fetch queue exhausted');
    return r;
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return { urls };
}

/** Extract a query parameter from a recorded request URL. */
function param(url: string | undefined, name: string): string | null {
  return new URL(String(url)).searchParams.get(name);
}

const WINDOW = { from: '2026-04-01T00:00:00Z', to: '2026-05-01T00:00:00Z' };

beforeEach(() => {
  _resetBreakers();
  _resetTokenCache();
  process.env['VALUE_COMMERCE_CLIENT_KEY'] = 'test-client-key-please-ignore';
  process.env['VALUE_COMMERCE_CLIENT_SECRET'] = 'test-client-secret-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['VALUE_COMMERCE_CLIENT_KEY'];
  delete process.env['VALUE_COMMERCE_CLIENT_SECRET'];
  _resetTokenCache();
});

describe('ValueCommerce.listTransactions pagination (#316)', () => {
  it('pulls the complete result set across pages when limit is absent', async () => {
    const { urls } = mockFetchQueue([
      jsonResponse(loadJson('token.json')),
      xmlResponse(loadXml('transactions-page1.json')),
      xmlResponse(loadXml('transactions-page2.json')),
    ]);

    const txns = await valueCommerceAdapter.listTransactions(WINDOW);

    // Token call + two data pages; page 2's short page ends the loop.
    expect(urls).toHaveLength(3);
    expect(param(urls[1], 'limit')).toBe(String(_internals.MAX_LIMIT));
    expect(param(urls[1], 'offset')).toBe('0');
    expect(param(urls[2], 'limit')).toBe(String(_internals.MAX_LIMIT));
    expect(param(urls[2], 'offset')).toBe(String(_internals.MAX_LIMIT));
    // Every page keeps the date window.
    expect(param(urls[2], 'from_date')).toBe('2026-04-01');
    expect(param(urls[2], 'to_date')).toBe('2026-05-01');

    expect(txns).toHaveLength(_internals.MAX_LIMIT + 3);
    // Merchant 3003 appears only on page 2 — the full pull reached it.
    expect(txns.some((t) => t.programmeId === '3003')).toBe(true);
  });

  it('stops at the MAX_PAGES backstop with a logged warning, never silently', async () => {
    const warn = vi.spyOn(_internals.log, 'warn').mockImplementation(() => undefined);
    const fullPage = loadXml('transactions-page1.json');
    // Token + exactly MAX_PAGES full pages: a further fetch would exhaust the
    // mock queue and reject, so reaching the assertion also proves the cap.
    mockFetchQueue([
      jsonResponse(loadJson('token.json')),
      ...Array.from({ length: _internals.MAX_PAGES }, () => xmlResponse(fullPage)),
    ]);

    const txns = await valueCommerceAdapter.listTransactions(WINDOW);

    expect(txns).toHaveLength(_internals.MAX_PAGES * _internals.MAX_LIMIT);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      operation: 'listTransactions',
      cap: _internals.MAX_PAGES,
    });
    expect(warn.mock.calls[0]?.[1]).toContain('MAX_PAGES');
  });

  it('short-circuits after one request when the limit is already satisfied', async () => {
    // Only the token and one data response are queued: a second data fetch
    // would reject, so this also proves the limit path sends the same single
    // request the pre-pagination adapter sent.
    const { urls } = mockFetchQueue([
      jsonResponse(loadJson('token.json')),
      xmlResponse(loadXml('transactions-page1.json')),
    ]);

    const txns = await valueCommerceAdapter.listTransactions({ ...WINDOW, limit: 2 });

    expect(urls).toHaveLength(2);
    expect(param(urls[1], 'limit')).toBe('2');
    expect(param(urls[1], 'offset')).toBe('0');
    expect(txns).toHaveLength(2);
  });

  it('keeps paging when the limit is not yet satisfied by page one', async () => {
    mockFetchQueue([
      jsonResponse(loadJson('token.json')),
      xmlResponse(loadXml('transactions-page1.json')),
      xmlResponse(loadXml('transactions-page2.json')),
    ]);

    // Page one carries MAX_LIMIT rows; a limit above that needs page two.
    const txns = await valueCommerceAdapter.listTransactions({
      ...WINDOW,
      limit: _internals.MAX_LIMIT + 2,
    });

    expect(txns).toHaveLength(_internals.MAX_LIMIT + 2);
  });

  it('treats an empty first page as a complete (empty) result', async () => {
    const { urls } = mockFetchQueue([
      jsonResponse(loadJson('token.json')),
      xmlResponse(loadXml('transactions_empty.json')),
    ]);

    const txns = await valueCommerceAdapter.listTransactions(WINDOW);

    expect(urls).toHaveLength(2);
    expect(txns).toEqual([]);
  });
});
