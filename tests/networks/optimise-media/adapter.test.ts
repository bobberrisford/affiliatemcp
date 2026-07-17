/**
 * Optimise Media (OMG Network API) adapter — unit tests.
 *
 * Pattern matched to `tests/networks/awin/adapter.test.ts` and
 * `tests/networks/everflow/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 *   - Fixtures under `tests/fixtures/optimise-media/` approximate the shape of
 *     the documented OMG Network API responses. No real keys, no real data.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { optimiseMediaAdapter, _internals } from '../../../src/networks/optimise-media/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'optimise-media');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(body: unknown, init: { status?: number; rawBody?: string } = {}): Response {
  const status = init.status ?? 200;
  const text = init.rawBody ?? (typeof body === 'string' ? body : JSON.stringify(body));
  return new Response(text, { status, headers: { 'content-type': 'application/json' } });
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
  process.env['OPTIMISE_MEDIA_API_TOKEN'] = 'test-api-key-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['OPTIMISE_MEDIA_API_TOKEN'];
});

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

describe('Optimise Media transformers (status normalisation, raw preservation)', () => {
  it('maps conversion statuses to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ status: 'Approved' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'Validated' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'Pending' })).toBe('pending');
    // 'declined'/'rejected' are the user-facing "reversed" intent (§15.4).
    expect(_internals.mapTransactionStatus({ status: 'Rejected' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'Declined' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'Paid' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ status: 'something-new' })).toBe('other');
    expect(_internals.mapTransactionStatus({})).toBe('other');
  });

  it('maps campaign relationship statuses to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ relationshipStatus: 'Joined' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ relationshipStatus: 'Approved' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ relationshipStatus: 'Pending' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ relationshipStatus: 'Declined' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ relationshipStatus: 'Paused' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ relationshipStatus: 'Available' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ relationshipStatus: 'never-seen' })).toBe('unknown');
  });

  it('preserves the raw payload under rawNetworkData', () => {
    const raw = (loadFixture('conversions.json') as { data: Record<string, unknown>[] }).data[0];
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('surfaces reversalReason on reversed transactions (§15.10)', () => {
    const rejected = (loadFixture('conversions.json') as { data: Record<string, unknown>[] })
      .data[2];
    const out = _internals.toTransaction(rejected as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Customer returned the item within 14 days');
  });

  it('computes ageDays from validationDate (preferred) then conversionDate', () => {
    const now = new Date('2026-05-21T00:00:00Z');
    const age1 = _internals.computeAgeDays({ validationDate: '2026-01-01T00:00:00Z' }, now);
    expect(age1).toBe(140);
    const age2 = _internals.computeAgeDays({ conversionDate: '2026-04-01T00:00:00Z' }, now);
    expect(age2).toBe(50);
    expect(_internals.computeAgeDays({}, now)).toBe(0);
  });

  it('reads sale value and commission across field-name synonyms', () => {
    const tx = _internals.toTransaction({
      conversionId: 'x',
      orderValue: 300,
      commissionValue: 15,
      currency: 'EUR',
      conversionDate: '2026-04-20T12:00:00Z',
      status: 'Pending',
    } as never);
    expect(tx.amount).toBe(300);
    expect(tx.commission).toBe(15);
    expect(tx.currency).toBe('EUR');
  });

  it('chunkDateRange splits windows wider than 31 days', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-03-31T00:00:00Z');
    const slices = _internals.chunkDateRange(from, to, 31);
    expect(slices.length).toBe(3);
    expect(slices[slices.length - 1]?.end.toISOString()).toBe(to.toISOString());
  });
});

// ---------------------------------------------------------------------------
// listProgrammes / getProgramme
// ---------------------------------------------------------------------------

describe('Optimise Media.listProgrammes', () => {
  it('maps campaign statuses from the fixture', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const programmes = await optimiseMediaAdapter.listProgrammes();
    expect(programmes.length).toBe(3);
    expect(programmes.find((p) => p.id === '1001')?.status).toBe('joined');
    expect(programmes.find((p) => p.id === '1002')?.status).toBe('pending');
    expect(programmes.find((p) => p.id === '1003')?.status).toBe('declined');
  });

  it('filters by status client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const only = await optimiseMediaAdapter.listProgrammes({ status: 'joined' });
    expect(only.every((p) => p.status === 'joined')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('applies search filter client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const results = await optimiseMediaAdapter.listProgrammes({ search: 'travel' });
    expect(results.length).toBe(1);
    expect(results[0]?.name).toBe('Atolls Travel');
  });

  it('throws a NetworkError when the API key is missing', async () => {
    delete process.env['OPTIMISE_MEDIA_API_TOKEN'];
    await expect(optimiseMediaAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes pagination (#316: lifted offset-paging exclusion)
// ---------------------------------------------------------------------------

describe('Optimise Media.listProgrammes pagination', () => {
  it('pulls every /Campaigns page when no limit is given', async () => {
    const spy = mockFetchQueue([
      fakeResponse(loadFixture('campaigns-page1.json')),
      fakeResponse(loadFixture('campaigns-page2.json')),
    ]);
    const programmes = await optimiseMediaAdapter.listProgrammes();
    expect(programmes.length).toBe(5);
    expect(programmes.map((p) => p.id)).toEqual(['2001', '2002', '2003', '2004', '2005']);
    expect(spy.mock.calls.length).toBe(2);
    const urls = spy.mock.calls.map((c) => String(c[0]));
    expect(urls[0]).toContain('page=1');
    expect(urls[1]).toContain('page=2');
  });

  it('stops as soon as a caller limit is satisfied (backward-compatible short-circuit)', async () => {
    // Only one response is queued: a second request would exhaust the queue
    // and fail, proving the loop short-circuits on limit.
    const spy = mockFetchQueue([fakeResponse(loadFixture('campaigns-page1.json'))]);
    const programmes = await optimiseMediaAdapter.listProgrammes({ limit: 2 });
    expect(programmes.length).toBe(2);
    expect(spy.mock.calls.length).toBe(1);
  });

  it('treats a page shorter than pageSize as the last page when no totalCount is present', async () => {
    const spy = mockFetchQueue([
      fakeResponse([
        {
          campaignId: 3001,
          campaignName: 'Atolls Outdoors',
          relationshipStatus: 'Joined',
        },
      ]),
    ]);
    const programmes = await optimiseMediaAdapter.listProgrammes();
    expect(programmes.length).toBe(1);
    expect(spy.mock.calls.length).toBe(1);
  });

  it('caps a runaway page loop at MAX_PAGES and warns rather than truncating silently', async () => {
    // Every page advertises far more rows than it serves, so the loop never
    // sees completion; the MAX_PAGES backstop must stop it and log a warning.
    const runawayPage = {
      data: [
        {
          campaignId: 9001,
          campaignName: 'Atolls Runaway',
          relationshipStatus: 'Joined',
        },
      ],
      page: 1,
      pageSize: 100,
      totalCount: 100000,
    };
    const spy = mockFetchQueue(
      Array.from({ length: 60 }, () => fakeResponse(runawayPage)),
    );
    const warnSpy = vi.spyOn(_internals.log, 'warn').mockImplementation(() => undefined);

    const programmes = await optimiseMediaAdapter.listProgrammes();
    expect(spy.mock.calls.length).toBe(50); // MAX_PAGES
    expect(programmes.length).toBe(50);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]?.[1])).toContain('MAX_PAGES');
  });
});

describe('Optimise Media.getProgramme', () => {
  it('returns the matching campaign', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const prog = await optimiseMediaAdapter.getProgramme('1001');
    expect(prog.id).toBe('1001');
    expect(prog.name).toBe('Atolls Bookshop');
    expect(prog.network).toBe('optimise-media');
  });

  it('throws a config_error envelope for non-numeric ids', async () => {
    await expect(optimiseMediaAdapter.getProgramme('not-a-number')).rejects.toBeInstanceOf(
      NetworkError,
    );
  });

  it('throws a network_api_error envelope when no campaign is returned', async () => {
    mockFetchQueue([fakeResponse({ data: [] })]);
    await expect(optimiseMediaAdapter.getProgramme('9999')).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('Optimise Media.listTransactions', () => {
  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const aged = await optimiseMediaAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-28T00:00:00Z',
      minAgeDays: 50,
    });
    for (const t of aged) {
      expect(t.ageDays).toBeGreaterThanOrEqual(50);
    }
    expect(aged.length).toBeGreaterThan(0);
  });

  it('includes reversed transactions with reason populated (§15.10)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const all = await optimiseMediaAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-28T00:00:00Z',
    });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toContain('returned the item');
  });

  it('filters by status when caller passes status[]', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const only = await optimiseMediaAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-28T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('chunks date ranges wider than 31 days into multiple calls', async () => {
    const spy = mockFetchQueue([
      fakeResponse({ data: [] }),
      fakeResponse({ data: [] }),
      fakeResponse({ data: [] }),
    ]);
    await optimiseMediaAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-03-31T00:00:00Z',
    });
    expect(spy.mock.calls.length).toBe(3);
  });

  it('emits an error envelope when the API key is missing (§15.4)', async () => {
    delete process.env['OPTIMISE_MEDIA_API_TOKEN'];
    await expect(optimiseMediaAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('Optimise Media.getEarningsSummary', () => {
  it('derives the summary from listTransactions', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const summary = await optimiseMediaAdapter.getEarningsSummary({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-28T00:00:00Z',
    });
    expect(summary.network).toBe('optimise-media');
    // 6.00 (approved) + 15.00 (pending) + 0.00 (rejected) = 21.00
    expect(summary.totalEarnings).toBeCloseTo(21.0, 2);
    expect(summary.byStatus.approved).toBeCloseTo(6.0, 2);
    expect(summary.byStatus.pending).toBeCloseTo(15.0, 2);
    expect(summary.byProgramme.length).toBeGreaterThan(0);
  });

  it('computes oldestUnpaidAgeDays from pending/approved transactions (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const summary = await optimiseMediaAdapter.getEarningsSummary({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-28T00:00:00Z',
    });
    expect(summary.oldestUnpaidAgeDays).toBeGreaterThan(30);
  });
});

// ---------------------------------------------------------------------------
// listClicks / generateTrackingLink — unsupported
// ---------------------------------------------------------------------------

describe('Optimise Media unsupported operations', () => {
  it('listClicks throws NotImplementedError with the documented reason', async () => {
    await expect(optimiseMediaAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await optimiseMediaAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click-level data');
    }
  });

  it('generateTrackingLink throws NotImplementedError', async () => {
    await expect(
      optimiseMediaAdapter.generateTrackingLink({
        programmeId: '1001',
        destinationUrl: 'https://x.example.com',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('Optimise Media.verifyAuth', () => {
  it('returns ok:true with identity when /Campaigns responds 200', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const r = await optimiseMediaAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toContain('optimise-media');
  });

  it('surfaces a NetworkErrorEnvelope shape on 401 (§15.4)', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_apikey"}', {
        status: 401,
        rawBody: '{"error":"invalid_apikey"}',
      }),
    ]);
    const r = await optimiseMediaAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/HTTP 401|401/);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('Optimise Media.validateCredential', () => {
  it('validates OPTIMISE_MEDIA_API_TOKEN by calling /Campaigns', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const r = await optimiseMediaAdapter.validateCredential('OPTIMISE_MEDIA_API_TOKEN', 'fresh');
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with a hint when validation fails', async () => {
    mockFetchQueue([fakeResponse('{"error":"bad"}', { status: 401 })]);
    const r = await optimiseMediaAdapter.validateCredential('OPTIMISE_MEDIA_API_TOKEN', 'bad');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('rejects an unknown field', async () => {
    const r = await optimiseMediaAdapter.validateCredential('NOPE', 'x');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// admin ops
// ---------------------------------------------------------------------------

describe('Optimise Media admin operations (not implemented at v0.1)', () => {
  it('listPublishers throws NotImplementedError', async () => {
    await expect(optimiseMediaAdapter.listPublishers()).rejects.toBeInstanceOf(NotImplementedError);
  });
  it('listPublisherSectors throws NotImplementedError', async () => {
    await expect(optimiseMediaAdapter.listPublisherSectors()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim response body on a 500', async () => {
    const body = '{"error":"upstream_error","trace":"omg123"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await optimiseMediaAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('optimise-media');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream_error');
    }
  });

  it('classifies 401 as auth_error', async () => {
    mockFetchQueue([fakeResponse('Forbidden', { status: 401, rawBody: 'Forbidden' })]);
    try {
      await optimiseMediaAdapter.listProgrammes();
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

describe('Optimise Media.capabilitiesCheck', () => {
  it('records unsupported ops and an experimental claim status', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('campaigns.json')), // listProgrammes
      fakeResponse(loadFixture('conversions.json')), // listTransactions
      fakeResponse(loadFixture('conversions.json')), // getEarningsSummary → listTransactions
      fakeResponse(loadFixture('campaigns.json')), // verifyAuth
    ]);
    const caps = await optimiseMediaAdapter.capabilitiesCheck();
    expect(caps.network).toBe('optimise-media');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
    expect(caps.operations['listProgrammes']?.claimStatus).toBe('experimental');
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
