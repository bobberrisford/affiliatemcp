/**
 * Affise adapter — pagination tests (#316: lift offset-paging exclusions).
 *
 * Proves the three contract points required to remove affise from
 * `src/tools/paging-exclusions.ts`:
 *
 *   1. an absent `limit` pulls the COMPLETE result set across pages
 *      (1-based `page` + `limit` params, stopping on
 *      `pagination.total_count`);
 *   2. the MAX_PAGES backstop stops the loop and logs a warning so a
 *      truncated pull is never silent;
 *   3. a present `limit` short-circuits after the first page that satisfies
 *      it — the same single request the pre-pagination adapter sent.
 *
 * Same mocking pattern as `adapter.test.ts`: `globalThis.fetch` is replaced
 * so the full client + resilience + transformer stack runs with no live HTTP.
 * Fixtures are scrubbed approximations of Affise API responses under
 * `tests/fixtures/affise/`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { affiseAdapter, _internals } from '../../../src/networks/affise/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'affise');

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
 * which `page` / `limit` each call actually sent.
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

/** One partner-offers page with `n` synthetic offers and a claimed total. */
function offersPage(startId: number, n: number, totalCount: number): unknown {
  return {
    status: 1,
    offers: Array.from({ length: n }, (_, i) => ({
      offer_id: startId + i,
      title: `Fixture Offer ${startId + i}`,
      status: 'active',
      currency: 'GBP',
      is_connected: true,
      categories: [],
      payments: [],
    })),
    pagination: { page: 1, per_page: n, total_count: totalCount },
  };
}

/** One conversions page with `n` synthetic conversions and a claimed total. */
function conversionsPage(startId: number, n: number, totalCount: number): unknown {
  return {
    status: 1,
    conversions: Array.from({ length: n }, (_, i) => ({
      id: `conv-${startId + i}`,
      action_id: `order-${startId + i}`,
      status: 'confirmed',
      currency: 'GBP',
      payouts: 1.0,
      revenue: 2.0,
      offer_id: 1001,
      created_at: '2026-01-15 10:00:00',
    })),
    pagination: { page: 1, per_page: n, total_count: totalCount },
  };
}

const WINDOW = { from: '2026-01-01', to: '2026-06-01' };

beforeEach(() => {
  _resetBreakers();
  process.env['AFFISE_BASE_URL'] = 'https://api-yournetwork.affise.com';
  process.env['AFFISE_API_KEY'] = 'test-api-key-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['AFFISE_BASE_URL'];
  delete process.env['AFFISE_API_KEY'];
});

// ---------------------------------------------------------------------------
// listProgrammes — page / total_count loop
// ---------------------------------------------------------------------------

describe('Affise.listProgrammes pagination', () => {
  it('pulls the complete offer list across pages when limit is absent', async () => {
    const { calls } = mockFetchQueue([
      fakeResponse(loadFixture('offers-page1.json')),
      fakeResponse(loadFixture('offers-page2.json')),
    ]);

    const programmes = await affiseAdapter.listProgrammes();

    expect(programmes).toHaveLength(3);
    expect(programmes.map((p) => p.id)).toEqual(['1001', '1002', '1003']);
    expect(calls).toHaveLength(2);
    expect(param(calls[0], 'page')).toBe('1');
    expect(param(calls[1], 'page')).toBe('2');
    // With no caller limit each page requests the default page size.
    expect(param(calls[0], 'limit')).toBe('100');
  });

  it('short-circuits after the first page once limit is satisfied', async () => {
    // total_count says three offers exist, but limit=2 is satisfied by page
    // one's two records — the same single request the old adapter sent.
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('offers-page1.json'))]);
    const programmes = await affiseAdapter.listProgrammes({ limit: 2 });
    expect(programmes).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(param(calls[0], 'limit')).toBe('2');
  });

  it('treats a response without a pagination object as complete on a short page', async () => {
    const noCounter = {
      status: 1,
      offers: [{ offer_id: 1001, title: 'Atolls Bookshop', status: 'active', is_connected: true }],
    };
    const { calls } = mockFetchQueue([fakeResponse(noCounter)]);
    const programmes = await affiseAdapter.listProgrammes();
    expect(programmes).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('stops at the MAX_PAGES backstop with a logged warning, never silently', async () => {
    const warnSpy = vi.spyOn(_internals.log, 'warn');
    // The upstream claims a huge catalogue and keeps yielding short pages, so
    // total_count never lets the loop finish early.
    const pages = Array.from({ length: _internals.MAX_PAGES + 5 }, (_, i) =>
      fakeResponse(offersPage(10_000 + i * 2, 2, 999_999)),
    );
    const { calls } = mockFetchQueue(pages);

    const programmes = await affiseAdapter.listProgrammes();

    expect(calls).toHaveLength(_internals.MAX_PAGES);
    expect(programmes).toHaveLength(_internals.MAX_PAGES * 2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'listProgrammes', cap: _internals.MAX_PAGES }),
      expect.stringContaining('MAX_PAGES cap'),
    );
  });
});

