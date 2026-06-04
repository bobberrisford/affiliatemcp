/**
 * Indoleads adapter — unit tests.
 *
 * Pattern-matched to `tests/networks/skimlinks/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - Circuit breakers are reset in `beforeEach` so no test bleeds state.
 *   - Fake credentials are injected via `process.env` (obvious non-secret values).
 *   - Fixtures live under `tests/fixtures/indoleads/`.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 *
 * Indoleads uses a single API token (no OAuth token exchange), so each adapter
 * op makes exactly ONE fetch call — no token-fetch step to queue.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { indoleadsAdapter, _internals } from '../../../src/networks/indoleads/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'indoleads');

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

beforeEach(() => {
  _resetBreakers();
  process.env['INDOLEADS_API_TOKEN'] = 'test-token-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['INDOLEADS_API_TOKEN'];
});

// ---------------------------------------------------------------------------
// Transformer unit tests (status normalisation + raw preservation)
// ---------------------------------------------------------------------------

describe('Indoleads transformers (status normalisation, raw preservation)', () => {
  it('maps Indoleads conversion status strings to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'approved' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'confirmed' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'paid' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ status: 'declined' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'reversed' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'canceled' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'cancelled' })).toBe('reversed');
    // overaged is deliberately NOT a guess — maps to 'other'.
    expect(_internals.mapTransactionStatus({ status: 'overaged' })).toBe('other');
    expect(_internals.mapTransactionStatus({ status: 'unknown_future' })).toBe('other');
    expect(_internals.mapTransactionStatus({})).toBe('other');
  });

  it('maps Indoleads offer statuses to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ status: 'allow' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'approved' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'need approval' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ status: 'need_approval' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ status: 'declined' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ status: 'available' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ status: 'paused' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'something-new' })).toBe('unknown');
    expect(_internals.mapProgrammeStatus({})).toBe('unknown');
  });

  it('preserves raw Indoleads conversion payload in rawNetworkData', () => {
    const fixture = (loadFixture('conversions.json') as { data: unknown[] }).data;
    const raw = fixture[0] as Record<string, unknown>;
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('preserves raw Indoleads offer payload in rawNetworkData', () => {
    const fixture = (loadFixture('offers.json') as { data: unknown[] }).data;
    const raw = fixture[0] as Record<string, unknown>;
    const out = _internals.toProgramme(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('surfaces reversalReason on reversed transactions (§15.10)', () => {
    const fixture = (loadFixture('conversions.json') as { data: unknown[] }).data;
    const declined = fixture[2] as Record<string, unknown>;
    const out = _internals.toTransaction(declined as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Order cancelled by the customer');
  });

  it('computes ageDays from approved date (preferred), then conversion date', () => {
    const now = new Date('2026-06-04T00:00:00Z');
    // approved 2026-05-25 → 10 days
    const age1 = _internals.computeAgeDays(
      { approved_date: '2026-05-25T00:00:00Z', conversion_date: '2026-05-01T00:00:00Z' },
      now,
    );
    expect(age1).toBe(10);
    // no approved date → falls back to conversion date 2026-05-05 → 30 days
    const age2 = _internals.computeAgeDays({ conversion_date: '2026-05-05T00:00:00Z' }, now);
    expect(age2).toBe(30);
  });

  it('normalises string and number commission amounts', () => {
    expect(_internals.toAmount(5.5)).toBe(5.5);
    expect(_internals.toAmount('12.75')).toBe(12.75);
    expect(_internals.toAmount(undefined)).toBe(0);
    expect(_internals.toAmount('not-a-number')).toBe(0);
  });

  it('produces a structured percent commission rate from offer payout_type', () => {
    const fixture = (loadFixture('offers.json') as { data: unknown[] }).data;
    const offer = fixture[0] as Record<string, unknown>;
    const rate = _internals.toCommissionRate(offer as never);
    expect(typeof rate).toBe('object');
    if (typeof rate === 'object' && rate) {
      expect(rate.type).toBe('percent');
      expect(rate.value).toBe(10);
    }
  });
});

// ---------------------------------------------------------------------------
// listProgrammes — offers → programmes
// ---------------------------------------------------------------------------

describe('IndoleadsAdapter.listProgrammes', () => {
  it('maps offers to programmes with normalised status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const programmes = await indoleadsAdapter.listProgrammes();
    expect(programmes.length).toBe(3);
    expect(programmes[0]?.network).toBe('indoleads');
    expect(programmes[0]?.status).toBe('joined'); // status: allow
    expect(programmes[1]?.status).toBe('pending'); // status: need approval
    expect(programmes[2]?.status).toBe('suspended'); // status: paused
  });

  it('filters by canonical status client-side after normalisation', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const joined = await indoleadsAdapter.listProgrammes({ status: 'joined' });
    expect(joined.every((p) => p.status === 'joined')).toBe(true);
    expect(joined.length).toBe(1);
  });

  it('respects limit', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const limited = await indoleadsAdapter.listProgrammes({ limit: 2 });
    expect(limited.length).toBe(2);
  });

  it('returns empty array when no offers match', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers_empty.json'))]);
    const programmes = await indoleadsAdapter.listProgrammes();
    expect(programmes).toHaveLength(0);
  });

  it('emits a NetworkError when INDOLEADS_API_TOKEN is missing', async () => {
    delete process.env['INDOLEADS_API_TOKEN'];
    await expect(indoleadsAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getProgramme — derived from offers listing
// ---------------------------------------------------------------------------

describe('IndoleadsAdapter.getProgramme', () => {
  it('returns the matching offer as a programme', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const programme = await indoleadsAdapter.getProgramme('5002');
    expect(programme.id).toBe('5002');
    expect(programme.name).toBe('Example Electronics APAC');
    expect(programme.status).toBe('pending');
  });

  it('throws NetworkError when the offer is not found', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers_empty.json'))]);
    await expect(indoleadsAdapter.getProgramme('9999')).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws config_error when programmeId is empty', async () => {
    await expect(indoleadsAdapter.getProgramme('')).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listTransactions — unpaid-age + reversed visibility (§15.9, §15.10)
// ---------------------------------------------------------------------------

describe('IndoleadsAdapter.listTransactions', () => {
  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const aged = await indoleadsAdapter.listTransactions({
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
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const all = await indoleadsAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toBe('Order cancelled by the customer');
  });

  it('filters by status when caller passes status[]', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const only = await indoleadsAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('respects limit after all other filters are applied', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const limited = await indoleadsAdapter.listTransactions({ limit: 2 });
    expect(limited.length).toBeLessThanOrEqual(2);
  });

  it('emits a NetworkError when INDOLEADS_API_TOKEN is missing', async () => {
    delete process.env['INDOLEADS_API_TOKEN'];
    await expect(indoleadsAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary — derived from listTransactions
// ---------------------------------------------------------------------------

describe('IndoleadsAdapter.getEarningsSummary', () => {
  it('aggregates conversions correctly from fixture data', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const summary = await indoleadsAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    expect(summary.network).toBe('indoleads');
    expect(summary.totalEarnings).toBeCloseTo(6.5 + 14.0 + 4.25 + 9.0 + 2.1, 2);
    expect(summary.byStatus.pending).toBeCloseTo(6.5, 2);
    expect(summary.byStatus.approved).toBeCloseTo(14.0, 2);
    expect(summary.byStatus.reversed).toBeCloseTo(4.25, 2);
    expect(summary.byStatus.paid).toBeCloseTo(9.0, 2);
    expect(summary.byStatus.other).toBeCloseTo(2.1, 2); // overaged
    expect(summary.byProgramme.length).toBe(2);
  });

  it('sets oldestUnpaidAgeDays from the longest-pending approved transaction (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const summary = await indoleadsAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    // Conversion 30002 approved 2024-01-18, still unpaid — oldest.
    expect(summary.oldestUnpaidAgeDays).toBeDefined();
    expect(summary.oldestUnpaidAgeDays ?? 0).toBeGreaterThan(365);
  });

  it('does not pass limit through to the underlying listTransactions call', async () => {
    // Single fetch; the summary must aggregate ALL rows even though limit is set.
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const summary = await indoleadsAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
      limit: 1,
    });
    // 5 fixture rows aggregated → 2 distinct programmes, full total.
    expect(summary.byProgramme.length).toBe(2);
    expect(summary.totalEarnings).toBeCloseTo(6.5 + 14.0 + 4.25 + 9.0 + 2.1, 2);
  });

  it('returns empty summary when no conversions match the window', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions_empty.json'))]);
    const summary = await indoleadsAdapter.getEarningsSummary({});
    expect(summary.totalEarnings).toBe(0);
    expect(summary.byProgramme).toHaveLength(0);
    expect(summary.oldestUnpaidAgeDays).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listClicks — not exposed by the public API
// ---------------------------------------------------------------------------

describe('IndoleadsAdapter.listClicks', () => {
  it('throws NotImplementedError with an Indoleads-specific reason', async () => {
    await expect(indoleadsAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await indoleadsAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click-level data');
    }
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — real API call to /offers
// ---------------------------------------------------------------------------

describe('IndoleadsAdapter.generateTrackingLink', () => {
  it('reads the tracking link from the offer payload and appends destination', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const link = await indoleadsAdapter.generateTrackingLink({
      programmeId: '5001',
      destinationUrl: 'https://www.exampletravel.test/hotel?id=7',
    });
    expect(link.network).toBe('indoleads');
    expect(link.programmeId).toBe('5001');
    expect(link.trackingUrl).toContain('https://app.indoleads.com/go/5001');
    expect(link.trackingUrl).toContain(
      'url=https%3A%2F%2Fwww.exampletravel.test%2Fhotel%3Fid%3D7',
    );
  });

  it('uses & as the separator when the tracking link already has a query string', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const link = await indoleadsAdapter.generateTrackingLink({
      programmeId: '5002',
      destinationUrl: 'https://example.test/p',
    });
    expect(link.trackingUrl).toContain('?aff=1&url=');
  });

  it('throws config_error when programmeId is empty', async () => {
    await expect(
      indoleadsAdapter.generateTrackingLink({ programmeId: '', destinationUrl: 'https://x.test/' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws NetworkError when no tracking link is returned for the offer', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers_empty.json'))]);
    await expect(
      indoleadsAdapter.generateTrackingLink({
        programmeId: '5001',
        destinationUrl: 'https://x.test/',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws NetworkError when INDOLEADS_API_TOKEN is missing', async () => {
    delete process.env['INDOLEADS_API_TOKEN'];
    await expect(
      indoleadsAdapter.generateTrackingLink({
        programmeId: '5001',
        destinationUrl: 'https://x.test/',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth — happy + failure paths
// ---------------------------------------------------------------------------

describe('IndoleadsAdapter.verifyAuth', () => {
  it('returns ok:true and a redacted identity when the offers call succeeds', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const r = await indoleadsAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('indoleads/token:');
      // Must NOT leak the full token.
      expect(r.identity).not.toContain('test-token-please-ignore');
    }
  });

  it('surfaces a failure (does not throw) on 401 (§15.4)', async () => {
    mockFetchQueue([
      fakeResponse('{"message":"Unauthenticated."}', {
        status: 401,
        rawBody: '{"message":"Unauthenticated."}',
      }),
    ]);
    const r = await indoleadsAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/401|Unauthenticated|auth/i);
    }
  });

  it('returns ok:false when the token is missing (does not throw)', async () => {
    delete process.env['INDOLEADS_API_TOKEN'];
    await expect(indoleadsAdapter.verifyAuth()).resolves.toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('IndoleadsAdapter.validateCredential', () => {
  it('validates INDOLEADS_API_TOKEN via a live offers call', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const r = await indoleadsAdapter.validateCredential(
      'INDOLEADS_API_TOKEN',
      'another-test-token-please-ignore',
    );
    expect(r.ok).toBe(true);
  });

  it('rejects an empty INDOLEADS_API_TOKEN', async () => {
    const r = await indoleadsAdapter.validateCredential('INDOLEADS_API_TOKEN', '');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('returns ok:false with hint when the token is wrong', async () => {
    mockFetchQueue([
      fakeResponse('{"message":"Unauthenticated."}', {
        status: 401,
        rawBody: '{"message":"Unauthenticated."}',
      }),
    ]);
    const r = await indoleadsAdapter.validateCredential('INDOLEADS_API_TOKEN', 'bad-token');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('returns ok:false for unknown credential fields', async () => {
    const r = await indoleadsAdapter.validateCredential('INDOLEADS_UNKNOWN_FIELD', 'value');
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
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await indoleadsAdapter.listTransactions({});
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('indoleads');
      expect(env.operation).toBe('listTransactions');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream exploded');
    }
  });

  it('classifies 401 on the conversions call as auth_error', async () => {
    mockFetchQueue([fakeResponse('Forbidden', { status: 401, rawBody: 'Forbidden' })]);
    try {
      await indoleadsAdapter.listTransactions({});
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

describe('IndoleadsAdapter.capabilitiesCheck', () => {
  it('records listClicks as unsupported and probes the API-backed ops', async () => {
    // Probes in order: verifyAuth (offers), listProgrammes (offers),
    // listTransactions (conversions), getEarningsSummary → listTransactions (conversions).
    mockFetchQueue([
      fakeResponse(loadFixture('offers.json')), // verifyAuth
      fakeResponse(loadFixture('offers.json')), // listProgrammes
      fakeResponse(loadFixture('conversions_empty.json')), // listTransactions
      fakeResponse(loadFixture('conversions_empty.json')), // getEarningsSummary
    ]);
    const caps = await indoleadsAdapter.capabilitiesCheck();
    expect(caps.network).toBe('indoleads');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['verifyAuth']?.supported).toBe(true);
    expect(caps.operations['listProgrammes']?.supported).toBe(true);
    expect(caps.operations['listTransactions']?.supported).toBe(true);
    expect(caps.operations['getEarningsSummary']?.supported).toBe(true);
    expect(caps.operations['getProgramme']?.supported).toBe(true);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(true);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
