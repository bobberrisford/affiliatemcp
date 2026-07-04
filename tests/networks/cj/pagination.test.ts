/**
 * CJ Affiliate adapter — pagination tests (#316: lift offset-paging exclusions).
 *
 * Proves the three contract points required to remove cj from
 * `src/tools/paging-exclusions.ts`:
 *
 *   1. an absent `limit` pulls the COMPLETE result set across pages
 *      (page/totalCount on the advertisers query; sinceCommissionId +
 *      payloadComplete on publisherCommissions);
 *   2. the MAX_PAGES backstop stops the loop and logs a warning so a
 *      truncated pull is never silent;
 *   3. a present `limit` short-circuits after the first page that satisfies
 *      it — the same single request the pre-pagination adapter sent.
 *
 * Same mocking pattern as `adapter.test.ts`: `globalThis.fetch` is replaced
 * so the full client + resilience + transformer stack runs with no live HTTP.
 * Fixtures are scrubbed approximations of CJ GraphQL responses.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { cjAdapter, _internals } from '../../../src/networks/cj/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'cj');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

interface RecordedCall {
  url: string;
  variables: Record<string, unknown>;
}

/**
 * Queue mock fetch responses and record each request's GraphQL variables so
 * tests can assert what cursor / page / maxRows each page actually sent.
 */
function mockFetchQueue(responses: Response[]): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const spy = vi.fn(async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as {
      variables?: Record<string, unknown>;
    };
    calls.push({ url: String(url), variables: body.variables ?? {} });
    const r = responses.shift();
    if (!r) throw new Error('mock fetch queue exhausted');
    return r;
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return { calls };
}

/** One publisherCommissions page with `n` synthetic records. */
function commissionsPage(startId: number, n: number, payloadComplete: boolean): unknown {
  return {
    data: {
      publisherCommissions: {
        count: n,
        payloadComplete,
        records: Array.from({ length: n }, (_, i) => ({
          commissionId: `C-${startId + i}`,
          actionId: `A-${startId + i}`,
          advertiserId: '7777',
          advertiserName: 'Atolls Bookshop',
          pubCommissionAmountPubCurrency: '1.00',
          pubCurrency: 'USD',
          actionStatus: 'LOCKED',
          postingDate: '2026-01-10T10:30:00Z',
          paidToPublisher: false,
        })),
      },
    },
  };
}

/** One advertisers page with `n` synthetic joined advertisers. */
function advertisersPage(startId: number, n: number, totalCount: number): unknown {
  return {
    data: {
      advertisers: {
        totalCount,
        resultList: Array.from({ length: n }, (_, i) => ({
          advertiserId: String(startId + i),
          advertiserName: `Fixture Advertiser ${startId + i}`,
          status: 'joined',
          relationshipStatus: 'joined',
          currency: 'USD',
        })),
      },
    },
  };
}

const WINDOW = { from: '2026-01-01T00:00:00Z', to: '2026-06-01T00:00:00Z' };

beforeEach(() => {
  _resetBreakers();
  process.env['CJ_API_TOKEN'] = 'test-token-please-ignore';
  process.env['CJ_COMPANY_ID'] = '1234567';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['CJ_API_TOKEN'];
  delete process.env['CJ_COMPANY_ID'];
});

// ---------------------------------------------------------------------------
// listTransactions — sinceCommissionId / payloadComplete cursor loop
// ---------------------------------------------------------------------------

