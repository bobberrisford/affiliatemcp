/**
 * CAKE affiliate adapter — unit tests.
 *
 * Pattern matched to `tests/networks/everflow/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - CAKE returns XML, so fixtures are `.xml` and the fake responses are served
 *     with a text/xml content type.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 *   - No real tokens, no real instance hosts, no real data.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { cakeAdapter, _internals } from '../../../src/networks/cake/adapter.js';
import { parseXml, findAll } from '../../../src/networks/cake/client.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'networks', 'cake', 'fixtures');

function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8');
}

/** Mint a fake XML `Response`. */
function fakeResponse(body: string, init: { status?: number } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/xml' },
  });
}

const EMPTY_CONVERSIONS =
  '<?xml version="1.0"?><conversion_report_response><conversions></conversions></conversion_report_response>';

/**
 * Queue of fake responses. The first call clones the first queued response; once
 * the explicit queue is drained, subsequent calls return an empty conversion
 * report. CAKE's listTransactions chunks wide windows into multiple ≤31-day
 * calls, so a single fixture must satisfy the first slice and later slices come
 * back empty rather than exhausting the mock.
 */
function mockFetchQueue(responses: Response[]): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => {
    const r = responses.shift();
    if (!r) return new Response(EMPTY_CONVERSIONS, { status: 200, headers: { 'content-type': 'text/xml' } });
    return r;
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

beforeEach(() => {
  _resetBreakers();
  process.env['CAKE_BASE_URL'] = 'https://test-instance.example.com';
  process.env['CAKE_API_KEY'] = 'test-api-key-please-ignore';
  process.env['CAKE_AFFILIATE_ID'] = '12345';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['CAKE_BASE_URL'];
  delete process.env['CAKE_API_KEY'];
  delete process.env['CAKE_AFFILIATE_ID'];
});

// ---------------------------------------------------------------------------
// XML parser
// ---------------------------------------------------------------------------

describe('CAKE XML parser', () => {
  it('parses elements, attributes, and decodes entities', () => {
    const root = parseXml(
      '<?xml version="1.0"?><r a="x&amp;y"><offer><offer_id>5</offer_id></offer></r>',
    );
    expect(root.name).toBe('r');
    expect(root.attrs['a']).toBe('x&y');
    expect(findAll(root, 'offer').length).toBe(1);
  });

  it('finds repeated child elements in document order', () => {
    const root = parseXml(loadFixture('offerfeed.xml'));
    const offers = findAll(root, 'offer');
    expect(offers.length).toBe(3);
  });

  it('throws on a document with no element nodes', () => {
    expect(() => parseXml('   ')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Transformation (status mapping + raw preservation)
// ---------------------------------------------------------------------------

describe('CAKE transformers (status normalisation, raw preservation)', () => {
  it('maps offer statuses to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ offer_status: 'approved' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ offer_status: 'active' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ offer_status: 'apply-to-run' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ offer_status: 'private' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ offer_status: 'rejected' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ offer_status: 'paused' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ offer_status: 'never-seen' })).toBe('unknown');
    // No status but an offer id present → available.
    expect(_internals.mapProgrammeStatus({ offer_id: '7' })).toBe('available');
  });

  it('maps conversion dispositions to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ disposition: 'Approved' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ disposition: 'Converted' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ disposition: 'Pending Review' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ disposition: 'Rejected' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ disposition: 'Charged Back' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ disposition: 'mystery' })).toBe('other');
    expect(_internals.mapTransactionStatus({})).toBe('other');
    // The paid flag overrides the disposition.
    expect(_internals.mapTransactionStatus({ disposition: 'Approved', paid: 'true' })).toBe('paid');
  });

  it('parses CAKE money strings, assuming major units', () => {
    expect(_internals.parseMoney('$6.00')).toBeCloseTo(6.0, 2);
    expect(_internals.parseMoney('40.00')).toBeCloseTo(40.0, 2);
    expect(_internals.parseMoney('-1.50')).toBeCloseTo(-1.5, 2);
    expect(_internals.parseMoney(undefined)).toBe(0);
    expect(_internals.parseMoney('')).toBe(0);
  });

  it('preserves the raw CAKE payload under rawNetworkData', () => {
    const raw = { conversion_id: 'c-1', price: '5.00' };
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('surfaces reversalReason from disposition_name on reversed transactions (§15.10)', () => {
    const out = _internals.toTransaction({
      conversion_id: 'c-1003',
      conversion_date: '04/22/2026 11:00:00',
      disposition: 'Rejected',
      disposition_name: 'Duplicate conversion — transaction already recorded for this order',
      price: '0.00',
    } as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toContain('Duplicate conversion');
  });

  it('computes ageDays from conversion_date against a fixed now', () => {
    const now = new Date('2026-05-28T12:00:00Z');
    // 01/15/2026 10:00:00 UTC → May 28 12:00 = 133 days.
    const age = _internals.computeAgeDays({ conversion_date: '01/15/2026 10:00:00' } as never, now);
    expect(age).toBe(133);
  });

  it('returns 0 ageDays when no conversion_date is present', () => {
    const now = new Date('2026-05-28T00:00:00Z');
    expect(_internals.computeAgeDays({} as never, now)).toBe(0);
  });

  it('maps offer commission rate from payout + price_format', () => {
    const cpa = _internals.toProgramme({ offer_id: '1', payout: '$6.00', price_format: 'CPA' });
    expect(cpa.commissionRate).toMatchObject({ type: 'flat', value: 6 });
    const rev = _internals.toProgramme({ offer_id: '2', payout: '10', price_format: 'RevShare' });
    expect(rev.commissionRate).toMatchObject({ type: 'percent' });
  });

  it('formatCakeDate produces MM/DD/YYYY HH:mm:ss in UTC', () => {
    const d = new Date('2026-05-28T13:45:09Z');
    expect(_internals.formatCakeDate(d)).toBe('05/28/2026 13:45:09');
  });

  it('chunkDateRange splits correctly at 31 days', () => {
    const from = new Date('2026-01-01T00:00:00Z');
    const to = new Date('2026-03-01T00:00:00Z'); // 59 days → 2 slices (31 + 28)
    const slices = _internals.chunkDateRange(from, to, 31);
    expect(slices.length).toBe(2);
    expect(slices[0]?.start.toISOString()).toBe(from.toISOString());
    expect(slices[slices.length - 1]?.end.toISOString()).toBe(to.toISOString());
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('CAKE.listProgrammes', () => {
  it('maps offer statuses correctly from the OfferFeed fixture', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offerfeed.xml'))]);
    const programmes = await cakeAdapter.listProgrammes();
    expect(programmes.length).toBe(3);
    expect(programmes.find((p) => p.id === '1001')?.status).toBe('joined');
    expect(programmes.find((p) => p.id === '1002')?.status).toBe('pending');
    expect(programmes.find((p) => p.id === '1003')?.status).toBe('declined');
  });

  it('filters by status client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offerfeed.xml'))]);
    const only = await cakeAdapter.listProgrammes({ status: 'joined' });
    expect(only.every((p) => p.status === 'joined')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('applies search filter client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offerfeed.xml'))]);
    const results = await cakeAdapter.listProgrammes({ search: 'travel' });
    expect(results.length).toBe(1);
    expect(results[0]?.name).toBe('Atolls Travel');
  });

  it('preserves rawNetworkData on each programme', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offerfeed.xml'))]);
    const programmes = await cakeAdapter.listProgrammes();
    for (const p of programmes) expect(p.rawNetworkData).toBeDefined();
  });

  it('throws a NetworkError when the API key is missing', async () => {
    delete process.env['CAKE_API_KEY'];
    await expect(cakeAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error NetworkError when CAKE_BASE_URL is missing', async () => {
    delete process.env['CAKE_BASE_URL'];
    await expect(cakeAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error NetworkError when CAKE_BASE_URL is malformed', async () => {
    process.env['CAKE_BASE_URL'] = 'not a url';
    try {
      await cakeAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).envelope.type).toBe('config_error');
    }
  });
});

// ---------------------------------------------------------------------------
// getProgramme
// ---------------------------------------------------------------------------

describe('CAKE.getProgramme', () => {
  it('returns a Programme from the GetCampaign endpoint', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offer.xml'))]);
    const prog = await cakeAdapter.getProgramme('1001');
    expect(prog.id).toBe('1001');
    expect(prog.name).toBe('Atolls Bookshop');
    expect(prog.network).toBe('cake');
  });

  it('throws a config_error envelope for a non-numeric programmeId', async () => {
    await expect(cakeAdapter.getProgramme('not-a-number')).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error envelope for an empty programmeId', async () => {
    await expect(cakeAdapter.getProgramme('')).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listTransactions — unpaid-age + reversed visibility (§15.9, §15.10)
// ---------------------------------------------------------------------------

describe('CAKE.listTransactions', () => {
  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.xml'))]);
    const aged = await cakeAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
      minAgeDays: 50,
    });
    for (const t of aged) expect(t.ageDays).toBeGreaterThanOrEqual(50);
    expect(aged.length).toBeGreaterThan(0);
  });

  it('includes reversed transactions with reason populated (§15.10)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.xml'))]);
    const all = await cakeAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
    });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toContain('Duplicate conversion');
  });

  it('filters by status when caller passes status[]', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.xml'))]);
    const only = await cakeAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('chunks date ranges to <=31-day slices (two calls for a 59-day window)', async () => {
    const spy = mockFetchQueue([
      fakeResponse(loadFixture('conversions.xml')),
      fakeResponse(
        '<?xml version="1.0"?><conversion_report_response><conversions></conversions></conversion_report_response>',
      ),
    ]);
    await cakeAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-03-01T00:00:00Z',
    });
    expect(spy.mock.calls.length).toBe(2);
  });

  it('emits an error envelope when the API key is missing (§15.4)', async () => {
    delete process.env['CAKE_API_KEY'];
    await expect(cakeAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('CAKE.getEarningsSummary', () => {
  it('derives the summary from listTransactions correctly', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.xml'))]);
    const summary = await cakeAdapter.getEarningsSummary({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
    });
    expect(summary.network).toBe('cake');
    // 5.00 approved + 5.00 pending + 0.00 reversed = 10.00
    expect(summary.totalEarnings).toBeCloseTo(10.0, 2);
    expect(summary.byStatus.approved).toBeCloseTo(5.0, 2);
    expect(summary.byStatus.pending).toBeCloseTo(5.0, 2);
    expect(summary.byStatus.reversed).toBeCloseTo(0.0, 2);
    expect(summary.byProgramme.length).toBeGreaterThan(0);
  });

  it('computes oldestUnpaidAgeDays from pending/approved transactions (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.xml'))]);
    const summary = await cakeAdapter.getEarningsSummary({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
    });
    // The Jan 15 approved conversion is the oldest unpaid.
    expect(summary.oldestUnpaidAgeDays).toBeGreaterThan(30);
  });
});

