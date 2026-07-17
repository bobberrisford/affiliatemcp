/**
 * Monetizze adapter — unit tests.
 *
 * Pattern-matched to `tests/networks/skimlinks/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - Circuit breakers are reset in `beforeEach` so no test bleeds state.
 *   - Fake credentials are injected via `process.env` (obvious non-secret values).
 *   - Fixtures live under `tests/fixtures/monetizze/`.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { monetizzeAdapter, _internals } from '../../../src/networks/monetizze/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';
import { _resetTokenCache } from '../../../src/networks/monetizze/auth.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'monetizze');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(
  body: unknown,
  init: { status?: number; rawBody?: string } = {},
): Response {
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

/**
 * Helper: mock a token exchange (first fetch) followed by the given data
 * response. Most adapter ops require a token first, then the data call.
 */
function mockWithToken(dataResponse: Response): ReturnType<typeof vi.fn> {
  return mockFetchQueue([fakeResponse(loadFixture('token.json')), dataResponse]);
}

beforeEach(() => {
  _resetBreakers();
  _resetTokenCache();
  process.env['MONETIZZE_API_KEY'] = 'test-api-key-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['MONETIZZE_API_KEY'];
  _resetTokenCache();
});

// ---------------------------------------------------------------------------
// Transformer unit tests (status normalisation + raw preservation)
// ---------------------------------------------------------------------------

