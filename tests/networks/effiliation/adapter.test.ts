/**
 * Effiliation publisher adapter — unit tests.
 *
 * Pattern matched to `tests/networks/everflow/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 *   - Fixtures live under `tests/fixtures/effiliation/` and approximate the
 *     shape of real Effiliation API responses. No real keys, no real data.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { effiliationAdapter, _internals } from '../../../src/networks/effiliation/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'effiliation');

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
  process.env['EFFILIATION_API_KEY'] = 'test-api-key-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['EFFILIATION_API_KEY'];
});

// ---------------------------------------------------------------------------
// Transformers (status mapping, dates, amounts, raw preservation)
// ---------------------------------------------------------------------------

describe('Effiliation transformers', () => {
  it('maps programme statuses (FR + EN) to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ statut: 'valide' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ statut: 'validee' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'active' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ statut: 'en attente' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ statut: 'refuse' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ statut: 'suspendu' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ statut: 'ferme' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ statut: 'quelque-chose' })).toBe('unknown');
    expect(_internals.mapProgrammeStatus({})).toBe('unknown');
  });

  it('maps transaction statuses (FR + EN) to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ etat: 'valide' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ etat: 'confirme' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ etat: 'en attente' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ etat: 'refuse' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ etat: 'annule' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ etat: 'paye' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ etat: 'payee' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ etat: 'autre-chose' })).toBe('other');
    expect(_internals.mapTransactionStatus({})).toBe('other');
  });

  it('parses DD/MM/YYYY dates correctly', () => {
    const ms = _internals.parseEffiliationDate('15/01/2026 10:00:00');
    expect(new Date(ms as number).toISOString()).toBe('2026-01-15T10:00:00.000Z');
    const dateOnly = _internals.parseEffiliationDate('02/02/2026');
    expect(new Date(dateOnly as number).toISOString()).toBe('2026-02-02T00:00:00.000Z');
    // ISO fallback still parses.
    expect(_internals.parseEffiliationDate('2026-01-15T10:00:00Z')).toBe(
      Date.parse('2026-01-15T10:00:00Z'),
    );
    expect(_internals.parseEffiliationDate(undefined)).toBeUndefined();
  });

  it('formats a Date back to DD/MM/YYYY for the query params', () => {
    expect(_internals.formatEffiliationDate(new Date('2026-01-15T10:00:00Z'))).toBe('15/01/2026');
  });

  it('coerces FR comma-decimal amounts to numbers', () => {
    expect(_internals.toNumber('12,50')).toBe(12.5);
    expect(_internals.toNumber('120.00')).toBe(120);
    expect(_internals.toNumber(6)).toBe(6);
    expect(_internals.toNumber(undefined)).toBe(0);
  });

  it('computes ageDays anchored on the validation date (§15.9)', () => {
    const now = new Date('2026-05-28T12:00:00Z');
    const age = _internals.computeAgeDays(
      { date_validation: '15/01/2026 10:00:00', date_transaction: '15/01/2026 10:00:00' } as never,
      now,
    );
    // 15 Jan 10:00 → 28 May 12:00 = 133 days.
    expect(age).toBe(133);
  });

  it('treats amounts as decimal major units and defaults currency to EUR', () => {
    const tx = _internals.toTransaction({
      id_transaction: 'TX-x',
      etat: 'valide',
      montant: '120.00',
      commission: '6.00',
      date_transaction: '15/01/2026 10:00:00',
    } as never);
    expect(tx.amount).toBe(120);
    expect(tx.commission).toBe(6);
    expect(tx.currency).toBe('EUR');
  });

  it('preserves the raw payload under rawNetworkData', () => {
    const raw = { id_transaction: 'TX-raw', etat: 'valide' };
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
    const prog = { id: 5001, nom: 'X', statut: 'valide' };
    expect(_internals.toProgramme(prog as never).rawNetworkData).toBe(prog);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('Effiliation.listProgrammes', () => {
  it('maps programme statuses from the fixture', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programmes.json'))]);
    const programmes = await effiliationAdapter.listProgrammes();
    expect(programmes.length).toBe(3);
    expect(programmes.find((p) => p.id === '5001')?.status).toBe('joined');
    expect(programmes.find((p) => p.id === '5002')?.status).toBe('pending');
    expect(programmes.find((p) => p.id === '5003')?.status).toBe('declined');
  });

  it('filters by status client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programmes.json'))]);
    const only = await effiliationAdapter.listProgrammes({ status: 'joined' });
    expect(only.every((p) => p.status === 'joined')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('applies a search filter client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programmes.json'))]);
    const results = await effiliationAdapter.listProgrammes({ search: 'travel' });
    expect(results.length).toBe(1);
    expect(results[0]?.name).toBe('Atolls Travel');
  });

  it('throws a NetworkError when the API key is missing (§15.4)', async () => {
    delete process.env['EFFILIATION_API_KEY'];
    await expect(effiliationAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });

  it('sends the API key as the `key` query parameter', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('programmes.json'))]);
    await effiliationAdapter.listProgrammes();
    const calledUrl = String(spy.mock.calls[0]?.[0]);
    expect(calledUrl).toContain('key=test-api-key-please-ignore');
    expect(calledUrl).toContain('/apiv2/programs.json');
  });
});

// ---------------------------------------------------------------------------
// getProgramme
// ---------------------------------------------------------------------------

describe('Effiliation.getProgramme', () => {
  it('selects a single programme by id', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programmes.json'))]);
    const prog = await effiliationAdapter.getProgramme('5001');
    expect(prog.id).toBe('5001');
    expect(prog.name).toBe('Atolls Bookshop');
  });

  it('throws a config_error envelope for an empty id', async () => {
    await expect(effiliationAdapter.getProgramme('')).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a network_api_error envelope for an unknown id', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programmes.json'))]);
    await expect(effiliationAdapter.getProgramme('999999')).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('Effiliation.listTransactions', () => {
  it('returns transactions with status normalisation and raw preservation', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const txns = await effiliationAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
    });
    expect(txns.length).toBe(3);
    expect(txns.find((t) => t.id === 'TX-1001')?.status).toBe('approved');
    expect(txns.find((t) => t.id === 'TX-1002')?.status).toBe('pending');
    expect(txns.every((t) => t.rawNetworkData !== undefined)).toBe(true);
  });

  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const aged = await effiliationAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
      minAgeDays: 50,
    });
    expect(aged.length).toBeGreaterThan(0);
    for (const t of aged) {
      expect(t.ageDays).toBeGreaterThanOrEqual(50);
    }
  });

  it('includes reversed transactions with the reason populated (§15.10)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const all = await effiliationAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
    });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toContain('annulee');
  });

  it('filters by status when caller passes status[]', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const only = await effiliationAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('sends DD/MM/YYYY start/end and type=date query params', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    await effiliationAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-31T00:00:00Z',
    });
    const url = String(spy.mock.calls[0]?.[0]);
    expect(url).toContain('start=01%2F01%2F2026');
    expect(url).toContain('end=31%2F01%2F2026');
    expect(url).toContain('type=date');
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('Effiliation.getEarningsSummary', () => {
  it('derives the summary from listTransactions', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const summary = await effiliationAdapter.getEarningsSummary({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
    });
    expect(summary.network).toBe('effiliation');
    expect(summary.currency).toBe('EUR');
    // 6.00 (approved) + 8.00 (pending) + 0.00 (reversed) = 14.00
    expect(summary.totalEarnings).toBeCloseTo(14.0, 2);
    expect(summary.byStatus.approved).toBeCloseTo(6.0, 2);
    expect(summary.byStatus.pending).toBeCloseTo(8.0, 2);
    expect(summary.byProgramme.length).toBeGreaterThan(0);
  });

  it('computes oldestUnpaidAgeDays from pending/approved transactions (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const summary = await effiliationAdapter.getEarningsSummary({
      from: '2026-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
    });
    // The Jan approved transaction is the oldest unpaid; well over 30 days old.
    expect(summary.oldestUnpaidAgeDays).toBeGreaterThan(30);
  });
});

// ---------------------------------------------------------------------------
// listClicks + generateTrackingLink — unsupported
// ---------------------------------------------------------------------------

describe('Effiliation unsupported operations', () => {
  it('listClicks throws NotImplementedError', async () => {
    await expect(effiliationAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('generateTrackingLink throws NotImplementedError', async () => {
    await expect(
      effiliationAdapter.generateTrackingLink({
        programmeId: '5001',
        destinationUrl: 'https://www.atolls-bookshop.example.com/products',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('Effiliation.verifyAuth', () => {
  it('returns ok:true with an identity when programs.json responds 200', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programmes.json'))]);
    const r = await effiliationAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toContain('effiliation');
  });

  it('surfaces a failure on 401 (§15.4)', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_key"}', {
        status: 401,
        rawBody: '{"error":"invalid_key"}',
      }),
    ]);
    const r = await effiliationAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/HTTP 401|401/);
  });
});

// ---------------------------------------------------------------------------
// admin ops
// ---------------------------------------------------------------------------

describe('Effiliation admin operations (not implemented at v0.1)', () => {
  it('listPublishers throws NotImplementedError', async () => {
    await expect(effiliationAdapter.listPublishers()).rejects.toBeInstanceOf(NotImplementedError);
  });
  it('listPublisherSectors throws NotImplementedError', async () => {
    await expect(effiliationAdapter.listPublisherSectors()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim Effiliation response body on a 500', async () => {
    const body = '{"error":"upstream_error","trace":"efg123"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await effiliationAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('effiliation');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream_error');
    }
  });

  it('classifies 401 as auth_error (§15.4)', async () => {
    mockFetchQueue([fakeResponse('Forbidden', { status: 401, rawBody: 'Forbidden' })]);
    try {
      await effiliationAdapter.listProgrammes();
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

describe('Effiliation.capabilitiesCheck', () => {
  it('reports operations and marks click/link as unsupported', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('programmes.json')), // listProgrammes
      fakeResponse(loadFixture('transactions.json')), // listTransactions
      fakeResponse(loadFixture('transactions.json')), // getEarningsSummary → listTransactions
      fakeResponse(loadFixture('programmes.json')), // verifyAuth
    ]);
    const caps = await effiliationAdapter.capabilitiesCheck();
    expect(caps.network).toBe('effiliation');
    expect(caps.operations['listProgrammes']?.supported).toBe(true);
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
