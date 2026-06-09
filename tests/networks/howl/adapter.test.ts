/**
 * Howl adapter — unit tests.
 *
 * Mirrors the Awin test patterns: we mock `globalThis.fetch` (the seam between
 * the adapter and the network), stub only the responses each test needs, and
 * use a queue-driven mock so multi-call ops (chunked windows) are exercised.
 * No live HTTP.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { howlAdapter, _internals } from '../../../src/networks/howl/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'networks', 'howl', 'fixtures');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(body: unknown, init: { status?: number; rawBody?: string } = {}): Response {
  const status = init.status ?? 200;
  const text = init.rawBody ?? (typeof body === 'string' ? body : JSON.stringify(body));
  return new Response(text, { status, headers: { 'content-type': 'application/json' } });
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
  process.env['HOWL_API_KEY'] = 'test-key-please-ignore';
  process.env['HOWL_PUBLISHER_ID'] = '12345';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['HOWL_API_KEY'];
  delete process.env['HOWL_PUBLISHER_ID'];
});

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

describe('Howl transformers (status, amounts, raw preservation)', () => {
  it('maps earnings>0 → approved and earnings=0 → other', () => {
    expect(_internals.mapStatStatus({ pub_earnings: 24.05 })).toBe('approved');
    expect(_internals.mapStatStatus({ pub_earnings: 0 })).toBe('other');
    expect(_internals.mapStatStatus({})).toBe('other');
  });

  it('preserves the raw stats row under rawNetworkData', () => {
    const rows = (loadFixture('stats.json') as { stats: Array<Record<string, unknown>> }).stats;
    const out = _internals.toTransaction(rows[0] as never);
    expect(out.rawNetworkData).toBe(rows[0]);
  });

  it('maps pub_earnings to commission and attributed sales to amount, in USD', () => {
    const rows = (loadFixture('stats.json') as { stats: Array<Record<string, unknown>> }).stats;
    const out = _internals.toTransaction(rows[0] as never);
    expect(out.commission).toBe(24.05);
    expect(out.amount).toBe(8);
    expect(out.currency).toBe('USD');
    expect(out.programmeId).toBe('7001');
    expect(out.programmeName).toBe('Atolls Bookshop');
  });

  it('synthesises a deterministic id from date + article + merchant', () => {
    const rows = (loadFixture('stats.json') as { stats: Array<Record<string, unknown>> }).stats;
    expect(_internals.statRowId(rows[0] as never)).toBe('2024-01-15:555:7001');
  });

  it('computes ageDays from event_date', () => {
    const now = new Date('2026-05-21T00:00:00Z');
    expect(_internals.computeAgeDays({ event_date: '2026-05-01' }, now)).toBe(20);
  });

  it('formats Howl date params as YYYY-MM-DD', () => {
    expect(_internals.formatHowlDate(new Date('2026-05-21T13:45:00Z'))).toBe('2026-05-21');
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('Howl.listTransactions', () => {
  it('returns aggregated rows as transactions over a narrow window', async () => {
    mockFetchQueue([fakeResponse(loadFixture('stats.json'))]);
    const txns = await howlAdapter.listTransactions({
      from: '2026-04-21',
      to: '2026-05-21',
    });
    expect(txns.length).toBe(3);
    expect(txns.every((t) => t.network === 'howl')).toBe(true);
  });

  it('filters by programmeId (merch id) client-side', async () => {
    mockFetchQueue([fakeResponse(loadFixture('stats.json'))]);
    const txns = await howlAdapter.listTransactions({
      from: '2026-04-21',
      to: '2026-05-21',
      programmeId: '7002',
    });
    expect(txns.length).toBe(1);
    expect(txns[0]?.programmeId).toBe('7002');
  });

  it('applies minAgeDays after status filtering (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('stats.json'))]);
    const txns = await howlAdapter.listTransactions({
      from: '2026-04-21',
      to: '2026-05-21',
      minAgeDays: 365,
    });
    for (const t of txns) expect(t.ageDays).toBeGreaterThanOrEqual(365);
  });

  it('chunks windows wider than 31 days into multiple calls', async () => {
    const spy = mockFetchQueue([
      fakeResponse({ stats: [] }),
      fakeResponse({ stats: [] }),
      fakeResponse({ stats: [] }),
    ]);
    await howlAdapter.listTransactions({ from: '2026-01-01', to: '2026-03-31' });
    expect(spy.mock.calls.length).toBe(3);
  });

  it('emits a NetworkError when the API key is missing', async () => {
    delete process.env['HOWL_API_KEY'];
    await expect(howlAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });

  it('emits a NetworkError when the publisher id is missing', async () => {
    delete process.env['HOWL_PUBLISHER_ID'];
    await expect(howlAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes / getProgramme
// ---------------------------------------------------------------------------

describe('Howl.listProgrammes', () => {
  it('derives distinct merchants from the statistics rows', async () => {
    mockFetchQueue([fakeResponse(loadFixture('stats.json'))]);
    const programmes = await howlAdapter.listProgrammes();
    const ids = programmes.map((p) => p.id).sort();
    expect(ids).toEqual(['7001', '7002']);
    expect(programmes.every((p) => p.status === 'joined')).toBe(true);
  });

  it('filters by search substring', async () => {
    mockFetchQueue([fakeResponse(loadFixture('stats.json'))]);
    const programmes = await howlAdapter.listProgrammes({ search: 'reef' });
    expect(programmes.length).toBe(1);
    expect(programmes[0]?.name).toBe('Reef Outfitters');
  });
});

describe('Howl.getProgramme', () => {
  it('throws a network_api_error envelope for an unknown merch id', async () => {
    mockFetchQueue([fakeResponse(loadFixture('stats.json'))]);
    await expect(howlAdapter.getProgramme('999999')).rejects.toBeInstanceOf(NetworkError);
  });

  it('returns the matching merchant programme', async () => {
    mockFetchQueue([fakeResponse(loadFixture('stats.json'))]);
    const p = await howlAdapter.getProgramme('7001');
    expect(p.name).toBe('Atolls Bookshop');
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('Howl.getEarningsSummary', () => {
  it('sums commission client-side from listTransactions', async () => {
    mockFetchQueue([fakeResponse(loadFixture('stats.json'))]);
    const summary = await howlAdapter.getEarningsSummary({
      from: '2026-04-21',
      to: '2026-05-21',
    });
    // 24.05 + 6.0 + 0 = 30.05
    expect(summary.totalEarnings).toBeCloseTo(30.05, 2);
    expect(summary.currency).toBe('USD');
    expect(summary.byStatus.approved).toBeCloseTo(30.05, 2);
  });
});

// ---------------------------------------------------------------------------
// listClicks
// ---------------------------------------------------------------------------

describe('Howl.listClicks', () => {
  it('throws NotImplementedError with the documented reason', async () => {
    await expect(howlAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await howlAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click-level data');
    }
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — server-side mint via POST /smart_links/
// ---------------------------------------------------------------------------

describe('Howl.generateTrackingLink', () => {
  it('mints a smart link and returns smart_link_url as trackingUrl', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('smart_link.json'))]);
    const link = await howlAdapter.generateTrackingLink({
      programmeId: '7001',
      destinationUrl: 'https://www.atolls-bookshop.example.com/product/123',
    });
    expect(link.trackingUrl).toBe('https://shop-links.co/1611792246540568252');
    expect(link.network).toBe('howl');
    expect(spy.mock.calls.length).toBe(1);
    // It POSTs to the smart_links endpoint.
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/smart_links/');
    expect(init.method).toBe('POST');
  });

  it('throws a config_error envelope when destinationUrl is missing', async () => {
    await expect(
      howlAdapter.generateTrackingLink({ programmeId: '7001', destinationUrl: '' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth + validateCredential
// ---------------------------------------------------------------------------

describe('Howl.verifyAuth', () => {
  it('returns ok:true with identity when /tokeninfo responds 200', async () => {
    mockFetchQueue([fakeResponse(loadFixture('tokeninfo.json'))]);
    const r = await howlAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toContain('howl/user 9001');
  });

  it('returns ok:false on 401', async () => {
    mockFetchQueue([fakeResponse('{"error":"invalid_key"}', { status: 401 })]);
    const r = await howlAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/401/);
  });
});

describe('Howl.validateCredential', () => {
  it('rejects malformed publisher ids', async () => {
    expect((await howlAdapter.validateCredential('HOWL_PUBLISHER_ID', 'abc')).ok).toBe(false);
    expect((await howlAdapter.validateCredential('HOWL_PUBLISHER_ID', '0')).ok).toBe(false);
  });

  it('accepts well-formed publisher ids', async () => {
    expect((await howlAdapter.validateCredential('HOWL_PUBLISHER_ID', '12345')).ok).toBe(true);
  });

  it('validates HOWL_API_KEY via /tokeninfo', async () => {
    mockFetchQueue([fakeResponse(loadFixture('tokeninfo.json'))]);
    const r = await howlAdapter.validateCredential('HOWL_API_KEY', 'fresh-key');
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('Howl.capabilitiesCheck', () => {
  it('records listClicks unsupported and tags experimental ops', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('stats.json')), // listProgrammes
      fakeResponse(loadFixture('stats.json')), // listTransactions
      fakeResponse(loadFixture('stats.json')), // getEarningsSummary → listTransactions
      fakeResponse(loadFixture('tokeninfo.json')), // verifyAuth
    ]);
    const caps = await howlAdapter.capabilitiesCheck();
    expect(caps.network).toBe('howl');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['listProgrammes']?.claimStatus).toBe('experimental');
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim Howl response body on a 500', async () => {
    const body = '{"error":"upstream broke","trace":"xyz"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await howlAdapter.listTransactions({ from: '2026-05-01', to: '2026-05-21' });
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('howl');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream broke');
    }
  });

  it('classifies 401 as auth_error', async () => {
    mockFetchQueue([fakeResponse('forbidden', { status: 401, rawBody: 'forbidden' })]);
    try {
      await howlAdapter.listTransactions({ from: '2026-05-01', to: '2026-05-21' });
      throw new Error('expected to throw');
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('auth_error');
    }
  });
});