describe('Monetizze transformers (status normalisation, raw preservation)', () => {
  it('maps numeric Monetizze status codes to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ codigo_status: 1 })).toBe('pending');
    expect(_internals.mapTransactionStatus({ codigo_status: 2 })).toBe('approved');
    expect(_internals.mapTransactionStatus({ codigo_status: 3 })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ codigo_status: 4 })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ codigo_status: 5 })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ codigo_status: 6 })).toBe('paid');
    expect(_internals.mapTransactionStatus({ codigo_status: 7 })).toBe('other');
    expect(_internals.mapTransactionStatus({ codigo_status: 99 })).toBe('other');
  });

  it('falls back to the textual status when no numeric code is present', () => {
    expect(_internals.mapTransactionStatus({ status: 'Finalizada' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'Cancelada' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'Completa' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ status: 'Aguardando pagamento' })).toBe('pending');
    expect(_internals.mapTransactionStatus({})).toBe('other');
  });

  it('maps Monetizze programme statuses to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ status: 'ativo' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'pendente' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ status: 'recusado' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ status: 'disponivel' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ status: 'suspenso' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'algo-novo' })).toBe('unknown');
    expect(_internals.mapProgrammeStatus({})).toBe('unknown');
  });

  it('preserves raw Monetizze payload in rawNetworkData', () => {
    const sales = (loadFixture('transactions.json') as { vendas: unknown[] }).vendas;
    const raw = sales[0] as Record<string, unknown>;
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('sums commission from the comissoes[] array', () => {
    const sales = (loadFixture('transactions.json') as { vendas: unknown[] }).vendas;
    const raw = sales[1] as Record<string, unknown>;
    const out = _internals.toTransaction(raw as never);
    expect(out.commission).toBeCloseTo(12.75, 2);
    expect(out.programmeId).toBe('3001');
    expect(out.programmeName).toBe('Curso de Marketing Digital');
    expect(out.currency).toBe('BRL');
  });

  it('parses the Monetizze "yyyy-mm-dd H:i:s" date format as UTC', () => {
    const ts = _internals.parseMonetizzeDate('2024-01-20 12:00:00');
    expect(ts).toBe(Date.parse('2024-01-20T12:00:00Z'));
    expect(_internals.parseMonetizzeDate('2026-04-01T10:15:00-04:00')).toBe(
      Date.parse('2026-04-01T10:15:00-04:00'),
    );
    expect(_internals.parseMonetizzeDate(undefined)).toBeUndefined();
    expect(_internals.parseMonetizzeDate('not-a-date')).toBeUndefined();
  });

  it('computes ageDays from dataFinalizada (preferred), then dataInicio', () => {
    const now = new Date('2024-01-28T12:00:00Z');
    // dataFinalizada = 2024-01-20 → 8 days
    const age1 = _internals.computeAgeDays(
      { dataFinalizada: '2024-01-20 12:00:00', dataInicio: '2024-01-01 00:00:00' },
      now,
    );
    expect(age1).toBe(8);
    // No dataFinalizada → falls back to dataInicio = 2024-01-08 → 20 days
    const age2 = _internals.computeAgeDays({ dataInicio: '2024-01-08 12:00:00' }, now);
    expect(age2).toBe(20);
  });

  it('normalises string and number amounts, tolerating comma decimals', () => {
    expect(_internals.toAmount(5.5)).toBe(5.5);
    expect(_internals.toAmount('12.75')).toBe(12.75);
    expect(_internals.toAmount('3,20')).toBeCloseTo(3.2, 2);
    expect(_internals.toAmount(undefined)).toBe(0);
    expect(_internals.toAmount('not-a-number')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// listTransactions — filters, unpaid-age + reversed visibility (§15.9, §15.10)
// ---------------------------------------------------------------------------

describe('MonetizzeAdapter.listTransactions', () => {
  const WIDE = { from: '2024-01-01T00:00:00Z', to: '2026-06-04T00:00:00Z' } as const;

  it('normalises all sales from the fixture', async () => {
    mockWithToken(fakeResponse(loadFixture('transactions.json')));
    const all = await monetizzeAdapter.listTransactions({ ...WIDE });
    expect(all.length).toBe(4);
    expect(all.every((t) => t.network === 'monetizze')).toBe(true);
  });

  it('includes reversed transactions (§15.10)', async () => {
    mockWithToken(fakeResponse(loadFixture('transactions.json')));
    const all = await monetizzeAdapter.listTransactions({ ...WIDE });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.id).toBe('CCC3333');
  });

  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockWithToken(fakeResponse(loadFixture('transactions.json')));
    const aged = await monetizzeAdapter.listTransactions({ ...WIDE, minAgeDays: 365 });
    for (const t of aged) {
      expect(t.ageDays).toBeGreaterThanOrEqual(365);
    }
    expect(aged.length).toBeGreaterThan(0);
  });

  it('filters by status when caller passes status[]', async () => {
    mockWithToken(fakeResponse(loadFixture('transactions.json')));
    const only = await monetizzeAdapter.listTransactions({ ...WIDE, status: ['paid'] });
    expect(only.every((t) => t.status === 'paid')).toBe(true);
    expect(only.length).toBe(1);
    expect(only[0]?.id).toBe('DDD4444');
  });

  it('filters by programmeId (product code)', async () => {
    mockWithToken(fakeResponse(loadFixture('transactions.json')));
    const only = await monetizzeAdapter.listTransactions({ ...WIDE, programmeId: '3002' });
    expect(only.every((t) => t.programmeId === '3002')).toBe(true);
    expect(only.length).toBe(2);
  });

  it('respects limit after all other filters are applied', async () => {
    mockWithToken(fakeResponse(loadFixture('transactions.json')));
    const limited = await monetizzeAdapter.listTransactions({ ...WIDE, limit: 2 });
    expect(limited.length).toBe(2);
  });

  it('emits a NetworkError when MONETIZZE_API_KEY is missing', async () => {
    delete process.env['MONETIZZE_API_KEY'];
    await expect(monetizzeAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes / getProgramme — unconfirmed endpoint, must throw
// ---------------------------------------------------------------------------

describe('MonetizzeAdapter.listProgrammes / getProgramme', () => {
  it('listProgrammes throws NotImplementedError', async () => {
    await expect(monetizzeAdapter.listProgrammes()).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await monetizzeAdapter.listProgrammes();
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('product');
    }
  });

  it('getProgramme throws NotImplementedError', async () => {
    await expect(monetizzeAdapter.getProgramme('3001')).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// listClicks / generateTrackingLink — not exposed by the API
// ---------------------------------------------------------------------------

describe('MonetizzeAdapter.listClicks', () => {
  it('throws NotImplementedError with a Monetizze-specific reason', async () => {
    await expect(monetizzeAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await monetizzeAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click-level data');
    }
  });
});

describe('MonetizzeAdapter.generateTrackingLink', () => {
  it('throws NotImplementedError because links are panel-generated', async () => {
    await expect(
      monetizzeAdapter.generateTrackingLink({
        programmeId: '3001',
        destinationUrl: 'https://example.test/',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await monetizzeAdapter.generateTrackingLink({
        programmeId: '3001',
        destinationUrl: 'https://example.test/',
      });
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('panel');
    }
  });
});

// ---------------------------------------------------------------------------
// verifyAuth — happy + failure paths
// ---------------------------------------------------------------------------

describe('MonetizzeAdapter.verifyAuth', () => {
  it('returns ok:true and identity when token exchange succeeds', async () => {
    mockFetchQueue([fakeResponse(loadFixture('token.json'))]);
    const r = await monetizzeAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('monetizze');
    }
  });

  it('surfaces failure (does not throw) on 403 from token endpoint (§15.4)', async () => {
    mockFetchQueue([
      fakeResponse('Credenciais de API não fornecidas', {
        status: 403,
        rawBody: 'Credenciais de API não fornecidas',
      }),
    ]);
    const r = await monetizzeAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/403|Credenciais|auth/i);
    }
  });

  it('returns ok:false (does not throw) when the API key is missing', async () => {
    delete process.env['MONETIZZE_API_KEY'];
    await expect(monetizzeAdapter.verifyAuth()).resolves.toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('MonetizzeAdapter.validateCredential', () => {
  it('validates MONETIZZE_API_KEY via a live token exchange', async () => {
    mockFetchQueue([fakeResponse(loadFixture('token.json'))]);
    const r = await monetizzeAdapter.validateCredential('MONETIZZE_API_KEY', 'a-key-please-ignore');
    expect(r.ok).toBe(true);
  });

  it('rejects an empty MONETIZZE_API_KEY without an API call', async () => {
    const r = await monetizzeAdapter.validateCredential('MONETIZZE_API_KEY', '');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('returns ok:false with hint when the key is wrong', async () => {
    mockFetchQueue([
      fakeResponse('Credenciais de API não fornecidas', {
        status: 403,
        rawBody: 'Credenciais de API não fornecidas',
      }),
    ]);
    const r = await monetizzeAdapter.validateCredential('MONETIZZE_API_KEY', 'bad-key');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('returns ok:false for unknown credential fields', async () => {
    const r = await monetizzeAdapter.validateCredential('MONETIZZE_UNKNOWN_FIELD', 'value');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary — derived from listTransactions
// ---------------------------------------------------------------------------

describe('MonetizzeAdapter.getEarningsSummary', () => {
  it('aggregates commissions correctly from fixture data', async () => {
    mockWithToken(fakeResponse(loadFixture('transactions.json')));
    const summary = await monetizzeAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    expect(summary.network).toBe('monetizze');
    expect(summary.currency).toBe('BRL');
    expect(summary.totalEarnings).toBeCloseTo(5.5 + 12.75 + 3.2 + 8.0, 2);
    expect(summary.byStatus.pending).toBeCloseTo(5.5, 2);
    expect(summary.byStatus.approved).toBeCloseTo(12.75, 2);
    expect(summary.byStatus.reversed).toBeCloseTo(3.2, 2);
    expect(summary.byStatus.paid).toBeCloseTo(8.0, 2);
    expect(summary.byProgramme.length).toBe(2);
  });

  it('sets oldestUnpaidAgeDays from the longest-pending/approved transaction (§15.9)', async () => {
    mockWithToken(fakeResponse(loadFixture('transactions.json')));
    const summary = await monetizzeAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    // BBB2222 was finalised on 2024-01-20 and is 'approved' (unpaid) — the oldest.
    expect(summary.oldestUnpaidAgeDays).toBeDefined();
    expect(summary.oldestUnpaidAgeDays ?? 0).toBeGreaterThan(365);
  });

  it('returns an empty summary when no sales match the window', async () => {
    mockWithToken(fakeResponse(loadFixture('transactions_empty.json')));
    const summary = await monetizzeAdapter.getEarningsSummary({});
    expect(summary.totalEarnings).toBe(0);
    expect(summary.byProgramme).toHaveLength(0);
    expect(summary.oldestUnpaidAgeDays).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces verbatim response body on a 500', async () => {
    const body = '{"error":"upstream exploded","trace":"xyz"}';
    mockFetchQueue([
      fakeResponse(loadFixture('token.json')),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await monetizzeAdapter.listTransactions({});
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('monetizze');
      expect(env.operation).toBe('listTransactions');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream exploded');
    }
  });

  it('classifies 403 on the data API as auth_error', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('token.json')),
      fakeResponse('Forbidden', { status: 403, rawBody: 'Forbidden' }),
    ]);
    try {
      await monetizzeAdapter.listTransactions({});
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

describe('MonetizzeAdapter.capabilitiesCheck', () => {
  it('records the unsupported ops and probes the supported ones', async () => {
    // capabilitiesCheck probes: verifyAuth (token), listTransactions (token+data),
    // getEarningsSummary (token+data).
    mockFetchQueue([
      fakeResponse(loadFixture('token.json')), // verifyAuth token
      fakeResponse(loadFixture('token.json')), // listTransactions token
      fakeResponse(loadFixture('transactions_empty.json')), // listTransactions data
      fakeResponse(loadFixture('token.json')), // getEarningsSummary → listTransactions token
      fakeResponse(loadFixture('transactions_empty.json')), // getEarningsSummary data
    ]);
    const caps = await monetizzeAdapter.capabilitiesCheck();
    expect(caps.network).toBe('monetizze');
    expect(caps.operations['listProgrammes']?.supported).toBe(false);
    expect(caps.operations['getProgramme']?.supported).toBe(false);
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
    expect(caps.operations['verifyAuth']?.supported).toBe(true);
    expect(caps.operations['listTransactions']?.supported).toBe(true);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
