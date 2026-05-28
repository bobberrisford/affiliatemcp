/**
 * Skimlinks adapter — unit tests.
 *
 * Pattern-matched to `tests/networks/cj/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - Circuit breakers are reset in `beforeEach` so no test bleeds state.
 *   - Fake credentials are injected via `process.env` (obvious non-secret values).
 *   - Fixtures live under `tests/fixtures/skimlinks/`.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { skimlinksAdapter, _internals } from '../../../src/networks/skimlinks/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';
import { _resetTokenCache } from '../../../src/networks/skimlinks/auth.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'skimlinks');

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
 * Helper: mock a token exchange (first fetch) followed by the given data response.
 * Most adapter ops require a token first, then the data call.
 */
function mockWithToken(dataResponse: Response): ReturnType<typeof vi.fn> {
  return mockFetchQueue([fakeResponse(loadFixture('token.json')), dataResponse]);
}

beforeEach(() => {
  _resetBreakers();
  _resetTokenCache();
  process.env['SKIMLINKS_CLIENT_ID'] = 'test-client-id-please-ignore';
  process.env['SKIMLINKS_CLIENT_SECRET'] = 'test-client-secret-please-ignore';
  process.env['SKIMLINKS_PUBLISHER_ID'] = '123456';
  process.env['SKIMLINKS_DOMAIN_ID'] = '789012';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['SKIMLINKS_CLIENT_ID'];
  delete process.env['SKIMLINKS_CLIENT_SECRET'];
  delete process.env['SKIMLINKS_PUBLISHER_ID'];
  delete process.env['SKIMLINKS_DOMAIN_ID'];
  _resetTokenCache();
});

// ---------------------------------------------------------------------------
// Transformer unit tests (status normalisation + raw preservation)
// ---------------------------------------------------------------------------

