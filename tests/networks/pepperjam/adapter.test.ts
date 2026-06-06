/**
 * Pepperjam (Ascend by Partnerize) adapter — unit tests.
 *
 * Mirrors the Awin test patterns: mock `globalThis.fetch`, exercise the full
 * client + resilience + transformer stack with no live HTTP. The Pepperjam
 * `meta`/`data` envelope and the apiKey query-param auth are exercised via the
 * fixtures.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { pepperjamAdapter, _internals } from '../../../src/networks/pepperjam/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'pepperjam');

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
  process.env['PEPPERJAM_API_KEY'] = 'test-key-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['PEPPERJAM_API_KEY'];
});

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

describe('Pepperjam transformers (status normalisation, raw preservation)', () => {
  it('maps Pepperjam statuses locked|pending|declined|paid → canonical', () => {
    const txns = (loadFixture('transactions.json') as { data: Array<Record<string, unknown>> }).data;
    expect(_internals.toTransaction(txns[0] as never).status).toBe('approved'); // locked
    expect(_internals.toTransaction(txns[1] as never).status).toBe('pending');
    expect(_internals.toTransaction(txns[2] as never).status).toBe('reversed'); // declined
    expect(_internals.toTransaction(txns[3] as never).status).toBe('paid');
  });

  it('preserves the raw row under rawNetworkData and coerces numeric strings', () => {
    const raw = (loadFixture('transactions.json') as { data: Array<Record<string, unknown>> })
      .data[0];
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
    expect(out.amount).toBe(120);
    expect(out.commission).toBeCloseTo(9.6);
    expect(out.currency).toBe('USD');
  });

  it('maps advertiser relationships to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ status: 'joined' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ status: 'declined' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ status: 'available' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ status: 'whatever' })).toBe('unknown');
  });

  it('computes ageDays from sale_date', () => {
    const now = new Date('2026-05-21T00:00:00Z');
    const age = _internals.computeAgeDays({ sale_date: '2026-01-01 00:00:00' }, now);
    expect(age).toBe(140);
  });

  it('formats report dates as YYYY-MM-DD', () => {
    expect(_internals.formatPepperjamDate(new Date('2026-03-15T12:30:00Z'))).toBe('2026-03-15');
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('Pepperjam.listProgrammes', () => {
  it('lists advertisers from the meta/data envelope', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    const programmes = await pepperjamAdapter.listProgrammes();
    expect(programmes.length).toBe(3);
    expect(programmes[0]?.network).toBe('pepperjam');
    expect(programmes[0]?.name).toBe('Atolls Bookshop');
  });

  it('filters by search substring and status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    const pending = await pepperjamAdapter.listProgrammes({ status: 'pending' });
    expect(pending.every((p) => p.status === 'pending')).toBe(true);
    expect(pending.length).toBe(1);
  });

  it('appends apiKey and format to the request URL', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    await pepperjamAdapter.listProgrammes();
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain('/20120402/publisher/advertiser');
    expect(url).toContain('apiKey=test-key-please-ignore');
    expect(url).toContain('format=json');
  });
});

// ---------------------------------------------------------------------------
// getProgramme
// ---------------------------------------------------------------------------

describe('Pepperjam.getProgramme', () => {
  it('returns the matching advertiser', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    const p = await pepperjamAdapter.getProgramme('1002');
    expect(p.id).toBe('1002');
    expect(p.status).toBe('pending');
  });

  it('throws a network_api_error envelope for an unknown id', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    await expect(pepperjamAdapter.getProgramme('does-not-exist')).rejects.toBeInstanceOf(
      NetworkError,
    );
  });

  it('throws a config_error envelope when id is empty', async () => {
    await expect(pepperjamAdapter.getProgramme('')).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('Pepperjam.listTransactions', () => {
  it('returns transactions from the transaction-details report', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const txns = await pepperjamAdapter.listTransactions({
      from: '2026-04-21T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
    });
    expect(txns.length).toBe(4);
    expect(txns.every((t) => t.network === 'pepperjam')).toBe(true);
  });

  it('filters by status[] (§15.10 reversed visibility)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const reversed = await pepperjamAdapter.listTransactions({
      from: '2026-04-21T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
      status: ['reversed'],
    });
    expect(reversed.every((t) => t.status === 'reversed')).toBe(true);
    expect(reversed.length).toBe(1);
  });

  it('applies minAgeDays after status filtering (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const aged = await pepperjamAdapter.listTransactions({
      from: '2026-04-21T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
      minAgeDays: 365,
    });
    expect(aged.length).toBeGreaterThan(0);
    for (const t of aged) expect(t.ageDays).toBeGreaterThanOrEqual(365);
  });

  it('chunks date ranges wider than 31 days into multiple calls', async () => {
    const empty = { meta: { pagination: { total_pages: 1 } }, data: [] };
    const spy = mockFetchQueue([fakeResponse(empty), fakeResponse(empty), fakeResponse(empty)]);
    await pepperjamAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-03-31T00:00:00Z',
    });
    expect(spy.mock.calls.length).toBe(3);
  });

  it('walks every page using meta.pagination.total_pages', async () => {
    const page1 = {
      meta: { pagination: { total_pages: 2 } },
      data: [{ transaction_id: 'a', program_id: '1', commission: '1.00', sale_date: '2026-05-01 00:00:00' }],
    };
    const page2 = {
      meta: { pagination: { total_pages: 2 } },
      data: [{ transaction_id: 'b', program_id: '1', commission: '2.00', sale_date: '2026-05-02 00:00:00' }],
    };
    const spy = mockFetchQueue([fakeResponse(page1), fakeResponse(page2)]);
    const txns = await pepperjamAdapter.listTransactions({
      from: '2026-05-01T00:00:00Z',
      to: '2026-05-10T00:00:00Z',
    });
    expect(spy.mock.calls.length).toBe(2);
    expect(txns.length).toBe(2);
  });

  it('emits an error envelope when the API key is missing', async () => {
    delete process.env['PEPPERJAM_API_KEY'];
    await expect(pepperjamAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('Pepperjam.getEarningsSummary', () => {
  it('aggregates commission by status and programme', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const summary = await pepperjamAdapter.getEarningsSummary({
      from: '2026-04-21T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
    });
    expect(summary.network).toBe('pepperjam');
    // 9.60 + 2.50 + 2.40 + 12.00
    expect(summary.totalEarnings).toBeCloseTo(26.5);
    expect(summary.byStatus.paid).toBeCloseTo(12);
    expect(summary.byStatus.reversed).toBeCloseTo(2.4);
    expect(summary.oldestUnpaidAgeDays).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// listClicks + generateTrackingLink — unsupported
// ---------------------------------------------------------------------------

describe('Pepperjam unsupported operations', () => {
  it('listClicks throws NotImplementedError with the documented reason', async () => {
    await expect(pepperjamAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await pepperjamAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click-level data');
    }
  });

  it('generateTrackingLink throws NotImplementedError and does not call fetch', async () => {
    const spy = mockFetchQueue([]);
    await expect(
      pepperjamAdapter.generateTrackingLink({
        programmeId: '1001',
        destinationUrl: 'https://x.example.com',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
    expect(spy.mock.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth + validateCredential
// ---------------------------------------------------------------------------

describe('Pepperjam.verifyAuth', () => {
  it('returns ok:true when /publisher/advertiser responds 200', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    const r = await pepperjamAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toContain('pepperjam');
  });

  it('returns ok:false on 401', async () => {
    mockFetchQueue([fakeResponse('{"meta":{"status":{"code":401}}}', { status: 401 })]);
    const r = await pepperjamAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/401/);
  });
});

describe('Pepperjam.validateCredential', () => {
  it('validates PEPPERJAM_API_KEY by calling the API', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    const r = await pepperjamAdapter.validateCredential('PEPPERJAM_API_KEY', 'fresh-key');
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with a hint when validation fails', async () => {
    mockFetchQueue([fakeResponse('{"error":"bad"}', { status: 401 })]);
    const r = await pepperjamAdapter.validateCredential('PEPPERJAM_API_KEY', 'bad-key');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('rejects an unknown field', async () => {
    const r = await pepperjamAdapter.validateCredential('NOPE', 'x');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('Pepperjam.capabilitiesCheck', () => {
  it('records listClicks and generateTrackingLink as unsupported', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('advertisers.json')), // listProgrammes
      fakeResponse(loadFixture('transactions.json')), // listTransactions probe
      fakeResponse(loadFixture('transactions.json')), // getEarningsSummary → listTransactions
      fakeResponse(loadFixture('advertisers.json')), // verifyAuth
    ]);
    const caps = await pepperjamAdapter.capabilitiesCheck();
    expect(caps.network).toBe('pepperjam');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Error transparency (§15.4)
// ---------------------------------------------------------------------------

describe('Pepperjam §15.4 error transparency', () => {
  it('surfaces the verbatim response body on a 500', async () => {
    const body = '{"error":"upstream broke","trace":"abc"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await pepperjamAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('pepperjam');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream broke');
    }
  });

  it('classifies 401 as auth_error', async () => {
    mockFetchQueue([fakeResponse('forbidden', { status: 401, rawBody: 'forbidden' })]);
    try {
      await pepperjamAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('auth_error');
    }
  });
});
