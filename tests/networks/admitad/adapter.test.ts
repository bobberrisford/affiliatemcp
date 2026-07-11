/**
 * Admitad adapter — unit tests.
 *
 * Pattern-matched to `tests/networks/skimlinks/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - The token exchange is mocked first, then the data call (see `mockWithToken`).
 *   - Circuit breakers are reset in `beforeEach` so no test bleeds state.
 *   - The token cache is reset via `_resetTokenCache` so no token leaks between tests.
 *   - Fake credentials are injected via `process.env` (obvious non-secret values).
 *   - Fixtures live under `tests/fixtures/admitad/`.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { admitadAdapter, _internals } from '../../../src/networks/admitad/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';
import { _resetTokenCache } from '../../../src/networks/admitad/auth.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'admitad');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(
  body: unknown,
  init: { status?: number; rawBody?: string } = {},
): Response {
  const status = init.status ?? 200;
  const text = init.rawBody ?? (typeof body === 'string' ? body : JSON.stringify(body));
  return new Response(text, {
    status,
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

/**
 * Helper: mock a token exchange (first fetch) followed by the given data response.
 * Most adapter ops require a token first, then the data call.
 */
function mockWithToken(dataResponse: Response): ReturnType<typeof vi.fn> {
  return mockFetchQueue([fakeResponse(loadFixture('token.json')), dataResponse]);
}

beforeEach(() => {
  _resetBreakers();
  _resetTokenCache();
  process.env['ADMITAD_CLIENT_ID'] = 'test-client-id-please-ignore';
  process.env['ADMITAD_CLIENT_SECRET'] = 'test-client-secret-please-ignore';
  process.env['ADMITAD_WEBSITE_ID'] = '123456';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['ADMITAD_CLIENT_ID'];
  delete process.env['ADMITAD_CLIENT_SECRET'];
  delete process.env['ADMITAD_WEBSITE_ID'];
  _resetTokenCache();
});

// ---------------------------------------------------------------------------
// Transformer unit tests (status normalisation + raw preservation)
// ---------------------------------------------------------------------------