// ---------------------------------------------------------------------------
// listClicks / generateTrackingLink — NotImplemented (documented gaps)
// ---------------------------------------------------------------------------

describe('CAKE unsupported operations', () => {
  it('listClicks throws NotImplementedError', async () => {
    await expect(cakeAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('generateTrackingLink throws NotImplementedError', async () => {
    await expect(
      cakeAdapter.generateTrackingLink({ programmeId: '1001', destinationUrl: 'https://x.example.com' }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('CAKE.verifyAuth', () => {
  it('returns ok:true with an instance-scoped identity when OfferFeed responds 200', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offerfeed.xml'))]);
    const r = await cakeAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('cake/');
      expect(r.identity).toContain('affiliate/12345');
    }
  });

  it('surfaces a failure reason on 401 (§15.4)', async () => {
    mockFetchQueue([fakeResponse('Unauthorized', { status: 401 })]);
    const r = await cakeAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/401/);
  });

  it('returns ok:false when CAKE_BASE_URL is missing (no throw)', async () => {
    delete process.env['CAKE_BASE_URL'];
    const r = await cakeAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// admin ops
// ---------------------------------------------------------------------------

describe('CAKE admin operations (not implemented at v0.1)', () => {
  it('listPublishers throws NotImplementedError', async () => {
    await expect(cakeAdapter.listPublishers()).rejects.toBeInstanceOf(NotImplementedError);
  });
  it('listPublisherSectors throws NotImplementedError', async () => {
    await expect(cakeAdapter.listPublisherSectors()).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim CAKE response body on a 500', async () => {
    const body = '<error><message>upstream_error</message></error>';
    mockFetchQueue([
      fakeResponse(body, { status: 500 }),
      fakeResponse(body, { status: 500 }),
      fakeResponse(body, { status: 500 }),
      fakeResponse(body, { status: 500 }),
    ]);
    try {
      await cakeAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('cake');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream_error');
    }
  });

  it('classifies 401 as auth_error (§15.4)', async () => {
    mockFetchQueue([fakeResponse('Forbidden', { status: 401 })]);
    try {
      await cakeAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('auth_error');
    }
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('CAKE.capabilitiesCheck', () => {
  it('reports operations and records the unsupported ones', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('offerfeed.xml')), // listProgrammes
      fakeResponse(loadFixture('conversions.xml')), // listTransactions
      fakeResponse(loadFixture('conversions.xml')), // getEarningsSummary → listTransactions
      fakeResponse(loadFixture('offerfeed.xml')), // verifyAuth
    ]);
    const caps = await cakeAdapter.capabilitiesCheck();
    expect(caps.network).toBe('cake');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
