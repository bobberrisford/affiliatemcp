/**
 * ValueCommerce adapter — unit tests.
 *
 * Pattern-matched to `tests/networks/skimlinks/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - Circuit breakers are reset in `beforeEach` so no test bleeds state.
 *   - Fake credentials are injected via `process.env` (obvious non-secret values).
 *   - Fixtures live under `tests/fixtures/value-commerce/`.
 *   - The order-report fixtures are XML (the affiliate report API returns XML);
 *     they are stored JSON-wrapped under an `xml` field and fed to the mock fetch
 *     as the raw body so we assert the client parses XML correctly.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { valueCommerceAdapter, _internals } from '../../../src/networks/value-commerce/adapter.js';
import { parseXml } from '../../../src/networks/value-commerce/client.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';
import { _resetTokenCache } from '../../../src/networks/value-commerce/auth.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'value-commerce');

function loadJson(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function loadXml(name: string): string {
  return (loadJson(name) as { xml: string }).xml;
}

function fakeResponse(rawBody: string, init: { status?: number } = {}): Response {
  return new Response(rawBody, {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/xml' },
  });
}

function fakeJsonResponse(body: unknown, init: { status?: number; rawBody?: string } = {}): Response {
  const text = init.rawBody ?? JSON.stringify(body);
  return new Response(text, {
    status: init.status ?? 200,
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

/** Token fetch (JSON), then the given XML data response. */
function mockWithToken(dataXml: string, init: { status?: number } = {}): ReturnType<typeof vi.fn> {
  return mockFetchQueue([
    fakeJsonResponse(loadJson('token.json')),
    fakeResponse(dataXml, init),
  ]);
}

beforeEach(() => {
  _resetBreakers();
  _resetTokenCache();
  process.env['VALUE_COMMERCE_CLIENT_KEY'] = 'test-client-key-please-ignore';
  process.env['VALUE_COMMERCE_CLIENT_SECRET'] = 'test-client-secret-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['VALUE_COMMERCE_CLIENT_KEY'];
  delete process.env['VALUE_COMMERCE_CLIENT_SECRET'];
  _resetTokenCache();
});

// ---------------------------------------------------------------------------
// XML parser
// ---------------------------------------------------------------------------

describe('ValueCommerce XML parser', () => {
  it('parses a flat list of repeated elements into an array', () => {
    const tree = parseXml(loadXml('transactions.json'));
    const nodes = _internals.extractTransactionNodes(tree);
    expect(nodes.length).toBe(4);
    const first = nodes[0];
    expect(first).toBeDefined();
    expect(_internals.pick(first ?? {}, ['transactionId'])).toBe('T-10001');
  });

  it('decodes entities and handles empty containers', () => {
    const tree = parseXml(loadXml('transactions_empty.json'));
    const nodes = _internals.extractTransactionNodes(tree);
    expect(nodes.length).toBe(0);
    const decoded = parseXml('<r><v>a &amp; b &lt; c</v></r>') as Record<string, unknown>;
    expect((decoded.r as Record<string, unknown>).v).toBe('a & b < c');
  });
});

// ---------------------------------------------------------------------------
// Transformers (status normalisation + raw preservation)
// ---------------------------------------------------------------------------

