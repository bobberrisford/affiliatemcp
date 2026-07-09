/**
 * Partnerize advertiser adapter — offset-pagination tests.
 *
 * Covers the fetchOffsetPages behaviour behind listProgrammes,
 * listTransactions, listMediaPartners and getProgrammePerformance:
 *   - absent `limit` pulls the complete result set across multiple pages;
 *   - the MAX_PAGES backstop stops a runaway loop and logs a warning;
 *   - a caller-supplied `limit` short-circuits after one page when satisfied.
 *
 * All tests are fixture-only (no live calls); `globalThis.fetch` is mocked
 * with a queued response list, mirroring adapter.test.ts.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  partnerizeAdvertiserAdapter,
  _internals,
} from '../../../src/networks/partnerize-advertiser/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'partnerize-advertiser');

// Must match the constants in the adapter.
const PAGE_SIZE = 100;
const MAX_PAGES = 50;

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

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

beforeEach(() => {
  _resetBreakers();
  process.env['PARTNERIZE_APPLICATION_KEY'] = 'test-app-key-1234';
  process.env['PARTNERIZE_USER_API_KEY'] = 'test-user-key-5678';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['PARTNERIZE_APPLICATION_KEY'];
  delete process.env['PARTNERIZE_USER_API_KEY'];
});

// ---------------------------------------------------------------------------
// readReportedTotal
// ---------------------------------------------------------------------------

describe('Partnerize advertiser readReportedTotal', () => {
  it('reads hypermedia.pagination.total_item_count', () => {
    expect(
      _internals.readReportedTotal({ hypermedia: { pagination: { total_item_count: 42 } } }),
    ).toBe(42);
  });

  it('reads a top-level total, coercing strings', () => {
    expect(_internals.readReportedTotal({ total: '7' })).toBe(7);
  });

  it('returns undefined for arrays, non-objects and missing totals', () => {
    expect(_internals.readReportedTotal([])).toBeUndefined();
    expect(_internals.readReportedTotal(null)).toBeUndefined();
    expect(_internals.readReportedTotal({ count: 3 })).toBeUndefined();
    expect(_internals.readReportedTotal({ total: 'not-a-number' })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Full pull across pages when `limit` is absent
// ---------------------------------------------------------------------------

describe('Partnerize advertiser pagination — full pull on absent limit', () => {
  it('listProgrammes pulls every page (hypermedia total_item_count)', async () => {
    const { spy, urls } = mockFetchQueue([
      fakeResponse(loadFixture('campaigns.page1.json')),
      fakeResponse(loadFixture('campaigns.page2.json')),
    ]);
    const r = await partnerizeAdvertiserAdapter.listProgrammes();
    expect(r).toHaveLength(5);
    expect(r.map((p) => p.id)).toEqual([
      'CAM-2001',
      'CAM-2002',
      'CAM-2003',
      'CAM-2004',
      'CAM-2005',
    ]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(urls[0]).toContain('limit=100');
    expect(urls[0]).toContain('offset=0');
    // Second page resumes after the 3 rows the (clamping) server returned.
    expect(urls[1]).toContain('offset=3');
  });

  it('listTransactions pulls every page (top-level total)', async () => {
    const { spy, urls } = mockFetchQueue([
      fakeResponse(loadFixture('conversions.page1.json')),
      fakeResponse(loadFixture('conversions.page2.json')),
    ]);
    const r = await partnerizeAdvertiserAdapter.listTransactions(undefined, {
      networkBrandId: 'CAM-2001',
    });
    expect(r).toHaveLength(4);
    expect(r.map((t) => t.id)).toEqual(['CONV-6001', 'CONV-6002', 'CONV-6003', 'CONV-6004']);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(urls[0]).toContain('/v3/brand/campaigns/CAM-2001/conversions');
    expect(urls[0]).toContain('offset=0');
    expect(urls[1]).toContain('offset=2');
  });

  it('listMediaPartners pulls every page', async () => {
    const { spy, urls } = mockFetchQueue([
      fakeResponse(loadFixture('publishers.page1.json')),
      fakeResponse(loadFixture('publishers.page2.json')),
    ]);
    const r = await partnerizeAdvertiserAdapter.listMediaPartners(undefined, {
      networkBrandId: 'CAM-2001',
    });
    expect(r).toHaveLength(3);
    expect(r.map((p) => p.id)).toEqual(['PUB-301', 'PUB-302', 'PUB-303']);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(urls[1]).toContain('offset=2');
  });

  it('getProgrammePerformance pulls every page', async () => {
    const { spy, urls } = mockFetchQueue([
      fakeResponse(loadFixture('metrics.page1.json')),
      fakeResponse(loadFixture('metrics.page2.json')),
    ]);
    const r = await partnerizeAdvertiserAdapter.getProgrammePerformance(
      { from: '2026-06-01', to: '2026-06-30' },
      { networkBrandId: 'CAM-2001' },
    );
    expect(r).toHaveLength(3);
    expect(r[2]?.date).toBe('2026-06-02');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(urls[0]).toContain('campaign_id=CAM-2001');
    expect(urls[1]).toContain('offset=2');
  });

  it('stops on a short page when no total is reported', async () => {
    // The single-page fixtures report no hypermedia total; a page shorter than
    // PAGE_SIZE must end the loop after one request.
    const { spy } = mockFetchQueue([fakeResponse(loadFixture('publishers.json'))]);
    const r = await partnerizeAdvertiserAdapter.listMediaPartners(undefined, {
      networkBrandId: 'CAM-1001',
    });
    expect(r).toHaveLength(3);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Caller-supplied `limit` short-circuits
// ---------------------------------------------------------------------------

describe('Partnerize advertiser pagination — limit short-circuits', () => {
  it('listProgrammes stops paging once the limit is satisfied', async () => {
    // Page 1 reports 5 total items but limit=3 is already satisfied by the
    // first page, so no second request may be issued.
    const { spy } = mockFetchQueue([fakeResponse(loadFixture('campaigns.page1.json'))]);
    const r = await partnerizeAdvertiserAdapter.listProgrammes({ limit: 3 });
    expect(r).toHaveLength(3);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('listProgrammes slices to the limit within the first page', async () => {
    const { spy } = mockFetchQueue([fakeResponse(loadFixture('campaigns.page1.json'))]);
    const r = await partnerizeAdvertiserAdapter.listProgrammes({ limit: 2 });
    expect(r).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('listTransactions stops paging once the limit is satisfied', async () => {
    const { spy } = mockFetchQueue([fakeResponse(loadFixture('conversions.page1.json'))]);
    const r = await partnerizeAdvertiserAdapter.listTransactions(
      { limit: 2 },
      { networkBrandId: 'CAM-2001' },
    );
    expect(r).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('listTransactions keeps paging when the limit is not yet satisfied', async () => {
    const { spy } = mockFetchQueue([
      fakeResponse(loadFixture('conversions.page1.json')),
      fakeResponse(loadFixture('conversions.page2.json')),
    ]);
    const r = await partnerizeAdvertiserAdapter.listTransactions(
      { limit: 3 },
      { networkBrandId: 'CAM-2001' },
    );
    expect(r).toHaveLength(3);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// MAX_PAGES backstop
// ---------------------------------------------------------------------------

describe('Partnerize advertiser pagination — MAX_PAGES backstop', () => {
  it('caps a runaway pull at MAX_PAGES and logs a warning', async () => {
    // Every page comes back full (PAGE_SIZE rows) with no total, so the loop
    // would run forever without the cap. Queue exactly MAX_PAGES responses:
    // a 51st request would exhaust the mock queue and fail the test.
    const fullPage = (page: number) => ({
      campaigns: Array.from({ length: PAGE_SIZE }, (_, i) => ({
        campaign_id: `CAM-${page}-${i}`,
        campaign_name: `Synthetic campaign ${page}-${i}`,
        status: 'active',
      })),
      count: PAGE_SIZE,
    });
    const { spy } = mockFetchQueue(
      Array.from({ length: MAX_PAGES }, (_, page) => fakeResponse(fullPage(page))),
    );
    const warnSpy = vi.spyOn(_internals.log, 'warn').mockImplementation(() => undefined);

    const r = await partnerizeAdvertiserAdapter.listProgrammes();

    expect(spy).toHaveBeenCalledTimes(MAX_PAGES);
    expect(r).toHaveLength(MAX_PAGES * PAGE_SIZE);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [bindings, message] = warnSpy.mock.calls[0] as [Record<string, unknown>, string];
    expect(bindings['cap']).toBe(MAX_PAGES);
    expect(bindings['fetched']).toBe(MAX_PAGES * PAGE_SIZE);
    expect(message).toMatch(/MAX_PAGES cap.*truncated/);
  });
});
