/**
 * Kwanko advertiser listProgrammes pagination — unit tests.
 *
 * Proves the #316 exclusion lift: on absent `limit` the adapter pages
 * /advertiser/campaigns to completion (short-page detection), the MAX_PAGES
 * backstop stops the loop with a logged warning rather than silently, and an
 * explicit `limit` short-circuits once satisfied. Deterministic: mock fetch
 * queue, reset breakers, fake creds in env, fixtures from
 * tests/fixtures/kwanko-advertiser/.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  kwankoAdvertiserAdapter,
  _internals,
} from '../../../src/networks/kwanko-advertiser/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'kwanko-advertiser');

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

/** A full page: exactly PAGE_SIZE campaigns, none matching the ctx brand. */
function fullPage(): unknown {
  return {
    data: Array.from({ length: _internals.PAGE_SIZE }, (_, i) => ({
      id: `CAMP-9${String(i).padStart(3, '0')}`,
      name: `Filler Campaign ${i}`,
      status: 'active',
      currency: 'eur',
    })),
  };
}

const CTX = { networkBrandId: 'CAMP-1001' };

beforeEach(() => {
  _resetBreakers();
  process.env['KWANKO_ADVERTISER_API_TOKEN'] = 'fake-token';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['KWANKO_ADVERTISER_API_TOKEN'];
});

describe('Kwanko advertiser.listProgrammes pagination', () => {
  it('pages to completion on absent limit and finds the brand campaign on page 2', async () => {
    // Page 1 is a full page (PAGE_SIZE campaigns, no CAMP-1001); page 2 is a
    // short page carrying the ctx campaign. Fixture page 1 must be exactly
    // PAGE_SIZE long or the short-page detection would stop the loop early.
    const page1 = loadFixture('campaigns-page1.json') as { data: unknown[] };
    expect(page1.data).toHaveLength(_internals.PAGE_SIZE);

    const { spy, urls } = mockFetchQueue([
      fakeResponse(page1),
      fakeResponse(loadFixture('campaigns-page2.json')),
    ]);
    const r = await kwankoAdvertiserAdapter.listProgrammes(undefined, CTX);

    // The ctx campaign lives on page 2 — a single-page pull would return [].
    expect(r).toHaveLength(1);
    expect(r[0]?.id).toBe('CAMP-1001');
    expect(r[0]?.name).toBe('Acme Widgets FR');

    expect(spy).toHaveBeenCalledTimes(2);
    expect(urls[0]).toContain('page=1');
    expect(urls[0]).toContain(`per_page=${_internals.PAGE_SIZE}`);
    expect(urls[1]).toContain('page=2');
  });

  it('stops after one short page (no phantom second request)', async () => {
    // campaigns.json holds 3 campaigns — a short page ends the loop; a second
    // fetch would exhaust the queue and throw.
    const { spy } = mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const r = await kwankoAdvertiserAdapter.listProgrammes(undefined, CTX);
    expect(r).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('caps at MAX_PAGES with a logged warning when every page is full', async () => {
    const warn = vi.spyOn(_internals.log, 'warn').mockImplementation(() => undefined);
    const { spy } = mockFetchQueue(
      Array.from({ length: _internals.MAX_PAGES }, () => fakeResponse(fullPage())),
    );

    const r = await kwankoAdvertiserAdapter.listProgrammes(undefined, CTX);

    // Exactly MAX_PAGES requests, then the backstop stops the loop.
    expect(spy).toHaveBeenCalledTimes(_internals.MAX_PAGES);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'listProgrammes',
        cap: _internals.MAX_PAGES,
        fetched: _internals.MAX_PAGES * _internals.PAGE_SIZE,
      }),
      expect.stringContaining('MAX_PAGES cap'),
    );
    // None of the filler campaigns match the ctx brand.
    expect(r).toEqual([]);
  });

  it('short-circuits once an explicit limit is satisfied', async () => {
    // limit <= PAGE_SIZE: one full page satisfies the limit; a second fetch
    // would exhaust the queue and throw.
    const { spy } = mockFetchQueue([fakeResponse(loadFixture('campaigns-page1.json'))]);
    const r = await kwankoAdvertiserAdapter.listProgrammes({ limit: 50 }, CTX);
    expect(spy).toHaveBeenCalledTimes(1);
    // CAMP-1001 is not on page 1, so the scoped result is empty — same as the
    // pre-pagination single request with per_page=50.
    expect(r).toEqual([]);
  });

  it('keeps paging under an explicit limit larger than one page', async () => {
    const { spy } = mockFetchQueue([
      fakeResponse(loadFixture('campaigns-page1.json')),
      fakeResponse(loadFixture('campaigns-page2.json')),
    ]);
    const r = await kwankoAdvertiserAdapter.listProgrammes(
      { limit: _internals.PAGE_SIZE + 10 },
      CTX,
    );
    expect(spy).toHaveBeenCalledTimes(2);
    expect(r).toHaveLength(1);
    expect(r[0]?.id).toBe('CAMP-1001');
  });
});
