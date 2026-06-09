/**
 * LinkConnector adapter — unit tests.
 *
 * Mirrors the Awin test patterns:
 *   - We mock `globalThis.fetch` directly (the adapter↔network seam), exercising
 *     the full client + resilience + transformer stack with no live HTTP.
 *   - Each test queues only the fetch responses it needs.
 *   - No live calls.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { linkconnectorAdapter, _internals } from '../../../src/networks/linkconnector/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'networks', 'linkconnector', 'fixtures');

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
  process.env['LINKCONNECTOR_API_KEY'] = 'test-key-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['LINKCONNECTOR_API_KEY'];
});

// ---------------------------------------------------------------------------
// Transformers (status mapping, amount parsing, raw preservation)
// ---------------------------------------------------------------------------

describe('LinkConnector transformers', () => {
  it('maps Status approved|pending|invalid|paid → canonical statuses', () => {
    const txns = (loadFixture('transactions.json') as { Transactions: Array<Record<string, unknown>> })
      .Transactions;
    expect(_internals.toTransaction(txns[0] as never).status).toBe('approved');
    expect(_internals.toTransaction(txns[1] as never).status).toBe('pending');
    // 'invalid' is LinkConnector's "reversed".
    expect(_internals.toTransaction(txns[2] as never).status).toBe('reversed');
    expect(_internals.toTransaction(txns[3] as never).status).toBe('paid');
  });

  it('parses amounts with currency symbols and preserves the raw row', () => {
    const txns = (loadFixture('transactions.json') as { Transactions: Array<Record<string, unknown>> })
      .Transactions;
    const reversed = _internals.toTransaction(txns[2] as never);
    // "$80.00" / "$8.00" must parse numerically.
    expect(reversed.amount).toBe(80);
    expect(reversed.commission).toBe(8);
    expect(reversed.rawNetworkData).toBe(txns[2]);
  });

  it('surfaces the invalidation reason on reversed transactions (§15.10)', () => {
    const txns = (loadFixture('transactions.json') as { Transactions: Array<Record<string, unknown>> })
      .Transactions;
    const reversed = _internals.toTransaction(txns[2] as never);
    expect(reversed.reversalReason).toBe('Customer returned the item within 30 days');
  });

  it('computes ageDays from FundedDate (preferred) then conversion date', () => {
    const now = new Date('2026-05-21T00:00:00Z');
    expect(_internals.computeAgeDays({ FundedDate: '2026-01-01' }, now)).toBe(140);
    expect(_internals.computeAgeDays({ TransactionDate: '2026-04-01' }, now)).toBe(50);
  });

  it('unwraps the various envelope keys defensively', () => {
    expect(_internals.unwrapRows([{ a: 1 }]).length).toBe(1);
    expect(_internals.unwrapRows({ Transactions: [{ a: 1 }, { b: 2 }] }).length).toBe(2);
    expect(_internals.unwrapRows({ Promotions: [{ a: 1 }] }).length).toBe(1);
    expect(_internals.unwrapRows({ nothing: true }).length).toBe(0);
  });

  it('de-duplicates merchants from the promotions feed in listProgrammes', async () => {
    mockFetchQueue([fakeResponse(loadFixture('promotions.json'))]);
    const programmes = await linkconnectorAdapter.listProgrammes();
    // 3 promotions across 2 merchants → 2 programmes.
    expect(programmes.length).toBe(2);
    expect(programmes.every((p) => p.status === 'joined')).toBe(true);
    expect(programmes.find((p) => p.id === '5001')?.name).toBe('Atolls Bookshop');
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('LinkConnector.listTransactions', () => {
  it('filters by status when caller passes status[]', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const reversed = await linkconnectorAdapter.listTransactions({
      from: '2026-01-01',
      to: '2026-06-01',
      status: ['reversed'],
    });
    expect(reversed.every((t) => t.status === 'reversed')).toBe(true);
    expect(reversed.length).toBe(1);
  });

  it('filters by minAgeDays AFTER status (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const old = await linkconnectorAdapter.listTransactions({
      from: '2025-01-01',
      to: '2026-06-01',
      minAgeDays: 365,
    });
    for (const t of old) expect(t.ageDays).toBeGreaterThanOrEqual(365);
    // The 2025-01 paid transaction is the only one >1 year old.
    expect(old.length).toBe(1);
    expect(old[0]?.id).toBe('LC-1004');
  });

  it('pages until a short page is returned', async () => {
    // First page returns a full 500 rows → adapter requests a second page.
    const full = { Transactions: Array.from({ length: 500 }, (_v, i) => ({ TransactionId: `t${i}`, Status: 'Pending', TransactionDate: '2026-05-01' })) };
    const spy = mockFetchQueue([fakeResponse(full), fakeResponse({ Transactions: [] })]);
    const txns = await linkconnectorAdapter.listTransactions({ from: '2026-05-01', to: '2026-05-31' });
    expect(spy.mock.calls.length).toBe(2);
    expect(txns.length).toBe(500);
  });

  it('emits an error envelope when the API key is missing', async () => {
    delete process.env['LINKCONNECTOR_API_KEY'];
    await expect(linkconnectorAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('LinkConnector.getEarningsSummary', () => {
  it('aggregates commission by status and programme', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const summary = await linkconnectorAdapter.getEarningsSummary({
      from: '2025-01-01',
      to: '2026-06-01',
    });
    expect(summary.network).toBe('linkconnector');
    // 12 + 4.55 + 8 + 30 = 54.55
    expect(summary.totalEarnings).toBeCloseTo(54.55, 2);
    expect(summary.byStatus.approved).toBeCloseTo(12, 2);
    expect(summary.byStatus.pending).toBeCloseTo(4.55, 2);
    expect(summary.byStatus.reversed).toBeCloseTo(8, 2);
    expect(summary.byStatus.paid).toBeCloseTo(30, 2);
    // Two merchants contribute to programme rollup (5001 twice).
    expect(summary.byProgramme.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// listClicks + generateTrackingLink — unsupported
// ---------------------------------------------------------------------------

describe('LinkConnector unsupported operations', () => {
  it('listClicks throws NotImplementedError with the documented reason', async () => {
    await expect(linkconnectorAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await linkconnectorAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click-level data');
    }
  });

  it('generateTrackingLink throws NotImplementedError (no deterministic scheme)', async () => {
    await expect(
      linkconnectorAdapter.generateTrackingLink({ programmeId: '5001', destinationUrl: 'https://x.example.com' }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// getProgramme
// ---------------------------------------------------------------------------

describe('LinkConnector.getProgramme', () => {
  it('returns a single merchant from the promotions feed', async () => {
    mockFetchQueue([fakeResponse(loadFixture('promotions.json'))]);
    const p = await linkconnectorAdapter.getProgramme('5002');
    expect(p.id).toBe('5002');
    expect(p.name).toBe('Atolls Coffee');
  });

  it('throws a config_error envelope when the id is empty', async () => {
    await expect(linkconnectorAdapter.getProgramme('')).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a network_api_error envelope for an unknown id', async () => {
    mockFetchQueue([fakeResponse(loadFixture('promotions.json'))]);
    await expect(linkconnectorAdapter.getProgramme('99999')).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('LinkConnector.verifyAuth', () => {
  it('returns ok:true when the report call responds 200', async () => {
    mockFetchQueue([fakeResponse({ Transactions: [] })]);
    const r = await linkconnectorAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toContain('linkconnector');
  });

  it('returns ok:false on a 401 (never throws)', async () => {
    mockFetchQueue([fakeResponse('{"error":"invalid key"}', { status: 401 })]);
    const r = await linkconnectorAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/401/);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('LinkConnector.validateCredential', () => {
  it('rejects an empty key without a network call', async () => {
    const r = await linkconnectorAdapter.validateCredential('LINKCONNECTOR_API_KEY', '   ');
    expect(r.ok).toBe(false);
  });

  it('validates the key by calling the report endpoint', async () => {
    mockFetchQueue([fakeResponse({ Transactions: [] })]);
    const r = await linkconnectorAdapter.validateCredential('LINKCONNECTOR_API_KEY', 'fresh-key');
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with a hint when validation fails', async () => {
    mockFetchQueue([fakeResponse('{"error":"bad"}', { status: 401 })]);
    const r = await linkconnectorAdapter.validateCredential('LINKCONNECTOR_API_KEY', 'bad-key');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('LinkConnector.capabilitiesCheck', () => {
  it('records listClicks + generateTrackingLink as unsupported', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('promotions.json')), // listProgrammes
      fakeResponse({ Transactions: [] }), // listTransactions probe
      fakeResponse({ Transactions: [] }), // getEarningsSummary → listTransactions
      fakeResponse({ Transactions: [] }), // verifyAuth
    ]);
    const caps = await linkconnectorAdapter.capabilitiesCheck();
    expect(caps.network).toBe('linkconnector');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim body on a 500', async () => {
    const body = '{"error":"upstream broke","trace":"abc"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await linkconnectorAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('linkconnector');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream broke');
    }
  });

  it('classifies 401 as auth_error', async () => {
    mockFetchQueue([fakeResponse('forbidden', { status: 401, rawBody: 'forbidden' })]);
    try {
      await linkconnectorAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('auth_error');
    }
  });
});
