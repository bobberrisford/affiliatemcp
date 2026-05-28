/**
 * mrge adapter — unit tests.
 *
 * Pattern-matched to tests/networks/cj/adapter.test.ts and
 * tests/networks/awin/adapter.test.ts:
 *   - We mock `globalThis.fetch` to exercise the full client + resilience +
 *     transformer stack without live HTTP.
 *   - Fixtures live under `tests/fixtures/mrge/` and approximate Yieldkit
 *     API response shapes. No real tokens or real data.
 *   - PRD-relevant tests are tagged with §15.x in their `it` strings.
 *
 * NOTE: The mrge API shapes are built from public documentation and are
 * marked with // TODO(verify) where uncertain. Tests cover the normalisation
 * logic that is independent of the live API response shape.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { mrgeAdapter, _internals } from '../../../src/networks/mrge/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'mrge');

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
  process.env['MRGE_API_KEY'] = 'test-api-key';
  process.env['MRGE_API_SECRET'] = 'test-api-secret';
  process.env['MRGE_SITE_ID'] = '12345';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['MRGE_API_KEY'];
  delete process.env['MRGE_API_SECRET'];
  delete process.env['MRGE_SITE_ID'];
});

// ---------------------------------------------------------------------------
// Status normalisation
// ---------------------------------------------------------------------------

describe('mrge transformers (status normalisation, raw preservation)', () => {
  it('maps Yieldkit commission states to canonical TransactionStatus', () => {
    const open = _internals.toTransaction({ state: 'OPEN' } as never);
    const confirmed = _internals.toTransaction({ state: 'CONFIRMED' } as never);
    const rejected = _internals.toTransaction({ state: 'REJECTED' } as never);
    const delayed = _internals.toTransaction({ state: 'DELAYED' } as never);
    const unknown = _internals.toTransaction({ state: 'MYSTERY' } as never);

    expect(open.status).toBe('pending');
    expect(confirmed.status).toBe('approved');
    // REJECTED → reversed: the commission did not pay out.
    expect(rejected.status).toBe('reversed');
    // DELAYED → pending: approval is deferred but not rejected.
    expect(delayed.status).toBe('pending');
    expect(unknown.status).toBe('other');
  });

  it('maps mrge advertiser statuses to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ status: 'active' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'joined' })).toBe('joined');
    // No status field — endpoint returns only active advertisers.
    expect(_internals.mapProgrammeStatus({})).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'suspended' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'declined' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ status: 'weird_value' })).toBe('unknown');
  });

  it('preserves the raw mrge payload under rawNetworkData', () => {
    const records = loadFixture('commissions.json') as Record<string, unknown>[];
    const raw = records[0];
    if (!raw) throw new Error('fixture empty');
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('surfaces reversalReason from rejection_reason on REJECTED commissions (§15.10)', () => {
    const records = loadFixture('commissions.json') as Record<string, unknown>[];
    // Index 2 is the REJECTED record.
    const rejected = records[2];
    if (!rejected) throw new Error('fixture missing index 2');
    const out = _internals.toTransaction(rejected as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Customer returned the item within 14 days');
  });

  it('computes ageDays from modified_date (preferred), then sales_date, then click_date', () => {
    const now = new Date('2026-05-28T00:00:00Z');
    const age1 = _internals.computeAgeDays({ modified_date: '2026-01-01T00:00:00Z' } as never, now);
    // 2026-01-01 to 2026-05-28 = 147 days
    expect(age1).toBe(147);

    const age2 = _internals.computeAgeDays({ sales_date: '2026-04-01T00:00:00Z' } as never, now);
    // 2026-04-01 to 2026-05-28 = 57 days
    expect(age2).toBe(57);

    const age3 = _internals.computeAgeDays({ click_date: '2026-03-01T00:00:00Z' } as never, now);
    // 2026-03-01 to 2026-05-28 = 88 days
    expect(age3).toBe(88);

    const age4 = _internals.computeAgeDays({} as never, now);
    expect(age4).toBe(0);
  });

  it('parses numeric and string commission amounts', () => {
    expect(_internals.parseAmount(8.5)).toBe(8.5);
    expect(_internals.parseAmount('4.25')).toBeCloseTo(4.25);
    expect(_internals.parseAmount(undefined)).toBe(0);
    expect(_internals.parseAmount('not-a-number')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Programme normalisation
// ---------------------------------------------------------------------------

describe('mrge programme (toProgramme)', () => {
  it('maps structured commission rate to percent type', () => {
    const programme = _internals.toProgramme({
      id: 1001,
      name: 'Test Shop',
      commission: '8',
      commission_type: 'percent',
      currency: 'EUR',
      status: 'active',
    } as never);
    expect(programme.id).toBe('1001');
    expect(programme.status).toBe('joined');
    expect(programme.network).toBe('mrge');
    expect(typeof programme.commissionRate).toBe('object');
    const rate = programme.commissionRate as { type: string; value: number };
    expect(rate.type).toBe('percent');
    expect(rate.value).toBe(8);
  });

  it('handles comma-separated categories string', () => {
    const programme = _internals.toProgramme({
      id: 1,
      name: 'Shop',
      categories: 'books, education, science',
    } as never);
    expect(programme.categories).toEqual(['books', 'education', 'science']);
  });

  it('handles categories as an array', () => {
    const programme = _internals.toProgramme({
      id: 2,
      name: 'Shop2',
      categories: ['sports', 'outdoor'],
    } as never);
    expect(programme.categories).toEqual(['sports', 'outdoor']);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('mrge.listProgrammes', () => {
  it('returns programmes from an array response', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    const programmes = await mrgeAdapter.listProgrammes();
    expect(programmes.length).toBeGreaterThan(0);
    expect(programmes[0]?.network).toBe('mrge');
  });

  it('applies search filter client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    const programmes = await mrgeAdapter.listProgrammes({ search: 'atolls' });
    expect(programmes.every((p) => p.name.toLowerCase().includes('atolls'))).toBe(true);
    expect(programmes.length).toBe(1);
  });

  it('applies status filter client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    const programmes = await mrgeAdapter.listProgrammes({ status: 'suspended' });
    expect(programmes.every((p) => p.status === 'suspended')).toBe(true);
    expect(programmes.length).toBe(1);
  });

  it('respects limit', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    const programmes = await mrgeAdapter.listProgrammes({ limit: 1 });
    expect(programmes.length).toBe(1);
  });

  it('throws a config_error envelope when MRGE_API_KEY is missing', async () => {
    delete process.env['MRGE_API_KEY'];
    await expect(mrgeAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listTransactions — unpaid-age + reversed visibility (§15.9, §15.10)
// ---------------------------------------------------------------------------

describe('mrge.listTransactions', () => {
  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);
    const aged = await mrgeAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
      minAgeDays: 365,
    });
    for (const t of aged) {
      expect(t.ageDays).toBeGreaterThanOrEqual(365);
    }
    expect(aged.length).toBeGreaterThan(0);
  });

  it('includes reversed transactions with reason populated (§15.10)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);
    const all = await mrgeAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
    });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toBe('Customer returned the item within 14 days');
  });

  it('filters by status when caller passes status[]', async () => {
    mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);
    const only = await mrgeAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-05-28T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('emits an error envelope when the MRGE_API_SECRET is missing', async () => {
    delete process.env['MRGE_API_SECRET'];
    await expect(mrgeAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listClicks
// ---------------------------------------------------------------------------

describe('mrge.listClicks', () => {
  it('throws NotImplementedError with a mrge-specific reason', async () => {
    await expect(mrgeAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await mrgeAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('mrge does not expose click-level data');
    }
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink
// ---------------------------------------------------------------------------

describe('mrge.generateTrackingLink', () => {
  it('constructs a tracking URL using the advertiser tracking_url from fixture', async () => {
    // getProgramme → listProgrammes (filtered client-side)
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    const link = await mrgeAdapter.generateTrackingLink({
      programmeId: '1001',
      destinationUrl: 'https://www.atollsbookshop.example.com/books?q=test',
    });
    expect(link.network).toBe('mrge');
    expect(link.programmeId).toBe('1001');
    expect(link.trackingUrl).toContain('click.yieldkit.com/1001');
    expect(link.trackingUrl).toContain(encodeURIComponent('https://www.atollsbookshop.example.com/books?q=test'));
    expect(link.destinationUrl).toBe('https://www.atollsbookshop.example.com/books?q=test');
  });

  it('throws a config_error envelope when programmeId is missing', async () => {
    await expect(
      mrgeAdapter.generateTrackingLink({
        programmeId: '',
        destinationUrl: 'https://x.example.com',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error envelope when destinationUrl is missing', async () => {
    await expect(
      mrgeAdapter.generateTrackingLink({
        programmeId: '1001',
        destinationUrl: '',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('mrge.verifyAuth', () => {
  it('returns ok:true with identity when credentials are valid', async () => {
    mockFetchQueue([fakeResponse(loadFixture('auth_ok.json'))]);
    const r = await mrgeAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('mrge/site:12345');
    }
  });

  it('surfaces a failure on 401 (§15.4)', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_credentials"}', {
        status: 401,
        rawBody: '{"error":"invalid_credentials"}',
      }),
    ]);
    const r = await mrgeAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/401|auth/i);
  });

  it('returns ok:false when MRGE_SITE_ID is missing', async () => {
    delete process.env['MRGE_SITE_ID'];
    const r = await mrgeAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('mrge.validateCredential', () => {
  it('rejects malformed MRGE_SITE_ID (non-numeric, zero, negative)', async () => {
    expect((await mrgeAdapter.validateCredential('MRGE_SITE_ID', 'abc')).ok).toBe(false);
    expect((await mrgeAdapter.validateCredential('MRGE_SITE_ID', '0')).ok).toBe(false);
    expect((await mrgeAdapter.validateCredential('MRGE_SITE_ID', '-5')).ok).toBe(false);
  });

  it('accepts a valid MRGE_SITE_ID', async () => {
    expect((await mrgeAdapter.validateCredential('MRGE_SITE_ID', '12345')).ok).toBe(true);
  });

  it('accepts a non-trivially-short MRGE_API_KEY with a deferred-validation message', async () => {
    const r = await mrgeAdapter.validateCredential('MRGE_API_KEY', 'yk_longkey123');
    expect(r.ok).toBe(true);
  });

  it('rejects a suspiciously short MRGE_API_KEY', async () => {
    const r = await mrgeAdapter.validateCredential('MRGE_API_KEY', 'ab');
    expect(r.ok).toBe(false);
  });

  it('returns ok:false for an unknown field', async () => {
    const r = await mrgeAdapter.validateCredential('UNKNOWN_FIELD', 'value');
    expect(r.ok).toBe(false);
    expect(r.hint).toContain('MRGE_API_KEY');
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('mrge.capabilitiesCheck', () => {
  it('records listClicks.supported = false with the known-limitation note', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('auth_ok.json')),        // verifyAuth
      fakeResponse(loadFixture('advertisers.json')),    // listProgrammes
      fakeResponse(loadFixture('commissions.json')),    // listTransactions probe
      fakeResponse(loadFixture('commissions.json')),    // getEarningsSummary → listTransactions
    ]);
    const caps = await mrgeAdapter.capabilitiesCheck();
    expect(caps.network).toBe('mrge');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['listClicks']?.note).toContain('click-level data');
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim mrge response body on a 500', async () => {
    const body = '{"error":"upstream_failure","trace":"abc123"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await mrgeAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('mrge');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream_failure');
    }
  });

  it('classifies 401 as auth_error (§15.4)', async () => {
    mockFetchQueue([fakeResponse('forbidden', { status: 401, rawBody: 'forbidden' })]);
    try {
      await mrgeAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('auth_error');
    }
  });
});
