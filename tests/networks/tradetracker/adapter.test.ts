/**
 * TradeTracker adapter — unit tests.
 *
 * Pattern matched to `tests/networks/cake/adapter.test.ts` and
 * `tests/networks/awin/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + session + transformer stack with no live HTTP.
 *   - TradeTracker speaks SOAP, so fixtures are `.xml` and the fake responses
 *     are served with a text/xml content type.
 *   - TradeTracker is session-based: every operation first calls `authenticate`
 *     (which must return a `Set-Cookie`), then the real SOAP method. So a single
 *     operation consumes TWO queued responses unless the session is already
 *     cached. We reset the cached session before each test.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 *   - No real customer IDs, passphrases, site IDs, or data.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { tradetrackerAdapter, _internals } from '../../../src/networks/tradetracker/adapter.js';
import { parseXml, findAll } from '../../../src/networks/tradetracker/client.js';
import { _resetSessionForTests } from '../../../src/networks/tradetracker/auth.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'networks', 'tradetracker', 'fixtures');

function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8');
}

/** Mint a fake XML `Response`. Optionally attach a `Set-Cookie` header. */
function fakeResponse(
  body: string,
  init: { status?: number; setCookie?: string } = {},
): Response {
  const headers: Record<string, string> = { 'content-type': 'text/xml' };
  if (init.setCookie) headers['set-cookie'] = init.setCookie;
  return new Response(body, { status: init.status ?? 200, headers });
}

/** A successful `authenticate` response carrying a session cookie. */
function authResponse(): Response {
  return fakeResponse(loadFixture('authenticate.xml'), {
    setCookie: 'PHPSESSID=test-session-please-ignore; path=/',
  });
}

const EMPTY_CONVERSIONS =
  '<?xml version="1.0"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">' +
  '<SOAP-ENV:Body><getConversionTransactionsResponse><return></return></getConversionTransactionsResponse>' +
  '</SOAP-ENV:Body></SOAP-ENV:Envelope>';

const EMPTY_CLICKS =
  '<?xml version="1.0"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">' +
  '<SOAP-ENV:Body><getClickTransactionsResponse><return></return></getClickTransactionsResponse>' +
  '</SOAP-ENV:Body></SOAP-ENV:Envelope>';

