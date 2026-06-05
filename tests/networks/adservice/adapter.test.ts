/**
 * Adservice adapter — unit tests.
 *
 * Pattern-matched to `tests/networks/skimlinks/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - Circuit breakers are reset in `beforeEach` so no test bleeds state.
 *   - Fake credentials are injected via `process.env` (obvious non-secret values).
 *   - Fixtures live under `tests/fixtures/adservice/`.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 *
 * Adservice auth is cookie-based (UID + LoginToken), so each adapter op makes a
 * single fetch (no separate token-exchange call).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { adserviceAdapter, _internals } from '../../../src/networks/adservice/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'adservice');

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

beforeEach(() => {
  _resetBreakers();
  process.env['ADSERVICE_UID'] = 'test-uid-please-ignore';
  process.env['ADSERVICE_LOGIN_TOKEN'] = 'test-login-token-please-ignore';
  process.env['ADSERVICE_AFFILIATE_ID'] = 'aff-test';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['ADSERVICE_UID'];
  delete process.env['ADSERVICE_LOGIN_TOKEN'];
  delete process.env['ADSERVICE_AFFILIATE_ID'];
});

// ---------------------------------------------------------------------------
// Transformer unit tests (status normalisation + raw preservation)
// ---------------------------------------------------------------------------

describe('Adservice transformers (status normalisation, raw preservation)', () => {
  it('derives transaction status from the pending/settled bucket', () => {
    expect(_internals.mapAggregateStatus(true)).toBe('pending');
    expect(_internals.mapAggregateStatus(false)).toBe('approved');
  });

  it('maps Adservice campaign statuses to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ status: 'active' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'approved' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ status: 'declined' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ status: 'available' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ status: 'paused' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'something-new' })).toBe('unknown');
    expect(_internals.mapProgrammeStatus({})).toBe('unknown');
  });

  it('preserves the raw Adservice payload in rawNetworkData on transactions', () => {
    const rows = (loadFixture('statistics.json') as { statistics: unknown[] }).statistics;
    const raw = rows[0] as Record<string, unknown>;
    const out = _internals.toTransaction(raw as never, { isPending: false });
    expect(out.rawNetworkData).toBe(raw);
  });

  it('preserves the raw Adservice payload in rawNetworkData on programmes', () => {
    const rows = (loadFixture('campaigns.json') as { campaigns: unknown[] }).campaigns;
    const raw = rows[0] as Record<string, unknown>;
    const out = _internals.toProgramme(raw as never);
    expect(out.rawNetworkData).toBe(raw);
    expect(out.network).toBe('adservice');
  });

  it('computes ageDays from the row period date with an injectable now (§15.9)', () => {
    const now = new Date('2026-05-10T00:00:00Z');
    // stamp = 2026-05-02 → 8 days
    const age = _internals.computeAgeDays({ stamp: '2026-05-02' }, now);
    expect(age).toBe(8);
    // No date → 0
    expect(_internals.computeAgeDays({}, now)).toBe(0);
  });

  it('normalises string and number amounts', () => {
    expect(_internals.toAmount(5.5)).toBe(5.5);
    expect(_internals.toAmount('12.75')).toBe(12.75);
    expect(_internals.toAmount(undefined)).toBe(0);
    expect(_internals.toAmount('not-a-number')).toBe(0);
  });

  it('reads the settled vs pending figure based on the bucket', () => {
    const row = { earnings: 42.5, pending: 7.25, currency: 'SEK', stamp: '2026-05-02', camp_id: '3001' };
    const settled = _internals.toTransaction(row as never, { isPending: false });
    const pending = _internals.toTransaction(row as never, { isPending: true });
    expect(settled.status).toBe('approved');
    expect(settled.commission).toBeCloseTo(42.5, 2);
    expect(pending.status).toBe('pending');
    expect(pending.commission).toBeCloseTo(7.25, 2);
    expect(settled.currency).toBe('SEK');
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('AdserviceAdapter.listTransactions', () => {
  it('emits a settled transaction per row and an extra pending row where present', async () => {
    mockFetchQueue([fakeResponse(loadFixture('statistics.json'))]);
    const txns = await adserviceAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-01T00:00:00Z',
    });
    // 3 settled rows + 2 rows with pending > 0 = 5 transactions.
    expect(txns.length).toBe(5);
    expect(txns.filter((t) => t.status === 'approved').length).toBe(3);
    expect(txns.filter((t) => t.status === 'pending').length).toBe(2);
  });

  it('filters by status when caller passes status[]', async () => {
    mockFetchQueue([fakeResponse(loadFixture('statistics.json'))]);
    const pendingOnly = await adserviceAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-01T00:00:00Z',
      status: ['pending'],
    });
    expect(pendingOnly.length).toBe(2);
    expect(pendingOnly.every((t) => t.status === 'pending')).toBe(true);
  });

  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('statistics.json'))]);
    const aged = await adserviceAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-01T00:00:00Z',
      minAgeDays: 365,
    });
    for (const t of aged) {
      expect(t.ageDays).toBeGreaterThanOrEqual(365);
    }
    expect(aged.length).toBeGreaterThan(0);
  });

  it('respects limit after all other filters are applied', async () => {
    mockFetchQueue([fakeResponse(loadFixture('statistics.json'))]);
    const limited = await adserviceAdapter.listTransactions({ limit: 2 });
    expect(limited.length).toBeLessThanOrEqual(2);
  });

  it('returns empty when the statistics array is empty', async () => {
    mockFetchQueue([fakeResponse(loadFixture('statistics_empty.json'))]);
    const txns = await adserviceAdapter.listTransactions({});
    expect(txns).toHaveLength(0);
  });

  it('emits a NetworkError when ADSERVICE_UID is missing', async () => {
    delete process.env['ADSERVICE_UID'];
    await expect(adserviceAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });

  it('emits a NetworkError when ADSERVICE_LOGIN_TOKEN is missing', async () => {
    delete process.env['ADSERVICE_LOGIN_TOKEN'];
    await expect(adserviceAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes / getProgramme
// ---------------------------------------------------------------------------

describe('AdserviceAdapter.listProgrammes', () => {
  it('normalises campaigns into programmes', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const programmes = await adserviceAdapter.listProgrammes();
    expect(programmes.length).toBe(3);
    expect(programmes[0]?.network).toBe('adservice');
    expect(programmes[0]?.status).toBe('joined');
    expect(programmes[1]?.status).toBe('pending');
    expect(programmes[2]?.status).toBe('suspended');
  });

  it('filters by search term', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const programmes = await adserviceAdapter.listProgrammes({ search: 'helsinki' });
    expect(programmes.length).toBe(1);
    expect(programmes[0]?.id).toBe('3002');
  });

  it('filters by status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const programmes = await adserviceAdapter.listProgrammes({ status: 'joined' });
    expect(programmes.length).toBe(1);
    expect(programmes[0]?.id).toBe('3001');
  });
});

describe('AdserviceAdapter.getProgramme', () => {
  it('returns a single programme by id', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const programme = await adserviceAdapter.getProgramme('3002');
    expect(programme.id).toBe('3002');
    expect(programme.name).toBe('Helsinki Home Oy');
  });

  it('throws a NetworkError when the id is not found', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    await expect(adserviceAdapter.getProgramme('9999')).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error NetworkError when id is empty', async () => {
    await expect(adserviceAdapter.getProgramme('')).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary — derived from listTransactions
// ---------------------------------------------------------------------------

describe('AdserviceAdapter.getEarningsSummary', () => {
  it('aggregates earnings correctly from fixture data', async () => {
    mockFetchQueue([fakeResponse(loadFixture('statistics.json'))]);
    const summary = await adserviceAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-01T00:00:00Z',
    });
    expect(summary.network).toBe('adservice');
    // approved = 42.5 + 18.0 + 0 ; pending = 7.25 + 15.8
    expect(summary.byStatus.approved).toBeCloseTo(60.5, 2);
    expect(summary.byStatus.pending).toBeCloseTo(23.05, 2);
    expect(summary.totalEarnings).toBeCloseTo(83.55, 2);
    // two distinct campaigns
    expect(summary.byProgramme.length).toBe(2);
  });

  it('sets oldestUnpaidAgeDays from the longest-pending/approved transaction (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('statistics.json'))]);
    const summary = await adserviceAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-01T00:00:00Z',
    });
    // The 2025-04-01 row is the oldest unpaid period.
    expect(summary.oldestUnpaidAgeDays).toBeDefined();
    expect(summary.oldestUnpaidAgeDays ?? 0).toBeGreaterThan(365);
  });

  it('returns an empty summary when no rows match', async () => {
    mockFetchQueue([fakeResponse(loadFixture('statistics_empty.json'))]);
    const summary = await adserviceAdapter.getEarningsSummary({});
    expect(summary.totalEarnings).toBe(0);
    expect(summary.byProgramme).toHaveLength(0);
    expect(summary.oldestUnpaidAgeDays).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listClicks / generateTrackingLink — NotImplemented with specific reasons
// ---------------------------------------------------------------------------

describe('AdserviceAdapter.listClicks', () => {
  it('throws NotImplementedError because no row-level click endpoint exists', async () => {
    await expect(adserviceAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await adserviceAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click');
    }
  });
});

describe('AdserviceAdapter.generateTrackingLink', () => {
  it('throws NotImplementedError because the link format is undocumented', async () => {
    await expect(
      adserviceAdapter.generateTrackingLink({
        programmeId: '3001',
        destinationUrl: 'https://www.nordicoutdoor.test/',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await adserviceAdapter.generateTrackingLink({
        programmeId: '3001',
        destinationUrl: 'https://www.nordicoutdoor.test/',
      });
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('tracking-link');
    }
  });
});

// ---------------------------------------------------------------------------
// verifyAuth — happy + failure paths
// ---------------------------------------------------------------------------

describe('AdserviceAdapter.verifyAuth', () => {
  it('returns ok:true and identity when the credentialed read succeeds', async () => {
    mockFetchQueue([fakeResponse(loadFixture('statistics_empty.json'))]);
    const r = await adserviceAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('adservice/affiliate:aff-test');
    }
  });

  it('returns identity from UID when no affiliate id is set', async () => {
    delete process.env['ADSERVICE_AFFILIATE_ID'];
    mockFetchQueue([fakeResponse(loadFixture('statistics_empty.json'))]);
    const r = await adserviceAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('adservice/uid:');
    }
  });

  it('returns ok:false (does not throw) on a 401 (§15.4)', async () => {
    mockFetchQueue([
      fakeResponse('Unauthorized', { status: 401, rawBody: 'Unauthorized' }),
    ]);
    await expect(adserviceAdapter.verifyAuth()).resolves.toMatchObject({ ok: false });
  });

  it('returns ok:false when credentials are missing', async () => {
    delete process.env['ADSERVICE_UID'];
    const r = await adserviceAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('AdserviceAdapter.validateCredential', () => {
  it('accepts a non-empty ADSERVICE_UID without an API call', async () => {
    const r = await adserviceAdapter.validateCredential('ADSERVICE_UID', 'some-uid');
    expect(r.ok).toBe(true);
  });

  it('rejects an empty ADSERVICE_UID', async () => {
    const r = await adserviceAdapter.validateCredential('ADSERVICE_UID', '');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('validates ADSERVICE_LOGIN_TOKEN via a live read', async () => {
    mockFetchQueue([fakeResponse(loadFixture('statistics_empty.json'))]);
    const r = await adserviceAdapter.validateCredential(
      'ADSERVICE_LOGIN_TOKEN',
      'test-login-token-please-ignore',
    );
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with a hint when ADSERVICE_LOGIN_TOKEN is wrong', async () => {
    mockFetchQueue([
      fakeResponse('Forbidden', { status: 403, rawBody: 'Forbidden' }),
    ]);
    const r = await adserviceAdapter.validateCredential('ADSERVICE_LOGIN_TOKEN', 'bad-token');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('accepts a blank optional ADSERVICE_AFFILIATE_ID', async () => {
    const r = await adserviceAdapter.validateCredential('ADSERVICE_AFFILIATE_ID', '');
    expect(r.ok).toBe(true);
  });

  it('rejects an ADSERVICE_AFFILIATE_ID with invalid characters', async () => {
    const r = await adserviceAdapter.validateCredential('ADSERVICE_AFFILIATE_ID', 'has spaces!');
    expect(r.ok).toBe(false);
  });

  it('returns ok:false for unknown credential fields', async () => {
    const r = await adserviceAdapter.validateCredential('ADSERVICE_UNKNOWN', 'x');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim response body on a 500', async () => {
    const body = '{"error":"upstream exploded","trace":"xyz"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await adserviceAdapter.listTransactions({});
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('adservice');
      expect(env.operation).toBe('listTransactions');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream exploded');
    }
  });

  it('classifies a 401 on the reporting API as auth_error', async () => {
    mockFetchQueue([
      fakeResponse('Forbidden', { status: 401, rawBody: 'Forbidden' }),
    ]);
    try {
      await adserviceAdapter.listTransactions({});
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

describe('AdserviceAdapter.capabilitiesCheck', () => {
  it('records listClicks and generateTrackingLink as not supported', async () => {
    // capabilitiesCheck probes: verifyAuth, listProgrammes, getProgramme,
    // listTransactions, getEarningsSummary. Each is a single fetch.
    mockFetchQueue([
      fakeResponse(loadFixture('statistics_empty.json')), // verifyAuth
      fakeResponse(loadFixture('campaigns.json')), // listProgrammes
      fakeResponse(loadFixture('campaigns.json')), // getProgramme → listProgrammes
      fakeResponse(loadFixture('statistics_empty.json')), // listTransactions
      fakeResponse(loadFixture('statistics_empty.json')), // getEarningsSummary → listTransactions
    ]);
    const caps = await adserviceAdapter.capabilitiesCheck();
    expect(caps.network).toBe('adservice');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
    expect(caps.operations['verifyAuth']?.supported).toBe(true);
    expect(caps.operations['listProgrammes']?.supported).toBe(true);
    expect(caps.operations['listTransactions']?.supported).toBe(true);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
