/**
 * Adrecord adapter — unit tests.
 *
 * Mirrors the Awin test patterns (`tests/networks/awin/adapter.test.ts`):
 *   - We mock `globalThis.fetch` directly to exercise the full
 *     client + resilience + transformer stack with no live HTTP.
 *   - Each test stubs only the fetch responses it needs.
 *   - PRD-relevant tests are tagged with `§15.x` where applicable.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { adrecordAdapter, _internals } from '../../../src/networks/adrecord/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'adrecord');

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
  process.env['ADRECORD_API_KEY'] = 'test-key-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['ADRECORD_API_KEY'];
});

// ---------------------------------------------------------------------------
// Transformation (status mapping + raw preservation)
// ---------------------------------------------------------------------------

describe('Adrecord transformers (status normalisation, raw preservation)', () => {
  it('maps Adrecord status strings → canonical statuses', () => {
    const txns = loadFixture('transactions.json') as Array<Record<string, unknown>>;
    const approved = _internals.toTransaction(txns[0] as never);
    const pending = _internals.toTransaction(txns[1] as never);
    const rejected = _internals.toTransaction(txns[2] as never);
    const paid = _internals.toTransaction(txns[3] as never);
    expect(approved.status).toBe('approved');
    expect(pending.status).toBe('pending');
    // 'Rejected' is our 'reversed' — the sale did not pay out.
    expect(rejected.status).toBe('reversed');
    expect(paid.status).toBe('paid');
  });

  it('treats Invoiced as approved and Invoiced Paid as paid', () => {
    expect(_internals.mapTransactionStatus({ status: 'Invoiced' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'Invoiced Paid' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ status: 'something-new' })).toBe('other');
  });

  it('preserves the raw Adrecord response under rawNetworkData', () => {
    const raw = (loadFixture('transactions.json') as Array<Record<string, unknown>>)[0];
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('maps programme status to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ status: 'active' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ status: 'rejected' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ status: 'available' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ status: 'paused' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'never-seen' })).toBe('unknown');
  });

  it('computes ageDays from the conversion date', () => {
    const now = new Date('2026-05-21T00:00:00Z');
    const age = _internals.computeAgeDays({ date: '2026-04-01T00:00:00Z' }, now);
    expect(age).toBe(50);
  });

  it('reads the latest status-change date as the approved anchor', () => {
    const iso = _internals.latestChangeIso({
      changes: [
        { date: '2026-01-01T00:00:00Z' },
        { date: '2026-03-01T00:00:00Z' },
      ],
    });
    expect(iso).toBe(new Date('2026-03-01T00:00:00Z').toISOString());
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('Adrecord.listProgrammes', () => {
  it('returns transformed programmes from a bare array response', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programs.json'))]);
    const programmes = await adrecordAdapter.listProgrammes();
    expect(programmes.length).toBe(3);
    expect(programmes[0]?.network).toBe('adrecord');
    expect(programmes[0]?.status).toBe('joined');
  });

  it('filters by search substring client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programs.json'))]);
    const programmes = await adrecordAdapter.listProgrammes({ search: 'travel' });
    expect(programmes.length).toBe(1);
    expect(programmes[0]?.name).toBe('Helsinki Travel');
  });

  it('accepts a wrapped { programs: [...] } response', async () => {
    mockFetchQueue([fakeResponse({ programs: loadFixture('programs.json') })]);
    const programmes = await adrecordAdapter.listProgrammes();
    expect(programmes.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// getProgramme
// ---------------------------------------------------------------------------

describe('Adrecord.getProgramme', () => {
  it('selects the matching programme by id', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programs.json'))]);
    const programme = await adrecordAdapter.getProgramme('1002');
    expect(programme.id).toBe('1002');
    expect(programme.name).toBe('Fjäll Outdoor');
  });

  it('throws a config_error for a non-numeric id', async () => {
    await expect(adrecordAdapter.getProgramme('abc')).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a network_api_error when the id is not present', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programs.json'))]);
    await expect(adrecordAdapter.getProgramme('9999')).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('Adrecord.listTransactions', () => {
  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const aged = await adrecordAdapter.listTransactions({
      from: '2026-05-01T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
      minAgeDays: 100,
    });
    for (const t of aged) {
      expect(t.ageDays).toBeGreaterThanOrEqual(100);
    }
  });

  it('filters by status when caller passes status[]', async () => {
    // A single 30-day window makes exactly one upstream call; the fixture is
    // returned regardless of date and the status filter is what we test.
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const only = await adrecordAdapter.listTransactions({
      from: '2026-04-21T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('chunks date ranges wider than 31 days into multiple calls', async () => {
    const spy = mockFetchQueue([fakeResponse([]), fakeResponse([]), fakeResponse([])]);
    await adrecordAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-03-31T00:00:00Z',
    });
    expect(spy.mock.calls.length).toBe(3);
  });

  it('emits an error envelope when the API key is missing', async () => {
    delete process.env['ADRECORD_API_KEY'];
    await expect(adrecordAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('Adrecord.getEarningsSummary', () => {
  it('aggregates commission by status and programme', async () => {
    // Single 30-day window → one upstream call, so the fixture is the whole set.
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const summary = await adrecordAdapter.getEarningsSummary({
      from: '2026-04-21T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
    });
    // 10 + 25 + 50 + 80 = 165 total commission.
    expect(summary.totalEarnings).toBe(165);
    expect(summary.byStatus.approved).toBe(10);
    expect(summary.byStatus.pending).toBe(25);
    expect(summary.byStatus.reversed).toBe(50);
    expect(summary.byStatus.paid).toBe(80);
    expect(summary.currency).toBe('SEK');
    expect(summary.byProgramme.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// listClicks + generateTrackingLink (both unsupported)
// ---------------------------------------------------------------------------

describe('Adrecord unsupported operations', () => {
  it('listClicks throws NotImplementedError with the documented reason', async () => {
    await expect(adrecordAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await adrecordAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click-level data');
    }
  });

  it('generateTrackingLink throws NotImplementedError with the documented reason', async () => {
    await expect(
      adrecordAdapter.generateTrackingLink({
        programmeId: '1001',
        destinationUrl: 'https://x.example.se',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await adrecordAdapter.generateTrackingLink({
        programmeId: '1001',
        destinationUrl: 'https://x.example.se',
      });
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('tracking-link');
    }
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('Adrecord.verifyAuth', () => {
  it('returns ok:true when /programs responds 200', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programs.json'))]);
    const r = await adrecordAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toContain('adrecord');
  });

  it('returns ok:false on 401', async () => {
    mockFetchQueue([fakeResponse('{"error":"invalid_key"}', { status: 401 })]);
    const r = await adrecordAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/HTTP 401|401/);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('Adrecord.validateCredential', () => {
  it('validates ADRECORD_API_KEY by calling /programs', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programs.json'))]);
    const r = await adrecordAdapter.validateCredential('ADRECORD_API_KEY', 'fresh-key');
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with a hint when the key is rejected', async () => {
    mockFetchQueue([fakeResponse('{"error":"bad"}', { status: 401 })]);
    const r = await adrecordAdapter.validateCredential('ADRECORD_API_KEY', 'bad-key');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('rejects an unknown credential field', async () => {
    const r = await adrecordAdapter.validateCredential('NOPE', 'x');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('Adrecord.capabilitiesCheck', () => {
  it('records listClicks + generateTrackingLink as unsupported without probing', async () => {
    mockFetchQueue([
      fakeResponse([]), // listProgrammes
      fakeResponse([]), // listTransactions probe
      fakeResponse([]), // getEarningsSummary → listTransactions
      fakeResponse(loadFixture('programs.json')), // verifyAuth
    ]);
    const caps = await adrecordAdapter.capabilitiesCheck();
    expect(caps.network).toBe('adrecord');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim Adrecord response body on a 500', async () => {
    const body = '{"error":"upstream broke","trace":"abc"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await adrecordAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('adrecord');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream broke');
    }
  });

  it('classifies 401 as auth_error', async () => {
    mockFetchQueue([fakeResponse('forbidden', { status: 401, rawBody: 'forbidden' })]);
    try {
      await adrecordAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('auth_error');
    }
  });
});
