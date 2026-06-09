/**
 * AccessTrade adapter — unit tests.
 *
 * Mirrors the Awin/Everflow test pattern:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - Each test stubs only the responses it needs.
 *   - No live network calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { accesstradeAdapter, _internals } from '../../../src/networks/accesstrade/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'networks', 'accesstrade', 'fixtures');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(body: unknown, init: { status?: number; rawBody?: string } = {}): Response {
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
  process.env['ACCESSTRADE_ACCESS_KEY'] = 'test-access-key-please-ignore';
  process.env['ACCESSTRADE_SITE_ID'] = 'site-abc';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['ACCESSTRADE_ACCESS_KEY'];
  delete process.env['ACCESSTRADE_SITE_ID'];
  delete process.env['ACCESSTRADE_BASE_URL'];
});

// ---------------------------------------------------------------------------
// Transformers (status normalisation + raw preservation)
// ---------------------------------------------------------------------------

describe('AccessTrade transformers (status normalisation, raw preservation)', () => {
  it('maps conversion status APPROVED|PENDING|REJECTED → canonical statuses', () => {
    const items = (loadFixture('conversions.json') as { conversionReportItems: Array<Record<string, unknown>> })
      .conversionReportItems;
    const approved = _internals.toTransaction(items[0] as never);
    const pending = _internals.toTransaction(items[1] as never);
    const rejected = _internals.toTransaction(items[2] as never);
    expect(approved.status).toBe('approved');
    expect(pending.status).toBe('pending');
    // REJECTED maps to 'reversed' (the user did not get paid).
    expect(rejected.status).toBe('reversed');
  });

  it('preserves the raw AccessTrade response under rawNetworkData', () => {
    const item = (loadFixture('conversions.json') as { conversionReportItems: Array<Record<string, unknown>> })
      .conversionReportItems[0];
    const out = _internals.toTransaction(item as never);
    expect(out.rawNetworkData).toBe(item);
  });

  it('surfaces reversalReason on reversed transactions (§15.10)', () => {
    const rejected = (loadFixture('conversions.json') as { conversionReportItems: Array<Record<string, unknown>> })
      .conversionReportItems[2];
    const out = _internals.toTransaction(rejected as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Customer returned the item within 14 days');
  });

  it('maps campaign affiliationStatus to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ affiliationStatus: 'affiliated' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ affiliationStatus: 'applied' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ affiliationStatus: 'rejected' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ affiliationStatus: 'unaffiliated' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ affiliationStatus: 'paused' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ affiliationStatus: 'never-seen' })).toBe('unknown');
  });

  it('computes ageDays from confirmedTime (preferred) or conversionTime', () => {
    const now = new Date('2026-05-21T00:00:00Z');
    const age1 = _internals.computeAgeDays(
      { confirmedTime: '2026-01-01T00:00:00Z' } as never,
      now,
    );
    expect(age1).toBe(140);
    const age2 = _internals.computeAgeDays(
      { conversionTime: '2026-04-01T00:00:00Z' } as never,
      now,
    );
    expect(age2).toBe(50);
  });

  it('picks the campaign segment from requested status', () => {
    expect(_internals.pickCampaignSegment()).toBe('affiliated');
    expect(_internals.pickCampaignSegment(['joined'])).toBe('affiliated');
    expect(_internals.pickCampaignSegment(['pending'])).toBe('applied');
    expect(_internals.pickCampaignSegment(['available'])).toBe('unaffiliated');
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('AccessTrade.listProgrammes', () => {
  it('returns programmes from the campaigns envelope and preserves raw data', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const programmes = await accesstradeAdapter.listProgrammes();
    expect(programmes.length).toBe(3);
    expect(programmes[0]?.network).toBe('accesstrade');
    expect(programmes[0]?.id).toBe('5001');
    expect(programmes[0]?.status).toBe('joined');
    expect(programmes[0]?.categories).toContain('Books');
  });

  it('applies a client-side search filter', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const programmes = await accesstradeAdapter.listProgrammes({ search: 'reef' });
    expect(programmes.length).toBe(1);
    expect(programmes[0]?.id).toBe('5002');
  });

  it('emits an error envelope when the access key is missing', async () => {
    delete process.env['ACCESSTRADE_ACCESS_KEY'];
    await expect(accesstradeAdapter.listProgrammes({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getProgramme
// ---------------------------------------------------------------------------

describe('AccessTrade.getProgramme', () => {
  it('resolves a campaign by ID from the affiliated list', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const programme = await accesstradeAdapter.getProgramme('5001');
    expect(programme.id).toBe('5001');
    expect(programme.name).toBe('Atolls Bookshop SEA');
  });

  it('throws a network_api_error envelope for an unknown campaign', async () => {
    // Two segment lookups (affiliated, then unaffiliated) — neither matches.
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json')), fakeResponse({ data: [] })]);
    await expect(accesstradeAdapter.getProgramme('999999')).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error envelope when the ID is empty', async () => {
    await expect(accesstradeAdapter.getProgramme('')).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listTransactions — chunking + unpaid-age + reversed visibility
// ---------------------------------------------------------------------------

describe('AccessTrade.listTransactions', () => {
  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const aged = await accesstradeAdapter.listTransactions({
      from: '2026-05-14T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
      minAgeDays: 365,
    });
    for (const t of aged) {
      expect(t.ageDays).toBeGreaterThanOrEqual(365);
    }
    expect(aged.length).toBeGreaterThan(0);
  });

  it('includes reversed transactions with reason populated (§15.10)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const all = await accesstradeAdapter.listTransactions({
      from: '2026-05-14T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
    });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toBe('Customer returned the item within 14 days');
  });

  it('chunks date ranges wider than 7 days into multiple calls', async () => {
    const spy = mockFetchQueue([
      fakeResponse({ conversionReportItems: [] }),
      fakeResponse({ conversionReportItems: [] }),
      fakeResponse({ conversionReportItems: [] }),
    ]);
    await accesstradeAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-21T00:00:00Z', // ~20 days → 3 slices of ≤7 days
    });
    expect(spy.mock.calls.length).toBe(3);
  });

  it('filters by status when caller passes status[]', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const only = await accesstradeAdapter.listTransactions({
      from: '2026-05-14T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('emits an error envelope when the access key is missing', async () => {
    delete process.env['ACCESSTRADE_ACCESS_KEY'];
    await expect(accesstradeAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('AccessTrade.getEarningsSummary', () => {
  it('aggregates commission by status and programme, tracking oldest unpaid age', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const summary = await accesstradeAdapter.getEarningsSummary({
      from: '2026-05-14T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
    });
    expect(summary.network).toBe('accesstrade');
    // 8 + 6 approved + 4 pending = 18 commission total (reversed contributes 0).
    expect(summary.totalEarnings).toBe(18);
    expect(summary.currency).toBe('SGD');
    expect(summary.byStatus.approved).toBe(14);
    expect(summary.byStatus.pending).toBe(4);
    expect(summary.oldestUnpaidAgeDays).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// listClicks — unsupported
// ---------------------------------------------------------------------------

describe('AccessTrade.listClicks', () => {
  it('throws NotImplementedError with the documented reason', async () => {
    await expect(accesstradeAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await accesstradeAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('does not expose click-level data');
    }
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — unsupported
// ---------------------------------------------------------------------------

describe('AccessTrade.generateTrackingLink', () => {
  it('throws NotImplementedError (no documented deterministic scheme)', async () => {
    const spy = mockFetchQueue([]);
    await expect(
      accesstradeAdapter.generateTrackingLink({
        programmeId: '5001',
        destinationUrl: 'https://x.example.com',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
    // No network call should be attempted.
    expect(spy.mock.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('AccessTrade.verifyAuth', () => {
  it('returns ok:true and a site identity when the campaigns probe responds 200', async () => {
    mockFetchQueue([fakeResponse({ data: [] })]);
    const r = await accesstradeAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('accesstrade/site/site-abc');
    }
  });

  it('returns ok:false on 401', async () => {
    mockFetchQueue([fakeResponse('{"error":"invalid_token"}', { status: 401 })]);
    const r = await accesstradeAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/HTTP 401|401/);
  });

  it('returns ok:false when the site id is missing', async () => {
    delete process.env['ACCESSTRADE_SITE_ID'];
    const r = await accesstradeAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('AccessTrade.validateCredential', () => {
  it('rejects an empty site id', async () => {
    const r = await accesstradeAdapter.validateCredential('ACCESSTRADE_SITE_ID', '');
    expect(r.ok).toBe(false);
  });

  it('accepts a non-empty site id', async () => {
    const r = await accesstradeAdapter.validateCredential('ACCESSTRADE_SITE_ID', 'site-abc');
    expect(r.ok).toBe(true);
  });

  it('validates the access key against the campaigns endpoint', async () => {
    mockFetchQueue([fakeResponse({ data: [] })]);
    const r = await accesstradeAdapter.validateCredential('ACCESSTRADE_ACCESS_KEY', 'fresh-key');
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with a hint when access-key validation fails', async () => {
    mockFetchQueue([fakeResponse('{"error":"bad"}', { status: 401 })]);
    const r = await accesstradeAdapter.validateCredential('ACCESSTRADE_ACCESS_KEY', 'bad-key');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('AccessTrade.capabilitiesCheck', () => {
  it('records listClicks and generateTrackingLink as unsupported', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('campaigns.json')), // listProgrammes
      fakeResponse({ conversionReportItems: [] }), // listTransactions probe
      fakeResponse({ conversionReportItems: [] }), // getEarningsSummary → listTransactions
      fakeResponse({ data: [] }), // verifyAuth
    ]);
    const caps = await accesstradeAdapter.capabilitiesCheck();
    expect(caps.network).toBe('accesstrade');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim AccessTrade response body on a 500', async () => {
    const body = '{"error":"upstream broke","trace":"abc"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await accesstradeAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('accesstrade');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream broke');
    }
  });

  it('classifies 401 as auth_error', async () => {
    mockFetchQueue([fakeResponse('forbidden', { status: 401, rawBody: 'forbidden' })]);
    try {
      await accesstradeAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('auth_error');
    }
  });
});

// ---------------------------------------------------------------------------
// ACCESSTRADE_BASE_URL override
// ---------------------------------------------------------------------------

describe('AccessTrade base URL override', () => {
  it('uses ACCESSTRADE_BASE_URL when set', async () => {
    process.env['ACCESSTRADE_BASE_URL'] = 'https://gurkha.accesstrade.in.th';
    const spy = mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    await accesstradeAdapter.listProgrammes();
    const calledUrl = String(spy.mock.calls[0]?.[0]);
    expect(calledUrl).toContain('gurkha.accesstrade.in.th');
  });
});
