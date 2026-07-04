/**
 * Partnerize adapter — pagination tests.
 *
 * The offset-paging exclusion for partnerize (issue #316) was lifted on the
 * strength of these behaviours, so they are load-bearing:
 *
 *   - absent `limit` pulls the COMPLETE result set: the reporting endpoints
 *     follow the `cursor_id` RESPONSE HEADER to completion, and the campaign
 *     list walks `limit`/`offset` pages until a short page;
 *   - the MAX_PAGES backstop stops a runaway pull AND logs a warning, so a
 *     truncated result is never silent (principle 4.1);
 *   - a present `limit` short-circuits the pull once satisfied (and never
 *     pulls less than the single page the pre-pagination adapter fetched).
 *
 * Same mocking pattern as `adapter.test.ts`: `globalThis.fetch` is mocked so
 * the full client + resilience + transformer stack runs with no live HTTP.
 * Fixtures live under `tests/fixtures/partnerize/`; all data is synthetic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { partnerizeAdapter, _internals } from '../../../src/networks/partnerize/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'partnerize');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

/**
 * Mint a fake `Response`. Pass `cursorId` to attach the `cursor_id` response
 * header Partnerize uses to signal that another page is available.
 */
function fakeResponse(body: unknown, init: { cursorId?: string } = {}): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.cursorId !== undefined) headers['cursor_id'] = init.cursorId;
  return new Response(JSON.stringify(body), { status: 200, headers });
}

/**
 * Queue up mock fetch responses. Each `fetch` call pops the front of the
 * queue; exhausting the queue throws so an unexpected extra request fails
 * loudly.
 */
function mockFetchQueue(responses: Response[]): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => {
    const r = responses.shift();
    if (!r) throw new Error('mock fetch queue exhausted');
    return r;
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

function requestedUrl(spy: ReturnType<typeof vi.fn>, call: number): string {
  return String(spy.mock.calls[call]?.[0]);
}

beforeEach(() => {
  _resetBreakers();
  process.env['PARTNERIZE_APPLICATION_KEY'] = 'test-app-key';
  process.env['PARTNERIZE_USER_API_KEY'] = 'test-user-api-key';
  process.env['PARTNERIZE_PUBLISHER_ID'] = '1007802';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['PARTNERIZE_APPLICATION_KEY'];
  delete process.env['PARTNERIZE_USER_API_KEY'];
  delete process.env['PARTNERIZE_PUBLISHER_ID'];
});

// ---------------------------------------------------------------------------
// listTransactions — cursor_id header continuation
// ---------------------------------------------------------------------------

describe('Partnerize.listTransactions pagination', () => {
  it('follows the cursor_id response header across pages when limit is absent', async () => {
    const spy = mockFetchQueue([
      fakeResponse(loadFixture('conversions-page1.json'), { cursorId: 'cursor-abc-1' }),
      fakeResponse(loadFixture('conversions-page2.json')), // no header → complete
    ]);

    const txns = await partnerizeAdapter.listTransactions({
      from: '2026-02-01',
      to: '2026-02-28',
    });

    expect(spy.mock.calls.length).toBe(2);
    // Page 1 must not send a cursor; page 2 must echo the header back.
    expect(requestedUrl(spy, 0)).not.toContain('cursor_id=');
    expect(requestedUrl(spy, 1)).toContain('cursor_id=cursor-abc-1');
    // 2 conversions on page 1 + 1 on page 2 = the complete window.
    expect(txns.length).toBe(3);
    expect(txns.map((t) => t.id)).toEqual(['conv_pg1_001', 'conv_pg1_002', 'conv_pg2_001']);
  });

  it('stops at the final page even when it still carries rows (empty page terminates too)', async () => {
    const spy = mockFetchQueue([
      fakeResponse(loadFixture('conversions-page1.json'), { cursorId: 'cursor-abc-1' }),
      fakeResponse({ conversions: { conversion: [] } }, { cursorId: 'cursor-abc-2' }),
    ]);

    const txns = await partnerizeAdapter.listTransactions({
      from: '2026-02-01',
      to: '2026-02-28',
    });

    // An empty page ends the loop even if a cursor header is (mis)returned.
    expect(spy.mock.calls.length).toBe(2);
    expect(txns.length).toBe(2);
  });

  it('short-circuits once a present limit is satisfied (single page, no continuation)', async () => {
    const spy = mockFetchQueue([
      fakeResponse(loadFixture('conversions-page1.json'), { cursorId: 'cursor-abc-1' }),
    ]);

    const txns = await partnerizeAdapter.listTransactions({
      from: '2026-02-01',
      to: '2026-02-28',
      limit: 2,
    });

    // Page 1 already holds 2 rows >= limit, so the cursor must NOT be followed.
    expect(spy.mock.calls.length).toBe(1);
    expect(txns.length).toBe(2);
  });

  it('caps a runaway cursor at MAX_PAGES and logs a warning (never a silent truncation)', async () => {
    const onePage = (n: number): Response =>
      fakeResponse(
        {
          conversions: {
            conversion: [
              {
                conversion_id: `conv_cap_${n}`,
                campaign_id: '10l176',
                conversion_date_time: '2026-02-01T09:00:00Z',
                conversion_status: 'approved',
                value: '10.00',
                publisher_commission: '1.00',
                currency: 'GBP',
              },
            ],
          },
        },
        { cursorId: `cursor-cap-${n}` }, // a cursor that never terminates
      );
    const spy = mockFetchQueue(
      Array.from({ length: _internals.MAX_PAGES + 5 }, (_, i) => onePage(i)),
    );
    const warnSpy = vi.spyOn(_internals.log, 'warn');

    const txns = await partnerizeAdapter.listTransactions({
      from: '2026-02-01',
      to: '2026-02-28',
    });

    expect(spy.mock.calls.length).toBe(_internals.MAX_PAGES);
    expect(txns.length).toBe(_internals.MAX_PAGES);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'listTransactions', cap: _internals.MAX_PAGES }),
      expect.stringContaining('MAX_PAGES'),
    );
  });
});