describe('ValueCommerce transformers', () => {
  it('maps ValueCommerce approval codes to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus('p')).toBe('pending');
    expect(_internals.mapTransactionStatus('pending')).toBe('pending');
    expect(_internals.mapTransactionStatus('a')).toBe('approved');
    expect(_internals.mapTransactionStatus('c')).toBe('reversed');
    expect(_internals.mapTransactionStatus('rejected')).toBe('reversed');
    expect(_internals.mapTransactionStatus('i')).toBe('paid');
    expect(_internals.mapTransactionStatus('invoiced')).toBe('paid');
    expect(_internals.mapTransactionStatus('something-new')).toBe('other');
    expect(_internals.mapTransactionStatus(undefined)).toBe('other');
  });

  it('maps canonical status back to the approval_status code', () => {
    expect(_internals.mapCanonicalToApprovalStatus(['pending'])).toBe('p');
    expect(_internals.mapCanonicalToApprovalStatus(['approved'])).toBe('a');
    expect(_internals.mapCanonicalToApprovalStatus(['reversed'])).toBe('c');
    expect(_internals.mapCanonicalToApprovalStatus(['paid'])).toBe('i');
    expect(_internals.mapCanonicalToApprovalStatus(['other'])).toBeUndefined();
    // Multiple statuses cannot be expressed in a single param → undefined.
    expect(_internals.mapCanonicalToApprovalStatus(['pending', 'approved'])).toBeUndefined();
  });

  it('preserves the raw transaction node in rawNetworkData', () => {
    const tree = parseXml(loadXml('transactions.json'));
    const node = _internals.extractTransactionNodes(tree)[0];
    expect(node).toBeDefined();
    const out = _internals.toTransaction(node ?? {});
    expect(out.rawNetworkData).toBe(node);
  });

  it('surfaces reversalReason on reversed transactions (§15.10)', () => {
    const tree = parseXml(loadXml('transactions.json'));
    const nodes = _internals.extractTransactionNodes(tree);
    const rejected = nodes.find((n) => _internals.pick(n, ['approvalStatus']) === 'c');
    expect(rejected).toBeDefined();
    const out = _internals.toTransaction(rejected ?? {});
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Customer cancelled the order');
  });

  it('computes ageDays from confirmation date, then order date', () => {
    const now = new Date('2024-01-28T00:00:00Z');
    // confirmationDate 2024-01-20 → 8 days
    const age1 = _internals.computeAgeDays(
      { confirmationDate: '2024-01-20 00:00:00', orderDate: '2024-01-01 00:00:00' },
      now,
    );
    expect(age1).toBe(8);
    // No confirmation → falls back to order date 2024-01-08 → 20 days
    const age2 = _internals.computeAgeDays({ orderDate: '2024-01-08 00:00:00' }, now);
    expect(age2).toBe(20);
  });

  it('normalises numeric strings stripped of currency markers', () => {
    expect(_internals.toAmount('5500')).toBe(5500);
    expect(_internals.toAmount('¥1,234')).toBe(1234);
    expect(_internals.toAmount(undefined)).toBe(0);
    expect(_internals.toAmount('not-a-number')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('ValueCommerceAdapter.listTransactions', () => {
  it('parses the XML report into canonical transactions', async () => {
    mockWithToken(loadXml('transactions.json'));
    const txns = await valueCommerceAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    expect(txns.length).toBe(4);
    expect(txns[0]?.network).toBe('value-commerce');
    expect(txns[0]?.commission).toBe(275);
    expect(txns[0]?.amount).toBe(5500);
    expect(txns[0]?.currency).toBe('JPY');
  });

  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockWithToken(loadXml('transactions.json'));
    const aged = await valueCommerceAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
      minAgeDays: 365,
    });
    for (const t of aged) {
      expect(t.ageDays).toBeGreaterThanOrEqual(365);
    }
    expect(aged.length).toBeGreaterThan(0);
  });

  it('filters by status when caller passes status[]', async () => {
    mockWithToken(loadXml('transactions.json'));
    const only = await valueCommerceAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('filters by programmeId client-side', async () => {
    mockWithToken(loadXml('transactions.json'));
    const only = await valueCommerceAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
      programmeId: '2002',
    });
    expect(only.every((t) => t.programmeId === '2002')).toBe(true);
    expect(only.length).toBe(2);
  });

  it('respects limit after all other filters are applied', async () => {
    mockWithToken(loadXml('transactions.json'));
    const limited = await valueCommerceAdapter.listTransactions({ limit: 2 });
    expect(limited.length).toBeLessThanOrEqual(2);
  });

  it('emits a NetworkError when CLIENT_KEY is missing', async () => {
    delete process.env['VALUE_COMMERCE_CLIENT_KEY'];
    await expect(valueCommerceAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('ValueCommerceAdapter.getEarningsSummary', () => {
  it('aggregates commissions correctly from fixture data', async () => {
    mockWithToken(loadXml('transactions.json'));
    const summary = await valueCommerceAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    expect(summary.network).toBe('value-commerce');
    expect(summary.totalEarnings).toBeCloseTo(275 + 637 + 160 + 400, 2);
    expect(summary.byStatus.pending).toBeCloseTo(275, 2);
    expect(summary.byStatus.approved).toBeCloseTo(637, 2);
    expect(summary.byStatus.reversed).toBeCloseTo(160, 2);
    expect(summary.byStatus.paid).toBeCloseTo(400, 2);
    expect(summary.byProgramme.length).toBe(2);
    expect(summary.currency).toBe('JPY');
  });

  it('sets oldestUnpaidAgeDays from the longest-pending unpaid transaction (§15.9)', async () => {
    mockWithToken(loadXml('transactions.json'));
    const summary = await valueCommerceAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    // The approved (unpaid) T-10002 was confirmed 2024-01-20 — well over a year ago.
    expect(summary.oldestUnpaidAgeDays).toBeDefined();
    expect(summary.oldestUnpaidAgeDays ?? 0).toBeGreaterThan(365);
  });

  it('returns an empty summary when no transactions match the window', async () => {
    mockWithToken(loadXml('transactions_empty.json'));
    const summary = await valueCommerceAdapter.getEarningsSummary({});
    expect(summary.totalEarnings).toBe(0);
    expect(summary.byProgramme).toHaveLength(0);
    expect(summary.oldestUnpaidAgeDays).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// NotImplemented operations
// ---------------------------------------------------------------------------

describe('ValueCommerceAdapter NotImplemented operations', () => {
  it('listProgrammes throws NotImplementedError', async () => {
    await expect(valueCommerceAdapter.listProgrammes()).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await valueCommerceAdapter.listProgrammes();
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('programme');
    }
  });

  it('getProgramme throws NotImplementedError', async () => {
    await expect(valueCommerceAdapter.getProgramme('2001')).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });

  it('listClicks throws NotImplementedError (never returns [])', async () => {
    await expect(valueCommerceAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await valueCommerceAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click-level data');
    }
  });

  it('generateTrackingLink throws NotImplementedError', async () => {
    await expect(
      valueCommerceAdapter.generateTrackingLink({
        programmeId: '2001',
        destinationUrl: 'https://example.test/',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth — happy + failure paths
// ---------------------------------------------------------------------------

describe('ValueCommerceAdapter.verifyAuth', () => {
  it('returns ok:true and identity when token acquisition succeeds', async () => {
    mockFetchQueue([fakeJsonResponse(loadJson('token.json'))]);
    const r = await valueCommerceAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('value-commerce/client:');
    }
  });

  it('surfaces a NetworkErrorEnvelope shape on 401 from the token endpoint (§15.4)', async () => {
    mockFetchQueue([
      fakeJsonResponse('{"error":"invalid_client"}', {
        status: 401,
        rawBody: '{"error":"invalid_client"}',
      }),
    ]);
    const r = await valueCommerceAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/HTTP 401|401|invalid_client|auth/i);
    }
  });

  it('returns ok:false (does not throw) on auth failure', async () => {
    mockFetchQueue([fakeJsonResponse('Unauthorized', { status: 401, rawBody: 'Unauthorized' })]);
    await expect(valueCommerceAdapter.verifyAuth()).resolves.toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('ValueCommerceAdapter.validateCredential', () => {
  it('accepts a non-empty CLIENT_KEY without an API call', async () => {
    const r = await valueCommerceAdapter.validateCredential('VALUE_COMMERCE_CLIENT_KEY', 'any-key');
    expect(r.ok).toBe(true);
  });

  it('rejects an empty CLIENT_KEY', async () => {
    const r = await valueCommerceAdapter.validateCredential('VALUE_COMMERCE_CLIENT_KEY', '');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('validates CLIENT_SECRET via live token acquisition', async () => {
    mockFetchQueue([fakeJsonResponse(loadJson('token.json'))]);
    const r = await valueCommerceAdapter.validateCredential(
      'VALUE_COMMERCE_CLIENT_SECRET',
      'test-secret-please-ignore',
    );
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with a hint when CLIENT_SECRET is wrong', async () => {
    mockFetchQueue([
      fakeJsonResponse('{"error":"invalid_client"}', {
        status: 401,
        rawBody: '{"error":"invalid_client"}',
      }),
    ]);
    const r = await valueCommerceAdapter.validateCredential(
      'VALUE_COMMERCE_CLIENT_SECRET',
      'bad-secret',
    );
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('returns ok:false for unknown credential fields', async () => {
    const r = await valueCommerceAdapter.validateCredential('VALUE_COMMERCE_UNKNOWN', 'value');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim response body on a 500', async () => {
    const body = '<error>upstream exploded</error>';
    mockFetchQueue([
      fakeJsonResponse(loadJson('token.json')),
      fakeResponse(body, { status: 500 }),
      fakeResponse(body, { status: 500 }),
      fakeResponse(body, { status: 500 }),
      fakeResponse(body, { status: 500 }),
    ]);
    try {
      await valueCommerceAdapter.listTransactions({});
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('value-commerce');
      expect(env.operation).toBe('listTransactions');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream exploded');
    }
  });

  it('classifies 401 on the report API as auth_error', async () => {
    mockFetchQueue([
      fakeJsonResponse(loadJson('token.json')),
      fakeResponse('Forbidden', { status: 401 }),
    ]);
    try {
      await valueCommerceAdapter.listTransactions({});
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

describe('ValueCommerceAdapter.capabilitiesCheck', () => {
  it('records the unsupported ops without probing them', async () => {
    // capabilitiesCheck probes: verifyAuth (token), listTransactions (token+data),
    // getEarningsSummary (token+data).
    mockFetchQueue([
      fakeJsonResponse(loadJson('token.json')), // verifyAuth token
      fakeJsonResponse(loadJson('token.json')), // listTransactions token
      fakeResponse(loadXml('transactions_empty.json')), // listTransactions data
      fakeJsonResponse(loadJson('token.json')), // getEarningsSummary token
      fakeResponse(loadXml('transactions_empty.json')), // getEarningsSummary data
    ]);
    const caps = await valueCommerceAdapter.capabilitiesCheck();
    expect(caps.network).toBe('value-commerce');
    expect(caps.operations['listProgrammes']?.supported).toBe(false);
    expect(caps.operations['getProgramme']?.supported).toBe(false);
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
    expect(caps.operations['verifyAuth']?.supported).toBe(true);
    expect(caps.operations['listTransactions']?.supported).toBe(true);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
