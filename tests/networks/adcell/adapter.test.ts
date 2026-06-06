/**
 * Adcell adapter — unit tests.
 *
 * Mirrors the Awin / Everflow test patterns:
 *   - We mock `globalThis.fetch` directly: that is the seam between the adapter
 *     and the network, so mocking it exercises the full client + resilience +
 *     transformer stack with no live HTTP.
 *   - Each test stubs only the responses it needs.
 *   - No live calls. The Adcell API is dashboard-gated and unverified; these
 *     tests pin the adapter's behaviour against reconstructed payload shapes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { adcellAdapter, _internals } from '../../../src/networks/adcell/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'adcell');

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
  process.env['ADCELL_API_TOKEN'] = 'test-key-please-ignore';
  process.env['ADCELL_AFFILIATE_ID'] = '123456';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['ADCELL_API_TOKEN'];
  delete process.env['ADCELL_AFFILIATE_ID'];
});

// ---------------------------------------------------------------------------
// Transformers (status mapping + raw preservation + numeric coercion)
// ---------------------------------------------------------------------------

describe('Adcell transformers', () => {
  it('maps German transaction states to canonical statuses', () => {
    const txns = (loadFixture('transactions.json') as { transactions: Array<Record<string, unknown>> })
      .transactions;
    expect(_internals.toTransaction(txns[0] as never).status).toBe('approved'); // bestätigt
    expect(_internals.toTransaction(txns[1] as never).status).toBe('pending'); // offen
    expect(_internals.toTransaction(txns[2] as never).status).toBe('reversed'); // storniert
    expect(_internals.toTransaction(txns[3] as never).status).toBe('paid'); // ausgezahlt
  });

  it('maps programme states (German + English) to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ status: 'aktiv' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'wartend' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ status: 'abgelehnt' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ status: 'verfügbar' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ status: 'pausiert' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'irgendwas' })).toBe('unknown');
    expect(_internals.mapProgrammeStatus({})).toBe('unknown');
  });

  it('coerces German-formatted decimals on amounts', () => {
    expect(_internals.toNumber('8,40')).toBeCloseTo(8.4);
    expect(_internals.toNumber('120,00')).toBeCloseTo(120);
    expect(_internals.toNumber(5)).toBe(5);
    expect(_internals.toNumber(undefined)).toBe(0);
  });

  it('preserves the raw Adcell payload under rawNetworkData', () => {
    const raw = (loadFixture('transactions.json') as { transactions: Array<Record<string, unknown>> })
      .transactions[0];
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('defaults currency to EUR when omitted', () => {
    const out = _internals.toTransaction({ transactionId: 1, status: 'offen' } as never);
    expect(out.currency).toBe('EUR');
  });

  it('surfaces reversalReason on reversed transactions (§15.10)', () => {
    const raw = (loadFixture('transactions.json') as { transactions: Array<Record<string, unknown>> })
      .transactions[2];
    const out = _internals.toTransaction(raw as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toContain('14 Tagen');
  });

  it('computes ageDays from the confirmation date (preferred)', () => {
    const now = new Date('2026-05-21T00:00:00Z');
    const age = _internals.computeAgeDays({ confirmationDate: '2026-01-01T00:00:00Z' }, now);
    expect(age).toBe(140);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('Adcell.listProgrammes', () => {
  it('reads the wrapped programmes envelope and filters by status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programs.json'))]);
    const joined = await adcellAdapter.listProgrammes({ status: 'joined' });
    expect(joined.length).toBe(1);
    expect(joined[0]?.name).toBe('Atolls Bücher');
    expect(joined[0]?.status).toBe('joined');
  });

  it('filters by search substring client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programs.json'))]);
    const found = await adcellAdapter.listProgrammes({ search: 'reisen' });
    expect(found.length).toBe(1);
    expect(found[0]?.id).toBe('1002');
  });
});

// ---------------------------------------------------------------------------
// listTransactions — unpaid-age + reversed visibility
// ---------------------------------------------------------------------------

describe('Adcell.listTransactions', () => {
  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const aged = await adcellAdapter.listTransactions({
      from: '2026-04-21T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
      minAgeDays: 365,
    });
    for (const t of aged) {
      expect(t.ageDays).toBeGreaterThanOrEqual(365);
    }
    expect(aged.length).toBeGreaterThan(0);
  });

  it('includes reversed transactions with reason populated (§15.10)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const all = await adcellAdapter.listTransactions({
      from: '2026-04-21T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
    });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toContain('zurückgegeben');
  });

  it('chunks date ranges wider than the window cap into multiple calls', async () => {
    const spy = mockFetchQueue([
      fakeResponse({ transactions: [] }),
      fakeResponse({ transactions: [] }),
      fakeResponse({ transactions: [] }),
    ]);
    await adcellAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-09-30T00:00:00Z', // ~272 days → 3 slices at 92-day cap
    });
    expect(spy.mock.calls.length).toBe(3);
  });

  it('emits an error envelope when the API key is missing', async () => {
    delete process.env['ADCELL_API_TOKEN'];
    await expect(adcellAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('Adcell.getEarningsSummary', () => {
  it('aggregates commission by status and programme', async () => {
    // Single ≤92-day slice → exactly one fetch → the fixture is counted once.
    // The mocked fetch returns the full fixture regardless of the date window;
    // Adcell filters by date server-side, so the adapter makes no client-side
    // date cut and a single slice avoids double-counting the fixture rows.
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const summary = await adcellAdapter.getEarningsSummary({
      from: '2026-04-01T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
    });
    expect(summary.network).toBe('adcell');
    expect(summary.currency).toBe('EUR');
    expect(summary.byStatus.approved).toBeCloseTo(8.4);
    expect(summary.byStatus.paid).toBeCloseTo(14);
    expect(summary.byStatus.reversed).toBeCloseTo(4.5);
    // pending + approved transactions contribute to oldestUnpaidAgeDays.
    expect(summary.oldestUnpaidAgeDays).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// listClicks + generateTrackingLink (NotImplemented)
// ---------------------------------------------------------------------------

describe('Adcell unsupported operations', () => {
  it('listClicks throws NotImplementedError with the documented reason', async () => {
    await expect(adcellAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await adcellAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click-level data');
    }
  });

  it('generateTrackingLink throws NotImplementedError', async () => {
    await expect(
      adcellAdapter.generateTrackingLink({ programmeId: '1001', destinationUrl: 'https://x.example.com' }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('Adcell.verifyAuth', () => {
  it('returns ok:true with an identity on a 200', async () => {
    mockFetchQueue([fakeResponse({ programs: [] })]);
    const r = await adcellAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toContain('adcell/publisher/123456');
  });

  it('returns ok:false on a 401', async () => {
    mockFetchQueue([fakeResponse('{"error":"invalid_key"}', { status: 401 })]);
    const r = await adcellAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/401/);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('Adcell.validateCredential', () => {
  it('rejects malformed affiliate IDs', async () => {
    expect((await adcellAdapter.validateCredential('ADCELL_AFFILIATE_ID', 'abc')).ok).toBe(false);
    expect((await adcellAdapter.validateCredential('ADCELL_AFFILIATE_ID', '0')).ok).toBe(false);
  });

  it('accepts well-formed affiliate IDs', async () => {
    expect((await adcellAdapter.validateCredential('ADCELL_AFFILIATE_ID', '123456')).ok).toBe(true);
  });

  it('validates ADCELL_API_TOKEN via the probe call', async () => {
    mockFetchQueue([fakeResponse({ programs: [] })]);
    const r = await adcellAdapter.validateCredential('ADCELL_API_TOKEN', 'fresh-key');
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('Adcell.capabilitiesCheck', () => {
  it('records listClicks and generateTrackingLink as unsupported', async () => {
    mockFetchQueue([
      fakeResponse({ programs: [] }), // listProgrammes
      fakeResponse({ transactions: [] }), // listTransactions probe
      fakeResponse({ transactions: [] }), // getEarningsSummary → listTransactions
      fakeResponse({ programs: [] }), // verifyAuth
    ]);
    const caps = await adcellAdapter.capabilitiesCheck();
    expect(caps.network).toBe('adcell');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('Adcell §15.4 error transparency', () => {
  it('surfaces the verbatim Adcell body on a 500', async () => {
    const body = '{"error":"upstream broke","trace":"abc"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await adcellAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('adcell');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream broke');
    }
  });

  it('classifies 401 as auth_error', async () => {
    mockFetchQueue([fakeResponse('forbidden', { status: 401, rawBody: 'forbidden' })]);
    try {
      await adcellAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('auth_error');
    }
  });
});
