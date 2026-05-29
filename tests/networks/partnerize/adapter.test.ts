/**
 * Partnerize adapter — unit tests.
 *
 * Pattern-matched to `tests/networks/cj/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 *   - Fixtures live under `tests/fixtures/partnerize/` and approximate the
 *     shape of real Partnerize API responses. No real credentials, no live data.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { partnerizeAdapter, _internals } from '../../../src/networks/partnerize/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'partnerize');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

/**
 * Mint a fake `Response` with a JSON body (or raw body for failure paths).
 */
function fakeResponse(body: unknown, init: { status?: number; rawBody?: string } = {}): Response {
  const status = init.status ?? 200;
  const text = init.rawBody ?? (typeof body === 'string' ? body : JSON.stringify(body));
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Queue up mock fetch responses. Each call to `fetch` pops the front of the
 * queue. Tests that exhaust the queue get a thrown error — use this to detect
 * unexpected extra calls.
 */
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
  process.env['PARTNERIZE_APPLICATION_KEY'] = 'test-app-key';
  process.env['PARTNERIZE_USER_API_KEY'] = 'test-user-api-key';
  process.env['PARTNERIZE_PUBLISHER_ID'] = '1007802';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['PARTNERIZE_APPLICATION_KEY'];
  delete process.env['PARTNERIZE_USER_API_KEY'];
  delete process.env['PARTNERIZE_PUBLISHER_ID'];
});

// ---------------------------------------------------------------------------
// Transformation (status mapping + raw preservation)
// ---------------------------------------------------------------------------