describe('CJ.listTransactions pagination', () => {
  it('pulls the complete result set across pages when limit is absent', async () => {
    const { calls } = mockFetchQueue([
      fakeResponse(loadFixture('commissions-page1.json')),
      fakeResponse(loadFixture('commissions-page2.json')),
    ]);

    const txns = await cjAdapter.listTransactions(WINDOW);

    expect(txns).toHaveLength(5);
    expect(txns.map((t) => t.id)).toEqual(['C-2001', 'C-2002', 'C-2003', 'C-2004', 'C-2005']);
    expect(calls).toHaveLength(2);
    // First page sends no cursor; every page requests the full maxRows.
    expect(calls[0]?.variables['sinceCommissionId']).toBeUndefined();
    expect(calls[0]?.variables['maxRows']).toBe(10_000);
    // Second page anchors on the last commissionId of page one.
    expect(calls[1]?.variables['sinceCommissionId']).toBe('C-2003');
  });

  it('treats a response without payloadComplete as complete (single page, older schemas)', async () => {
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);
    const txns = await cjAdapter.listTransactions(WINDOW);
    expect(txns).toHaveLength(5);
    expect(calls).toHaveLength(1);
  });

  it('short-circuits after the first page once limit is satisfied', async () => {
    // Page one carries payloadComplete: false — more data exists upstream —
    // but limit=2 is already satisfied by its three records.
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('commissions-page1.json'))]);
    const txns = await cjAdapter.listTransactions({ ...WINDOW, limit: 2 });
    expect(txns).toHaveLength(2);
    expect(calls).toHaveLength(1);
  });

  it('stops at the MAX_PAGES backstop with a logged warning, never silently', async () => {
    const warnSpy = vi.spyOn(_internals.log, 'warn');
    const pages = Array.from({ length: _internals.MAX_PAGES + 5 }, (_, i) =>
      fakeResponse(commissionsPage(3000 + i * 2, 2, false)),
    );
    const { calls } = mockFetchQueue(pages);

    const txns = await cjAdapter.listTransactions(WINDOW);

    expect(calls).toHaveLength(_internals.MAX_PAGES);
    expect(txns).toHaveLength(_internals.MAX_PAGES * 2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ cap: _internals.MAX_PAGES }),
      expect.stringContaining('MAX_PAGES cap'),
    );
  });

  it('stops with a warning when payloadComplete is false but no cursor is available', async () => {
    const warnSpy = vi.spyOn(_internals.log, 'warn');
    const page = {
      data: {
        publisherCommissions: {
          payloadComplete: false,
          records: [{ actionStatus: 'NEW', postingDate: '2026-01-10T10:30:00Z' }],
        },
      },
    };
    const { calls } = mockFetchQueue([fakeResponse(page)]);
    const txns = await cjAdapter.listTransactions(WINDOW);
    expect(txns).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'listTransactions' }),
      expect.stringContaining('no commissionId cursor'),
    );
  });
});

// ---------------------------------------------------------------------------
// listProgrammes — page / totalCount loop
// ---------------------------------------------------------------------------

describe('CJ.listProgrammes pagination', () => {
  it('pulls the complete advertiser list across pages when limit is absent', async () => {
    const { calls } = mockFetchQueue([
      fakeResponse(loadFixture('advertisers-page1.json')),
      fakeResponse(loadFixture('advertisers-page2.json')),
    ]);

    const programmes = await cjAdapter.listProgrammes();

    expect(programmes).toHaveLength(5);
    expect(programmes.map((p) => p.id)).toEqual(['7777', '8888', '9999', '6060', '5050']);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.variables['page']).toBe(1);
    expect(calls[1]?.variables['page']).toBe(2);
  });

  it('short-circuits after the first page once limit is satisfied', async () => {
    // totalCount says five advertisers exist, but limit=3 is satisfied by
    // page one's three records.
    const { calls } = mockFetchQueue([fakeResponse(loadFixture('advertisers-page1.json'))]);
    const programmes = await cjAdapter.listProgrammes({ limit: 3 });
    expect(programmes).toHaveLength(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.variables['records']).toBe(3);
  });

  it('treats a flattened top-level array as a single complete page', async () => {
    const flattened = {
      data: {
        advertisers: [
          { advertiserId: '7777', advertiserName: 'Atolls Bookshop', status: 'joined' },
        ],
      },
    };
    const { calls } = mockFetchQueue([fakeResponse(flattened)]);
    const programmes = await cjAdapter.listProgrammes();
    expect(programmes).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('stops at the MAX_PAGES backstop with a logged warning, never silently', async () => {
    const warnSpy = vi.spyOn(_internals.log, 'warn');
    // The upstream claims a huge catalogue and keeps yielding short pages, so
    // neither totalCount nor the short-page signal ends the loop early —
    // totalCount present means a short page alone does not stop it.
    const pages = Array.from({ length: _internals.MAX_PAGES + 5 }, (_, i) =>
      fakeResponse(advertisersPage(10_000 + i * 2, 2, 999_999)),
    );
    const { calls } = mockFetchQueue(pages);

    const programmes = await cjAdapter.listProgrammes();

    expect(calls).toHaveLength(_internals.MAX_PAGES);
    expect(programmes).toHaveLength(_internals.MAX_PAGES * 2);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ cap: _internals.MAX_PAGES }),
      expect.stringContaining('MAX_PAGES cap'),
    );
  });
});