describe('Admitad transformers (status normalisation, raw preservation)', () => {
  it('maps Admitad action statuses to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'on_hold' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'approved' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'approved_but_stalled' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'confirmed' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'declined' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'rejected' })).toBe('reversed');
    // payment_status == 1 wins over the textual status → paid.
    expect(_internals.mapTransactionStatus({ status: 'approved', payment_status: 1 })).toBe('paid');
    expect(_internals.mapTransactionStatus({ status: 'approved', payment_status: '1' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ status: 'unknown_future_status' })).toBe('other');
    expect(_internals.mapTransactionStatus({})).toBe('other');
  });

  it('isPaid only true when payment_status is 1', () => {
    expect(_internals.isPaid({ payment_status: 1 })).toBe(true);
    expect(_internals.isPaid({ payment_status: '1' })).toBe(true);
    expect(_internals.isPaid({ payment_status: 0 })).toBe(false);
    expect(_internals.isPaid({})).toBe(false);
  });

  it('maps Admitad campaign connection statuses to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ connection_status: 'active' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ connection_status: 'connected' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ connection_status: 'pending' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ connection_status: 'declined' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ connection_status: 'not_connected' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ connection_status: 'suspended' })).toBe('suspended');
    // Falls back to `status` when connection_status absent.
    expect(_internals.mapProgrammeStatus({ status: 'active' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'something-new' })).toBe('unknown');
    expect(_internals.mapProgrammeStatus({})).toBe('unknown');
  });

  it('preserves raw Admitad payload in rawNetworkData', () => {
    const actions = (loadFixture('actions.json') as { results: unknown[] }).results;
    const raw = actions[0] as Record<string, unknown>;
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('surfaces reversalReason from comment on reversed transactions (§15.10)', () => {
    const actions = (loadFixture('actions.json') as { results: unknown[] }).results;
    // Index 2 is the declined action.
    const declined = actions[2] as Record<string, unknown>;
    const out = _internals.toTransaction(declined as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Customer returned the item within 30 days');
  });

  it('parses Admitad space-separated and ISO timestamps', () => {
    const space = _internals.parseAdmitadDate('2024-01-20 12:00:00');
    expect(space).toBe(Date.parse('2024-01-20T12:00:00Z'));
    const iso = _internals.parseAdmitadDate('2026-04-01T10:15:00Z');
    expect(iso).toBe(Date.parse('2026-04-01T10:15:00Z'));
    const offset = _internals.parseAdmitadDate('2026-04-01T10:15:00-04:00');
    expect(offset).toBe(Date.parse('2026-04-01T10:15:00-04:00'));
    expect(_internals.parseAdmitadDate('not-a-date')).toBeUndefined();
  });

  it('formats dates as DD.MM.YYYY for the statistics endpoint', () => {
    expect(_internals.toAdmitadDate(new Date('2011-01-01T00:00:00Z'))).toBe('01.01.2011');
    expect(_internals.toAdmitadDate(new Date('2026-12-09T00:00:00Z'))).toBe('09.12.2026');
  });

  it('computes ageDays from closing_date (preferred), then action_date', () => {
    const now = new Date('2024-01-28T00:00:00Z');
    // closing_date = 2024-01-20 → 8 days
    const age1 = _internals.computeAgeDays(
      { closing_date: '2024-01-20 00:00:00', action_date: '2024-01-01 00:00:00' },
      now,
    );
    expect(age1).toBe(8);
    // No closing_date → falls back to action_date = 2024-01-08 → 20 days
    const age2 = _internals.computeAgeDays({ action_date: '2024-01-08 00:00:00' }, now);
    expect(age2).toBe(20);
  });

  it('normalises string and number commission amounts', () => {
    expect(_internals.toAmount(5.5)).toBe(5.5);
    expect(_internals.toAmount('12.75')).toBe(12.75);
    expect(_internals.toAmount(undefined)).toBe(0);
    expect(_internals.toAmount('not-a-number')).toBe(0);
  });

  it('maps an advcampaign to a Programme with categories and currency', () => {
    const single = loadFixture('advcampaign_single.json') as Record<string, unknown>;
    const p = _internals.toProgramme(single as never);
    expect(p.id).toBe('3001');
    expect(p.name).toBe('Example Books Ltd');
    expect(p.network).toBe('admitad');
    expect(p.status).toBe('joined');
    expect(p.currency).toBe('EUR');
    expect(p.categories).toEqual(['Books', 'Media']);
    expect(p.advertiserUrl).toBe('https://www.examplebooks.test');
    expect(p.rawNetworkData).toBe(single);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes / getProgramme — mapped from /advcampaigns/
// ---------------------------------------------------------------------------

describe('AdmitadAdapter.listProgrammes', () => {
  it('returns programmes mapped from advcampaigns', async () => {
    mockWithToken(fakeResponse(loadFixture('advcampaigns.json')));
    const programmes = await admitadAdapter.listProgrammes();
    expect(programmes.length).toBe(3);
    expect(programmes[0]?.name).toBe('Example Books Ltd');
    expect(programmes[0]?.status).toBe('joined');
  });

  it('filters by canonical status', async () => {
    mockWithToken(fakeResponse(loadFixture('advcampaigns.json')));
    const joined = await admitadAdapter.listProgrammes({ status: 'joined' });
    expect(joined.every((p) => p.status === 'joined')).toBe(true);
    expect(joined.length).toBe(1);
  });

  it('filters by search term', async () => {
    mockWithToken(fakeResponse(loadFixture('advcampaigns.json')));
    const found = await admitadAdapter.listProgrammes({ search: 'coffee' });
    expect(found.length).toBe(1);
    expect(found[0]?.id).toBe('3003');
  });

  it('emits a NetworkError when ADMITAD_CLIENT_ID is missing', async () => {
    delete process.env['ADMITAD_CLIENT_ID'];
    await expect(admitadAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });

  it('pages /advcampaigns/ to completion when no limit is passed', async () => {
    // _meta.count = 502 > one 500-row page, so the adapter must fetch page two
    // (offset=500) before _meta.count says the pull is complete.
    const spy = mockFetchQueue([
      fakeResponse(loadFixture('token.json')),
      fakeResponse(loadFixture('advcampaigns_page1.json')),
      fakeResponse(loadFixture('advcampaigns_page2.json')),
    ]);
    const programmes = await admitadAdapter.listProgrammes();
    expect(programmes.length).toBe(5);
    expect(programmes.map((p) => p.id)).toEqual(['3001', '3002', '3003', '3501', '3502']);
    // Token exchange + exactly two data pages; nothing left in the queue.
    expect(spy).toHaveBeenCalledTimes(3);
    const calls = spy.mock.calls as unknown as Array<[string]>;
    expect(String(calls[1]?.[0])).toContain('offset=0');
    expect(String(calls[2]?.[0])).toContain('offset=500');
  });

  it('stops at the MAX_CAMPAIGN_PAGES backstop and logs a warning (never silent)', async () => {
    const { ACTIONS_PAGE_LIMIT, MAX_CAMPAIGN_PAGES } = _internals;
    // Every page is full and _meta.count claims far more rows than the cap
    // allows, so the loop can only stop at the backstop. The queue holds
    // exactly MAX_CAMPAIGN_PAGES data responses: a 51st request would throw
    // 'mock fetch queue exhausted'.
    const fullPage = (pageIndex: number): unknown => ({
      results: Array.from({ length: ACTIONS_PAGE_LIMIT }, (_, i) => ({
        id: pageIndex * ACTIONS_PAGE_LIMIT + i,
        name: `Synthetic campaign ${pageIndex * ACTIONS_PAGE_LIMIT + i}`,
        connection_status: 'active',
      })),
      _meta: {
        count: ACTIONS_PAGE_LIMIT * (MAX_CAMPAIGN_PAGES + 5),
        limit: ACTIONS_PAGE_LIMIT,
        offset: pageIndex * ACTIONS_PAGE_LIMIT,
      },
    });
    const responses = [fakeResponse(loadFixture('token.json'))];
    for (let p = 0; p < MAX_CAMPAIGN_PAGES; p += 1) {
      responses.push(fakeResponse(fullPage(p)));
    }
    const spy = mockFetchQueue(responses);
    const warnSpy = vi.spyOn(_internals.log, 'warn');

    const programmes = await admitadAdapter.listProgrammes();
    expect(programmes.length).toBe(ACTIONS_PAGE_LIMIT * MAX_CAMPAIGN_PAGES);
    expect(spy).toHaveBeenCalledTimes(1 + MAX_CAMPAIGN_PAGES);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const warnArgs = warnSpy.mock.calls[0] as unknown[];
    expect(JSON.stringify(warnArgs)).toContain('MAX_CAMPAIGN_PAGES');
  });

  it('keeps a single bounded request when the caller passes a limit', async () => {
    const spy = mockWithToken(fakeResponse(loadFixture('advcampaigns.json')));
    const programmes = await admitadAdapter.listProgrammes({ limit: 2 });
    expect(programmes.length).toBe(2);
    // Token exchange + one data call only: the limit short-circuits paging.
    expect(spy).toHaveBeenCalledTimes(2);
    const calls = spy.mock.calls as unknown as Array<[string]>;
    expect(String(calls[1]?.[0])).toContain('limit=2');
    expect(String(calls[1]?.[0])).toContain('offset=0');
  });
});

describe('AdmitadAdapter.getProgramme', () => {
  it('returns a single programme by id', async () => {
    mockWithToken(fakeResponse(loadFixture('advcampaign_single.json')));
    const p = await admitadAdapter.getProgramme('3001');
    expect(p.id).toBe('3001');
    expect(p.status).toBe('joined');
  });

  it('throws config_error NetworkError when programmeId is empty', async () => {
    await expect(admitadAdapter.getProgramme('')).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listTransactions — status normalisation, unpaid-age, reversed visibility
// ---------------------------------------------------------------------------

describe('AdmitadAdapter.listTransactions', () => {
  it('normalises mixed statuses including the paid (payment_status=1) row', async () => {
    mockWithToken(fakeResponse(loadFixture('actions.json')));
    const all = await admitadAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
    });
    const byStatus = all.reduce<Record<string, number>>((acc, t) => {
      acc[t.status] = (acc[t.status] ?? 0) + 1;
      return acc;
    }, {});
    // pending(1) + approved(2: approved + approved_but_stalled) + reversed(1) + paid(1)
    expect(byStatus['pending']).toBe(1);
    expect(byStatus['approved']).toBe(2);
    expect(byStatus['reversed']).toBe(1);
    expect(byStatus['paid']).toBe(1);
  });

  it('includes reversed transactions with reason (§15.10)', async () => {
    mockWithToken(fakeResponse(loadFixture('actions.json')));
    const all = await admitadAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
    });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toBe('Customer returned the item within 30 days');
  });

  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockWithToken(fakeResponse(loadFixture('actions.json')));
    const aged = await admitadAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-12-31T00:00:00Z',
      minAgeDays: 365,
    });
    for (const t of aged) {
      expect(t.ageDays).toBeGreaterThanOrEqual(365);
    }
    expect(aged.length).toBeGreaterThan(0);
  });

  it('filters by status when caller passes status[]', async () => {
    mockWithToken(fakeResponse(loadFixture('actions.json')));
    const only = await admitadAdapter.listTransactions({ status: ['reversed'] });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('respects limit after all other filters are applied', async () => {
    mockWithToken(fakeResponse(loadFixture('actions.json')));
    const limited = await admitadAdapter.listTransactions({ limit: 2 });
    expect(limited.length).toBe(2);
  });

  it('returns empty when no actions match the window', async () => {
    mockWithToken(fakeResponse(loadFixture('actions_empty.json')));
    const none = await admitadAdapter.listTransactions({});
    expect(none).toHaveLength(0);
  });

  it('emits a NetworkError when ADMITAD_CLIENT_ID is missing', async () => {
    delete process.env['ADMITAD_CLIENT_ID'];
    await expect(admitadAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary — derived from listTransactions
// ---------------------------------------------------------------------------

describe('AdmitadAdapter.getEarningsSummary', () => {
  it('aggregates actions correctly from fixture data', async () => {
    mockWithToken(fakeResponse(loadFixture('actions.json')));
    const summary = await admitadAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-12-31T00:00:00Z',
    });
    expect(summary.network).toBe('admitad');
    expect(summary.totalEarnings).toBeCloseTo(5.5 + 12.75 + 3.2 + 8.0 + 2.1, 2);
    expect(summary.byStatus.pending).toBeCloseTo(5.5, 2);
    expect(summary.byStatus.approved).toBeCloseTo(12.75 + 2.1, 2);
    expect(summary.byStatus.reversed).toBeCloseTo(3.2, 2);
    expect(summary.byStatus.paid).toBeCloseTo(8.0, 2);
    // 3 distinct campaigns in the fixture.
    expect(summary.byProgramme.length).toBe(3);
    expect(summary.currency).toBe('EUR');
  });

  it('sets oldestUnpaidAgeDays from the longest-pending/approved transaction (§15.9)', async () => {
    mockWithToken(fakeResponse(loadFixture('actions.json')));
    const summary = await admitadAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-12-31T00:00:00Z',
    });
    // The 2024-01-20 approved action is the oldest unpaid → well over a year old.
    expect(summary.oldestUnpaidAgeDays).toBeDefined();
    expect(summary.oldestUnpaidAgeDays ?? 0).toBeGreaterThan(365);
  });

  it('returns an empty summary when no actions match the window', async () => {
    mockWithToken(fakeResponse(loadFixture('actions_empty.json')));
    const summary = await admitadAdapter.getEarningsSummary({});
    expect(summary.totalEarnings).toBe(0);
    expect(summary.byProgramme).toHaveLength(0);
    expect(summary.oldestUnpaidAgeDays).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listClicks — not exposed by the publisher API
// ---------------------------------------------------------------------------

describe('AdmitadAdapter.listClicks', () => {
  it('throws NotImplementedError with an Admitad-specific reason', async () => {
    await expect(admitadAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await admitadAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click-level data');
    }
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — deeplink generator API call
// ---------------------------------------------------------------------------

describe('AdmitadAdapter.generateTrackingLink', () => {
  it('returns the goto link from the deeplink generator', async () => {
    mockWithToken(fakeResponse(loadFixture('deeplink.json')));
    const link = await admitadAdapter.generateTrackingLink({
      programmeId: '3001',
      destinationUrl: 'https://www.examplebooks.test/product/123',
    });
    expect(link.network).toBe('admitad');
    expect(link.trackingUrl).toMatch(/^https:\/\/ad\.admitad\.com\/goto\//);
    expect(link.programmeId).toBe('3001');
    expect(link.destinationUrl).toBe('https://www.examplebooks.test/product/123');
  });

  it('calls the deeplink endpoint with the website id, campaign id and ulp', async () => {
    const spy = mockWithToken(fakeResponse(loadFixture('deeplink.json')));
    await admitadAdapter.generateTrackingLink({
      programmeId: '3001',
      destinationUrl: 'https://www.examplebooks.test/product/123',
    });
    // First call is the token exchange; second is the deeplink request.
    const calls = spy.mock.calls as unknown as Array<[string, RequestInit]>;
    const dataUrl = calls[1]?.[0] as unknown as string;
    expect(dataUrl).toContain('/deeplink/123456/advcampaign/3001/');
    expect(dataUrl).toContain('ulp=');
  });

  it('throws config_error when destinationUrl is empty', async () => {
    await expect(
      admitadAdapter.generateTrackingLink({ programmeId: '3001', destinationUrl: '' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws config_error when programmeId is empty', async () => {
    await expect(
      admitadAdapter.generateTrackingLink({ programmeId: '', destinationUrl: 'https://x.test/' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws NetworkError when ADMITAD_WEBSITE_ID is missing', async () => {
    delete process.env['ADMITAD_WEBSITE_ID'];
    await expect(
      admitadAdapter.generateTrackingLink({
        programmeId: '3001',
        destinationUrl: 'https://x.test/',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws when the deeplink generator returns no link', async () => {
    mockWithToken(fakeResponse({ results: [] }));
    await expect(
      admitadAdapter.generateTrackingLink({
        programmeId: '3001',
        destinationUrl: 'https://x.test/',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth — happy + failure paths
// ---------------------------------------------------------------------------

describe('AdmitadAdapter.verifyAuth', () => {
  it('returns ok:true and identity when token exchange and /me/ succeed', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('token.json')),
      fakeResponse(loadFixture('me.json')),
    ]);
    const r = await admitadAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('admitad/test-publisher');
    }
  });

  it('still returns ok:true (token-only identity) when /me/ fails but token succeeds', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('token.json')),
      fakeResponse('Forbidden', { status: 403, rawBody: 'Forbidden' }),
    ]);
    const r = await admitadAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('admitad/client:');
    }
  });

  it('surfaces failure (does not throw) on 401 from token endpoint (§15.4)', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_client"}', {
        status: 401,
        rawBody: '{"error":"invalid_client"}',
      }),
    ]);
    const r = await admitadAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/HTTP 401|401|invalid_client|auth/i);
    }
  });

  it('never throws on auth failure', async () => {
    mockFetchQueue([fakeResponse('Unauthorized', { status: 401, rawBody: 'Unauthorized' })]);
    await expect(admitadAdapter.verifyAuth()).resolves.toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('AdmitadAdapter.validateCredential', () => {
  it('accepts a non-empty ADMITAD_CLIENT_ID without an API call', async () => {
    const r = await admitadAdapter.validateCredential('ADMITAD_CLIENT_ID', 'any-id');
    expect(r.ok).toBe(true);
  });

  it('rejects an empty ADMITAD_CLIENT_ID', async () => {
    const r = await admitadAdapter.validateCredential('ADMITAD_CLIENT_ID', '');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('validates ADMITAD_CLIENT_SECRET via live token exchange', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('token.json')),
      fakeResponse(loadFixture('me.json')),
    ]);
    const r = await admitadAdapter.validateCredential(
      'ADMITAD_CLIENT_SECRET',
      'test-secret-please-ignore',
    );
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with hint when ADMITAD_CLIENT_SECRET is wrong', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_client"}', {
        status: 401,
        rawBody: '{"error":"invalid_client"}',
      }),
    ]);
    const r = await admitadAdapter.validateCredential('ADMITAD_CLIENT_SECRET', 'bad-secret');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('accepts a positive integer ADMITAD_WEBSITE_ID', async () => {
    const r = await admitadAdapter.validateCredential('ADMITAD_WEBSITE_ID', '123456');
    expect(r.ok).toBe(true);
  });

  it('rejects a non-numeric ADMITAD_WEBSITE_ID', async () => {
    const r1 = await admitadAdapter.validateCredential('ADMITAD_WEBSITE_ID', 'abc');
    expect(r1.ok).toBe(false);
    const r2 = await admitadAdapter.validateCredential('ADMITAD_WEBSITE_ID', '0');
    expect(r2.ok).toBe(false);
    expect(r2.hint).toBeTruthy();
  });

  it('returns ok:false for unknown credential fields', async () => {
    const r = await admitadAdapter.validateCredential('ADMITAD_UNKNOWN_FIELD', 'value');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces verbatim response body on a 500', async () => {
    const body = '{"error":"upstream exploded","trace":"xyz"}';
    mockFetchQueue([
      fakeResponse(loadFixture('token.json')),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await admitadAdapter.listTransactions({});
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('admitad');
      expect(env.operation).toBe('listTransactions');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream exploded');
    }
  });

  it('classifies 401 on the data API as auth_error', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('token.json')),
      fakeResponse('Forbidden', { status: 401, rawBody: 'Forbidden' }),
    ]);
    try {
      await admitadAdapter.listTransactions({});
      throw new Error('expected to throw');
    } catch (err) {
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('auth_error');
    }
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('AdmitadAdapter.capabilitiesCheck', () => {
  it('records listClicks as not supported and the API-backed ops as supported', async () => {
    // Probe order: verifyAuth (token + /me/), listProgrammes (token + data),
    // listTransactions (token + data), getEarningsSummary (token + data).
    mockFetchQueue([
      fakeResponse(loadFixture('token.json')), // verifyAuth token
      fakeResponse(loadFixture('me.json')), // verifyAuth /me/
      fakeResponse(loadFixture('token.json')), // listProgrammes token
      fakeResponse(loadFixture('advcampaigns.json')), // listProgrammes data
      fakeResponse(loadFixture('token.json')), // listTransactions token
      fakeResponse(loadFixture('actions_empty.json')), // listTransactions data
      fakeResponse(loadFixture('token.json')), // getEarningsSummary token
      fakeResponse(loadFixture('actions_empty.json')), // getEarningsSummary data
    ]);
    const caps = await admitadAdapter.capabilitiesCheck();
    expect(caps.network).toBe('admitad');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['verifyAuth']?.supported).toBe(true);
    expect(caps.operations['listProgrammes']?.supported).toBe(true);
    expect(caps.operations['listTransactions']?.supported).toBe(true);
    expect(caps.operations['getEarningsSummary']?.supported).toBe(true);
    expect(caps.operations['getProgramme']?.supported).toBe(true);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(true);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
