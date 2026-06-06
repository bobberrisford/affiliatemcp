/**
 * Belboon adapter — unit tests.
 *
 * Mirrors the structure of `tests/networks/awin/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly. That is the single seam between the
 *     adapter and the network, so mocking it exercises the full
 *     client + resilience + CSV-parser + transformer stack with no live HTTP.
 *   - Belboon differs from Awin in one load-bearing way: the export API serves
 *     CSV, not JSON, so the fixtures are `.csv` files and the fake responses
 *     carry the verbatim CSV text.
 *   - Each test stubs only the responses it needs.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings so a
 *     future contributor can grep for the requirement they break.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { belboonAdapter, _internals } from '../../../src/networks/belboon/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';
import type { BelboonRow } from '../../../src/networks/belboon/client.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'belboon');

function loadCsv(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8');
}

/**
 * Mint a fake `Response`. Belboon bodies are CSV text (or a plain-text/HTML
 * error body), so we pass the raw string through verbatim. Status defaults 200.
 */
function fakeResponse(body: string, init: { status?: number } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/csv' },
  });
}

/**
 * Replace `globalThis.fetch` with a queue-driven mock. Each call shifts the next
 * response off the queue. Returns the spy for call-count assertions.
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
  process.env['BELBOON_MAGIC_KEY'] = 'f0d58188-5420-4856-84b2-0417a3a85225';
  process.env['BELBOON_USER_ID'] = '123';
  delete process.env['BELBOON_EXPORT_HOST'];
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['BELBOON_MAGIC_KEY'];
  delete process.env['BELBOON_USER_ID'];
  delete process.env['BELBOON_EXPORT_HOST'];
});

// ---------------------------------------------------------------------------
// Transformation (status mapping, money/date parsing, raw preservation)
// ---------------------------------------------------------------------------

describe('Belboon transformers (status normalisation, raw preservation)', () => {
  it('maps conversion status open|confirmed|rejected → canonical statuses', () => {
    expect(_internals.mapTransactionStatus('open')).toBe('pending');
    expect(_internals.mapTransactionStatus('confirmed')).toBe('approved');
    expect(_internals.mapTransactionStatus('rejected')).toBe('reversed');
    expect(_internals.mapTransactionStatus('cancelled')).toBe('reversed');
    // The platform also encodes status numerically: 1=open, 2=confirmed, 3=rejected.
    expect(_internals.mapTransactionStatus('1')).toBe('pending');
    expect(_internals.mapTransactionStatus('2')).toBe('approved');
    expect(_internals.mapTransactionStatus('3')).toBe('reversed');
    // Anything unrecognised → 'other' rather than a wrong guess.
    expect(_internals.mapTransactionStatus('7')).toBe('other');
    expect(_internals.mapTransactionStatus(undefined)).toBe('other');
  });

  it('maps partnership status → canonical ProgrammeStatus, unknown as fallback', () => {
    expect(_internals.mapProgrammeStatus('active')).toBe('joined');
    expect(_internals.mapProgrammeStatus('pending')).toBe('pending');
    expect(_internals.mapProgrammeStatus('rejected')).toBe('declined');
    expect(_internals.mapProgrammeStatus('open')).toBe('available');
    expect(_internals.mapProgrammeStatus('paused')).toBe('suspended');
    expect(_internals.mapProgrammeStatus('weird-state')).toBe('unknown');
    expect(_internals.mapProgrammeStatus(undefined)).toBe('unknown');
  });

  it('parses German-formatted money (1.234,56) and English (1,234.56)', () => {
    expect(_internals.parseAmount('1.234,56')).toBeCloseTo(1234.56);
    expect(_internals.parseAmount('1,234.56')).toBeCloseTo(1234.56);
    expect(_internals.parseAmount('49,99')).toBeCloseTo(49.99);
    expect(_internals.parseAmount('100')).toBe(100);
    expect(_internals.parseAmount('')).toBe(0);
    expect(_internals.parseAmount(undefined)).toBe(0);
    // Currency symbols / spaces stripped.
    expect(_internals.parseAmount('€ 1.000,00')).toBeCloseTo(1000);
  });

  it('parses DD.MM.YYYY dates to ISO and rejects garbage', () => {
    expect(_internals.parseBelboonDateIso('15.01.2026')).toBe('2026-01-15T00:00:00.000Z');
    expect(_internals.parseBelboonDateIso('05.04.2026 13:45:00')).toBe('2026-04-05T13:45:00.000Z');
    expect(_internals.parseBelboonDateIso('not-a-date')).toBeUndefined();
    expect(_internals.parseBelboonDateIso('')).toBeUndefined();
    expect(_internals.parseBelboonDateIso(undefined)).toBeUndefined();
  });

  it('reads candidate column names case- and separator-insensitively', () => {
    const row: BelboonRow = { 'Advertiser ID': '42', commission_amount: '5,00' };
    expect(_internals.readField(row, ['advertiserid'])).toBe('42');
    expect(_internals.readField(row, ['commission_amount'])).toBe('5,00');
    expect(_internals.readField(row, ['missing'])).toBeUndefined();
  });

  it('preserves the raw CSV row under rawNetworkData on a transaction', () => {
    const row: BelboonRow = {
      conversion_id: '9001',
      status: 'confirmed',
      commission: '61,73',
      conversion_date: '15.01.2026',
    };
    const out = _internals.toTransaction(row, new Date('2026-06-06T00:00:00Z'));
    expect(out.rawNetworkData).toBe(row);
    expect(out.id).toBe('9001');
    expect(out.status).toBe('approved');
    expect(out.commission).toBeCloseTo(61.73);
    expect(out.network).toBe('belboon');
  });

  it('surfaces reversalReason only on reversed transactions', () => {
    const reversed: BelboonRow = {
      status: 'rejected',
      rejection_reason: 'Customer cancelled the order',
      conversion_date: '10.03.2026',
    };
    const out = _internals.toTransaction(reversed, new Date('2026-06-06T00:00:00Z'));
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Customer cancelled the order');

    const approved: BelboonRow = { status: 'confirmed', conversion_date: '15.01.2026' };
    expect(_internals.toTransaction(approved).reversalReason).toBeUndefined();
  });

  it('computes ageDays from the approval/conversion anchor (§15.9)', () => {
    const now = new Date('2026-06-06T00:00:00Z');
    expect(_internals.computeAgeDays('2026-01-01T00:00:00Z', now)).toBe(156);
    expect(_internals.computeAgeDays(undefined, now)).toBe(0);
    expect(_internals.computeAgeDays('garbage', now)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes — CSV parse + client-side filtering
// ---------------------------------------------------------------------------

describe('Belboon.listProgrammes', () => {
  it('parses the merchant export into programmes with normalised status', async () => {
    mockFetchQueue([fakeResponse(loadCsv('merchants.csv'))]);
    const programmes = await belboonAdapter.listProgrammes();
    expect(programmes.length).toBe(6);
    const byId = new Map(programmes.map((p) => [p.id, p]));
    expect(byId.get('1001')?.status).toBe('joined');
    expect(byId.get('1002')?.status).toBe('pending');
    expect(byId.get('1003')?.status).toBe('declined');
    expect(byId.get('1004')?.status).toBe('available');
    expect(byId.get('1005')?.status).toBe('suspended');
    expect(byId.get('1006')?.status).toBe('unknown');
    expect(byId.get('1001')?.name).toBe('Atolls Bookshop');
    expect(byId.get('1001')?.network).toBe('belboon');
  });

  it('applies client-side status, search, category and limit filters', async () => {
    mockFetchQueue([fakeResponse(loadCsv('merchants.csv'))]);
    const joined = await belboonAdapter.listProgrammes({ status: 'joined' });
    expect(joined.every((p) => p.status === 'joined')).toBe(true);
    expect(joined.length).toBe(1);

    mockFetchQueue([fakeResponse(loadCsv('merchants.csv'))]);
    const search = await belboonAdapter.listProgrammes({ search: 'garden' });
    expect(search.length).toBe(1);
    expect(search[0]?.id).toBe('1002');

    mockFetchQueue([fakeResponse(loadCsv('merchants.csv'))]);
    const cat = await belboonAdapter.listProgrammes({ categories: ['Books'] });
    expect(cat.length).toBe(1);
    expect(cat[0]?.id).toBe('1001');

    mockFetchQueue([fakeResponse(loadCsv('merchants.csv'))]);
    const limited = await belboonAdapter.listProgrammes({ limit: 2 });
    expect(limited.length).toBe(2);
  });

  it('emits a config_error envelope when the magic key is missing', async () => {
    delete process.env['BELBOON_MAGIC_KEY'];
    await expect(belboonAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
    try {
      await belboonAdapter.listProgrammes();
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('config_error');
    }
  });
});

// ---------------------------------------------------------------------------
// getProgramme — select-by-id from the merchant export
// ---------------------------------------------------------------------------

describe('Belboon.getProgramme', () => {
  it('returns the matching programme row', async () => {
    mockFetchQueue([fakeResponse(loadCsv('merchants.csv'))]);
    const p = await belboonAdapter.getProgramme('1004');
    expect(p.id).toBe('1004');
    expect(p.name).toBe('Atolls Travel');
    expect(p.currency).toBe('GBP');
    expect(p.status).toBe('available');
  });

  it('throws a config_error envelope when no id is supplied', async () => {
    await expect(belboonAdapter.getProgramme('')).rejects.toBeInstanceOf(NetworkError);
    try {
      await belboonAdapter.getProgramme('   ');
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('config_error');
    }
  });

  it('throws a network_api_error envelope when the id is not in the export', async () => {
    mockFetchQueue([fakeResponse(loadCsv('merchants.csv'))]);
    try {
      await belboonAdapter.getProgramme('does-not-exist');
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).envelope.type).toBe('network_api_error');
    }
  });
});

// ---------------------------------------------------------------------------
// listTransactions — status normalisation, age + status filters, chunking
// ---------------------------------------------------------------------------

describe('Belboon.listTransactions', () => {
  it('parses the conversion export and normalises numeric + word statuses', async () => {
    // The 5-month window spans two ~quarter slices; the fixture answers the
    // first slice and the second slice is empty.
    mockFetchQueue([fakeResponse(loadCsv('conversions.csv')), fakeResponse('')]);
    const txns = await belboonAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-06-06T00:00:00Z',
    });
    expect(txns.length).toBe(6);
    const byId = new Map(txns.map((t) => [t.id, t]));
    expect(byId.get('9001')?.status).toBe('approved');
    expect(byId.get('9002')?.status).toBe('pending');
    expect(byId.get('9003')?.status).toBe('reversed');
    expect(byId.get('9003')?.reversalReason).toBe('Customer cancelled the order');
    expect(byId.get('9004')?.status).toBe('approved');
    expect(byId.get('9005')?.status).toBe('pending'); // numeric "1"
    expect(byId.get('9006')?.status).toBe('other'); // numeric "7" → other
    // German money parsing flows through the full stack.
    expect(byId.get('9001')?.commission).toBeCloseTo(61.73);
    expect(byId.get('9004')?.amount).toBeCloseTo(2500);
  });

  it('filters by status[] client-side (§15.10 reversed visibility)', async () => {
    mockFetchQueue([fakeResponse(loadCsv('conversions.csv')), fakeResponse('')]);
    const reversed = await belboonAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-06-06T00:00:00Z',
      status: ['reversed'],
    });
    expect(reversed.every((t) => t.status === 'reversed')).toBe(true);
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toBe('Customer cancelled the order');
  });

  it('filters by programmeId, and by minAgeDays (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadCsv('conversions.csv')), fakeResponse('')]);
    const prog = await belboonAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-06-06T00:00:00Z',
      programmeId: '1001',
    });
    expect(prog.every((t) => t.programmeId === '1001')).toBe(true);
    expect(prog.length).toBe(2);

    mockFetchQueue([fakeResponse(loadCsv('conversions.csv')), fakeResponse('')]);
    const aged = await belboonAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-06-06T00:00:00Z',
      minAgeDays: 90,
    });
    for (const t of aged) expect(t.ageDays).toBeGreaterThanOrEqual(90);
    expect(aged.length).toBeGreaterThan(0);
  });

  it('chunks date ranges wider than the quarter cap into multiple calls', async () => {
    // 200-day window ÷ 92-day chunk → 3 slices → 3 upstream calls.
    const spy = mockFetchQueue([fakeResponse(''), fakeResponse(''), fakeResponse('')]);
    await belboonAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-07-20T00:00:00Z',
    });
    expect(spy.mock.calls.length).toBe(3);
  });

  it('makes exactly one call for the default (30-day) window', async () => {
    const spy = mockFetchQueue([fakeResponse('')]);
    await belboonAdapter.listTransactions();
    expect(spy.mock.calls.length).toBe(1);
  });

  it('emits a config_error envelope when credentials are missing', async () => {
    delete process.env['BELBOON_USER_ID'];
    await expect(belboonAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary — derived from listTransactions
// ---------------------------------------------------------------------------

describe('Belboon.getEarningsSummary', () => {
  it('derives by-status, by-programme totals and oldest unpaid age (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadCsv('conversions.csv')), fakeResponse('')]);
    const summary = await belboonAdapter.getEarningsSummary({
      from: '2026-01-01T00:00:00Z',
      to: '2026-06-06T00:00:00Z',
    });

    expect(summary.network).toBe('belboon');
    expect(summary.currency).toBe('EUR');

    // Commission sums per status (61,73 + 125,00 approved; 2,50 + 17,49 pending;
    // 0,00 reversed; 0,50 other).
    expect(summary.byStatus.approved).toBeCloseTo(186.73);
    expect(summary.byStatus.pending).toBeCloseTo(19.99);
    expect(summary.byStatus.reversed).toBeCloseTo(0);
    expect(summary.byStatus.other).toBeCloseTo(0.5);

    // Total = sum of all commissions.
    expect(summary.totalEarnings).toBeCloseTo(207.22);

    // Three distinct programmes appear (1001, 1002, 1003).
    expect(summary.byProgramme.length).toBe(3);
    const p1001 = summary.byProgramme.find((p) => p.programmeId === '1001');
    expect(p1001?.transactionCount).toBe(2);
    expect(p1001?.total).toBeCloseTo(64.23);

    // Oldest unpaid (pending/approved): conversion 9001 from 15.01.2026 is the
    // oldest non-reversed record, so oldestUnpaidAgeDays is the largest age.
    expect(summary.oldestUnpaidAgeDays).toBeGreaterThan(100);
    expect(summary.periodFrom).toBe('2026-01-01T00:00:00Z');
    expect(summary.periodTo).toBe('2026-06-06T00:00:00Z');
  });
});

// ---------------------------------------------------------------------------
// listClicks — known-unsupported
// ---------------------------------------------------------------------------

describe('Belboon.listClicks', () => {
  it('throws NotImplementedError with the documented reason', async () => {
    await expect(belboonAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await belboonAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('aggregated daily stats');
    }
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — deterministic URL construction
// ---------------------------------------------------------------------------

describe('Belboon.generateTrackingLink', () => {
  it('constructs the deep-link URL with a URL-encoded destination', async () => {
    const link = await belboonAdapter.generateTrackingLink({
      programmeId: '1001',
      destinationUrl: 'https://books.example.com/path?q=a b&c=ü',
    });
    expect(link.trackingUrl).toContain('https://www1.belboon.de/tracking/1001.html?deeplink=');
    // The space, '&', and 'ü' must be percent-encoded.
    expect(link.trackingUrl).toContain(
      'deeplink=https%3A%2F%2Fbooks.example.com%2Fpath%3Fq%3Da%20b%26c%3D%C3%BC',
    );
    expect(link.network).toBe('belboon');
    expect(link.programmeId).toBe('1001');
  });

  it('throws a config_error envelope when programmeId is missing', async () => {
    await expect(
      belboonAdapter.generateTrackingLink({ programmeId: '', destinationUrl: 'https://x.example.com' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error envelope when destinationUrl is missing', async () => {
    await expect(
      belboonAdapter.generateTrackingLink({ programmeId: '1001', destinationUrl: '' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('does NOT call fetch (deterministic construction)', async () => {
    const spy = mockFetchQueue([]);
    await belboonAdapter.generateTrackingLink({
      programmeId: '1001',
      destinationUrl: 'https://x.example.com',
    });
    expect(spy.mock.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('Belboon.verifyAuth', () => {
  it('returns ok:true and an identity built from the user id when the export responds 200', async () => {
    mockFetchQueue([fakeResponse(loadCsv('merchants.csv'))]);
    const r = await belboonAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toBe('belboon/partner/123');
  });

  it('returns ok:false (never throws) on a 401', async () => {
    mockFetchQueue([fakeResponse('forbidden', { status: 401 })]);
    const r = await belboonAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/401/);
  });

  it('returns ok:false when a required credential is missing', async () => {
    delete process.env['BELBOON_MAGIC_KEY'];
    const r = await belboonAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('Belboon.validateCredential', () => {
  it('rejects malformed user ids and accepts positive integers', async () => {
    expect((await belboonAdapter.validateCredential('BELBOON_USER_ID', 'abc')).ok).toBe(false);
    expect((await belboonAdapter.validateCredential('BELBOON_USER_ID', '-5')).ok).toBe(false);
    expect((await belboonAdapter.validateCredential('BELBOON_USER_ID', '0')).ok).toBe(false);
    expect((await belboonAdapter.validateCredential('BELBOON_USER_ID', '123')).ok).toBe(true);
  });

  it('defers the magic-key live check when no user id is set', async () => {
    delete process.env['BELBOON_USER_ID'];
    const r = await belboonAdapter.validateCredential(
      'BELBOON_MAGIC_KEY',
      'f0d58188-5420-4856-84b2-0417a3a85225',
    );
    expect(r.ok).toBe(true);
  });

  it('rejects an obviously-too-short magic key', async () => {
    const r = await belboonAdapter.validateCredential('BELBOON_MAGIC_KEY', 'abc');
    expect(r.ok).toBe(false);
  });

  it('reports an unknown field', async () => {
    const r = await belboonAdapter.validateCredential('BELBOON_NONSENSE', 'x');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('Belboon.capabilitiesCheck', () => {
  it('records listClicks.supported = false and surfaces the known limitations', async () => {
    // Probes: listProgrammes, listTransactions, getEarningsSummary (→ listTransactions),
    // verifyAuth. The default 30-day window means one fetch per reporting probe.
    mockFetchQueue([
      fakeResponse(''), // listProgrammes
      fakeResponse(''), // listTransactions probe
      fakeResponse(''), // getEarningsSummary → listTransactions
      fakeResponse(loadCsv('merchants.csv')), // verifyAuth
    ]);
    const caps = await belboonAdapter.capabilitiesCheck();
    expect(caps.network).toBe('belboon');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['listClicks']?.note).toContain('aggregated daily stats');
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim Belboon response body on a 500', async () => {
    const body = 'Internal export error: file generation failed at 03:14:15';
    mockFetchQueue([fakeResponse(body, { status: 500 })]);
    try {
      await belboonAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('belboon');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('file generation failed at 03:14:15');
    }
  });

  it('classifies a 401 as auth_error and preserves the body', async () => {
    mockFetchQueue([fakeResponse('invalid magic key', { status: 401 })]);
    try {
      await belboonAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('auth_error');
      expect(env.networkErrorBody).toContain('invalid magic key');
    }
  });
});