/**
 * Queue of fake responses. Each fetch call shifts the next response. When the
 * explicit queue drains we throw, mirroring Awin's strict queue — TradeTracker
 * date chunking, where exercised, must be fed explicitly so a forgotten slice
 * surfaces as a test failure rather than silently passing.
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

beforeEach(() => {
  _resetBreakers();
  _resetSessionForTests();
  process.env['TRADETRACKER_CUSTOMER_ID'] = '123456';
  process.env['TRADETRACKER_PASSPHRASE'] = 'test-passphrase-please-ignore';
  process.env['TRADETRACKER_SITE_ID'] = '654321';
});

afterEach(() => {
  vi.restoreAllMocks();
  _resetSessionForTests();
  delete process.env['TRADETRACKER_CUSTOMER_ID'];
  delete process.env['TRADETRACKER_PASSPHRASE'];
  delete process.env['TRADETRACKER_SITE_ID'];
});

// ---------------------------------------------------------------------------
// XML parser
// ---------------------------------------------------------------------------

describe('TradeTracker XML parser', () => {
  it('parses elements, attributes, and decodes entities', () => {
    const root = parseXml(
      '<?xml version="1.0"?><r a="x&amp;y"><campaign><name>Books &amp; Media</name></campaign></r>',
    );
    expect(root.name).toBe('r');
    expect(root.attrs['a']).toBe('x&y');
    const campaigns = findAll(root, 'campaign');
    expect(campaigns.length).toBe(1);
  });

  it('finds repeated campaign elements in document order', () => {
    const root = parseXml(loadFixture('campaigns.xml'));
    expect(findAll(root, 'campaign').length).toBe(3);
  });

  it('throws on a document with no element nodes', () => {
    expect(() => parseXml('   ')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Transformation (status normalisation + raw preservation)
// ---------------------------------------------------------------------------

describe('TradeTracker transformers (status normalisation, raw preservation)', () => {
  it('maps conversion transactionStatus pending|accepted|rejected → canonical', () => {
    expect(_internals.mapTransactionStatus('pending')).toBe('pending');
    expect(_internals.mapTransactionStatus('accepted')).toBe('approved');
    // §15.4: 'rejected' maps to 'reversed' (the user-facing intent).
    expect(_internals.mapTransactionStatus('rejected')).toBe('reversed');
    expect(_internals.mapTransactionStatus('mystery')).toBe('other');
    expect(_internals.mapTransactionStatus(undefined)).toBe('other');
    // paidOut overrides the status string.
    expect(_internals.mapTransactionStatus('accepted', 'true')).toBe('paid');
    expect(_internals.mapTransactionStatus('pending', '1')).toBe('paid');
  });

  it('maps campaign assignmentStatus → canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus('accepted')).toBe('joined');
    expect(_internals.mapProgrammeStatus('signedup')).toBe('joined');
    expect(_internals.mapProgrammeStatus('pending')).toBe('pending');
    expect(_internals.mapProgrammeStatus('onhold')).toBe('pending');
    expect(_internals.mapProgrammeStatus('rejected')).toBe('declined');
    expect(_internals.mapProgrammeStatus('notsignedup')).toBe('available');
    expect(_internals.mapProgrammeStatus('never-seen')).toBe('unknown');
    expect(_internals.mapProgrammeStatus(undefined)).toBe('unknown');
  });

  it('preserves the raw parsed element under rawNetworkData', () => {
    const root = parseXml(loadFixture('conversions.xml'));
    const el = findAll(root, 'conversionTransaction')[0]!;
    const out = _internals.toTransaction(el);
    expect(out.rawNetworkData).toBe(el);
  });

  it('surfaces reversalReason on reversed transactions (§15.10)', () => {
    const root = parseXml(loadFixture('conversions.xml'));
    const rejected = findAll(root, 'conversionTransaction').find(
      (el) => _internals.toTransaction(el).status === 'reversed',
    )!;
    const out = _internals.toTransaction(rejected);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toContain('cooling-off period');
  });

  it('computes ageDays from assessmentDate (preferred) over registrationDate', () => {
    const now = new Date('2026-05-01T00:00:00Z');
    const root = parseXml(loadFixture('conversions.xml'));
    const first = findAll(root, 'conversionTransaction')[0]!;
    // assessmentDate 2026-01-20 09:30 → 2026-05-01 00:00 = 100 full days (floored).
    const out = _internals.toTransaction(first, now);
    expect(out.ageDays).toBe(100);
  });

  it('returns 0 ageDays when the anchor date is absent', () => {
    const now = new Date('2026-05-01T00:00:00Z');
    expect(_internals.computeAgeDays(undefined, now)).toBe(0);
    expect(_internals.computeAgeDays('not-a-date', now)).toBe(0);
  });

  it('maps commission components to a structured rate (percent / flat)', () => {
    const root = parseXml(loadFixture('campaigns.xml'));
    const campaigns = findAll(root, 'campaign').map(_internals.toProgramme);
    // 1001 has saleCommissionVariable 8.50 → percent.
    expect(campaigns.find((p) => p.id === '1001')?.commissionRate).toMatchObject({
      type: 'percent',
      value: 8.5,
    });
    // 1002 has saleCommissionFixed 5.00 → flat.
    expect(campaigns.find((p) => p.id === '1002')?.commissionRate).toMatchObject({
      type: 'flat',
      value: 5,
    });
    // 1003 has only leadCommission 2.00 → flat (per lead).
    expect(campaigns.find((p) => p.id === '1003')?.commissionRate).toMatchObject({
      type: 'flat',
      value: 2,
    });
  });

  it('pickAssignmentStatus defaults to accepted, follows the requested status', () => {
    expect(_internals.pickAssignmentStatus()).toBe('accepted');
    expect(_internals.pickAssignmentStatus([])).toBe('accepted');
    expect(_internals.pickAssignmentStatus(['joined'])).toBe('accepted');
    expect(_internals.pickAssignmentStatus(['pending'])).toBe('pending');
    expect(_internals.pickAssignmentStatus(['available'])).toBe('notsignedup');
  });

  it('formatTradeTrackerDate produces YYYY-MM-DD HH:MM:SS in UTC', () => {
    const d = new Date('2026-05-28T13:45:09Z');
    expect(_internals.formatTradeTrackerDate(d)).toBe('2026-05-28 13:45:09');
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

describe('TradeTracker.listProgrammes', () => {
  it('maps campaign statuses from the getCampaigns fixture', async () => {
    mockFetchQueue([authResponse(), fakeResponse(loadFixture('campaigns.xml'))]);
    const programmes = await tradetrackerAdapter.listProgrammes();
    expect(programmes.length).toBe(3);
    expect(programmes.find((p) => p.id === '1001')?.status).toBe('joined');
    expect(programmes.find((p) => p.id === '1002')?.status).toBe('pending');
    expect(programmes.find((p) => p.id === '1003')?.status).toBe('available');
    expect(programmes.every((p) => p.network === 'tradetracker')).toBe(true);
  });

  it('authenticates first, then calls getCampaigns (two fetches, cookie replayed)', async () => {
    const spy = mockFetchQueue([authResponse(), fakeResponse(loadFixture('campaigns.xml'))]);
    await tradetrackerAdapter.listProgrammes();
    expect(spy.mock.calls.length).toBe(2);
    // Second call replays the session cookie.
    const secondInit = spy.mock.calls[1]?.[1] as RequestInit | undefined;
    const headers = secondInit?.headers as Record<string, string> | undefined;
    expect(headers?.['Cookie']).toContain('PHPSESSID=test-session-please-ignore');
  });

  it('caches the session: a second op does not re-authenticate', async () => {
    const spy = mockFetchQueue([
      authResponse(),
      fakeResponse(loadFixture('campaigns.xml')),
      // No second authResponse: the cached cookie must be reused.
      fakeResponse(loadFixture('campaigns.xml')),
    ]);
    await tradetrackerAdapter.listProgrammes();
    await tradetrackerAdapter.listProgrammes();
    expect(spy.mock.calls.length).toBe(3);
  });

  it('applies search filter client-side', async () => {
    mockFetchQueue([authResponse(), fakeResponse(loadFixture('campaigns.xml'))]);
    const results = await tradetrackerAdapter.listProgrammes({ search: 'travel' });
    expect(results.length).toBe(1);
    expect(results[0]?.name).toBe('Atolls Travel');
  });

  it('filters by status client-side', async () => {
    mockFetchQueue([authResponse(), fakeResponse(loadFixture('campaigns.xml'))]);
    const only = await tradetrackerAdapter.listProgrammes({ status: 'pending' });
    expect(only.every((p) => p.status === 'pending')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('honours limit client-side', async () => {
    mockFetchQueue([authResponse(), fakeResponse(loadFixture('campaigns.xml'))]);
    const limited = await tradetrackerAdapter.listProgrammes({ limit: 2 });
    expect(limited.length).toBe(2);
  });

  it('emits a config_error envelope when the site ID is missing (§15.4)', async () => {
    delete process.env['TRADETRACKER_SITE_ID'];
    await expect(tradetrackerAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getProgramme
// ---------------------------------------------------------------------------

describe('TradeTracker.getProgramme', () => {
  it('returns a matching campaign by ID', async () => {
    mockFetchQueue([authResponse(), fakeResponse(loadFixture('campaigns.xml'))]);
    const prog = await tradetrackerAdapter.getProgramme('1001');
    expect(prog.id).toBe('1001');
    expect(prog.name).toBe('Atolls Bookshop');
    expect(prog.network).toBe('tradetracker');
  });

  it('throws a config_error envelope for a non-numeric programmeId', async () => {
    await expect(tradetrackerAdapter.getProgramme('not-a-number')).rejects.toBeInstanceOf(
      NetworkError,
    );
  });

  it('throws a network_api_error when the campaign ID is not found', async () => {
    mockFetchQueue([authResponse(), fakeResponse(loadFixture('campaigns.xml'))]);
    try {
      await tradetrackerAdapter.getProgramme('9999');
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).envelope.type).toBe('network_api_error');
    }
  });
});

// ---------------------------------------------------------------------------
// listTransactions — unpaid-age + reversed visibility + status normalisation
// ---------------------------------------------------------------------------

describe('TradeTracker.listTransactions', () => {
  it('normalises all four statuses from the conversions fixture', async () => {
    mockFetchQueue([authResponse(), fakeResponse(loadFixture('conversions.xml'))]);
    const txns = await tradetrackerAdapter.listTransactions({
      from: '2026-01-15T00:00:00Z',
      to: '2026-02-11T00:00:00Z',
    });
    expect(txns.length).toBe(4);
    expect(txns.find((t) => t.id === 'tx-2001')?.status).toBe('approved');
    expect(txns.find((t) => t.id === 'tx-2002')?.status).toBe('pending');
    expect(txns.find((t) => t.id === 'tx-2003')?.status).toBe('reversed');
    // paidOut=true overrides accepted → paid.
    expect(txns.find((t) => t.id === 'tx-2004')?.status).toBe('paid');
  });

  it('includes reversed transactions with reason populated (§15.10)', async () => {
    mockFetchQueue([authResponse(), fakeResponse(loadFixture('conversions.xml'))]);
    const all = await tradetrackerAdapter.listTransactions({
      from: '2026-01-15T00:00:00Z',
      to: '2026-02-11T00:00:00Z',
    });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toContain('cooling-off period');
  });

  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockFetchQueue([authResponse(), fakeResponse(loadFixture('conversions.xml'))]);
    const aged = await tradetrackerAdapter.listTransactions({
      from: '2026-01-15T00:00:00Z',
      to: '2026-02-11T00:00:00Z',
      minAgeDays: 1,
    });
    for (const t of aged) expect(t.ageDays).toBeGreaterThanOrEqual(1);
    expect(aged.length).toBeGreaterThan(0);
  });

  it('filters by status when caller passes status[]', async () => {
    mockFetchQueue([authResponse(), fakeResponse(loadFixture('conversions.xml'))]);
    const only = await tradetrackerAdapter.listTransactions({
      from: '2026-01-15T00:00:00Z',
      to: '2026-02-11T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('filters by programmeId client-side', async () => {
    mockFetchQueue([authResponse(), fakeResponse(loadFixture('conversions.xml'))]);
    const only = await tradetrackerAdapter.listTransactions({
      from: '2026-01-15T00:00:00Z',
      to: '2026-02-11T00:00:00Z',
      programmeId: '1002',
    });
    expect(only.every((t) => t.programmeId === '1002')).toBe(true);
    expect(only.length).toBe(2);
  });

  it('chunks date ranges wider than 31 days into multiple SOAP calls', async () => {
    // 1 authenticate + 2 conversion slices for a 59-day window.
    const spy = mockFetchQueue([
      authResponse(),
      fakeResponse(EMPTY_CONVERSIONS),
      fakeResponse(EMPTY_CONVERSIONS),
    ]);
    await tradetrackerAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-03-01T00:00:00Z',
    });
    expect(spy.mock.calls.length).toBe(3);
  });

  it('emits an error envelope when the site ID is missing (§15.4)', async () => {
    delete process.env['TRADETRACKER_SITE_ID'];
    await expect(tradetrackerAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('TradeTracker.getEarningsSummary', () => {
  it('derives the summary from listTransactions correctly', async () => {
    mockFetchQueue([authResponse(), fakeResponse(loadFixture('conversions.xml'))]);
    const summary = await tradetrackerAdapter.getEarningsSummary({
      from: '2026-01-15T00:00:00Z',
      to: '2026-02-11T00:00:00Z',
    });
    expect(summary.network).toBe('tradetracker');
    // 4.25 approved + 5.00 pending + 0.00 reversed + 9.00 paid = 18.25.
    expect(summary.totalEarnings).toBeCloseTo(18.25, 2);
    expect(summary.byStatus.approved).toBeCloseTo(4.25, 2);
    expect(summary.byStatus.pending).toBeCloseTo(5.0, 2);
    expect(summary.byStatus.reversed).toBeCloseTo(0.0, 2);
    expect(summary.byStatus.paid).toBeCloseTo(9.0, 2);
    expect(summary.currency).toBe('EUR');
    expect(summary.byProgramme.length).toBe(2);
  });

  it('computes oldestUnpaidAgeDays from pending/approved transactions (§15.9)', async () => {
    mockFetchQueue([authResponse(), fakeResponse(loadFixture('conversions.xml'))]);
    const summary = await tradetrackerAdapter.getEarningsSummary({
      from: '2026-01-15T00:00:00Z',
      to: '2026-02-11T00:00:00Z',
    });
    // Only tx-2001 (approved) and tx-2002 (pending) are unpaid; both are aged.
    expect(summary.oldestUnpaidAgeDays).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// listClicks
// ---------------------------------------------------------------------------

describe('TradeTracker.listClicks', () => {
  it('returns click transactions from the getClickTransactions fixture', async () => {
    mockFetchQueue([authResponse(), fakeResponse(loadFixture('clicks.xml'))]);
    const clicks = await tradetrackerAdapter.listClicks({
      from: '2026-02-01T00:00:00Z',
      to: '2026-02-28T00:00:00Z',
    });
    expect(clicks.length).toBe(2);
    expect(clicks[0]?.id).toBe('click-3001');
    expect(clicks[0]?.programmeId).toBe('1001');
    expect(clicks[0]?.referrer).toContain('best-books');
    expect(clicks.every((c) => c.network === 'tradetracker')).toBe(true);
  });

  it('filters clicks by programmeId client-side', async () => {
    mockFetchQueue([authResponse(), fakeResponse(loadFixture('clicks.xml'))]);
    const only = await tradetrackerAdapter.listClicks({
      from: '2026-02-01T00:00:00Z',
      to: '2026-02-28T00:00:00Z',
      programmeId: '1002',
    });
    expect(only.length).toBe(1);
    expect(only[0]?.programmeId).toBe('1002');
  });

  it('chunks click date ranges wider than 31 days into multiple SOAP calls', async () => {
    const spy = mockFetchQueue([
      authResponse(),
      fakeResponse(EMPTY_CLICKS),
      fakeResponse(EMPTY_CLICKS),
    ]);
    await tradetrackerAdapter.listClicks({
      from: '2026-01-01T00:00:00Z',
      to: '2026-03-01T00:00:00Z',
    });
    expect(spy.mock.calls.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — deterministic URL construction
// ---------------------------------------------------------------------------

describe('TradeTracker.generateTrackingLink', () => {
  it('constructs the tc.tradetracker.net click URL with URL-encoded destination', async () => {
    const link = await tradetrackerAdapter.generateTrackingLink({
      programmeId: '1001',
      destinationUrl: 'https://bookshop.atolls.example.com/path?q=a b&c=ü',
    });
    expect(link.trackingUrl).toContain('https://tc.tradetracker.net/?c=1001');
    expect(link.trackingUrl).toContain('&a=654321');
    expect(link.trackingUrl).toContain(
      '&u=https%3A%2F%2Fbookshop.atolls.example.com%2Fpath%3Fq%3Da%20b%26c%3D%C3%BC',
    );
    expect(link.network).toBe('tradetracker');
    expect(link.programmeId).toBe('1001');
  });

  it('throws a config_error envelope when programmeId is missing', async () => {
    await expect(
      tradetrackerAdapter.generateTrackingLink({
        programmeId: '',
        destinationUrl: 'https://x.example.com',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error envelope when destinationUrl is missing', async () => {
    await expect(
      tradetrackerAdapter.generateTrackingLink({
        programmeId: '1001',
        destinationUrl: '',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('does NOT call fetch (deterministic construction)', async () => {
    const spy = mockFetchQueue([]);
    await tradetrackerAdapter.generateTrackingLink({
      programmeId: '1001',
      destinationUrl: 'https://x.example.com',
    });
    expect(spy.mock.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('TradeTracker.verifyAuth', () => {
  it('returns ok:true with a customer-scoped identity when authenticate + getAffiliateSites succeed', async () => {
    mockFetchQueue([authResponse(), fakeResponse(loadFixture('affiliateSites.xml'))]);
    const r = await tradetrackerAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('tradetracker/customer/123456');
      expect(r.identity).toContain('Atolls Reviews');
    }
  });

  it('surfaces a failure reason when authenticate returns no session cookie (§15.4)', async () => {
    // authenticate succeeds (200) but issues no Set-Cookie → unusable session.
    mockFetchQueue([fakeResponse(loadFixture('authenticate.xml'))]);
    const r = await tradetrackerAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });

  it('surfaces a failure reason on a 401 (§15.4)', async () => {
    mockFetchQueue([fakeResponse('Unauthorized', { status: 401 })]);
    const r = await tradetrackerAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/401/);
  });

  it('returns ok:false when the customer ID is missing (no throw)', async () => {
    delete process.env['TRADETRACKER_CUSTOMER_ID'];
    const r = await tradetrackerAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// admin ops
// ---------------------------------------------------------------------------

describe('TradeTracker admin operations (not implemented at v0.1)', () => {
  it('listPublishers throws NotImplementedError', async () => {
    await expect(tradetrackerAdapter.listPublishers()).rejects.toBeInstanceOf(NotImplementedError);
  });
  it('listPublisherSectors throws NotImplementedError', async () => {
    await expect(tradetrackerAdapter.listPublisherSectors()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim TradeTracker response body on a 500', async () => {
    const body = '<error><message>upstream_error_at_03:14</message></error>';
    // authenticate succeeds; getCampaigns returns a 500. A 500 is not retried.
    mockFetchQueue([authResponse(), fakeResponse(body, { status: 500 })]);
    try {
      await tradetrackerAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('tradetracker');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream_error_at_03:14');
    }
  });

  it('classifies 401 as auth_error', async () => {
    mockFetchQueue([authResponse(), fakeResponse('Forbidden', { status: 401 })]);
    try {
      await tradetrackerAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('auth_error');
    }
  });

  it('surfaces a SOAP Fault body verbatim (200 with <Fault>)', async () => {
    mockFetchQueue([authResponse(), fakeResponse(loadFixture('fault.xml'))]);
    try {
      await tradetrackerAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('network_api_error');
      expect(env.networkErrorBody).toContain('not assigned to this customer account');
    }
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('TradeTracker.capabilitiesCheck', () => {
  it('reports operations and carries the known limitations', async () => {
    mockFetchQueue([
      authResponse(), // listProgrammes → getSession authenticates, caches cookie
      fakeResponse(loadFixture('campaigns.xml')), // listProgrammes
      fakeResponse(loadFixture('conversions.xml')), // listTransactions (cached cookie)
      fakeResponse(loadFixture('conversions.xml')), // getEarningsSummary → listTransactions
      fakeResponse(loadFixture('clicks.xml')), // listClicks
      authResponse(), // verifyAuth re-authenticates directly (not via getSession)
      fakeResponse(loadFixture('affiliateSites.xml')), // verifyAuth → getAffiliateSites
    ]);
    const caps = await tradetrackerAdapter.capabilitiesCheck();
    expect(caps.network).toBe('tradetracker');
    expect(caps.operations['listProgrammes']?.supported).toBe(true);
    expect(caps.operations['listClicks']?.supported).toBe(true);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(true);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
