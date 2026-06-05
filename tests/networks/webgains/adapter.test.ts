/**
 * Webgains adapter — unit tests.
 *
 * Pattern-matched to `tests/networks/skimlinks/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - Circuit breakers are reset in `beforeEach` so no test bleeds state.
 *   - Fake credentials are injected via `process.env` (obvious non-secret values).
 *   - Fixtures live under `tests/fixtures/webgains/`.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 *
 * Webgains uses a Personal Access Token passed directly as a bearer credential —
 * there is NO token-exchange step, so each operation makes a single data fetch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { webgainsAdapter, _internals } from '../../../src/networks/webgains/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'webgains');

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
 * listTransactions chunks windows longer than one year into multiple calls.
 * This helper returns the given transactions fixture on the FIRST fetch and an
 * empty transaction report on every subsequent fetch, so multi-year windows do
 * not double-count and do not exhaust the queue.
 */
function mockTransactionsAcrossChunks(fixtureName: string): ReturnType<typeof vi.fn> {
  let first = true;
  const spy = vi.fn(async () => {
    if (first) {
      first = false;
      return fakeResponse(loadFixture(fixtureName));
    }
    return fakeResponse(loadFixture('transactions_empty.json'));
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

beforeEach(() => {
  _resetBreakers();
  process.env['WEBGAINS_API_KEY'] = 'test-api-key-please-ignore';
  process.env['WEBGAINS_PUBLISHER_ID'] = '123456';
  process.env['WEBGAINS_CAMPAIGN_ID'] = '789012';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['WEBGAINS_API_KEY'];
  delete process.env['WEBGAINS_PUBLISHER_ID'];
  delete process.env['WEBGAINS_CAMPAIGN_ID'];
});

// ---------------------------------------------------------------------------
// Transformer unit tests (status normalisation + raw preservation + ageDays)
// ---------------------------------------------------------------------------

describe('Webgains transformers (status normalisation, raw preservation)', () => {
  it('maps Webgains commission status strings to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ status: 'open' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'in recall' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'confirmed' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'approved' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'paid' })).toBe('paid');
    // cancelled → reversed (the user-facing intent: the sale did not pay out).
    expect(_internals.mapTransactionStatus({ status: 'cancelled' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'declined' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'reversed' })).toBe('reversed');
    // delayed is a hold state — neither approved nor reversed.
    expect(_internals.mapTransactionStatus({ status: 'delayed' })).toBe('other');
    expect(_internals.mapTransactionStatus({ status: 'unknown_future_status' })).toBe('other');
    expect(_internals.mapTransactionStatus({})).toBe('other');
  });

  it('maps Webgains programme statuses to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ status: 'active' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'accepted' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ status: 'declined' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ status: 'available' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ status: 'suspended' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'paused' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'something-new' })).toBe('unknown');
    expect(_internals.mapProgrammeStatus({})).toBe('unknown');
  });

  it('preserves raw Webgains payload in rawNetworkData', () => {
    const fixture = (loadFixture('transactions.json') as { transactions: unknown[] }).transactions;
    const raw = fixture[0] as Record<string, unknown>;
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('reads currency per row, not assuming GBP', () => {
    const fixture = (loadFixture('transactions.json') as { transactions: unknown[] }).transactions;
    const eurRow = fixture[2] as Record<string, unknown>;
    const out = _internals.toTransaction(eurRow as never);
    expect(out.currency).toBe('EUR');
  });

  it('surfaces reversalReason from changeReason on reversed transactions (§15.10)', () => {
    const fixture = (loadFixture('transactions.json') as { transactions: unknown[] }).transactions;
    // Fixture index 2 is the cancelled transaction.
    const cancelled = fixture[2] as Record<string, unknown>;
    const out = _internals.toTransaction(cancelled as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Customer returned the item within 30 days');
  });

  it('computes ageDays from validationDate (preferred), then transactionDate', () => {
    const now = new Date('2026-06-04T00:00:00Z');
    // validationDate = 2026-05-25 → 10 days
    const age1 = _internals.computeAgeDays(
      { validationDate: '2026-05-25T00:00:00Z', transactionDate: '2026-05-01T00:00:00Z' },
      now,
    );
    expect(age1).toBe(10);
    // No validationDate → falls back to transactionDate = 2026-05-05 → 30 days
    const age2 = _internals.computeAgeDays({ transactionDate: '2026-05-05T00:00:00Z' }, now);
    expect(age2).toBe(30);
    // No anchor at all → 0
    expect(_internals.computeAgeDays({}, now)).toBe(0);
  });

  it('normalises string and number amounts', () => {
    expect(_internals.toAmount(5.5)).toBe(5.5);
    expect(_internals.toAmount('12.75')).toBe(12.75);
    expect(_internals.toAmount(undefined)).toBe(0);
    expect(_internals.toAmount('not-a-number')).toBe(0);
  });

  it('chunks date ranges longer than one year into <= 365-day segments', () => {
    const chunks = _internals.chunkDateRange(
      new Date('2023-01-01T00:00:00Z'),
      new Date('2026-01-01T00:00:00Z'),
    );
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      const days = (c.to.getTime() - c.from.getTime()) / (24 * 60 * 60 * 1000);
      expect(days).toBeLessThanOrEqual(365);
    }
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('WebgainsAdapter.listProgrammes', () => {
  it('returns the publisher programmes from the Get Programs response', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programs.json'))]);
    const programmes = await webgainsAdapter.listProgrammes();
    expect(programmes.length).toBe(3);
    expect(programmes[0]?.network).toBe('webgains');
    expect(programmes[0]?.status).toBe('joined');
  });

  it('filters by programme status when caller passes status[]', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programs.json'))]);
    const pending = await webgainsAdapter.listProgrammes({ status: ['pending'] });
    expect(pending.length).toBe(1);
    expect(pending[0]?.status).toBe('pending');
  });

  it('filters by search term against the programme name', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programs.json'))]);
    const found = await webgainsAdapter.listProgrammes({ search: 'electronics' });
    expect(found.length).toBe(1);
    expect(found[0]?.id).toBe('3002');
  });

  it('emits a NetworkError when WEBGAINS_API_KEY is missing', async () => {
    delete process.env['WEBGAINS_API_KEY'];
    await expect(webgainsAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getProgramme
// ---------------------------------------------------------------------------

describe('WebgainsAdapter.getProgramme', () => {
  it('returns the matching programme by id', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programs.json'))]);
    const programme = await webgainsAdapter.getProgramme('3002');
    expect(programme.id).toBe('3002');
    expect(programme.currency).toBe('EUR');
  });

  it('throws a NetworkError when the programme is not found', async () => {
    mockFetchQueue([fakeResponse(loadFixture('programs.json'))]);
    await expect(webgainsAdapter.getProgramme('999999')).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error NetworkError when programmeId is empty', async () => {
    await expect(webgainsAdapter.getProgramme('')).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listTransactions — unpaid-age + reversed visibility (§15.9, §15.10)
// ---------------------------------------------------------------------------

describe('WebgainsAdapter.listTransactions', () => {
  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockTransactionsAcrossChunks('transactions.json');
    const aged = await webgainsAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
      minAgeDays: 365,
    });
    for (const t of aged) {
      expect(t.ageDays).toBeGreaterThanOrEqual(365);
    }
    expect(aged.length).toBeGreaterThan(0);
  });

  it('includes reversed transactions with reason (§15.10)', async () => {
    mockTransactionsAcrossChunks('transactions.json');
    const all = await webgainsAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toBe('Customer returned the item within 30 days');
  });

  it('filters by status when caller passes status[]', async () => {
    mockTransactionsAcrossChunks('transactions.json');
    const only = await webgainsAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('respects limit after all other filters are applied', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const limited = await webgainsAdapter.listTransactions({ limit: 2 });
    expect(limited.length).toBeLessThanOrEqual(2);
  });

  it('emits a NetworkError when WEBGAINS_PUBLISHER_ID is missing', async () => {
    delete process.env['WEBGAINS_PUBLISHER_ID'];
    await expect(webgainsAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listClicks — not exposed by the publisher API
// ---------------------------------------------------------------------------

describe('WebgainsAdapter.listClicks', () => {
  it('throws NotImplementedError with a Webgains-specific reason', async () => {
    await expect(webgainsAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await webgainsAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click-level data');
    }
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — deterministic URL construction
// ---------------------------------------------------------------------------

describe('WebgainsAdapter.generateTrackingLink', () => {
  it('constructs the track.webgains.com deeplink with mandatory parameters', async () => {
    const link = await webgainsAdapter.generateTrackingLink({
      programmeId: '3001',
      destinationUrl: 'https://www.examplebooks.test/product?q=test value&page=1',
    });
    expect(link.trackingUrl).toMatch(/^https:\/\/track\.webgains\.com\/click\.html\?/);
    // wgcampaignid from WEBGAINS_CAMPAIGN_ID (789012), wgprogramid from input.
    expect(link.trackingUrl).toContain('wgcampaignid=789012');
    expect(link.trackingUrl).toContain('wgprogramid=3001');
    expect(link.trackingUrl).toContain(
      'wgtarget=https%3A%2F%2Fwww.examplebooks.test%2Fproduct%3Fq%3Dtest%20value%26page%3D1',
    );
    expect(link.network).toBe('webgains');
    expect(link.programmeId).toBe('3001');
  });

  it('is deterministic — same inputs always produce the same URL', async () => {
    const link1 = await webgainsAdapter.generateTrackingLink({
      programmeId: '3001',
      destinationUrl: 'https://example.test/page',
    });
    const link2 = await webgainsAdapter.generateTrackingLink({
      programmeId: '3001',
      destinationUrl: 'https://example.test/page',
    });
    expect(link1.trackingUrl).toBe(link2.trackingUrl);
  });

  it('throws config_error when destinationUrl is empty', async () => {
    await expect(
      webgainsAdapter.generateTrackingLink({ programmeId: '3001', destinationUrl: '' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws config_error when programmeId is empty', async () => {
    await expect(
      webgainsAdapter.generateTrackingLink({ programmeId: '', destinationUrl: 'https://x.test/' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws NetworkError when WEBGAINS_CAMPAIGN_ID is missing', async () => {
    delete process.env['WEBGAINS_CAMPAIGN_ID'];
    await expect(
      webgainsAdapter.generateTrackingLink({
        programmeId: '3001',
        destinationUrl: 'https://example.test/',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth — happy + failure paths
// ---------------------------------------------------------------------------

describe('WebgainsAdapter.verifyAuth', () => {
  it('returns ok:true and identity when Get Publisher succeeds', async () => {
    mockFetchQueue([fakeResponse(loadFixture('publisher.json'))]);
    const r = await webgainsAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('webgains/publisher:123456');
      expect(r.identity).toContain('Example Publisher Ltd');
    }
  });

  it('surfaces a failure (does not throw) on 401 from Get Publisher (§15.4)', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_token"}', {
        status: 401,
        rawBody: '{"error":"invalid_token"}',
      }),
    ]);
    const r = await webgainsAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/401|invalid_token|auth/i);
    }
  });

  it('returns ok:false (does not throw) when WEBGAINS_API_KEY is missing', async () => {
    delete process.env['WEBGAINS_API_KEY'];
    await expect(webgainsAdapter.verifyAuth()).resolves.toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('WebgainsAdapter.validateCredential', () => {
  it('validates WEBGAINS_API_KEY via a live Get Publisher call when publisher id is set', async () => {
    mockFetchQueue([fakeResponse(loadFixture('publisher.json'))]);
    const r = await webgainsAdapter.validateCredential('WEBGAINS_API_KEY', 'a-token');
    expect(r.ok).toBe(true);
  });

  it('rejects an empty WEBGAINS_API_KEY', async () => {
    const r = await webgainsAdapter.validateCredential('WEBGAINS_API_KEY', '');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('returns ok:false with hint when WEBGAINS_API_KEY is wrong', async () => {
    mockFetchQueue([
      fakeResponse('Unauthorized', { status: 401, rawBody: 'Unauthorized' }),
    ]);
    const r = await webgainsAdapter.validateCredential('WEBGAINS_API_KEY', 'bad-token');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('accepts a positive integer WEBGAINS_PUBLISHER_ID', async () => {
    const r = await webgainsAdapter.validateCredential('WEBGAINS_PUBLISHER_ID', '123456');
    expect(r.ok).toBe(true);
  });

  it('rejects a non-numeric WEBGAINS_PUBLISHER_ID', async () => {
    expect((await webgainsAdapter.validateCredential('WEBGAINS_PUBLISHER_ID', 'abc')).ok).toBe(false);
    expect((await webgainsAdapter.validateCredential('WEBGAINS_PUBLISHER_ID', '0')).ok).toBe(false);
  });

  it('accepts a positive integer WEBGAINS_CAMPAIGN_ID', async () => {
    const r = await webgainsAdapter.validateCredential('WEBGAINS_CAMPAIGN_ID', '789012');
    expect(r.ok).toBe(true);
  });

  it('rejects a non-numeric WEBGAINS_CAMPAIGN_ID', async () => {
    const r = await webgainsAdapter.validateCredential('WEBGAINS_CAMPAIGN_ID', 'abc');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('returns ok:false for unknown credential fields', async () => {
    const r = await webgainsAdapter.validateCredential('WEBGAINS_UNKNOWN_FIELD', 'value');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary — derived from listTransactions
// ---------------------------------------------------------------------------

describe('WebgainsAdapter.getEarningsSummary', () => {
  it('aggregates commissions correctly from fixture data', async () => {
    mockTransactionsAcrossChunks('transactions.json');
    const summary = await webgainsAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    expect(summary.network).toBe('webgains');
    expect(summary.totalEarnings).toBeCloseTo(5.5 + 12.75 + 3.2 + 8.0 + 2.0, 2);
    expect(summary.byStatus.pending).toBeCloseTo(5.5, 2);
    expect(summary.byStatus.approved).toBeCloseTo(12.75, 2);
    expect(summary.byStatus.reversed).toBeCloseTo(3.2, 2);
    expect(summary.byStatus.paid).toBeCloseTo(8.0, 2);
    expect(summary.byStatus.other).toBeCloseTo(2.0, 2);
    expect(summary.byProgramme.length).toBe(2);
  });

  it('sets oldestUnpaidAgeDays from the longest-pending/approved transaction (§15.9)', async () => {
    mockTransactionsAcrossChunks('transactions.json');
    const summary = await webgainsAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    // WG10002 was confirmed on 2024-01-20 and is still unpaid — oldest.
    expect(summary.oldestUnpaidAgeDays).toBeDefined();
    expect(summary.oldestUnpaidAgeDays ?? 0).toBeGreaterThan(365);
  });

  it('returns an empty summary when no transactions match the window', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions_empty.json'))]);
    const summary = await webgainsAdapter.getEarningsSummary({});
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
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await webgainsAdapter.listTransactions({});
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('webgains');
      expect(env.operation).toBe('listTransactions');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream exploded');
    }
  });

  it('classifies 401 on the reporting API as auth_error', async () => {
    mockFetchQueue([fakeResponse('Forbidden', { status: 401, rawBody: 'Forbidden' })]);
    try {
      await webgainsAdapter.listTransactions({});
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

describe('WebgainsAdapter.capabilitiesCheck', () => {
  it('records listClicks as not supported and the rest as probed', async () => {
    // Probe order: verifyAuth (publisher), listProgrammes (programs),
    // listTransactions (transactions), getEarningsSummary (transactions).
    mockFetchQueue([
      fakeResponse(loadFixture('publisher.json')),
      fakeResponse(loadFixture('programs.json')),
      fakeResponse(loadFixture('transactions_empty.json')),
      fakeResponse(loadFixture('transactions_empty.json')),
    ]);
    const caps = await webgainsAdapter.capabilitiesCheck();
    expect(caps.network).toBe('webgains');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(true);
    expect(caps.operations['verifyAuth']?.supported).toBe(true);
    expect(caps.operations['listProgrammes']?.supported).toBe(true);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