describe('Partnerize transformers (status normalisation, raw preservation)', () => {
  it('maps Partnerize conversion_status values → canonical TransactionStatus', () => {
    const approved = _internals.toTransaction({ conversion_status: 'approved' } as never);
    const pending = _internals.toTransaction({ conversion_status: 'pending' } as never);
    const rejected = _internals.toTransaction({ conversion_status: 'rejected' } as never);
    const declined = _internals.toTransaction({ conversion_status: 'declined' } as never);
    const paid = _internals.toTransaction({ conversion_status: 'paid' } as never);
    const unknown = _internals.toTransaction({ conversion_status: 'something-else' } as never);

    expect(approved.status).toBe('approved');
    expect(pending.status).toBe('pending');
    // §15.10: 'rejected' must map to 'reversed' (publisher was not paid).
    expect(rejected.status).toBe('reversed');
    expect(declined.status).toBe('reversed');
    expect(paid.status).toBe('paid');
    // Unknown statuses → 'other', never invent a canonical status.
    expect(unknown.status).toBe('other');
  });

  it('maps campaign approval_state values → canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ approval_state: 'approved' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ approval_state: 'a' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ approval_state: 'active' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ approval_state: 'pending' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ approval_state: 'p' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ approval_state: 'rejected' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ approval_state: 'r' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ approval_state: 'suspended' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ approval_state: 'never-seen-before' })).toBe('unknown');
  });

  it('preserves the raw Partnerize payload under rawNetworkData', () => {
    const fixture = loadFixture('conversions.json') as {
      conversions: { conversion: Record<string, unknown>[] };
    };
    const raw = fixture.conversions.conversion[0];
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('surfaces reversalReason from reject_reason on reversed transactions (§15.10)', () => {
    const fixture = loadFixture('conversions.json') as {
      conversions: { conversion: Record<string, unknown>[] };
    };
    // Index 2 is the rejected conversion.
    const raw = fixture.conversions.conversion[2];
    const out = _internals.toTransaction(raw as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Customer returned the item within 14 days');
  });

  it('computes ageDays from conversion_date_time (preferred), then conversion_date', () => {
    const now = new Date('2026-05-28T00:00:00Z');
    // conversion_date_time present — 2026-01-15 = 133 days before 2026-05-28
    const age1 = _internals.computeAgeDays(
      { conversion_date_time: '2026-01-15T00:00:00Z' } as never,
      now,
    );
    expect(age1).toBe(133);

    // date-only fallback
    const age2 = _internals.computeAgeDays({ conversion_date: '2026-04-28' } as never, now);
    expect(age2).toBe(30);

    // no date → 0
    const age3 = _internals.computeAgeDays({} as never, now);
    expect(age3).toBe(0);
  });

  it('uses publisher_commission (not commission) for the canonical commission field', () => {
    const raw = {
      commission: '10.50',
      publisher_commission: '9.00',
      conversion_status: 'approved',
    };
    const out = _internals.toTransaction(raw as never);
    // publisher_commission should win.
    expect(out.commission).toBe(9.0);
  });

  it('falls back to commission when publisher_commission is absent', () => {
    const raw = { commission: '10.50', conversion_status: 'approved' };
    const out = _internals.toTransaction(raw as never);
    expect(out.commission).toBe(10.5);
  });

  it('maps programme commission type correctly', () => {
    const pct = _internals.toProgramme({
      campaign_id: '1',
      campaign_title: 'Test',
      default_commission: { value: '7.5', value_type: 'percentage' },
    });
    expect((pct.commissionRate as { type: string }).type).toBe('percent');

    const flat = _internals.toProgramme({
      campaign_id: '2',
      campaign_title: 'Test2',
      default_commission: { value: '5.00', value_type: 'fixed' },
    });
    expect((flat.commissionRate as { type: string }).type).toBe('flat');
  });
});

// ---------------------------------------------------------------------------
// listTransactions — unpaid-age + reversed visibility (§15.9, §15.10)
// ---------------------------------------------------------------------------

describe('Partnerize.listTransactions', () => {
  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    // Fixture contains Jan 2026, Mar 2026, and Sep 2024 conversions.
    // With minAgeDays=365 only the Sep 2024 conversion qualifies.
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);

    const aged = await partnerizeAdapter.listTransactions({
      from: '2024-01-01',
      to: '2026-05-28',
      minAgeDays: 365,
    });

    for (const t of aged) {
      expect(t.ageDays).toBeGreaterThanOrEqual(365);
    }
    expect(aged.length).toBeGreaterThan(0);
  });

  it('includes reversed transactions with reason populated (§15.10)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const all = await partnerizeAdapter.listTransactions({
      from: '2024-01-01',
      to: '2026-05-28',
    });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toBe('Customer returned the item within 14 days');
  });

  it('filters by status when caller passes status[]', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const pendingOnly = await partnerizeAdapter.listTransactions({
      from: '2024-01-01',
      to: '2026-05-28',
      status: ['pending'],
    });
    expect(pendingOnly.every((t) => t.status === 'pending')).toBe(true);
    expect(pendingOnly.length).toBeGreaterThan(0);
  });

  it('emits an error envelope when the application key is missing (§15.4)', async () => {
    delete process.env['PARTNERIZE_APPLICATION_KEY'];
    await expect(partnerizeAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });

  it('emits an error envelope when the publisher id is missing', async () => {
    delete process.env['PARTNERIZE_PUBLISHER_ID'];
    await expect(partnerizeAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });

  it('limits results to query.limit', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const limited = await partnerizeAdapter.listTransactions({
      from: '2024-01-01',
      to: '2026-05-28',
      limit: 1,
    });
    expect(limited.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('Partnerize.listProgrammes', () => {
  it('returns mapped programmes from the campaigns fixture', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const programmes = await partnerizeAdapter.listProgrammes();
    expect(programmes.length).toBe(2);
    expect(programmes[0]?.id).toBe('10l176');
    expect(programmes[0]?.name).toBe('Acme Online Shop');
    expect(programmes[0]?.network).toBe('partnerize');
  });

  it('applies search filter client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const filtered = await partnerizeAdapter.listProgrammes({ search: 'acme' });
    expect(filtered.length).toBe(1);
    expect(filtered[0]?.name).toContain('Acme');
  });

  it('applies limit', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const limited = await partnerizeAdapter.listProgrammes({ limit: 1 });
    expect(limited.length).toBe(1);
  });

  it('emits an error envelope when credentials are missing', async () => {
    delete process.env['PARTNERIZE_APPLICATION_KEY'];
    await expect(partnerizeAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listClicks
// ---------------------------------------------------------------------------

describe('Partnerize.listClicks', () => {
  it('returns mapped clicks from the clicks fixture', async () => {
    mockFetchQueue([fakeResponse(loadFixture('clicks.json'))]);
    const clicks = await partnerizeAdapter.listClicks({
      from: '2026-04-01',
      to: '2026-04-30',
    });
    expect(clicks.length).toBe(2);
    expect(clicks[0]?.id).toBe('click_001');
    expect(clicks[0]?.network).toBe('partnerize');
    expect(clicks[0]?.programmeId).toBe('10l176');
  });

  it('preserves rawNetworkData on click records', async () => {
    mockFetchQueue([fakeResponse(loadFixture('clicks.json'))]);
    const clicks = await partnerizeAdapter.listClicks({});
    expect(clicks[0]?.rawNetworkData).toBeDefined();
  });

  it('emits an error envelope when credentials are missing', async () => {
    delete process.env['PARTNERIZE_USER_API_KEY'];
    await expect(partnerizeAdapter.listClicks({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — deterministic URL construction
// ---------------------------------------------------------------------------

describe('Partnerize.generateTrackingLink', () => {
  it('constructs the prf.hn camref deep-link with URL-encoded destination', async () => {
    const link = await partnerizeAdapter.generateTrackingLink({
      programmeId: '1101l3ofu',
      destinationUrl: 'https://www.acme-example.com/product?id=123&name=foo bar',
    });
    expect(link.trackingUrl).toContain('https://prf.hn/click/camref:1101l3ofu/destination:');
    expect(link.trackingUrl).toContain(
      encodeURIComponent('https://www.acme-example.com/product?id=123&name=foo bar'),
    );
    expect(link.network).toBe('partnerize');
    expect(link.programmeId).toBe('1101l3ofu');
  });

  it('throws a config_error envelope when programmeId (camref) is missing', async () => {
    await expect(
      partnerizeAdapter.generateTrackingLink({
        programmeId: '',
        destinationUrl: 'https://x.example.com',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error envelope when destinationUrl is missing', async () => {
    await expect(
      partnerizeAdapter.generateTrackingLink({
        programmeId: '1101l3ofu',
        destinationUrl: '',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('does NOT call fetch (deterministic construction)', async () => {
    const spy = mockFetchQueue([]);
    await partnerizeAdapter.generateTrackingLink({
      programmeId: '1101l3ofu',
      destinationUrl: 'https://x.example.com',
    });
    expect(spy.mock.calls.length).toBe(0);
  });

  it('includes construction context in rawNetworkData', async () => {
    const link = await partnerizeAdapter.generateTrackingLink({
      programmeId: '1101l3ofu',
      destinationUrl: 'https://x.example.com',
    });
    const raw = link.rawNetworkData as Record<string, unknown>;
    expect(raw['camref']).toBe('1101l3ofu');
    expect(raw['format']).toContain('prf.hn');
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('Partnerize.verifyAuth (happy path)', () => {
  it('returns ok:true with identity when GET /user/publisher responds 200', async () => {
    mockFetchQueue([fakeResponse(loadFixture('publisher.json'))]);
    const r = await partnerizeAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('partnerize');
    }
  });

  it('surfaces a NetworkError shape on 401 (§15.4)', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_credentials"}', {
        status: 401,
        rawBody: '{"error":"invalid_credentials"}',
      }),
    ]);
    const r = await partnerizeAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/HTTP 401|401/);
    }
  });
});

// ---------------------------------------------------------------------------
// Admin operations (NotImplementedError)
// ---------------------------------------------------------------------------

describe('Partnerize admin operations', () => {
  it('listPublishers throws NotImplementedError', async () => {
    await expect(partnerizeAdapter.listPublishers()).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('listPublisherSectors throws NotImplementedError', async () => {
    await expect(partnerizeAdapter.listPublisherSectors()).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('Partnerize.validateCredential', () => {
  it('rejects empty application key', async () => {
    const r = await partnerizeAdapter.validateCredential('PARTNERIZE_APPLICATION_KEY', '');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('rejects malformed publisher IDs', async () => {
    const r1 = await partnerizeAdapter.validateCredential('PARTNERIZE_PUBLISHER_ID', 'abc');
    expect(r1.ok).toBe(false);
    const r2 = await partnerizeAdapter.validateCredential('PARTNERIZE_PUBLISHER_ID', '-5');
    expect(r2.ok).toBe(false);
    const r3 = await partnerizeAdapter.validateCredential('PARTNERIZE_PUBLISHER_ID', '0');
    expect(r3.ok).toBe(false);
  });

  it('accepts well-formed publisher IDs', async () => {
    const r = await partnerizeAdapter.validateCredential('PARTNERIZE_PUBLISHER_ID', '1007802');
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with a hint for unknown field names', async () => {
    const r = await partnerizeAdapter.validateCredential('PARTNERIZE_UNKNOWN_FIELD', 'value');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('Partnerize.capabilitiesCheck', () => {
  it('marks generateTrackingLink as supported without probing', async () => {
    // Stub fetches for: listProgrammes, listTransactions probe,
    // getEarningsSummary → listTransactions, listClicks probe, verifyAuth.
    mockFetchQueue([
      fakeResponse(loadFixture('campaigns.json')),                // listProgrammes
      fakeResponse(loadFixture('conversions.json')),              // listTransactions probe
      fakeResponse(loadFixture('conversions.json')),              // getEarningsSummary → listTransactions
      fakeResponse(loadFixture('clicks.json')),                   // listClicks probe
      fakeResponse(loadFixture('publisher.json')),                // verifyAuth
    ]);
    const caps = await partnerizeAdapter.capabilitiesCheck();
    expect(caps.network).toBe('partnerize');
    expect(caps.operations['generateTrackingLink']?.supported).toBe(true);
    expect(caps.operations['generateTrackingLink']?.note).toContain('Deterministic');
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });

  it('marks listClicks as experimental', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('campaigns.json')),
      fakeResponse(loadFixture('conversions.json')),
      fakeResponse(loadFixture('conversions.json')),
      fakeResponse(loadFixture('clicks.json')),
      fakeResponse(loadFixture('publisher.json')),
    ]);
    const caps = await partnerizeAdapter.capabilitiesCheck();
    expect(caps.operations['listClicks']?.claimStatus).toBe('experimental');
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim Partnerize response body on a 500', async () => {
    const body = '{"error":"internal server error","trace":"abc123"}';
    // Three responses to satisfy retry attempts.
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await partnerizeAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('partnerize');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('internal server error');
    }
  });

  it('classifies 401 as auth_error (§15.4)', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"unauthorized"}', { status: 401, rawBody: '{"error":"unauthorized"}' }),
    ]);
    try {
      await partnerizeAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('auth_error');
    }
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('Partnerize.getEarningsSummary', () => {
  it('derives byStatus totals from listTransactions', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const summary = await partnerizeAdapter.getEarningsSummary({
      from: '2024-01-01',
      to: '2026-05-28',
    });
    expect(summary.network).toBe('partnerize');
    expect(summary.totalEarnings).toBeGreaterThan(0);
    // The fixture has 1 approved, 1 pending, 1 reversed.
    expect(summary.byStatus.approved).toBeGreaterThan(0);
    expect(summary.byStatus.pending).toBeGreaterThan(0);
    // Reversed commissions still contribute to the reversed bucket.
    expect(summary.byStatus.reversed).toBeGreaterThan(0);
  });

  it('computes oldestUnpaidAgeDays from pending + approved transactions (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const now = new Date('2026-05-28T00:00:00Z');
    // Use a custom now by injecting via _internals.computeAgeDays in transformer
    // (the summary calls listTransactions which uses new Date() internally;
    // we simply assert the value is > 0, relying on the computeAgeDays unit test
    // for precision).
    const summary = await partnerizeAdapter.getEarningsSummary({
      from: '2024-01-01',
      to: now.toISOString(),
    });
    expect(summary.oldestUnpaidAgeDays).toBeGreaterThan(0);
  });

  it('groups earnings by programme', async () => {
    mockFetchQueue([fakeResponse(loadFixture('conversions.json'))]);
    const summary = await partnerizeAdapter.getEarningsSummary({
      from: '2024-01-01',
      to: '2026-05-28',
    });
    expect(summary.byProgramme.length).toBeGreaterThan(0);
    const programmeIds = summary.byProgramme.map((p) => p.programmeId);
    expect(programmeIds).toContain('10l176');
  });
});

// ---------------------------------------------------------------------------
// formatPartnerizeDate helper
// ---------------------------------------------------------------------------

describe('_internals.formatPartnerizeDate', () => {
  it('formats a Date as YYYY-MM-DD', () => {
    const d = new Date('2026-03-15T12:00:00Z');
    expect(_internals.formatPartnerizeDate(d)).toBe('2026-03-15');
  });
});

// ---------------------------------------------------------------------------
// pickPartnerizeStatuses helper
// ---------------------------------------------------------------------------

describe('_internals.pickPartnerizeStatuses', () => {
  it('defaults to approved when no statuses given', () => {
    expect(_internals.pickPartnerizeStatuses(undefined)).toEqual(['a']);
    expect(_internals.pickPartnerizeStatuses([])).toEqual(['a']);
  });

  it('maps joined → a, pending → p, declined → r', () => {
    const result = _internals.pickPartnerizeStatuses(['joined', 'pending', 'declined']);
    expect(result).toContain('a');
    expect(result).toContain('p');
    expect(result).toContain('r');
  });

  it('ignores unsupported statuses (available, suspended, unknown)', () => {
    const result = _internals.pickPartnerizeStatuses(['available', 'suspended', 'unknown']);
    // All unsupported → fall back to default ['a']
    expect(result).toEqual(['a']);
  });
});
