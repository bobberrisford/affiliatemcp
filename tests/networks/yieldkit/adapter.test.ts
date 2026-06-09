/**
 * Yieldkit adapter — unit tests.
 *
 * Patterns mirrored from `tests/networks/awin/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly — the seam between adapter and
 *     network — so the full client + resilience + transformer stack is
 *     exercised with no live HTTP.
 *   - Each test stubs only the fetch responses it needs.
 *   - No live calls; credentials are stubbed in env.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { yieldkitAdapter, _internals } from '../../../src/networks/yieldkit/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'yieldkit');

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
  process.env['YIELDKIT_API_KEY'] = 'test-key-please-ignore';
  process.env['YIELDKIT_API_SECRET'] = 'test-secret-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['YIELDKIT_API_KEY'];
  delete process.env['YIELDKIT_API_SECRET'];
});

// ---------------------------------------------------------------------------
// Transformers (status normalisation + raw preservation)
// ---------------------------------------------------------------------------

describe('Yieldkit transformers', () => {
  it('maps OPEN|CONFIRMED|REJECTED|DELAYED → canonical statuses', () => {
    const c = loadFixture('commissions.json') as { commissions: Array<Record<string, unknown>> };
    const confirmed = _internals.toTransaction(c.commissions[0] as never);
    const open = _internals.toTransaction(c.commissions[1] as never);
    const rejected = _internals.toTransaction(c.commissions[2] as never);
    const delayed = _internals.toTransaction(c.commissions[3] as never);
    expect(confirmed.status).toBe('approved');
    expect(open.status).toBe('pending');
    expect(rejected.status).toBe('reversed');
    expect(delayed.status).toBe('pending');
  });

  it('preserves the raw commission payload under rawNetworkData', () => {
    const raw = (loadFixture('commissions.json') as { commissions: Array<Record<string, unknown>> })
      .commissions[0];
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('surfaces reversalReason on reversed commissions (§15.10)', () => {
    const rejected = (loadFixture('commissions.json') as {
      commissions: Array<Record<string, unknown>>;
    }).commissions[2];
    const out = _internals.toTransaction(rejected as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Customer returned the item within 14 days');
  });

  it('parses decimal amounts as major currency units (floats)', () => {
    expect(_internals.toAmount('6.00')).toBe(6);
    expect(_internals.toAmount(10.5)).toBe(10.5);
    expect(_internals.toAmount(undefined)).toBe(0);
    expect(_internals.toAmount('not-a-number')).toBe(0);
  });

  it('maps advertiser status to canonical ProgrammeStatus (missing → joined)', () => {
    expect(_internals.mapProgrammeStatus({ status: 'active' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'paused' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'rejected' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ status: 'inactive' })).toBe('available');
    expect(_internals.mapProgrammeStatus({})).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'mystery' })).toBe('joined');
  });

  it('computes ageDays from confirmed/modified then sale date', () => {
    const now = new Date('2026-06-06T00:00:00Z');
    const age1 = _internals.computeAgeDays({ confirmed_date: '2026-01-01T00:00:00Z' }, now);
    expect(age1).toBe(156);
    const age2 = _internals.computeAgeDays({ sales_date: '2026-05-07T00:00:00Z' }, now);
    expect(age2).toBe(30);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('Yieldkit.listProgrammes', () => {
  it('maps advertiser offers to programmes', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    const programmes = await yieldkitAdapter.listProgrammes();
    expect(programmes.length).toBe(3);
    expect(programmes[0]?.name).toBe('Atolls Bookshop');
    expect(programmes[0]?.network).toBe('yieldkit');
    expect(programmes[0]?.status).toBe('joined');
  });

  it('filters by search substring', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    const programmes = await yieldkitAdapter.listProgrammes({ search: 'outdoors' });
    expect(programmes.length).toBe(1);
    expect(programmes[0]?.name).toBe('Atolls Outdoors');
  });

  it('emits a NetworkError when credentials are missing', async () => {
    delete process.env['YIELDKIT_API_KEY'];
    await expect(yieldkitAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getProgramme
// ---------------------------------------------------------------------------

describe('Yieldkit.getProgramme', () => {
  it('returns the matching advertiser', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    const p = await yieldkitAdapter.getProgramme('1002');
    expect(p.id).toBe('1002');
    expect(p.name).toBe('Atolls Outdoors');
    expect(p.status).toBe('suspended');
  });

  it('throws a config_error envelope when the id is blank', async () => {
    await expect(yieldkitAdapter.getProgramme('')).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a network_api_error envelope when the id is unknown', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    await expect(yieldkitAdapter.getProgramme('9999')).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('Yieldkit.listTransactions', () => {
  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);
    const aged = await yieldkitAdapter.listTransactions({
      from: '2024-01-01',
      to: '2026-06-06',
      minAgeDays: 365,
    });
    for (const t of aged) expect(t.ageDays).toBeGreaterThanOrEqual(365);
    expect(aged.length).toBeGreaterThan(0);
  });

  it('includes reversed transactions with reason populated (§15.10)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);
    const all = await yieldkitAdapter.listTransactions({ from: '2024-01-01', to: '2026-06-06' });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toBe('Customer returned the item within 14 days');
  });

  it('filters by status when caller passes status[]', async () => {
    mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);
    const only = await yieldkitAdapter.listTransactions({
      from: '2024-01-01',
      to: '2026-06-06',
      status: ['pending'],
    });
    expect(only.every((t) => t.status === 'pending')).toBe(true);
    expect(only.length).toBe(2);
  });

  it('follows the next pagination url across pages', async () => {
    const page1 = { next: 'https://api.yieldkit.com/v3/report/commission?page=2', commissions: [
      (loadFixture('commissions.json') as { commissions: unknown[] }).commissions[0],
    ] };
    const page2 = { commissions: [
      (loadFixture('commissions.json') as { commissions: unknown[] }).commissions[1],
    ] };
    const spy = mockFetchQueue([fakeResponse(page1), fakeResponse(page2)]);
    const txns = await yieldkitAdapter.listTransactions({ from: '2024-01-01', to: '2026-06-06' });
    expect(spy.mock.calls.length).toBe(2);
    expect(txns.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('Yieldkit.getEarningsSummary', () => {
  it('aggregates commission by status and programme', async () => {
    mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);
    const summary = await yieldkitAdapter.getEarningsSummary({
      from: '2024-01-01',
      to: '2026-06-06',
    });
    expect(summary.network).toBe('yieldkit');
    // approved: 6.00, pending: 1.40 + 10.00, reversed: 0
    expect(summary.byStatus.approved).toBeCloseTo(6);
    expect(summary.byStatus.pending).toBeCloseTo(11.4);
    expect(summary.totalEarnings).toBeCloseTo(17.4);
    expect(summary.oldestUnpaidAgeDays).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// listClicks
// ---------------------------------------------------------------------------

describe('Yieldkit.listClicks', () => {
  it('returns click rows from the report', async () => {
    mockFetchQueue([fakeResponse(loadFixture('clicks.json'))]);
    const clicks = await yieldkitAdapter.listClicks({ from: '2026-05-01', to: '2026-05-31' });
    expect(clicks.length).toBe(2);
    expect(clicks[0]?.network).toBe('yieldkit');
    expect(clicks[0]?.destinationUrl).toContain('atolls-bookshop');
    // referrer falls back to `source` when `referrer` is absent.
    expect(clicks[1]?.referrer).toContain('blog.example.com/gear');
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — deterministic construction
// ---------------------------------------------------------------------------

describe('Yieldkit.generateTrackingLink', () => {
  it('constructs a redirect URL with the encoded destination', async () => {
    const link = await yieldkitAdapter.generateTrackingLink({
      programmeId: '1001',
      destinationUrl: 'https://www.atolls-bookshop.example.com/path?q=a b',
    });
    expect(link.trackingUrl).toContain('https://r.srvtrck.com/v1/redirect');
    expect(link.trackingUrl).toContain('type=url');
    expect(link.trackingUrl).toContain('api_key=test-key-please-ignore');
    expect(link.trackingUrl).toContain('url=https%3A%2F%2Fwww.atolls-bookshop.example.com');
    expect(link.network).toBe('yieldkit');
  });

  it('does NOT call fetch (deterministic construction)', async () => {
    const spy = mockFetchQueue([]);
    await yieldkitAdapter.generateTrackingLink({
      programmeId: '1001',
      destinationUrl: 'https://x.example.com',
    });
    expect(spy.mock.calls.length).toBe(0);
  });

  it('throws a config_error envelope when destinationUrl is missing', async () => {
    await expect(
      yieldkitAdapter.generateTrackingLink({ programmeId: '1001', destinationUrl: '' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('Yieldkit.verifyAuth', () => {
  it('returns ok:true when the advertiser probe responds 200', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    const r = await yieldkitAdapter.verifyAuth();
    expect(r.ok).toBe(true);
  });

  it('returns ok:false on a 401', async () => {
    mockFetchQueue([fakeResponse('{"error":"invalid_credentials"}', { status: 401 })]);
    const r = await yieldkitAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/401/);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('Yieldkit.validateCredential', () => {
  it('accepts a non-empty API key without an API call', async () => {
    const r = await yieldkitAdapter.validateCredential('YIELDKIT_API_KEY', 'abc');
    expect(r.ok).toBe(true);
  });

  it('rejects an empty API key', async () => {
    const r = await yieldkitAdapter.validateCredential('YIELDKIT_API_KEY', '');
    expect(r.ok).toBe(false);
  });

  it('validates the secret by calling the API', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    const r = await yieldkitAdapter.validateCredential('YIELDKIT_API_SECRET', 'fresh-secret');
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with a hint when the secret fails to validate', async () => {
    mockFetchQueue([fakeResponse('{"error":"bad"}', { status: 401 })]);
    const r = await yieldkitAdapter.validateCredential('YIELDKIT_API_SECRET', 'bad-secret');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('Yieldkit.capabilitiesCheck', () => {
  it('probes the live ops and records generateTrackingLink without probing', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('advertisers.json')), // listProgrammes
      fakeResponse(loadFixture('commissions.json')), // listTransactions probe
      fakeResponse(loadFixture('commissions.json')), // getEarningsSummary → listTransactions
      fakeResponse(loadFixture('clicks.json')), // listClicks
      fakeResponse(loadFixture('advertisers.json')), // verifyAuth
    ]);
    const caps = await yieldkitAdapter.capabilitiesCheck();
    expect(caps.network).toBe('yieldkit');
    expect(caps.operations['listClicks']?.supported).toBe(true);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(true);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Error transparency (§15.4)
// ---------------------------------------------------------------------------

describe('Yieldkit §15.4 error transparency', () => {
  it('surfaces the verbatim response body on a 500', async () => {
    const body = '{"error":"upstream broke","trace":"abc"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await yieldkitAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('yieldkit');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream broke');
    }
  });

  it('classifies 401 as auth_error', async () => {
    mockFetchQueue([fakeResponse('forbidden', { status: 401, rawBody: 'forbidden' })]);
    try {
      await yieldkitAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('auth_error');
    }
  });
});
