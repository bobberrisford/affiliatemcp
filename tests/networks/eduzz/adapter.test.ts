/**
 * Eduzz adapter — unit tests.
 *
 * Pattern-matched to `tests/networks/skimlinks/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - Circuit breakers are reset in `beforeEach` so no test bleeds state.
 *   - Fake credentials are injected via `process.env` (obvious non-secret values).
 *   - Fixtures live under `tests/fixtures/eduzz/`.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 *   - Deterministic: every age/earnings assertion injects a fixed `now`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { eduzzAdapter, _internals } from '../../../src/networks/eduzz/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';
import { _resetTokenCache } from '../../../src/networks/eduzz/auth.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'eduzz');

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

/** Mock a token exchange (first fetch) followed by the given data response. */
function mockWithToken(dataResponse: Response): ReturnType<typeof vi.fn> {
  return mockFetchQueue([fakeResponse(loadFixture('token.json')), dataResponse]);
}

beforeEach(() => {
  _resetBreakers();
  _resetTokenCache();
  process.env['EDUZZ_EMAIL'] = 'tester@example.com';
  process.env['EDUZZ_PUBLIC_KEY'] = 'test-public-key-please-ignore';
  process.env['EDUZZ_API_KEY'] = 'test-api-key-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['EDUZZ_EMAIL'];
  delete process.env['EDUZZ_PUBLIC_KEY'];
  delete process.env['EDUZZ_API_KEY'];
  _resetTokenCache();
});

// ---------------------------------------------------------------------------
// Transformer unit tests (status normalisation + raw preservation)
// ---------------------------------------------------------------------------