// ---------------------------------------------------------------------------
// listTransactions — page / total_count loop
// ---------------------------------------------------------------------------

describe('Affise.listTransactions pagination', () => {
  it('pulls the complete conversion list across pages when limit is absent', async () => {
    const { calls } = mockFetchQueue([
      fakeResponse(loadFixture('conversions-page1.json')),
      fakeResponse(loadFixture('conversions-page2.json')),
    ]);

    const txns = await affiseAdapter.listTransactions(WINDOW);

    expect(txns).toHaveLength(5);
    expect(txns.map((t) => t.id)).toEqual([
      '59359e1d7e28feb7568b456a',
      '59359e1d7e28feb7568b456b',
      '59359e1d7e28feb7568b456c',
      '59359e1d7e28feb7568b456d',
      '59359e1d7e28feb7568b456e',
    ]);
    expect(calls).toHaveLength(2);
    expect(param(calls[0], 'page')).toBe('1');
    expect(param(calls[1], 'page')).toBe('2');
    // Every page keeps the date window and the default page size.
    expect(param(calls[1], 'date_from')).toBe('2026-01-01');
    expect(param(calls[1], 'date_to')).toBe('2026-06-01');
    expect(param(calls[0], 'limit')).toBe('500');
  });

  it('short-circuits after the first page once limit is satisfied', async () => {
    // total_count says five conversions exist, but limit=2 is satisfied by
    // page one's three records.
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('conversions-page1.json'))]);
    const txns = await affiseAdapter.listTransactions({ ...WINDOW, limit: 2 });
    expect(txns).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(param(calls[0], 'limit')).toBe('2');
  });

  it('treats a response without a pagination object as complete on a short page', async () => {
    const noCounter = {
      status: 1,
      conversions: [
        {
          id: 'conv-solo',
          status: 'confirmed',
          currency: 'GBP',
          payouts: 1.0,
          created_at: '2026-01-15 10:00:00',
        },
      ],
    };
    const { calls } = mockFetchQueue([fakeResponse(noCounter)]);
    const txns = await affiseAdapter.listTransactions(WINDOW);
    expect(txns).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('stops at the MAX_PAGES backstop with a logged warning, never silently', async () => {
    const warnSpy = vi.spyOn(_internals.log, 'warn');
    const pages = Array.from({ length: _internals.MAX_PAGES + 5 }, (_, i) =>
      fakeResponse(conversionsPage(20_000 + i * 2, 2, 999_999)),
    );
    const { calls } = mockFetchQueue(pages);

    const txns = await affiseAdapter.listTransactions(WINDOW);

    expect(calls).toHaveLength(_internals.MAX_PAGES);
    expect(txns).toHaveLength(_internals.MAX_PAGES * 2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'listTransactions', cap: _internals.MAX_PAGES }),
      expect.stringContaining('MAX_PAGES cap'),
    );
  });
});
