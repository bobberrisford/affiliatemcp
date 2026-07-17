/**
 * Rakuten adapter — pagination tests (#316: lift offset-paging exclusions).
 *
 * Proves the three contract points required to remove rakuten from
 * `src/tools/paging-exclusions.ts`:
 *
 *   1. an absent `limit` pulls the COMPLETE programme list across pages
 *      (1-based `page` + `page_size` params, stepping until a short page);
 *   2. the MAX_PAGES backstop stops the loop and logs a warning so a
 *      truncated pull is never silent;
 *   3. a present `limit` short-circuits after the first page that satisfies
 *      it — the same single request the pre-pagination adapter sent.
 *
 * Same mocking pattern as `adapter.test.ts`: `globalThis.fetch` is replaced
 * so the full client + token cache + resilience + transformer stack runs with
 * no live HTTP. Every queue starts with a token-exchange response because the
 * Rakuten client fetches a bearer token before the first data call. Fixtures
 * are scrubbed approximations of Rakuten API responses under
 * `tests/fixtures/rakuten/`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { rakutenAdapter, _internals } from '../../../src/networks/rakuten/adapter.js';
import { _resetTokenCache } from '../../../src/networks/rakuten/auth.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'rakuten');

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
 * which `page` / `page_size` each call actually sent.
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

/** The recorded data-endpoint calls (the first call is the token exchange). */
function dataCalls(calls: string[]): string[] {
  return calls.filter((u) => u.includes('/v1/programs/'));
}

/** Extract a query parameter from a recorded request URL. */
function param(url: string | undefined, name: string): string | null {
  return new URL(String(url)).searchParams.get(name);
}

/** One full programmes page with `n` synthetic merchants. */
function programmesPage(startMid: number, n: number): unknown {
  return {
    programs: Array.from({ length: n }, (_, i) => ({
      mid: startMid + i,
      advertiser_name: `Fixture Merchant ${startMid + i}`,
      status: 'active',
      application_status: 'approved',
      currency: 'USD',
    })),
  };
}

beforeEach(() => {
  _resetBreakers();
  _resetTokenCache();
  process.env['RAKUTEN_CLIENT_ID'] = 'test-client-id';
  process.env['RAKUTEN_CLIENT_SECRET'] = 'test-client-secret';
  process.env['RAKUTEN_SID'] = '4567890';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['RAKUTEN_CLIENT_ID'];
  delete process.env['RAKUTEN_CLIENT_SECRET'];
  delete process.env['RAKUTEN_SID'];
  delete process.env['RAKUTEN_TOKEN_URL'];
});

describe('Rakuten.listProgrammes pagination', () => {
  it('pulls the complete programme list across pages when limit is absent', async () => {
    const { calls } = mockFetchQueue([
      fakeResponse(loadFixture('token-response.json')),
      // Page one is exactly page_size long (100), so the loop continues.
      fakeResponse(loadFixture('programmes-page1.json')),
      // Page two is short (3), so the loop stops there.
      fakeResponse(loadFixture('programmes-page2.json')),
    ]);

    const programmes = await rakutenAdapter.listProgrammes();

    expect(programmes).toHaveLength(103);
    expect(programmes[0]?.id).toBe('51001');
    expect(programmes[102]?.id).toBe('51103');

    const pages = dataCalls(calls);
    expect(pages).toHaveLength(2);
    expect(param(pages[0], 'page')).toBe('1');
    expect(param(pages[1], 'page')).toBe('2');
    // With no caller limit each page requests the default page size.
    expect(param(pages[0], 'page_size')).toBe('100');
    expect(param(pages[1], 'page_size')).toBe('100');
  });

  it('treats a short first page as a complete pull (single request)', async () => {
    const { calls } = mockFetchQueue([
      fakeResponse(loadFixture('token-response.json')),
      // The original three-programme fixture: 3 < page_size 100 → complete.
      fakeResponse(loadFixture('programmes.json')),
    ]);

    const programmes = await rakutenAdapter.listProgrammes();

    expect(programmes).toHaveLength(3);
    expect(dataCalls(calls)).toHaveLength(1);
  });

  it('short-circuits after the first page once limit is satisfied', async () => {
    // The fixture holds three programmes, but limit=2 is satisfied by page
    // one — the same single request the old adapter sent.
    const { calls } = mockFetchQueue([
      fakeResponse(loadFixture('token-response.json')),
      fakeResponse(loadFixture('programmes.json')),
    ]);

    const programmes = await rakutenAdapter.listProgrammes({ limit: 2 });

    expect(programmes).toHaveLength(2);
    const pages = dataCalls(calls);
    expect(pages).toHaveLength(1);
    // A limit within one page keeps the old page_size=limit request shape.
    expect(param(pages[0], 'page_size')).toBe('2');
    expect(param(pages[0], 'page')).toBe('1');
  });

  it('keeps paging until a limit larger than one page is satisfied', async () => {
    const { calls } = mockFetchQueue([
      fakeResponse(loadFixture('token-response.json')),
      fakeResponse(programmesPage(60_001, 200)),
      fakeResponse(programmesPage(60_201, 200)),
    ]);

    // limit 300 caps page_size at 200, so two pages are needed.
    const programmes = await rakutenAdapter.listProgrammes({ limit: 300 });

    expect(programmes).toHaveLength(300);
    const pages = dataCalls(calls);
    expect(pages).toHaveLength(2);
    expect(param(pages[0], 'page_size')).toBe('200');
    expect(param(pages[1], 'page')).toBe('2');
  });

  it('stops at the MAX_PAGES backstop with a logged warning, never silently', async () => {
    const warnSpy = vi.spyOn(_internals.log, 'warn');
    // The upstream keeps yielding full pages, so no stop condition fires
    // before the cap.
    const pages = [
      fakeResponse(loadFixture('token-response.json')),
      ...Array.from({ length: _internals.MAX_PAGES + 5 }, (_, i) =>
        fakeResponse(programmesPage(70_000 + i * 100, 100)),
      ),
    ];
    const { calls } = mockFetchQueue(pages);

    const programmes = await rakutenAdapter.listProgrammes();

    expect(dataCalls(calls)).toHaveLength(_internals.MAX_PAGES);
    expect(programmes).toHaveLength(_internals.MAX_PAGES * 100);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'listProgrammes', cap: _internals.MAX_PAGES }),
      expect.stringContaining('MAX_PAGES cap'),
    );
  });

  it('passes the server-side status filter through on every page', async () => {
    const { calls } = mockFetchQueue([
      fakeResponse(loadFixture('token-response.json')),
      fakeResponse(loadFixture('programmes-page1.json')),
      fakeResponse(loadFixture('programmes-page2.json')),
    ]);

    const programmes = await rakutenAdapter.listProgrammes({ status: 'joined' });

    // The page-one fixture is all approved; page two holds one pending and
    // one no-relationship merchant that the client-side filter drops.
    expect(programmes).toHaveLength(101);
    const pages = dataCalls(calls);
    expect(pages).toHaveLength(2);
    expect(param(pages[0], 'status')).toBe('approved');
    expect(param(pages[1], 'status')).toBe('approved');
  });
});