describe('Eduzz transformers (status normalisation, raw preservation)', () => {
  it('maps Eduzz string sale statuses to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ sale_status: 'open' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ sale_status: 'waitingPayment' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ sale_status: 'analysing' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ sale_status: 'paid' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ sale_status: 'canceled' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ sale_status: 'refunded' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ sale_status: 'chargeback' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ sale_status: 'something-new' })).toBe('other');
    expect(_internals.mapTransactionStatus({})).toBe('other');
  });

  it('maps Eduzz legacy numeric sale statuses to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ sale_status: 1 })).toBe('pending');
    expect(_internals.mapTransactionStatus({ sale_status: 15 })).toBe('pending');
    expect(_internals.mapTransactionStatus({ sale_status: 3 })).toBe('paid');
    expect(_internals.mapTransactionStatus({ sale_status: 4 })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ sale_status: 7 })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ sale_status: '3' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ sale_status: 99 })).toBe('other');
  });

  it('maps Eduzz product statuses to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ status: 'active' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ status: 1 })).toBe('available');
    expect(_internals.mapProgrammeStatus({ status: 'paused' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 0 })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'weird' })).toBe('unknown');
    expect(_internals.mapProgrammeStatus({})).toBe('unknown');
  });

  it('preserves raw Eduzz sale payload in rawNetworkData', () => {
    const sales = (loadFixture('sales.json') as { data: unknown[] }).data;
    const raw = sales[0] as Record<string, unknown>;
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('reads aliased legacy field names defensively', () => {
    const out = _internals.toTransaction({
      trans_cod: '555',
      product_cod: '777',
      product_name: 'Legacy Product',
      trans_status: 3,
      trans_value: '100.00',
      aff_value: '30.00',
      trans_currency: 'brl',
      trans_createdate: '2025-01-01T00:00:00Z',
      trans_paiddate: '2025-01-02T00:00:00Z',
    });
    expect(out.id).toBe('555');
    expect(out.programmeId).toBe('777');
    expect(out.programmeName).toBe('Legacy Product');
    expect(out.status).toBe('paid');
    expect(out.amount).toBe(100);
    expect(out.commission).toBe(30);
    expect(out.currency).toBe('BRL');
  });

  it('surfaces reversalReason on reversed transactions (§15.10)', () => {
    const sales = (loadFixture('sales.json') as { data: unknown[] }).data;
    // sale 90003 (index 2) is canceled with a reason.
    const canceled = sales[2] as Record<string, unknown>;
    const out = _internals.toTransaction(canceled as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Reembolso solicitado pelo cliente');
  });

  it('computes ageDays from date_payment (preferred), then date_create', () => {
    const now = new Date('2026-06-04T00:00:00Z');
    // date_payment = 2026-05-25 → 10 days
    const age1 = _internals.computeAgeDays(
      { date_payment: '2026-05-25T00:00:00Z', date_create: '2026-05-01T00:00:00Z' },
      now,
    );
    expect(age1).toBe(10);
    // no payment date → falls back to date_create = 2026-05-20 → 15 days
    const age2 = _internals.computeAgeDays({ date_create: '2026-05-20T00:00:00Z' }, now);
    expect(age2).toBe(15);
    // no anchors → 0
    expect(_internals.computeAgeDays({}, now)).toBe(0);
  });

  it('normalises string and number amounts', () => {
    expect(_internals.toAmount(5.5)).toBe(5.5);
    expect(_internals.toAmount('12.75')).toBe(12.75);
    expect(_internals.toAmount(undefined)).toBe(0);
    expect(_internals.toAmount('not-a-number')).toBe(0);
  });

  it('unwraps the { profile, data } envelope', () => {
    expect(_internals.unwrapList({ profile: {}, data: [{ a: 1 }] })).toHaveLength(1);
    expect(_internals.unwrapList([{ a: 1 }, { a: 2 }])).toHaveLength(2);
    expect(_internals.unwrapList({ profile: {}, data: { a: 1 } })).toHaveLength(1);
    expect(_internals.unwrapList(undefined)).toHaveLength(0);
    expect(_internals.unwrapList({ profile: {} })).toHaveLength(0);
  });

  it('maps a product to a Programme with currency, commission and category', () => {
    const products = (loadFixture('products.json') as { data: unknown[] }).data;
    const prog = _internals.toProgramme(products[0] as never);
    expect(prog.id).toBe('3001');
    expect(prog.name).toBe('Curso de Marketing Digital');
    expect(prog.network).toBe('eduzz');
    expect(prog.status).toBe('available');
    expect(prog.currency).toBe('BRL');
    expect(prog.commissionRate).toBe('30%');
    expect(prog.categories).toEqual(['Marketing']);
    expect(prog.advertiserUrl).toBe('https://sun.eduzz.com/3001');
  });
});

// ---------------------------------------------------------------------------
// listProgrammes / getProgramme — products
// ---------------------------------------------------------------------------

describe('EduzzAdapter.listProgrammes', () => {
  it('lists products as programmes', async () => {
    mockWithToken(fakeResponse(loadFixture('products.json')));
    const programmes = await eduzzAdapter.listProgrammes();
    expect(programmes.length).toBe(3);
    expect(programmes[0]?.network).toBe('eduzz');
  });

  it('filters by status client-side', async () => {
    mockWithToken(fakeResponse(loadFixture('products.json')));
    const suspended = await eduzzAdapter.listProgrammes({ status: 'suspended' });
    expect(suspended.length).toBe(1);
    expect(suspended[0]?.id).toBe('3003');
  });

  it('filters by search term (case-insensitive)', async () => {
    mockWithToken(fakeResponse(loadFixture('products.json')));
    const found = await eduzzAdapter.listProgrammes({ search: 'ebook' });
    expect(found.length).toBe(1);
    expect(found[0]?.id).toBe('3002');
  });

  it('respects limit', async () => {
    mockWithToken(fakeResponse(loadFixture('products.json')));
    const limited = await eduzzAdapter.listProgrammes({ limit: 2 });
    expect(limited.length).toBe(2);
  });

  it('emits a NetworkError when EDUZZ_EMAIL is missing', async () => {
    delete process.env['EDUZZ_EMAIL'];
    await expect(eduzzAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('EduzzAdapter.getProgramme', () => {
  it('returns the matching product', async () => {
    mockWithToken(fakeResponse(loadFixture('products.json')));
    const prog = await eduzzAdapter.getProgramme('3002');
    expect(prog.id).toBe('3002');
    expect(prog.name).toBe('Ebook Financas Pessoais');
  });

  it('throws NotImplementedError when the product id is not found', async () => {
    mockWithToken(fakeResponse(loadFixture('products.json')));
    await expect(eduzzAdapter.getProgramme('does-not-exist')).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });
});

// ---------------------------------------------------------------------------
// listTransactions — sales (filters, age, reversed visibility)
// ---------------------------------------------------------------------------

describe('EduzzAdapter.listTransactions', () => {
  it('normalises all sales in the fixture', async () => {
    mockWithToken(fakeResponse(loadFixture('sales.json')));
    const txns = await eduzzAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    expect(txns.length).toBe(5);
    expect(txns.every((t) => t.network === 'eduzz')).toBe(true);
    expect(txns.every((t) => t.currency === 'BRL')).toBe(true);
  });

  it('includes reversed transactions with reason (§15.10)', async () => {
    mockWithToken(fakeResponse(loadFixture('sales.json')));
    const all = await eduzzAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(2);
    expect(reversed.some((t) => t.reversalReason === 'Reembolso solicitado pelo cliente')).toBe(
      true,
    );
  });

  it('filters by status[]', async () => {
    mockWithToken(fakeResponse(loadFixture('sales.json')));
    const onlyPaid = await eduzzAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
      status: ['paid'],
    });
    expect(onlyPaid.length).toBe(1);
    expect(onlyPaid[0]?.id).toBe('90002');
  });

  it('filters by programmeId (content_id)', async () => {
    mockWithToken(fakeResponse(loadFixture('sales.json')));
    const onlyEbook = await eduzzAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
      programmeId: '3002',
    });
    expect(onlyEbook.every((t) => t.programmeId === '3002')).toBe(true);
    expect(onlyEbook.length).toBe(2);
  });

  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockWithToken(fakeResponse(loadFixture('sales.json')));
    const aged = await eduzzAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
      minAgeDays: 365,
    });
    expect(aged.length).toBeGreaterThan(0);
    for (const t of aged) {
      expect(t.ageDays).toBeGreaterThanOrEqual(365);
    }
  });

  it('respects limit after all other filters are applied', async () => {
    mockWithToken(fakeResponse(loadFixture('sales.json')));
    const limited = await eduzzAdapter.listTransactions({ limit: 2 });
    expect(limited.length).toBeLessThanOrEqual(2);
  });

  it('emits a NetworkError when credentials are missing', async () => {
    delete process.env['EDUZZ_API_KEY'];
    await expect(eduzzAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary — derived from listTransactions
// ---------------------------------------------------------------------------

describe('EduzzAdapter.getEarningsSummary', () => {
  it('aggregates commissions correctly from fixture data', async () => {
    mockWithToken(fakeResponse(loadFixture('sales.json')));
    const summary = await eduzzAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    expect(summary.network).toBe('eduzz');
    expect(summary.currency).toBe('BRL');
    // pending: 90001 (89.1) + 90005 (89.1); paid: 90002 (89.1); reversed: 90003 + 90004 (14.1 each)
    expect(summary.byStatus.pending).toBeCloseTo(178.2, 2);
    expect(summary.byStatus.paid).toBeCloseTo(89.1, 2);
    expect(summary.byStatus.reversed).toBeCloseTo(28.2, 2);
    expect(summary.totalEarnings).toBeCloseTo(89.1 + 89.1 + 89.1 + 14.1 + 14.1, 2);
    expect(summary.byProgramme.length).toBe(2);
  });

  it('sets oldestUnpaidAgeDays from the longest-pending transaction (§15.9)', async () => {
    mockWithToken(fakeResponse(loadFixture('sales.json')));
    const summary = await eduzzAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    // sale 90005 is waitingPayment, created 2024-02-01 — over a year old.
    expect(summary.oldestUnpaidAgeDays).toBeDefined();
    expect(summary.oldestUnpaidAgeDays ?? 0).toBeGreaterThan(365);
  });

  it('returns an empty summary when no sales match the window', async () => {
    mockWithToken(fakeResponse(loadFixture('sales_empty.json')));
    const summary = await eduzzAdapter.getEarningsSummary({});
    expect(summary.totalEarnings).toBe(0);
    expect(summary.byProgramme).toHaveLength(0);
    expect(summary.oldestUnpaidAgeDays).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listClicks / generateTrackingLink — NotImplemented
// ---------------------------------------------------------------------------

describe('EduzzAdapter.listClicks', () => {
  it('throws NotImplementedError with an Eduzz-specific reason', async () => {
    await expect(eduzzAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await eduzzAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click-level data');
    }
  });
});

describe('EduzzAdapter.generateTrackingLink', () => {
  it('throws NotImplementedError because links are panel-generated', async () => {
    await expect(
      eduzzAdapter.generateTrackingLink({ programmeId: '3001', destinationUrl: 'https://x.test/' }),
    ).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await eduzzAdapter.generateTrackingLink({ programmeId: '3001', destinationUrl: 'https://x.test/' });
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('panel');
    }
  });
});

// ---------------------------------------------------------------------------
// verifyAuth — happy + failure paths
// ---------------------------------------------------------------------------

describe('EduzzAdapter.verifyAuth', () => {
  it('returns ok:true and identity when token exchange succeeds', async () => {
    mockFetchQueue([fakeResponse(loadFixture('token.json'))]);
    const r = await eduzzAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('eduzz/account:tester@example.com');
    }
  });

  it('surfaces failure on 401 from the token endpoint and never throws (§15.4)', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_credentials"}', {
        status: 401,
        rawBody: '{"error":"invalid_credentials"}',
      }),
    ]);
    const r = await eduzzAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/401|invalid|auth/i);
    }
  });

  it('returns ok:false (does not throw) when credentials are missing', async () => {
    delete process.env['EDUZZ_EMAIL'];
    await expect(eduzzAdapter.verifyAuth()).resolves.toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('EduzzAdapter.validateCredential', () => {
  it('accepts a valid EDUZZ_EMAIL without an API call', async () => {
    const r = await eduzzAdapter.validateCredential('EDUZZ_EMAIL', 'you@example.com');
    expect(r.ok).toBe(true);
  });

  it('rejects a malformed EDUZZ_EMAIL', async () => {
    const r = await eduzzAdapter.validateCredential('EDUZZ_EMAIL', 'not-an-email');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('accepts a non-empty EDUZZ_PUBLIC_KEY without an API call', async () => {
    const r = await eduzzAdapter.validateCredential('EDUZZ_PUBLIC_KEY', 'some-public-key');
    expect(r.ok).toBe(true);
  });

  it('rejects an empty EDUZZ_PUBLIC_KEY', async () => {
    const r = await eduzzAdapter.validateCredential('EDUZZ_PUBLIC_KEY', '');
    expect(r.ok).toBe(false);
  });

  it('validates EDUZZ_API_KEY via live token exchange', async () => {
    mockFetchQueue([fakeResponse(loadFixture('token.json'))]);
    const r = await eduzzAdapter.validateCredential('EDUZZ_API_KEY', 'test-api-key-please-ignore');
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with hint when EDUZZ_API_KEY is wrong', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_credentials"}', {
        status: 401,
        rawBody: '{"error":"invalid_credentials"}',
      }),
    ]);
    const r = await eduzzAdapter.validateCredential('EDUZZ_API_KEY', 'bad-key');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('returns ok:false for unknown credential fields', async () => {
    const r = await eduzzAdapter.validateCredential('EDUZZ_UNKNOWN_FIELD', 'value');
    expect(r.ok).toBe(false);
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
    ]);
    try {
      await eduzzAdapter.listTransactions({});
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('eduzz');
      expect(env.operation).toBe('listTransactions');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream exploded');
    }
  });

  it('classifies 401 on a data endpoint as auth_error', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('token.json')),
      fakeResponse('Forbidden', { status: 401, rawBody: 'Forbidden' }),
    ]);
    try {
      await eduzzAdapter.listTransactions({});
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

describe('EduzzAdapter.capabilitiesCheck', () => {
  it('records listClicks and generateTrackingLink as not supported', async () => {
    // probes: verifyAuth (token), listProgrammes (token+data), listTransactions
    // (token+data), getEarningsSummary (token+data).
    mockFetchQueue([
      fakeResponse(loadFixture('token.json')), // verifyAuth
      fakeResponse(loadFixture('token.json')), // listProgrammes token
      fakeResponse(loadFixture('products.json')), // listProgrammes data
      fakeResponse(loadFixture('token.json')), // listTransactions token
      fakeResponse(loadFixture('sales_empty.json')), // listTransactions data
      fakeResponse(loadFixture('token.json')), // getEarningsSummary token
      fakeResponse(loadFixture('sales_empty.json')), // getEarningsSummary data
    ]);
    const caps = await eduzzAdapter.capabilitiesCheck();
    expect(caps.network).toBe('eduzz');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
    expect(caps.operations['listProgrammes']?.supported).toBe(true);
    expect(caps.operations['listTransactions']?.supported).toBe(true);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
