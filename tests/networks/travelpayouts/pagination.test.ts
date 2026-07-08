/**
 * Travelpayouts pagination — offset paging to completion (#316).
 *
 * The actions endpoint pages with `offset`/`limit` (max 300 rows per page).
 * These tests prove, against multi-page fixtures:
 *   - an absent `limit` pulls every page (a campaign that only appears on
 *     page 2 is still synthesised into a programme);
 *   - the MAX_PAGES backstop stops a never-ending upstream and logs a
 *     warning, so truncation is never silent;
 *   - a present `limit` short-circuits once satisfied and never pulls less
 *     than the previous single-page behaviour.
 *
 * Fixtures live in tests/fixtures/travelpayouts/: actions-page-1.json is a
 * full 300-row page (signalling a continuation); actions-page-2.json is a
 * short page introducing campaign 300, which never appears on page 1.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { travelpayoutsAdapter, _internals } from '../../../src/networks/travelpayouts/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'travelpayouts');

function fixtureText(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8');
}

function fakeResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
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

beforeEach(() => {
  _resetBreakers();
  process.env['TRAVELPAYOUTS_ACCESS_TOKEN'] = 'test-token-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['TRAVELPAYOUTS_ACCESS_TOKEN'];
});

describe('Travelpayouts.listProgrammes pagination (#316)', () => {
  it('pulls every page when limit is absent and synthesises page-2-only campaigns', async () => {
    const { urls } = mockFetchQueue([
      fakeResponse(fixtureText('actions-page-1.json')),
      fakeResponse(fixtureText('actions-page-2.json')),
    ]);

    const programmes = await travelpayoutsAdapter.listProgrammes();

    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('offset=0');
    expect(urls[1]).toContain(`offset=${_internals.ACTIONS_PAGE_LIMIT}`);
    // Campaign 300 ("Sample Transfers") appears only on page 2.
    expect(programmes.map((p) => p.name).sort()).toEqual([
      'Aviasales',
      'Hotellook',
      'Sample Transfers',
    ]);
  });

  it('stops at the MAX_PAGES backstop with a logged warning, never silently', async () => {
    const warn = vi.spyOn(_internals.log, 'warn').mockImplementation(() => undefined);
    const page1 = fixtureText('actions-page-1.json');
    mockFetchQueue(
      Array.from({ length: _internals.MAX_PAGES }, () => fakeResponse(page1)),
    );

    const programmes = await travelpayoutsAdapter.listProgrammes();

    // The full-page upstream never ends; the loop stops at the cap (a 101st
    // fetch would exhaust the mock queue and reject) and still returns what
    // was pulled.
    expect(programmes.map((p) => p.name).sort()).toEqual(['Aviasales', 'Hotellook']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      operation: 'listProgrammes',
      cap: _internals.MAX_PAGES,
    });
    expect(warn.mock.calls[0]?.[1]).toContain('MAX_PAGES');
  });

  it('short-circuits after page one when the limit is already satisfied', async () => {
    // Only one response is queued: a second fetch would reject, so this also
    // proves the limit path never pulls less than the old single-page pull.
    const { urls } = mockFetchQueue([fakeResponse(fixtureText('actions-page-1.json'))]);

    const programmes = await travelpayoutsAdapter.listProgrammes({ limit: 2 });

    expect(urls).toHaveLength(1);
    expect(programmes).toHaveLength(2);
    expect(programmes.map((p) => p.name).sort()).toEqual(['Aviasales', 'Hotellook']);
  });

  it('keeps paging when the limit is not yet satisfied by page one', async () => {
    const { urls } = mockFetchQueue([
      fakeResponse(fixtureText('actions-page-1.json')),
      fakeResponse(fixtureText('actions-page-2.json')),
    ]);

    // Page 1 only yields two programmes; a limit of 3 needs page 2.
    const programmes = await travelpayoutsAdapter.listProgrammes({ limit: 3 });

    expect(urls).toHaveLength(2);
    expect(programmes).toHaveLength(3);
    expect(programmes.map((p) => p.name).sort()).toEqual([
      'Aviasales',
      'Hotellook',
      'Sample Transfers',
    ]);
  });
});

describe('Travelpayouts.listTransactions pagination (#316)', () => {
  it('pulls every page when limit is absent', async () => {
    const { urls } = mockFetchQueue([
      fakeResponse(fixtureText('actions-page-1.json')),
      fakeResponse(fixtureText('actions-page-2.json')),
    ]);

    const txns = await travelpayoutsAdapter.listTransactions({
      from: '2026-01-01',
      to: '2026-02-01',
    });

    expect(urls).toHaveLength(2);
    expect(txns).toHaveLength(_internals.ACTIONS_PAGE_LIMIT + 2);
    // The page-2 rows made it through the pull.
    expect(txns.some((t) => t.id === '5301')).toBe(true);
  });

  it('applies limit as a final slice over the complete pull', async () => {
    mockFetchQueue([
      fakeResponse(fixtureText('actions-page-1.json')),
      fakeResponse(fixtureText('actions-page-2.json')),
    ]);

    const txns = await travelpayoutsAdapter.listTransactions({
      from: '2026-01-01',
      to: '2026-02-01',
      limit: 5,
    });

    expect(txns).toHaveLength(5);
  });
});