describe('Skimlinks transformers (status normalisation, raw preservation)', () => {
  it('maps Skimlinks status strings to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'approved' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'confirmed' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'paid' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ status: 'settled' })).toBe('paid');
    // declined → reversed (the user-facing intent: the sale didn't pay out).
    expect(_internals.mapTransactionStatus({ status: 'declined' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'rejected' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'reversed' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'unknown_future_status' })).toBe('other');
    expect(_internals.mapTransactionStatus({})).toBe('other');
  });

  it('maps Skimlinks programme statuses to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ status: 'active' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'joined' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ status: 'declined' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ status: 'available' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ status: 'suspended' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'paused' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'something-new' })).toBe('unknown');
    expect(_internals.mapProgrammeStatus({})).toBe('unknown');
  });

  it('preserves raw Skimlinks payload in rawNetworkData', () => {
    const fixture = (loadFixture('commissions.json') as { commissions: unknown[] }).commissions;
    const raw = fixture[0] as Record<string, unknown>;
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('surfaces reversalReason from declineReason on reversed transactions (§15.10)', () => {
    const fixture = (loadFixture('commissions.json') as { commissions: unknown[] }).commissions;
    // Fixture index 2 is the declined commission.
    const declined = fixture[2] as Record<string, unknown>;
    const out = _internals.toTransaction(declined as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Customer returned the item within 30 days');
  });

  it('computes ageDays from approvedDate (preferred), then transactionDate', () => {
    const now = new Date('2026-05-28T00:00:00Z');
    // approvedDate = 2026-05-20 → 8 days
    const age1 = _internals.computeAgeDays(
      { approvedDate: '2026-05-20T00:00:00Z', transactionDate: '2026-05-01T00:00:00Z' },
      now,
    );
    expect(age1).toBe(8);
    // No approvedDate → falls back to transactionDate = 2026-05-08 → 20 days
    const age2 = _internals.computeAgeDays(
      { transactionDate: '2026-05-08T00:00:00Z' },
      now,
    );
    expect(age2).toBe(20);
  });

  it('normalises string and number commission amounts', () => {
    expect(_internals.toAmount(5.5)).toBe(5.5);
    expect(_internals.toAmount('12.75')).toBe(12.75);
    expect(_internals.toAmount(undefined)).toBe(0);
    expect(_internals.toAmount('not-a-number')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// listTransactions — unpaid-age + reversed visibility (§15.9, §15.10)
// ---------------------------------------------------------------------------

describe('SkimlinksAdapter.listTransactions', () => {
  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockWithToken(fakeResponse(loadFixture('commissions.json')));

    const aged = await skimlinksAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
      minAgeDays: 365,
    });
    for (const t of aged) {
      expect(t.ageDays).toBeGreaterThanOrEqual(365);
    }
    expect(aged.length).toBeGreaterThan(0);
  });

  it('includes reversed transactions with reason (§15.10)', async () => {
    mockWithToken(fakeResponse(loadFixture('commissions.json')));
    const all = await skimlinksAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
    });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toBe('Customer returned the item within 30 days');
  });

  it('filters by status when caller passes status[]', async () => {
    mockWithToken(fakeResponse(loadFixture('commissions.json')));
    const only = await skimlinksAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('respects limit after all other filters are applied', async () => {
    mockWithToken(fakeResponse(loadFixture('commissions.json')));
    const limited = await skimlinksAdapter.listTransactions({ limit: 2 });
    expect(limited.length).toBeLessThanOrEqual(2);
  });

  it('emits a NetworkError when SKIMLINKS_PUBLISHER_ID is missing', async () => {
    delete process.env['SKIMLINKS_PUBLISHER_ID'];
    await expect(skimlinksAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });

  it('emits a NetworkError when SKIMLINKS_CLIENT_ID is missing', async () => {
    delete process.env['SKIMLINKS_CLIENT_ID'];
    // Token fetch will fail because client_id is missing.
    await expect(skimlinksAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes / getProgramme — tier-gated, must throw NotImplementedError
// ---------------------------------------------------------------------------

describe('SkimlinksAdapter.listProgrammes', () => {
  it('throws NotImplementedError because Merchant API is tier-gated', async () => {
    await expect(skimlinksAdapter.listProgrammes()).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await skimlinksAdapter.listProgrammes();
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('Merchant API');
    }
  });
});

describe('SkimlinksAdapter.getProgramme', () => {
  it('throws NotImplementedError because Merchant API is tier-gated', async () => {
    await expect(skimlinksAdapter.getProgramme('2001')).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// listClicks — not exposed by the Reporting API
// ---------------------------------------------------------------------------

describe('SkimlinksAdapter.listClicks', () => {
  it('throws NotImplementedError with a Skimlinks-specific reason', async () => {
    await expect(skimlinksAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await skimlinksAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click-level data');
    }
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — deterministic URL construction
// ---------------------------------------------------------------------------

describe('SkimlinksAdapter.generateTrackingLink', () => {
  it('constructs the go.skimresources.com deeplink with URL-encoded destination', async () => {
    // The adapter calls getAccessToken before constructing the URL.
    mockFetchQueue([fakeResponse(loadFixture('token.json'))]);

    const link = await skimlinksAdapter.generateTrackingLink({
      programmeId: '2001',
      destinationUrl: 'https://www.examplebooks.test/product?q=test value&page=1',
    });

    expect(link.trackingUrl).toMatch(/^https:\/\/go\.skimresources\.com\//);
    // id={publisherId}X{domainId} — publisher ID is 123456, domain ID is 789012 (see beforeEach)
    expect(link.trackingUrl).toContain('id=123456X789012');
    expect(link.trackingUrl).toContain('xs=1');
    expect(link.trackingUrl).toContain(
      'url=https%3A%2F%2Fwww.examplebooks.test%2Fproduct%3Fq%3Dtest%20value%26page%3D1',
    );
    expect(link.network).toBe('skimlinks');
    expect(link.programmeId).toBe('2001');
  });

  it('is deterministic — same inputs always produce the same URL', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('token.json')),
      fakeResponse(loadFixture('token.json')),
    ]);

    const link1 = await skimlinksAdapter.generateTrackingLink({
      programmeId: '2001',
      destinationUrl: 'https://example.test/page',
    });
    _resetTokenCache();
    const link2 = await skimlinksAdapter.generateTrackingLink({
      programmeId: '2001',
      destinationUrl: 'https://example.test/page',
    });
    expect(link1.trackingUrl).toBe(link2.trackingUrl);
  });

  it('throws config_error when destinationUrl is empty', async () => {
    await expect(
      skimlinksAdapter.generateTrackingLink({
        programmeId: '2001',
        destinationUrl: '',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws NetworkError when SKIMLINKS_PUBLISHER_ID is missing', async () => {
    delete process.env['SKIMLINKS_PUBLISHER_ID'];
    await expect(
      skimlinksAdapter.generateTrackingLink({
        programmeId: '2001',
        destinationUrl: 'https://example.test/',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws NetworkError when SKIMLINKS_DOMAIN_ID is missing', async () => {
    delete process.env['SKIMLINKS_DOMAIN_ID'];
    await expect(
      skimlinksAdapter.generateTrackingLink({
        programmeId: '2001',
        destinationUrl: 'https://example.test/',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth — happy + failure paths
// ---------------------------------------------------------------------------

describe('SkimlinksAdapter.verifyAuth', () => {
  it('returns ok:true and identity when token exchange succeeds', async () => {
    mockFetchQueue([fakeResponse(loadFixture('token.json'))]);
    const r = await skimlinksAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('skimlinks/publisher:123456');
    }
  });

  it('surfaces NetworkErrorEnvelope shape on 401 from token endpoint (§15.4)', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_client"}', {
        status: 401,
        rawBody: '{"error":"invalid_client"}',
      }),
    ]);
    const r = await skimlinksAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/HTTP 401|401|invalid_client|auth/i);
    }
  });

  it('returns ok:false (does not throw) on auth failure', async () => {
    mockFetchQueue([
      fakeResponse('Unauthorized', { status: 401, rawBody: 'Unauthorized' }),
    ]);
    // verifyAuth must never throw — it is called by error handlers.
    await expect(skimlinksAdapter.verifyAuth()).resolves.toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('SkimlinksAdapter.validateCredential', () => {
  it('accepts a non-empty SKIMLINKS_CLIENT_ID without an API call', async () => {
    const r = await skimlinksAdapter.validateCredential('SKIMLINKS_CLIENT_ID', 'any-id');
    expect(r.ok).toBe(true);
  });

  it('rejects an empty SKIMLINKS_CLIENT_ID', async () => {
    const r = await skimlinksAdapter.validateCredential('SKIMLINKS_CLIENT_ID', '');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('validates SKIMLINKS_CLIENT_SECRET via live token exchange', async () => {
    mockFetchQueue([fakeResponse(loadFixture('token.json'))]);
    const r = await skimlinksAdapter.validateCredential(
      'SKIMLINKS_CLIENT_SECRET',
      'test-secret-please-ignore',
    );
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with hint when SKIMLINKS_CLIENT_SECRET is wrong', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_client"}', {
        status: 401,
        rawBody: '{"error":"invalid_client"}',
      }),
    ]);
    const r = await skimlinksAdapter.validateCredential('SKIMLINKS_CLIENT_SECRET', 'bad-secret');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('accepts a positive integer SKIMLINKS_PUBLISHER_ID', async () => {
    const r = await skimlinksAdapter.validateCredential('SKIMLINKS_PUBLISHER_ID', '123456');
    expect(r.ok).toBe(true);
  });

  it('rejects a non-numeric SKIMLINKS_PUBLISHER_ID', async () => {
    const r1 = await skimlinksAdapter.validateCredential('SKIMLINKS_PUBLISHER_ID', 'abc');
    expect(r1.ok).toBe(false);
    const r2 = await skimlinksAdapter.validateCredential('SKIMLINKS_PUBLISHER_ID', '0');
    expect(r2.ok).toBe(false);
  });

  it('accepts a positive integer SKIMLINKS_DOMAIN_ID', async () => {
    const r = await skimlinksAdapter.validateCredential('SKIMLINKS_DOMAIN_ID', '789012');
    expect(r.ok).toBe(true);
  });

  it('rejects a non-numeric SKIMLINKS_DOMAIN_ID', async () => {
    const r1 = await skimlinksAdapter.validateCredential('SKIMLINKS_DOMAIN_ID', 'abc');
    expect(r1.ok).toBe(false);
    const r2 = await skimlinksAdapter.validateCredential('SKIMLINKS_DOMAIN_ID', '0');
    expect(r2.ok).toBe(false);
    expect(r2.hint).toBeTruthy();
  });

  it('returns ok:false for unknown credential fields', async () => {
    const r = await skimlinksAdapter.validateCredential('SKIMLINKS_UNKNOWN_FIELD', 'value');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary — derived from listTransactions
// ---------------------------------------------------------------------------

describe('SkimlinksAdapter.getEarningsSummary', () => {
  it('aggregates commissions correctly from fixture data', async () => {
    // getEarningsSummary calls listTransactions, which needs a token then data.
    mockWithToken(fakeResponse(loadFixture('commissions.json')));
    const summary = await skimlinksAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
    });
    expect(summary.network).toBe('skimlinks');
    expect(summary.totalEarnings).toBeCloseTo(5.5 + 12.75 + 3.2 + 8.0, 2);
    expect(summary.byStatus.pending).toBeCloseTo(5.5, 2);
    expect(summary.byStatus.approved).toBeCloseTo(12.75, 2);
    expect(summary.byStatus.reversed).toBeCloseTo(3.2, 2);
    expect(summary.byStatus.paid).toBeCloseTo(8.0, 2);
    expect(summary.byProgramme.length).toBe(2);
  });

  it('sets oldestUnpaidAgeDays from the longest-pending approved transaction (§15.9)', async () => {
    mockWithToken(fakeResponse(loadFixture('commissions.json')));
    const summary = await skimlinksAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
    });
    // Commission 10002 was approved on 2024-01-20 and is still unpaid — oldest.
    expect(summary.oldestUnpaidAgeDays).toBeDefined();
    expect(summary.oldestUnpaidAgeDays ?? 0).toBeGreaterThan(365);
  });

  it('returns empty summary when no commissions match the window', async () => {
    mockWithToken(fakeResponse(loadFixture('commissions_empty.json')));
    const summary = await skimlinksAdapter.getEarningsSummary({});
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
    ]);
    try {
      await skimlinksAdapter.listTransactions({});
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('skimlinks');
      expect(env.operation).toBe('listTransactions');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream exploded');
    }
  });

  it('classifies 401 on reporting API as auth_error', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('token.json')),
      fakeResponse('Forbidden', { status: 401, rawBody: 'Forbidden' }),
    ]);
    try {
      await skimlinksAdapter.listTransactions({});
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

describe('SkimlinksAdapter.capabilitiesCheck', () => {
  it('records listProgrammes, getProgramme, listClicks as not supported', async () => {
    // capabilitiesCheck probes: verifyAuth (token+check), listTransactions (token+data),
    // getEarningsSummary (token+data), and generateTrackingLink (just token).
    mockFetchQueue([
      fakeResponse(loadFixture('token.json')), // verifyAuth token
      fakeResponse(loadFixture('token.json')), // listTransactions token
      fakeResponse(loadFixture('commissions_empty.json')), // listTransactions data
      fakeResponse(loadFixture('token.json')), // getEarningsSummary → listTransactions token
      fakeResponse(loadFixture('commissions_empty.json')), // getEarningsSummary data
    ]);
    const caps = await skimlinksAdapter.capabilitiesCheck();
    expect(caps.network).toBe('skimlinks');
    expect(caps.operations['listProgrammes']?.supported).toBe(false);
    expect(caps.operations['getProgramme']?.supported).toBe(false);
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(true);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
