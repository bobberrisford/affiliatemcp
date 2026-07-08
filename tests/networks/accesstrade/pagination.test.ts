/**
 * AccessTrade listProgrammes pagination — unit tests.
 *
 * Covers the lifted offset-paging exclusion (issue #316): with no `limit` the
 * adapter must pull the complete campaign listing across pages (using the
 * envelope's `total` as the end-of-results signal), stop at the MAX_PAGES
 * backstop with a logged warning rather than a silent truncation, and keep
 * the previous single-request behaviour when a `limit` is supplied.
 *
 * Mirrors the adapter.test.ts pattern: `globalThis.fetch` is mocked directly
 * so the full client + resilience + transformer stack runs with no live HTTP.
 * Multi-page fixtures live under tests/fixtures/accesstrade/.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { accesstradeAdapter, _internals } from '../../../src/networks/accesstrade/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'accesstrade');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
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
  process.env['ACCESSTRADE_ACCESS_KEY'] = 'test-access-key-please-ignore';
  process.env['ACCESSTRADE_SITE_ID'] = 'site-abc';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['ACCESSTRADE_ACCESS_KEY'];
  delete process.env['ACCESSTRADE_SITE_ID'];
});

describe('AccessTrade.listProgrammes pagination', () => {
  it('pulls every page when limit is absent (loops until total is reached)', async () => {
    const spy = mockFetchQueue([
      fakeResponse(loadFixture('campaigns-page1.json')),
      fakeResponse(loadFixture('campaigns-page2.json')),
    ]);

    const programmes = await accesstradeAdapter.listProgrammes();

    expect(programmes.length).toBe(5);
    expect(programmes.map((p) => p.id)).toEqual(['5001', '5002', '5003', '5004', '5005']);
    expect(spy.mock.calls.length).toBe(2);
    const firstUrl = String(spy.mock.calls[0]?.[0]);
    const secondUrl = String(spy.mock.calls[1]?.[0]);
    expect(firstUrl).toContain('page=1');
    expect(secondUrl).toContain('page=2');
    // With no caller limit, the adapter requests the full page size each call.
    expect(firstUrl).toContain('limit=300');
    expect(secondUrl).toContain('limit=300');
  });

  it('short-circuits after one request when the caller limit is satisfied', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('campaigns-page1.json'))]);

    const programmes = await accesstradeAdapter.listProgrammes({ limit: 3 });

    expect(programmes.length).toBe(3);
    expect(spy.mock.calls.length).toBe(1);
    // The caller limit is forwarded upstream, matching the previous behaviour.
    expect(String(spy.mock.calls[0]?.[0])).toContain('limit=3');
  });

  it('keeps paging past page one when the caller limit exceeds a single page', async () => {
    const spy = mockFetchQueue([
      fakeResponse(loadFixture('campaigns-page1.json')),
      fakeResponse(loadFixture('campaigns-page2.json')),
    ]);

    // limit 4 > the 3 rows on page one, so a second page is fetched, then the
    // client-side slice trims back to the requested 4.
    const programmes = await accesstradeAdapter.listProgrammes({ limit: 4 });

    expect(programmes.length).toBe(4);
    expect(spy.mock.calls.length).toBe(2);
  });

  it('stops on an empty page instead of trusting a misreported total', async () => {
    const warnSpy = vi.spyOn(_internals.log, 'warn');
    const spy = mockFetchQueue([
      fakeResponse({ ...(loadFixture('campaigns-page1.json') as object), total: 100000 }),
      fakeResponse({ total: 100000, page: 2, limit: 300, data: [] }),
    ]);

    const programmes = await accesstradeAdapter.listProgrammes();

    expect(programmes.length).toBe(3);
    expect(spy.mock.calls.length).toBe(2);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('caps at MAX_PAGES with a warning so truncation is never silent', async () => {
    const warnSpy = vi.spyOn(_internals.log, 'warn');
    // Every page claims more results remain; the backstop must stop the loop.
    const spy = vi.fn(async () =>
      fakeResponse({
        total: 100000,
        limit: 300,
        data: [
          { id: '9001', name: 'Endless Campaign A', affiliationStatus: 'affiliated' },
          { id: '9002', name: 'Endless Campaign B', affiliationStatus: 'affiliated' },
        ],
      }),
    );
    globalThis.fetch = spy as unknown as typeof fetch;

    const programmes = await accesstradeAdapter.listProgrammes();

    expect(spy.mock.calls.length).toBe(_internals.MAX_PAGES);
    expect(programmes.length).toBe(_internals.MAX_PAGES * 2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [bindings, message] = warnSpy.mock.calls[0] ?? [];
    expect(bindings).toMatchObject({ operation: 'listProgrammes', cap: _internals.MAX_PAGES });
    expect(String(message)).toContain('MAX_PAGES');
  });

  it('falls back to the short-page signal when the envelope has no total', async () => {
    const page1 = loadFixture('campaigns-page1.json') as { data: unknown[] };
    const spy = mockFetchQueue([fakeResponse({ data: page1.data })]);

    const programmes = await accesstradeAdapter.listProgrammes();

    // 3 rows against a requested page size of 300 → last page, single call.
    expect(programmes.length).toBe(3);
    expect(spy.mock.calls.length).toBe(1);
  });
});
