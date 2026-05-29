/**
 * Tradedoubler adapter — unit tests.
 *
 * Pattern-matched to tests/networks/cj/adapter.test.ts:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 *   - Fixtures live under `tests/fixtures/tradedoubler/`.
 *   - No live credentials — all credentials are synthetic process.env values
 *     set in `beforeEach`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { tradedoublerAdapter, _internals } from '../../../src/networks/tradedoubler/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'tradedoubler');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

/**
 * Mint a fake `Response` for mocking fetch.
 */
function fakeResponse(
  body: unknown,
  init: { status?: number; rawBody?: string } = {},
): Response {
  const status = init.status ?? 200;
  const text =
    init.rawBody ?? (typeof body === 'string' ? body : JSON.stringify(body));
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
  process.env['TRADEDOUBLER_API_TOKEN'] = 'test-token-please-ignore';
  process.env['TRADEDOUBLER_ORGANIZATION_ID'] = '1234567';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['TRADEDOUBLER_API_TOKEN'];
  delete process.env['TRADEDOUBLER_ORGANIZATION_ID'];
});

// ---------------------------------------------------------------------------
// Transformer unit tests (status normalisation + raw preservation)
// ---------------------------------------------------------------------------

describe('Tradedoubler transformers (status normalisation, raw preservation)', () => {
  it('maps Tradedoubler transaction status A/P/D → canonical statuses', () => {
    const accepted = _internals.toTransaction({ status: 'A' } as never);
    const pending = _internals.toTransaction({ status: 'P' } as never);
    const denied = _internals.toTransaction({
      status: 'D',
      statusReason: 'Returned',
    } as never);
    const paid = _internals.toTransaction({ status: 'A', paid: true } as never);
    const unknown = _internals.toTransaction({ status: 'X' } as never);

    expect(accepted.status).toBe('approved');
    expect(pending.status).toBe('pending');
    // §15.10: D (Denied) must map to 'reversed'.
    expect(denied.status).toBe('reversed');
    // paid flag overrides status.
    expect(paid.status).toBe('paid');
    expect(unknown.status).toBe('other');
  });

  it('maps Tradedoubler programme status strings to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ status: 'JOINED' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'joined' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'APPLIED' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ status: 'DECLINED' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ status: 'NOT_JOINED' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ status: 'TERMINATED' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'NEVER_SEEN_BEFORE' })).toBe('unknown');
    expect(_internals.mapProgrammeStatus({})).toBe('unknown');
  });

  it('preserves the raw Tradedoubler payload under rawNetworkData', () => {
    const fixtures = loadFixture('transactions.json') as {
      items: Record<string, unknown>[];
    };
    const raw = fixtures.items[0];
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('preserves raw programme payload under rawNetworkData', () => {
    const fixtures = loadFixture('programmes.json') as {
      items: Record<string, unknown>[];
    };
    const raw = fixtures.items[0];
    const out = _internals.toProgramme(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('surfaces reversalReason from statusReason on reversed transactions (§15.10)', () => {
    const items = (
      loadFixture('transactions.json') as { items: Record<string, unknown>[] }
    ).items;
    // TXN-003 is the denied/reversed transaction.
    const denied = items[2] as Record<string, unknown>;
    const out = _internals.toTransaction(denied as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Customer returned the item within 30 days');
  });

  it('computes ageDays from timeOfLastModified (preferred) then timeOfTransaction', () => {
    const now = new Date('2026-05-28T00:00:00Z');
    // lastModified = 2024-02-01 → 847 days
    const age1 = _internals.computeAgeDays(
      { timeOfLastModified: '2024-02-01T08:00:00Z' } as never,
      now,
    );
    expect(age1).toBeGreaterThan(800);

    // Falls back to timeOfTransaction = 2026-05-01 → ~26-27 days depending on time-of-day
    const age2 = _internals.computeAgeDays(
      { timeOfTransaction: '2026-05-01T14:22:00Z' } as never,
      now,
    );
    expect(age2).toBeGreaterThanOrEqual(26);
    expect(age2).toBeLessThanOrEqual(28);

    // No timestamps → 0
    const age3 = _internals.computeAgeDays({} as never, now);
    expect(age3).toBe(0);
  });

  it('normalises id from `id` field (falling back to programId)', () => {
    const p1 = _internals.toProgramme({ id: 9999, name: 'Test' } as never);
    expect(p1.id).toBe('9999');

    const p2 = _internals.toProgramme({ programId: 8888, name: 'Test' } as never);
    expect(p2.id).toBe('8888');
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('TradedoublerAdapter.listProgrammes', () => {
  it('returns programmes mapped to canonical shape from fixture', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programmes.json'))]);
    const programmes = await tradedoublerAdapter.listProgrammes();
    expect(programmes.length).toBeGreaterThan(0);
    for (const p of programmes) {
      expect(p.network).toBe('tradedoubler');
      expect(p.id).toBeTruthy();
    }
  });

  it('filters by status client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programmes.json'))]);
    const joined = await tradedoublerAdapter.listProgrammes({ status: 'joined' });
    expect(joined.every((p) => p.status === 'joined')).toBe(true);
    expect(joined.length).toBeGreaterThan(0);
  });

  it('filters by search substring client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programmes.json'))]);
    const results = await tradedoublerAdapter.listProgrammes({ search: 'bookshop' });
    expect(results.every((p) => p.name.toLowerCase().includes('bookshop'))).toBe(true);
  });

  it('honours `limit` cap', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programmes.json'))]);
    const results = await tradedoublerAdapter.listProgrammes({ limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('throws NetworkError when token is missing', async () => {
    delete process.env['TRADEDOUBLER_API_TOKEN'];
    await expect(tradedoublerAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws NetworkError when organisation ID is missing', async () => {
    delete process.env['TRADEDOUBLER_ORGANIZATION_ID'];
    await expect(tradedoublerAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listTransactions — unpaid-age + reversed visibility (§15.9, §15.10)
// ---------------------------------------------------------------------------

describe('TradedoublerAdapter.listTransactions', () => {
  it('returns transactions from fixture with canonical shape', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const txns = await tradedoublerAdapter.listTransactions({
      from: '2024-01-01',
      to: '2026-05-28',
    });
    expect(txns.length).toBeGreaterThan(0);
    for (const t of txns) {
      expect(t.network).toBe('tradedoubler');
      expect(typeof t.ageDays).toBe('number');
      expect(t.ageDays).toBeGreaterThanOrEqual(0);
    }
  });

  it('returns aged transactions only when minAgeDays is set (§15.9)', async () => {
    // With minAgeDays=365 only TXN-001 and TXN-003 should qualify (Jan 2024, Sep 2024).
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const aged = await tradedoublerAdapter.listTransactions({
      from: '2024-01-01',
      to: '2026-05-28',
      minAgeDays: 365,
    });
    for (const t of aged) {
      expect(t.ageDays).toBeGreaterThanOrEqual(365);
    }
    expect(aged.length).toBeGreaterThan(0);
  });

  it('includes reversed transactions with reason populated (§15.10)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const all = await tradedoublerAdapter.listTransactions({
      from: '2024-01-01',
      to: '2026-05-28',
    });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toBe('Customer returned the item within 30 days');
  });

  it('filters by status when caller passes status[]', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const only = await tradedoublerAdapter.listTransactions({
      from: '2024-01-01',
      to: '2026-05-28',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('emits a NetworkError when the token is missing (§15.4)', async () => {
    delete process.env['TRADEDOUBLER_API_TOKEN'];
    await expect(tradedoublerAdapter.listTransactions({})).rejects.toBeInstanceOf(
      NetworkError,
    );
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary — derives from listTransactions
// ---------------------------------------------------------------------------

describe('TradedoublerAdapter.getEarningsSummary', () => {
  it('correctly aggregates pending/approved/reversed/paid buckets', async () => {
    // getEarningsSummary calls listTransactions internally.
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const summary = await tradedoublerAdapter.getEarningsSummary({
      from: '2024-01-01',
      to: '2026-05-28',
    });
    expect(summary.network).toBe('tradedoubler');
    expect(typeof summary.totalEarnings).toBe('number');
    // TXN-003 is reversed (D), so byStatus.reversed should be non-zero.
    expect(summary.byStatus.reversed).toBeGreaterThan(0);
    // TXN-002 is pending (P).
    expect(summary.byStatus.pending).toBeGreaterThan(0);
    // TXN-004 is paid (paid: true).
    expect(summary.byStatus.paid).toBeGreaterThan(0);
  });

  it('populates oldestUnpaidAgeDays from pending/approved transactions (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const summary = await tradedoublerAdapter.getEarningsSummary({
      from: '2024-01-01',
      to: '2026-05-28',
    });
    expect(typeof summary.oldestUnpaidAgeDays).toBe('number');
    // TXN-001 is approved and from 2024 — should be the oldest.
    expect(summary.oldestUnpaidAgeDays).toBeGreaterThan(300);
  });
});

// ---------------------------------------------------------------------------
// listClicks
// ---------------------------------------------------------------------------

describe('TradedoublerAdapter.listClicks', () => {
  it('throws NotImplementedError with a Tradedoubler-specific reason', async () => {
    await expect(tradedoublerAdapter.listClicks({})).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    try {
      await tradedoublerAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain(
        'Tradedoubler does not expose click-level data',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — deterministic URL construction
// ---------------------------------------------------------------------------

describe('TradedoublerAdapter.generateTrackingLink', () => {
  it('constructs clk.tradedoubler.com deep-link with URL-encoded destination', async () => {
    const link = await tradedoublerAdapter.generateTrackingLink({
      programmeId: '1001',
      destinationUrl: 'https://www.atolls-bookshop.example.com/path?q=a b&c=ü',
    });
    expect(link.trackingUrl).toContain('https://clk.tradedoubler.com/click');
    expect(link.trackingUrl).toContain('p=1001');
    expect(link.trackingUrl).toContain('a=1234567'); // orgId from env
    expect(link.trackingUrl).toContain(
      'url=https%3A%2F%2Fwww.atolls-bookshop.example.com%2Fpath%3Fq%3Da%20b%26c%3D%C3%BC',
    );
    expect(link.network).toBe('tradedoubler');
    expect(link.programmeId).toBe('1001');
  });

  it('throws a config_error NetworkError when programmeId is missing', async () => {
    await expect(
      tradedoublerAdapter.generateTrackingLink({
        programmeId: '',
        destinationUrl: 'https://example.com',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('does NOT call fetch (deterministic construction)', async () => {
    const spy = mockFetchQueue([]);
    await tradedoublerAdapter.generateTrackingLink({
      programmeId: '1001',
      destinationUrl: 'https://example.com',
    });
    expect(spy.mock.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('TradedoublerAdapter.verifyAuth (happy path)', () => {
  it('returns ok:true and identity when /users/me responds 200', async () => {
    mockFetchQueue([fakeResponse(loadFixture('me.json'))]);
    const r = await tradedoublerAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('tradedoubler/');
    }
  });

  it('surfaces a NetworkError-derived reason on 401 (§15.4)', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_token"}', {
        status: 401,
        rawBody: '{"error":"invalid_token"}',
      }),
    ]);
    const r = await tradedoublerAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/HTTP 401|401/);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('TradedoublerAdapter.validateCredential', () => {
  it('rejects malformed organisation IDs', async () => {
    const r1 = await tradedoublerAdapter.validateCredential(
      'TRADEDOUBLER_ORGANIZATION_ID',
      'abc',
    );
    expect(r1.ok).toBe(false);
    const r2 = await tradedoublerAdapter.validateCredential(
      'TRADEDOUBLER_ORGANIZATION_ID',
      '-5',
    );
    expect(r2.ok).toBe(false);
    const r3 = await tradedoublerAdapter.validateCredential(
      'TRADEDOUBLER_ORGANIZATION_ID',
      '0',
    );
    expect(r3.ok).toBe(false);
  });

  it('accepts well-formed organisation IDs', async () => {
    const r = await tradedoublerAdapter.validateCredential(
      'TRADEDOUBLER_ORGANIZATION_ID',
      '1234567',
    );
    expect(r.ok).toBe(true);
  });

  it('validates TRADEDOUBLER_API_TOKEN by calling /users/me', async () => {
    mockFetchQueue([fakeResponse(loadFixture('me.json'))]);
    const r = await tradedoublerAdapter.validateCredential(
      'TRADEDOUBLER_API_TOKEN',
      'fresh-test-token',
    );
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with hint when token validation fails', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"bad token"}', {
        status: 401,
        rawBody: '{"error":"bad token"}',
      }),
    ]);
    const r = await tradedoublerAdapter.validateCredential(
      'TRADEDOUBLER_API_TOKEN',
      'bad-token',
    );
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('returns ok:false for an unknown field name', async () => {
    const r = await tradedoublerAdapter.validateCredential('UNKNOWN_FIELD', 'value');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('TradedoublerAdapter.capabilitiesCheck', () => {
  it('records listClicks.supported = false with the known-limitation note', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('programmes.json')), // listProgrammes probe
      fakeResponse(loadFixture('transactions.json')), // listTransactions probe
      fakeResponse(loadFixture('transactions.json')), // getEarningsSummary → listTransactions
      fakeResponse(loadFixture('me.json')), // verifyAuth probe
    ]);
    const caps = await tradedoublerAdapter.capabilitiesCheck();
    expect(caps.network).toBe('tradedoubler');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['listClicks']?.note).toContain('click-level data');
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });

  it('records generateTrackingLink.supported = true (deterministic)', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('programmes.json')),
      fakeResponse(loadFixture('transactions.json')),
      fakeResponse(loadFixture('transactions.json')),
      fakeResponse(loadFixture('me.json')),
    ]);
    const caps = await tradedoublerAdapter.capabilitiesCheck();
    expect(caps.operations['generateTrackingLink']?.supported).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim Tradedoubler response body on a 500', async () => {
    const body = '{"error":"upstream broke","trace":"abc"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await tradedoublerAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('tradedoubler');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream broke');
    }
  });

  it('classifies 401 as auth_error (§15.4)', async () => {
    mockFetchQueue([
      fakeResponse('forbidden', { status: 401, rawBody: 'forbidden' }),
    ]);
    try {
      await tradedoublerAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('auth_error');
    }
  });
});
