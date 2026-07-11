/**
 * Scaleo listProgrammes pagination — unit tests.
 *
 * Covers the page/perPage walk added when the offset-paging exclusion was
 * lifted (issue #316): with no `limit` the adapter must pull the COMPLETE
 * offers result set across pages, stopping on `meta.total`, an empty page, or
 * a short page, and never exceeding MAX_PAGES without a logged warning. With
 * `limit` set the walk short-circuits as soon as enough rows are fetched.
 *
 * Mocking pattern matches `tests/networks/scaleo/adapter.test.ts` (mock
 * `globalThis.fetch`, exercise the full client + resilience stack). The
 * multi-page fixtures live under `tests/fixtures/scaleo/` (the repo-standard
 * fixture location); they are scrubbed approximations of the Scaleo offers
 * envelope with no real tenant data.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { scaleoAdapter, _internals } from '../../../src/networks/scaleo/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'scaleo');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** Queue of responses; also records each requested URL for assertions. */
function mockFetchQueue(responses: Response[]): { urls: string[] } {
  const urls: string[] = [];
  const spy = vi.fn(async (input: unknown) => {
    urls.push(String(input));
    const r = responses.shift();
    if (!r) throw new Error('mock fetch queue exhausted');
    return r;
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return { urls };
}

/** Build a full synthetic offers page (no meta.total) of `size` rows. */
function fullPage(size: number, startId: number): unknown {
  return {
    data: Array.from({ length: size }, (_, i) => ({
      id: startId + i,
      name: `Synthetic offer ${startId + i}`,
      approval_status: 'approved',
      currency: 'GBP',
      payout: 1,
      payout_type: 'CPA',
    })),
  };
}

beforeEach(() => {
  _resetBreakers();
  process.env['SCALEO_BASE_URL'] = 'https://sandbox.scaletrk.com';
  process.env['SCALEO_API_KEY'] = 'test-api-key-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['SCALEO_BASE_URL'];
  delete process.env['SCALEO_API_KEY'];
});

describe('Scaleo.listProgrammes pagination (full pull on absent limit)', () => {
  it('walks page/perPage to completion across two pages when no limit is set', async () => {
    const { urls } = mockFetchQueue([
      fakeResponse(loadFixture('offers-page1.json')),
      fakeResponse(loadFixture('offers-page2.json')),
    ]);

    const programmes = await scaleoAdapter.listProgrammes();

    expect(programmes.length).toBe(5);
    expect(programmes.map((p) => p.id)).toEqual(['1001', '1002', '1003', '1004', '1005']);
    expect(urls.length).toBe(2);
    expect(urls[0]).toContain('page=1');
    expect(urls[1]).toContain('page=2');
    // No limit → the default full-pull page size is requested.
    expect(urls[0]).toContain(`perPage=${_internals.OFFERS_PAGE_SIZE}`);
  });

  it('stops on meta.total even when the tenant caps perPage below the requested size', async () => {
    // The fixtures return 3 + 2 rows against a requested perPage of 100 with
    // meta.total = 5: the walk must trust the total and stop after page 2
    // rather than treating the short page as exhaustion at page 1.
    const { urls } = mockFetchQueue([
      fakeResponse(loadFixture('offers-page1.json')),
      fakeResponse(loadFixture('offers-page2.json')),
    ]);

    const programmes = await scaleoAdapter.listProgrammes();
    expect(programmes.length).toBe(5);
    expect(urls.length).toBe(2);
  });

  it('continues past a full page when no meta.total is reported, and stops on the short page', async () => {
    const size = _internals.OFFERS_PAGE_SIZE;
    const { urls } = mockFetchQueue([
      fakeResponse(fullPage(size, 1)),
      fakeResponse(fullPage(2, size + 1)),
    ]);

    const programmes = await scaleoAdapter.listProgrammes();
    expect(programmes.length).toBe(size + 2);
    expect(urls.length).toBe(2);
  });

  it('stops after one request on an empty first page', async () => {
    const { urls } = mockFetchQueue([fakeResponse({ data: [], meta: { total: 0 } })]);
    const programmes = await scaleoAdapter.listProgrammes();
    expect(programmes).toEqual([]);
    expect(urls.length).toBe(1);
  });

  it('caps the walk at MAX_PAGES and logs a warning instead of truncating silently', async () => {
    const warnSpy = vi.spyOn(_internals.log, 'warn').mockImplementation(() => undefined);

    // Every page claims a huge total and returns 2 rows, so the walk would run
    // forever without the backstop.
    const responses = Array.from({ length: _internals.MAX_PAGES }, (_, i) =>
      fakeResponse({
        data: [
          { id: i * 2 + 1, name: `Endless offer ${i * 2 + 1}`, approval_status: 'approved' },
          { id: i * 2 + 2, name: `Endless offer ${i * 2 + 2}`, approval_status: 'approved' },
        ],
        meta: { total: 999999, page: i + 1, perPage: 2 },
      }),
    );
    const { urls } = mockFetchQueue(responses);

    const programmes = await scaleoAdapter.listProgrammes();

    expect(urls.length).toBe(_internals.MAX_PAGES);
    expect(programmes.length).toBe(_internals.MAX_PAGES * 2);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[1]).toContain('MAX_PAGES');
  });
});

describe('Scaleo.listProgrammes pagination (limit short-circuit, backward compatible)', () => {
  it('stops after one request when the first page satisfies the limit', async () => {
    const { urls } = mockFetchQueue([
      fakeResponse({
        data: [
          { id: 1001, name: 'Atolls Bookshop', approval_status: 'approved' },
          { id: 1002, name: 'Reef Travel Club', approval_status: 'approved' },
        ],
        meta: { total: 5, page: 1, perPage: 2 },
      }),
    ]);

    const programmes = await scaleoAdapter.listProgrammes({ limit: 2 });

    expect(programmes.length).toBe(2);
    expect(urls.length).toBe(1);
    // The limit is passed through as the requested page size, as before.
    expect(urls[0]).toContain('perPage=2');
    expect(urls[0]).toContain('page=1');
  });

  it('keeps paging until the limit is satisfied when a page comes back short', async () => {
    // limit=4 against pages of 3 + 2 (total 5): page 1 alone is not enough, so
    // the walk must continue — never pull less than the caller asked for.
    const { urls } = mockFetchQueue([
      fakeResponse(loadFixture('offers-page1.json')),
      fakeResponse(loadFixture('offers-page2.json')),
    ]);

    const programmes = await scaleoAdapter.listProgrammes({ limit: 4 });

    expect(programmes.length).toBe(4);
    expect(urls.length).toBe(2);
  });

  it('slices to the limit locally when the upstream returns more rows', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers-page1.json'))]);
    const programmes = await scaleoAdapter.listProgrammes({ limit: 1 });
    expect(programmes.length).toBe(1);
    expect(programmes[0]?.id).toBe('1001');
  });
});
