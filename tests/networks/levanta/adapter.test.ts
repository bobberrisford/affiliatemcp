/**
 * Levanta adapter — unit tests.
 *
 * Mirrors the Awin test patterns:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - Each test stubs only the fetch responses it needs.
 *
 * No live calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { levantaAdapter, _internals } from '../../../src/networks/levanta/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'networks', 'levanta', 'fixtures');

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
  process.env['LEVANTA_API_KEY'] = 'test-token-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['LEVANTA_API_KEY'];
});

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

describe('Levanta transformers', () => {
  it('models each partner as a joined programme and preserves the raw payload', () => {
    const partners = loadFixture('partners.json') as Array<Record<string, unknown>>;
    const prog = _internals.toProgramme(partners[0] as never);
    expect(prog.id).toBe('1001');
    expect(prog.name).toBe('Atolls Coffee Co');
    expect(prog.status).toBe('joined');
    expect(prog.network).toBe('levanta');
    expect(prog.rawNetworkData).toBe(partners[0]);
  });

  it('maps a report row to a pending transaction with sales/commission and raw preserved', () => {
    const rows = (loadFixture('reports.json') as { reports: Array<Record<string, unknown>> })
      .reports;
    const txn = _internals.toTransaction(rows[0] as never);
    // Levanta figures are Amazon estimates: never invent approved/paid.
    expect(txn.status).toBe('pending');
    expect(txn.amount).toBe(240.5);
    expect(txn.commission).toBe(19.24);
    expect(txn.currency).toBe('USD');
    expect(txn.programmeId).toBe('1001');
    expect(txn.rawNetworkData).toBe(rows[0]);
  });

  it('synthesises a deterministic id from the report row dimensions', () => {
    const row = { brandId: '1001', asin: 'B0AAAA0001', source: 'newsletter', date: '2026-05-01' };
    expect(_internals.reportRowId(row)).toBe('1001|B0AAAA0001|newsletter|2026-05-01');
  });

  it('computes ageDays anchored on the row date', () => {
    const now = new Date('2026-05-21T00:00:00Z');
    expect(_internals.computeAgeDays({ date: '2026-05-01' }, now)).toBe(20);
    expect(_internals.computeAgeDays({}, now)).toBe(0);
  });

  it('formats report dates as YYYY-MM-DD', () => {
    expect(_internals.formatLevantaDate(new Date('2026-05-01T12:34:56Z'))).toBe('2026-05-01');
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('Levanta.listProgrammes', () => {
  it('returns programmes from /partners and applies the search filter', async () => {
    mockFetchQueue([fakeResponse(loadFixture('partners.json'))]);
    const all = await levantaAdapter.listProgrammes();
    expect(all.length).toBe(3);
    expect(all.every((p) => p.status === 'joined')).toBe(true);

    mockFetchQueue([fakeResponse(loadFixture('partners.json'))]);
    const filtered = await levantaAdapter.listProgrammes({ search: 'atolls' });
    expect(filtered.length).toBe(1);
    expect(filtered[0]?.name).toBe('Atolls Coffee Co');
  });

  it('emits a NetworkError when the token is missing', async () => {
    delete process.env['LEVANTA_API_KEY'];
    await expect(levantaAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getProgramme
// ---------------------------------------------------------------------------

describe('Levanta.getProgramme', () => {
  it('returns the matching partnership by brand id', async () => {
    mockFetchQueue([fakeResponse(loadFixture('partners.json'))]);
    const prog = await levantaAdapter.getProgramme('1002');
    expect(prog.name).toBe('Berrisford Outdoors');
  });

  it('throws a config_error envelope when the id is empty', async () => {
    await expect(levantaAdapter.getProgramme('')).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a network_api_error envelope for an unknown id', async () => {
    mockFetchQueue([fakeResponse(loadFixture('partners.json'))]);
    await expect(levantaAdapter.getProgramme('9999')).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('Levanta.listTransactions', () => {
  it('maps report rows to transactions within a narrow window (one call)', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('reports.json'))]);
    const txns = await levantaAdapter.listTransactions({
      from: '2026-04-21T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
    });
    expect(spy.mock.calls.length).toBe(1);
    expect(txns.length).toBe(3);
    expect(txns.every((t) => t.status === 'pending')).toBe(true);
  });

  it('filters by programmeId (brand id)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('reports.json'))]);
    const only = await levantaAdapter.listTransactions({
      from: '2026-04-21T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
      programmeId: '1001',
    });
    expect(only.every((t) => t.programmeId === '1001')).toBe(true);
    expect(only.length).toBe(2);
  });

  it('chunks date ranges wider than 31 days into multiple calls', async () => {
    const spy = mockFetchQueue([fakeResponse([]), fakeResponse([]), fakeResponse([])]);
    await levantaAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-03-31T00:00:00Z',
    });
    expect(spy.mock.calls.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('Levanta.getEarningsSummary', () => {
  it('aggregates commission client-side, by programme and status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('reports.json'))]);
    const summary = await levantaAdapter.getEarningsSummary({
      from: '2026-04-21T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
    });
    expect(summary.network).toBe('levanta');
    // 19.24 + 7.92 + 0
    expect(summary.totalEarnings).toBeCloseTo(27.16, 2);
    expect(summary.byStatus.pending).toBeCloseTo(27.16, 2);
    // Two distinct brands present.
    expect(summary.byProgramme.length).toBe(2);
    expect(summary.oldestUnpaidAgeDays).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// listClicks + generateTrackingLink (both unsupported)
// ---------------------------------------------------------------------------

describe('Levanta unsupported operations', () => {
  it('listClicks throws NotImplementedError with a documented reason', async () => {
    await expect(levantaAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await levantaAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click-level events');
    }
  });

  it('generateTrackingLink throws NotImplementedError with a documented reason', async () => {
    await expect(
      levantaAdapter.generateTrackingLink({ programmeId: '1001', destinationUrl: 'https://x' }),
    ).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await levantaAdapter.generateTrackingLink({ programmeId: '1001', destinationUrl: 'https://x' });
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('/links');
    }
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('Levanta.verifyAuth', () => {
  it('returns ok:true with a partnership-count identity on 200', async () => {
    mockFetchQueue([fakeResponse(loadFixture('partners.json'))]);
    const r = await levantaAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toContain('3 active partnerships');
  });

  it('returns ok:false on 401', async () => {
    mockFetchQueue([fakeResponse('{"error":"invalid_token"}', { status: 401 })]);
    const r = await levantaAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/401/);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('Levanta.validateCredential', () => {
  it('validates LEVANTA_API_KEY by calling /partners', async () => {
    mockFetchQueue([fakeResponse(loadFixture('partners.json'))]);
    const r = await levantaAdapter.validateCredential('LEVANTA_API_KEY', 'fresh-token');
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with a hint on a bad token', async () => {
    mockFetchQueue([fakeResponse('{"error":"bad"}', { status: 401 })]);
    const r = await levantaAdapter.validateCredential('LEVANTA_API_KEY', 'bad-token');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('rejects unknown credential fields', async () => {
    const r = await levantaAdapter.validateCredential('SOMETHING_ELSE', 'x');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('Levanta.capabilitiesCheck', () => {
  it('records listClicks and generateTrackingLink as unsupported with notes', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('partners.json')), // listProgrammes
      fakeResponse(loadFixture('reports.json')), // listTransactions probe
      fakeResponse(loadFixture('reports.json')), // getEarningsSummary → listTransactions
      fakeResponse(loadFixture('partners.json')), // verifyAuth
    ]);
    const caps = await levantaAdapter.capabilitiesCheck();
    expect(caps.network).toBe('levanta');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency
// ---------------------------------------------------------------------------

describe('Levanta error transparency', () => {
  it('surfaces the verbatim response body on a 500', async () => {
    const body = '{"error":"levanta upstream broke","trace":"abc"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await levantaAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('levanta');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream broke');
    }
  });

  it('classifies 401 as auth_error', async () => {
    mockFetchQueue([fakeResponse('forbidden', { status: 401, rawBody: 'forbidden' })]);
    try {
      await levantaAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('auth_error');
    }
  });
});
