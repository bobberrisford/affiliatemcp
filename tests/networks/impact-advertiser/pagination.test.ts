/**
 * Impact advertiser adapter — pagination tests (#316, lift offset-paging
 * exclusions).
 *
 * Proves the contract the tool layer's offset paging depends on:
 *   - absent `limit` → the adapter pulls the COMPLETE result set, following
 *     Impact's dual `@nextpageuri` / `@page`+`@numpages` signals;
 *   - the MAX_PAGES backstop stops a runaway continuation AND logs a stderr
 *     warning so truncation is never silent;
 *   - present `limit` → the loop short-circuits once enough raw rows are
 *     collected (backward-compatible with the previous single-request pull).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  impactAdvertiserAdapter,
  _internals,
} from '../../../src/networks/impact-advertiser/adapter.js';
import { _resetCredentialCache } from '../../../src/networks/impact-advertiser/auth.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'impact-advertiser');

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

// The shape-detection probe: succeed → agency tier.
function expectAgency(): Response {
  return fakeResponse({ Id: 'IRA-AGENCY-1', Name: 'Test Agency' });
}

beforeEach(() => {
  _resetBreakers();
  _resetCredentialCache();
  process.env['IMPACT_ADVERTISER_ACCOUNT_SID'] = 'IRA-AGENCY-1';
  process.env['IMPACT_ADVERTISER_AUTH_TOKEN'] = 'fake-token';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['IMPACT_ADVERTISER_ACCOUNT_SID'];
  delete process.env['IMPACT_ADVERTISER_AUTH_TOKEN'];
  _resetCredentialCache();
});

// ---------------------------------------------------------------------------
// Prefix stripping and continuation signals (pure helpers)
// ---------------------------------------------------------------------------

describe('stripAdvertiserPrefix', () => {
  it('strips the brand-direct tier prefix from a relative @nextpageuri', () => {
    expect(
      _internals.stripAdvertiserPrefix('/Advertisers/BRAND-42/Campaigns?Page=2', 'BRAND-42'),
    ).toBe('/Campaigns?Page=2');
  });

  it('strips the agency tier prefix from an absolute @nextpageuri', () => {
    expect(
      _internals.stripAdvertiserPrefix(
        'https://api.impact.com/Agencies/IRA-AGENCY-1/Advertisers/BRAND-42/Actions?Page=3&PageSize=100',
        'BRAND-42',
      ),
    ).toBe('/Actions?Page=3&PageSize=100');
  });

  it('passes through a path that carries no tier prefix', () => {
    expect(_internals.stripAdvertiserPrefix('ReportExport/abc?Page=2', 'BRAND-42')).toBe(
      '/ReportExport/abc?Page=2',
    );
  });
});

describe('nextAdvPageState', () => {
  it('prefers @nextpageuri over the @page fallback', () => {
    const state = _internals.nextAdvPageState(
      { '@nextpageuri': '/Advertisers/BRAND-42/Campaigns?Page=2', '@page': '1', '@numpages': '9' },
      '/Campaigns',
      'BRAND-42',
    );
    expect(state).toEqual({ nextPath: '/Campaigns?Page=2' });
  });

  it('falls back to @page/@numpages against the base path', () => {
    const state = _internals.nextAdvPageState(
      { '@page': '1', '@numpages': '2' },
      '/Actions',
      'BRAND-42',
    );
    expect(state).toEqual({ nextPath: '/Actions', pageParam: 2 });
  });

  it('signals no further page when @page has reached @numpages, or on a bare array', () => {
    expect(
      _internals.nextAdvPageState({ '@page': '2', '@numpages': '2' }, '/Actions', 'BRAND-42'),
    ).toEqual({});
    expect(_internals.nextAdvPageState([], '/Actions', 'BRAND-42')).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Full pull on absent limit
// ---------------------------------------------------------------------------

describe('full pull across pages when limit is absent', () => {
  it('listProgrammes follows @nextpageuri to completion', async () => {
    const { spy, urls } = mockFetchQueue([
      expectAgency(),
      fakeResponse(loadFixture('campaigns-page1.json')),
      fakeResponse(loadFixture('campaigns-page2.json')),
    ]);
    const r = await impactAdvertiserAdapter.listProgrammes(undefined, {
      networkBrandId: 'BRAND-42',
    });
    expect(r).toHaveLength(3);
    expect(r.map((p) => p.id)).toEqual(['CAM-9001', 'CAM-9002', 'CAM-9003']);
    // probe + two pages, no more.
    expect(spy).toHaveBeenCalledTimes(3);
    // The continuation re-uses the stripped @nextpageuri under the tier prefix
    // impactAdvRequest prepends — no doubled brand segment.
    expect(urls[2]).toContain('/Agencies/IRA-AGENCY-1/Advertisers/BRAND-42/Campaigns?Page=2');
    expect(urls[2]?.match(/\/Advertisers\//g)).toHaveLength(1);
  });

  it('listTransactions follows the @page/@numpages fallback and re-sends the date window', async () => {
    const { spy, urls } = mockFetchQueue([
      expectAgency(),
      fakeResponse(loadFixture('actions-page1.json')),
      fakeResponse(loadFixture('actions-page2.json')),
    ]);
    const r = await impactAdvertiserAdapter.listTransactions(
      { from: '2026-04-01', to: '2026-04-30' },
      { networkBrandId: 'BRAND-42' },
    );
    expect(r).toHaveLength(3);
    expect(r.map((t) => t.id)).toEqual(['ACT-10', 'ACT-11', 'ACT-12']);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(urls[2]).toContain('Page=2');
    expect(urls[2]).toContain('ActionDateStart=2026-04-01');
  });

  it('listMediaPartners strips an absolute @nextpageuri back to a brand-relative path', async () => {
    const { spy, urls } = mockFetchQueue([
      expectAgency(),
      fakeResponse(loadFixture('media-partners-page1.json')),
      fakeResponse(loadFixture('media-partners-page2.json')),
    ]);
    const r = await impactAdvertiserAdapter.listMediaPartners(undefined, {
      networkBrandId: 'BRAND-42',
    });
    expect(r).toHaveLength(3);
    expect(r.map((p) => p.id)).toEqual(['MP-1', 'MP-2', 'MP-3']);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(urls[2]).toContain('/Agencies/IRA-AGENCY-1/Advertisers/BRAND-42/MediaPartners?Page=2');
    expect(urls[2]?.match(/\/Advertisers\//g)).toHaveLength(1);
  });

  it('getProgrammePerformance (sync shape) follows @nextpageuri to completion', async () => {
    const { spy, urls } = mockFetchQueue([
      expectAgency(),
      fakeResponse(loadFixture('performance-report-page1.json')),
      fakeResponse(loadFixture('performance-report-page2.json')),
    ]);
    const r = await impactAdvertiserAdapter.getProgrammePerformance(
      { from: '2026-05-01', to: '2026-05-31' },
      { networkBrandId: 'BRAND-42' },
    );
    expect(r).toHaveLength(3);
    expect(r.map((row) => row.publisherId)).toEqual(['MP-1', 'MP-2', 'MP-3']);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(urls[2]).toContain('/Reports/adv_performance_by_media?Page=2');
  });

  it(
    'getProgrammePerformance (async shape) paginates the polled result too',
    async () => {
      const { spy } = mockFetchQueue([
        expectAgency(),
        fakeResponse({ ResultUri: '/ReportExport/abc123', Status: 'queued' }),
        fakeResponse(loadFixture('performance-report-page1.json')),
        fakeResponse(loadFixture('performance-report-page2.json')),
      ]);
      const r = await impactAdvertiserAdapter.getProgrammePerformance(undefined, {
        networkBrandId: 'BRAND-42',
      });
      expect(r).toHaveLength(3);
      // probe + report request + poll + continuation page.
      expect(spy).toHaveBeenCalledTimes(4);
    },
    10_000,
  );
});

// ---------------------------------------------------------------------------
// MAX_PAGES backstop
// ---------------------------------------------------------------------------

describe('MAX_PAGES backstop', () => {
  it('stops at the cap and logs a stderr warning instead of looping forever', async () => {
    // A misbehaving tenant that always signals another page (self-referential
    // @nextpageuri — the historically observed failure on the publisher side).
    const runaway = {
      Campaigns: [{ CampaignId: 'CAM-LOOP', CampaignName: 'Loop', CampaignStatus: 'Active' }],
      '@nextpageuri': '/Advertisers/BRAND-42/Campaigns?Page=2&PageSize=100',
    };
    const responses: Response[] = [expectAgency()];
    for (let i = 0; i < _internals.MAX_PAGES + 5; i++) responses.push(fakeResponse(runaway));
    const { spy } = mockFetchQueue(responses);
    const warn = vi.spyOn(_internals.log, 'warn');

    const r = await impactAdvertiserAdapter.listProgrammes(undefined, {
      networkBrandId: 'BRAND-42',
    });

    expect(r).toHaveLength(_internals.MAX_PAGES); // one row per page, capped
    expect(spy).toHaveBeenCalledTimes(_internals.MAX_PAGES + 1); // probe + capped pages
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[1])).toMatch(/MAX_PAGES cap/);
  });
});

// ---------------------------------------------------------------------------
// limit present → short-circuit (backward-compatible)
// ---------------------------------------------------------------------------

describe('limit present short-circuits the pull', () => {
  it('listProgrammes stops after the first page once limit rows are collected', async () => {
    const { spy, urls } = mockFetchQueue([
      expectAgency(),
      fakeResponse(loadFixture('campaigns-page1.json')),
    ]);
    const r = await impactAdvertiserAdapter.listProgrammes(
      { limit: 2 },
      { networkBrandId: 'BRAND-42' },
    );
    expect(r).toHaveLength(2);
    // Page 1 satisfied the limit — the @nextpageuri continuation is NOT followed.
    expect(spy).toHaveBeenCalledTimes(2);
    // Backward-compatible request shape: PageSize mirrors the limit.
    expect(urls[1]).toContain('PageSize=2');
  });

  it('listProgrammes still crosses pages when the limit exceeds page one', async () => {
    const { spy } = mockFetchQueue([
      expectAgency(),
      fakeResponse(loadFixture('campaigns-page1.json')),
      fakeResponse(loadFixture('campaigns-page2.json')),
    ]);
    const r = await impactAdvertiserAdapter.listProgrammes(
      { limit: 3 },
      { networkBrandId: 'BRAND-42' },
    );
    expect(r).toHaveLength(3);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('getProgrammePerformance with a limit does not follow the continuation', async () => {
    const { spy } = mockFetchQueue([
      expectAgency(),
      fakeResponse(loadFixture('performance-report-page1.json')),
    ]);
    const r = await impactAdvertiserAdapter.getProgrammePerformance(
      { limit: 1 },
      { networkBrandId: 'BRAND-42' },
    );
    expect(r).toHaveLength(1);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('listTransactions with a limit stops once enough raw rows are collected', async () => {
    const { spy } = mockFetchQueue([
      expectAgency(),
      fakeResponse(loadFixture('actions-page1.json')),
    ]);
    const r = await impactAdvertiserAdapter.listTransactions(
      { limit: 2 },
      { networkBrandId: 'BRAND-42' },
    );
    expect(r).toHaveLength(2);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