// ---------------------------------------------------------------------------
// listClicks — cursor_id header continuation
// ---------------------------------------------------------------------------

describe('Partnerize.listClicks pagination', () => {
  it('follows the cursor_id response header across pages when limit is absent', async () => {
    const spy = mockFetchQueue([
      fakeResponse(loadFixture('clicks-page1.json'), { cursorId: 'cursor-clk-1' }),
      fakeResponse(loadFixture('clicks-page2.json')),
    ]);

    const clicks = await partnerizeAdapter.listClicks({
      from: '2026-04-01',
      to: '2026-04-30',
    });

    expect(spy.mock.calls.length).toBe(2);
    expect(requestedUrl(spy, 1)).toContain('cursor_id=cursor-clk-1');
    expect(clicks.length).toBe(3);
    expect(clicks.map((c) => c.id)).toEqual(['click_pg1_001', 'click_pg1_002', 'click_pg2_001']);
  });

  it('short-circuits once a present limit is satisfied and still forwards limit upstream', async () => {
    const spy = mockFetchQueue([
      fakeResponse(loadFixture('clicks-page1.json'), { cursorId: 'cursor-clk-1' }),
    ]);

    const clicks = await partnerizeAdapter.listClicks({
      from: '2026-04-01',
      to: '2026-04-30',
      limit: 2,
    });

    expect(spy.mock.calls.length).toBe(1);
    // Pre-existing behaviour preserved: limit is forwarded upstream.
    expect(requestedUrl(spy, 0)).toContain('limit=2');
    expect(clicks.length).toBe(2);
  });

  it('caps a runaway cursor at MAX_PAGES and logs a warning', async () => {
    const onePage = (n: number): Response =>
      fakeResponse(
        {
          clicks: {
            click: [
              {
                click_id: `click_cap_${n}`,
                campaign_id: '10l176',
                set_time: '2026-04-05T10:00:00Z',
              },
            ],
          },
        },
        { cursorId: `cursor-clk-cap-${n}` },
      );
    const spy = mockFetchQueue(
      Array.from({ length: _internals.MAX_PAGES + 5 }, (_, i) => onePage(i)),
    );
    const warnSpy = vi.spyOn(_internals.log, 'warn');

    const clicks = await partnerizeAdapter.listClicks({
      from: '2026-04-01',
      to: '2026-04-30',
    });

    expect(spy.mock.calls.length).toBe(_internals.MAX_PAGES);
    expect(clicks.length).toBe(_internals.MAX_PAGES);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'listClicks', cap: _internals.MAX_PAGES }),
      expect.stringContaining('MAX_PAGES'),
    );
  });
});

// ---------------------------------------------------------------------------
// listProgrammes — limit/offset pages on the campaign list
// ---------------------------------------------------------------------------

describe('Partnerize.listProgrammes pagination', () => {
  it('walks limit/offset pages until a short page when limit is absent', async () => {
    // Page 1 is exactly PROGRAMME_PAGE_SIZE rows (continue); page 2 is short (stop).
    const spy = mockFetchQueue([
      fakeResponse(loadFixture('campaigns-page1.json')),
      fakeResponse(loadFixture('campaigns-page2.json')),
    ]);

    const programmes = await partnerizeAdapter.listProgrammes();

    expect(spy.mock.calls.length).toBe(2);
    expect(requestedUrl(spy, 0)).toContain(`limit=${_internals.PROGRAMME_PAGE_SIZE}`);
    expect(requestedUrl(spy, 0)).toContain('offset=0');
    expect(requestedUrl(spy, 1)).toContain(`offset=${_internals.PROGRAMME_PAGE_SIZE}`);
    expect(programmes.length).toBe(_internals.PROGRAMME_PAGE_SIZE + 2);
    expect(programmes[0]?.id).toBe('10lp001');
    expect(programmes[programmes.length - 1]?.id).toBe('10lp102');
  });

  it('short-circuits once a present limit is satisfied (single page, no second offset)', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('campaigns-page1.json'))]);

    const programmes = await partnerizeAdapter.listProgrammes({ limit: 5 });

    expect(spy.mock.calls.length).toBe(1);
    expect(programmes.length).toBe(5);
  });

  it('caps a runaway campaign list at MAX_PAGES and logs a warning', async () => {
    const fullPage = loadFixture('campaigns-page1.json');
    const spy = mockFetchQueue(
      Array.from({ length: _internals.MAX_PAGES + 5 }, () => fakeResponse(fullPage)),
    );
    const warnSpy = vi.spyOn(_internals.log, 'warn');

    const programmes = await partnerizeAdapter.listProgrammes();

    expect(spy.mock.calls.length).toBe(_internals.MAX_PAGES);
    expect(programmes.length).toBe(_internals.MAX_PAGES * _internals.PROGRAMME_PAGE_SIZE);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'listProgrammes', cap: _internals.MAX_PAGES }),
      expect.stringContaining('MAX_PAGES'),
    );
  });
});
