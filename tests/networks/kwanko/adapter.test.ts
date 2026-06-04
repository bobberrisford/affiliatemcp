/**
 * Kwanko adapter — unit tests.
 *
 * Pattern-matched to `tests/networks/skimlinks/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - Circuit breakers are reset in `beforeEach` so no test bleeds state.
 *   - Fake credentials are injected via `process.env` (obvious non-secret values).
 *   - Fixtures live under `tests/fixtures/kwanko/`.
 *   - Date-sensitive transformer tests inject `now` so they never drift in CI.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { kwankoAdapter, _internals } from '../../../src/networks/kwanko/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'kwanko');

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
  process.env['KWANKO_API_TOKEN'] = 'test-api-token-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['KWANKO_API_TOKEN'];
});

// ---------------------------------------------------------------------------
// Transformer unit tests (status normalisation + raw preservation)
// ---------------------------------------------------------------------------

describe('Kwanko transformers (status normalisation, raw preservation)', () => {
  it('maps Kwanko conversion status strings to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'waiting' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'validated' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'confirmed' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'paid' })).toBe('paid');
    // refused → reversed (the user-facing intent: the sale didn't pay out).
    expect(_internals.mapTransactionStatus({ status: 'refused' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'cancelled' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'rejected' })).toBe('reversed');
    // reads `state` as a fallback key.
    expect(_internals.mapTransactionStatus({ state: 'validated' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'unknown_future_status' })).toBe('other');
    expect(_internals.mapTransactionStatus({})).toBe('other');
  });

  it('maps Kwanko campaign statuses to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ status: 'active' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'running' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ status: 'refused' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ status: 'available' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ status: 'paused' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'closed' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'something-new' })).toBe('unknown');
    expect(_internals.mapProgrammeStatus({})).toBe('unknown');
  });

  it('preserves raw Kwanko conversion payload in rawNetworkData', () => {
    const fixture = (loadFixture('conversions.json') as { data: unknown[] }).data;
    const raw = fixture[0] as Record<string, unknown>;
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('preserves raw Kwanko campaign payload in rawNetworkData', () => {
    const fixture = (loadFixture('campaigns.json') as { data: unknown[] }).data;
    const raw = fixture[0] as Record<string, unknown>;
    const out = _internals.toProgramme(raw as never);
    expect(out.rawNetworkData).toBe(raw);
    expect(out.network).toBe('kwanko');
  });

  it('surfaces reversalReason from refusal_reason on reversed transactions (§15.10)', () => {
    const fixture = (loadFixture('conversions.json') as { data: unknown[] }).data;
    // Fixture index 2 is the refused conversion.
    const refused = fixture[2] as Record<string, unknown>;
    const out = _internals.toTransaction(refused as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Commande annulee par le client');
  });

  it('computes ageDays from validation_date (preferred), then conversion_date', () => {
    const now = new Date('2026-06-04T00:00:00Z');
    // validation_date = 2026-05-27 → 8 days
    const age1 = _internals.computeAgeDays(
      { validation_date: '2026-05-27T00:00:00Z', conversion_date: '2026-05-01T00:00:00Z' },
      now,
    );
    expect(age1).toBe(8);
    // No validation_date → falls back to conversion_date = 2026-05-15 → 20 days
    const age2 = _internals.computeAgeDays(
      { conversion_date: '2026-05-15T00:00:00Z' },
      now,
    );
    expect(age2).toBe(20);
    // No anchor at all → 0
    expect(_internals.computeAgeDays({}, now)).toBe(0);
  });

  it('normalises string and number commission amounts', () => {
    expect(_internals.toAmount(5.5)).toBe(5.5);
    expect(_internals.toAmount('12.75')).toBe(12.75);
    expect(_internals.toAmount(undefined)).toBe(0);
    expect(_internals.toAmount('not-a-number')).toBe(0);
  });

  it('reads alternative collection keys defensively', () => {
    expect(_internals.pickConversionArray({ conversions: [{ id: '1' }] }).length).toBe(1);
    expect(_internals.pickConversionArray({ items: [{ id: '1' }] }).length).toBe(1);
    expect(_internals.pickConversionArray({}).length).toBe(0);
    expect(_internals.pickCampaignArray({ campaigns: [{ id: '1' }] }).length).toBe(1);
    expect(_internals.pickCampaignArray({}).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// listTransactions — unpaid-age + reversed visibility (§15.9, §15.10)
// ---------------------------------------------------------------------------

describe('KwankoAdapter.listTransactions', () => {
  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const aged = await kwankoAdapter.listTransactions({
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
    const all = await kwankoAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toBe('Commande annulee par le client');
  });

  it('filters by status when caller passes status[]', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const only = await kwankoAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('filters by programmeId client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const only = await kwankoAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
      programmeId: '5002',
    });
    expect(only.every((t) => t.programmeId === '5002')).toBe(true);
    expect(only.length).toBe(2);
  });

  it('respects limit after all other filters are applied', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const limited = await kwankoAdapter.listTransactions({ limit: 2 });
    expect(limited.length).toBeLessThanOrEqual(2);
  });

  it('emits a NetworkError when KWANKO_API_TOKEN is missing', async () => {
    delete process.env['KWANKO_API_TOKEN'];
    await expect(kwankoAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes / getProgramme — campaigns
// ---------------------------------------------------------------------------

describe('KwankoAdapter.listProgrammes', () => {
  it('maps campaigns to programmes', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const programmes = await kwankoAdapter.listProgrammes();
    expect(programmes.length).toBe(3);
    expect(programmes[0]?.network).toBe('kwanko');
    expect(programmes[0]?.name).toBe('Voyages Exemple SARL');
    expect(programmes[0]?.status).toBe('joined');
  });

  it('filters programmes by status client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const pending = await kwankoAdapter.listProgrammes({ status: 'pending' });
    expect(pending.every((p) => p.status === 'pending')).toBe(true);
    expect(pending.length).toBe(1);
  });

  it('filters programmes by search term', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const matches = await kwankoAdapter.listProgrammes({ search: 'boutique' });
    expect(matches.length).toBe(1);
    expect(matches[0]?.id).toBe('5002');
  });

  it('returns an empty list when no campaigns are present', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns_empty.json'))]);
    const programmes = await kwankoAdapter.listProgrammes();
    expect(programmes).toHaveLength(0);
  });

  it('emits a NetworkError when KWANKO_API_TOKEN is missing', async () => {
    delete process.env['KWANKO_API_TOKEN'];
    await expect(kwankoAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('KwankoAdapter.getProgramme', () => {
  it('fetches a single campaign by id', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaign.json'))]);
    const programme = await kwankoAdapter.getProgramme('5001');
    expect(programme.id).toBe('5001');
    expect(programme.name).toBe('Voyages Exemple SARL');
    expect(programme.status).toBe('joined');
    expect(programme.network).toBe('kwanko');
  });
});

// ---------------------------------------------------------------------------
// listClicks — not exposed at row level
// ---------------------------------------------------------------------------

describe('KwankoAdapter.listClicks', () => {
  it('throws NotImplementedError with a Kwanko-specific reason', async () => {
    await expect(kwankoAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await kwankoAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click-level data');
    }
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — not constructible from the token
// ---------------------------------------------------------------------------

describe('KwankoAdapter.generateTrackingLink', () => {
  it('throws NotImplementedError with a Kwanko-specific reason', async () => {
    await expect(
      kwankoAdapter.generateTrackingLink({
        programmeId: '5001',
        destinationUrl: 'https://example.test/page',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await kwankoAdapter.generateTrackingLink({
        programmeId: '5001',
        destinationUrl: 'https://example.test/page',
      });
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('per campaign and per site');
    }
  });
});

// ---------------------------------------------------------------------------
// verifyAuth — happy + failure paths
// ---------------------------------------------------------------------------

describe('KwankoAdapter.verifyAuth', () => {
  it('returns ok:true and identity when the authenticated call succeeds', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const r = await kwankoAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('kwanko/token:');
    }
  });

  it('surfaces a failure (does not throw) on 401 (§15.4)', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_token"}', {
        status: 401,
        rawBody: '{"error":"invalid_token"}',
      }),
    ]);
    const r = await kwankoAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/HTTP 401|401|invalid_token|auth/i);
    }
  });

  it('returns ok:false (does not throw) when the token is missing', async () => {
    delete process.env['KWANKO_API_TOKEN'];
    await expect(kwankoAdapter.verifyAuth()).resolves.toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('KwankoAdapter.validateCredential', () => {
  it('validates KWANKO_API_TOKEN via a live authenticated call', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const r = await kwankoAdapter.validateCredential(
      'KWANKO_API_TOKEN',
      'fresh-token-please-ignore',
    );
    expect(r.ok).toBe(true);
  });

  it('rejects an empty KWANKO_API_TOKEN without an API call', async () => {
    const r = await kwankoAdapter.validateCredential('KWANKO_API_TOKEN', '');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('returns ok:false with a hint when the token is wrong', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_token"}', {
        status: 401,
        rawBody: '{"error":"invalid_token"}',
      }),
    ]);
    const r = await kwankoAdapter.validateCredential('KWANKO_API_TOKEN', 'bad-token');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('returns ok:false for unknown credential fields', async () => {
    const r = await kwankoAdapter.validateCredential('KWANKO_UNKNOWN_FIELD', 'value');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary — derived from listTransactions
// ---------------------------------------------------------------------------

describe('KwankoAdapter.getEarningsSummary', () => {
  it('aggregates conversions correctly from fixture data', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const summary = await kwankoAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    expect(summary.network).toBe('kwanko');
    expect(summary.totalEarnings).toBeCloseTo(6.0 + 12.5 + 2.0 + 4.5, 2);
    expect(summary.byStatus.pending).toBeCloseTo(6.0, 2);
    expect(summary.byStatus.approved).toBeCloseTo(12.5, 2);
    expect(summary.byStatus.reversed).toBeCloseTo(2.0, 2);
    expect(summary.byStatus.paid).toBeCloseTo(4.5, 2);
    expect(summary.byProgramme.length).toBe(2);
    expect(summary.currency).toBe('EUR');
  });

  it('sets oldestUnpaidAgeDays from the longest-pending/approved transaction (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const summary = await kwankoAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    // Conversion 30002 was validated on 2024-01-18 and is still unpaid — oldest.
    expect(summary.oldestUnpaidAgeDays).toBeDefined();
    expect(summary.oldestUnpaidAgeDays ?? 0).toBeGreaterThan(365);
  });

  it('returns an empty summary when no conversions match the window', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions_empty.json'))]);
    const summary = await kwankoAdapter.getEarningsSummary({});
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
      await kwankoAdapter.listTransactions({});
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('kwanko');
      expect(env.operation).toBe('listTransactions');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream exploded');
    }
  });

  it('classifies 401 on the conversions endpoint as auth_error', async () => {
    mockFetchQueue([fakeResponse('Forbidden', { status: 401, rawBody: 'Forbidden' })]);
    try {
      await kwankoAdapter.listTransactions({});
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

describe('KwankoAdapter.capabilitiesCheck', () => {
  it('records listClicks and generateTrackingLink as not supported', async () => {
    // capabilitiesCheck probes: verifyAuth, listProgrammes, listTransactions,
    // getEarningsSummary (→ listTransactions). Each is a single authenticated call.
    mockFetchQueue([
      fakeResponse(loadFixture('campaigns.json')), // verifyAuth
      fakeResponse(loadFixture('campaigns_empty.json')), // listProgrammes
      fakeResponse(loadFixture('conversions_empty.json')), // listTransactions
      fakeResponse(loadFixture('conversions_empty.json')), // getEarningsSummary → listTransactions
    ]);
    const caps = await kwankoAdapter.capabilitiesCheck();
    expect(caps.network).toBe('kwanko');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
    expect(caps.operations['verifyAuth']?.supported).toBe(true);
    expect(caps.operations['listProgrammes']?.supported).toBe(true);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
