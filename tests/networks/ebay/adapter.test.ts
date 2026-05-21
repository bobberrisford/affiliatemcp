/**
 * eBay Partner Network adapter — unit tests.
 *
 * Patterns to mirror in future network adapters:
 *   - We mock `globalThis.fetch` directly. The mock is queue-driven; each
 *     test stubs ONLY the responses it needs.
 *   - The eBay adapter acquires an OAuth2 access token before every API call
 *     via `auth.ts::getAccessToken`. The auth module caches the token for the
 *     duration of a test (we pre-seed the cache via a token-fixture response
 *     on the first fetch of each test that exercises the adapter ops).
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings so a
 *     future contributor can grep for the requirement they break.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ebayAdapter, _internals } from '../../../src/networks/ebay/adapter.js';
import { _resetTokenCache } from '../../../src/networks/ebay/auth.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'ebay');

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

/**
 * Replace `globalThis.fetch` with a queue-driven mock. The first response
 * served is intended to satisfy the OAuth token exchange — every adapter op
 * triggers a token acquisition on the cold cache. Returns the spy for
 * assertions.
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

/**
 * Build the standard set of fetch responses needed by an adapter test that
 * makes `n` API calls: one token exchange followed by `n` data responses.
 * The token cache is reset between tests so each test does see the token
 * fetch as the first response in its queue.
 */
function withToken(responses: Response[]): Response[] {
  return [fakeResponse(loadFixture('token.json')), ...responses];
}

beforeEach(() => {
  _resetBreakers();
  _resetTokenCache();
  process.env['EBAY_CLIENT_ID'] = 'test-client-id-12345';
  process.env['EBAY_CLIENT_SECRET'] = 'test-client-secret-please-ignore';
  process.env['EBAY_CAMPAIGN_ID'] = '5338000001';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['EBAY_CLIENT_ID'];
  delete process.env['EBAY_CLIENT_SECRET'];
  delete process.env['EBAY_CAMPAIGN_ID'];
  delete process.env['EBAY_ROTATION_ID'];
  _resetTokenCache();
});

// ---------------------------------------------------------------------------
// Transformation (status mapping + raw preservation)
// ---------------------------------------------------------------------------

describe('eBay transformers (status normalisation, raw preservation)', () => {
  it('maps eBay status PENDING|CLEARED|CANCELLED|PAID → canonical statuses', () => {
    const txns = (loadFixture('transactions.json') as { transactions: Array<Record<string, unknown>> })
      .transactions;
    const cleared = _internals.toTransaction(txns[0] as never);
    const pending = _internals.toTransaction(txns[1] as never);
    const cancelled = _internals.toTransaction(txns[2] as never);
    const paid = _internals.toTransaction(txns[3] as never);
    // PRD §15.4: CLEARED maps to 'approved' (recognised but not yet paid).
    expect(cleared.status).toBe('approved');
    expect(pending.status).toBe('pending');
    // PRD §15.4: CANCELLED maps to 'reversed' (the user-facing intent).
    expect(cancelled.status).toBe('reversed');
    expect(paid.status).toBe('paid');
  });

  it('also accepts the US "CANCELED" spelling', () => {
    expect(_internals.mapTransactionStatus({ status: 'CANCELED' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'cancelled' })).toBe('reversed');
  });

  it('preserves the raw eBay response under rawNetworkData', () => {
    const raw = (loadFixture('transactions.json') as { transactions: Array<Record<string, unknown>> })
      .transactions[0];
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('surfaces reversalReason on reversed transactions (§15.10)', () => {
    const cancelled = (loadFixture('transactions.json') as { transactions: Array<Record<string, unknown>> })
      .transactions[2];
    const out = _internals.toTransaction(cancelled as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Buyer cancelled within return window');
  });

  it('maps campaign status ACTIVE|PAUSED|DRAFT|EXPIRED → canonical ProgrammeStatus', () => {
    expect(_internals.mapCampaignStatus({ campaignStatus: 'ACTIVE' })).toBe('joined');
    expect(_internals.mapCampaignStatus({ campaignStatus: 'PAUSED' })).toBe('suspended');
    expect(_internals.mapCampaignStatus({ campaignStatus: 'EXPIRED' })).toBe('suspended');
    expect(_internals.mapCampaignStatus({ campaignStatus: 'DRAFT' })).toBe('pending');
    expect(_internals.mapCampaignStatus({ campaignStatus: 'NEVER_SEEN' })).toBe('unknown');
  });

  it('computes ageDays from clearedDate (preferred) or eventDate', () => {
    const now = new Date('2026-05-21T00:00:00Z');
    const age1 = _internals.computeAgeDays(
      { clearedDate: '2026-01-01T00:00:00Z' },
      now,
    );
    expect(age1).toBe(140);
    const age2 = _internals.computeAgeDays(
      { eventDate: '2026-04-01T00:00:00Z' },
      now,
    );
    expect(age2).toBe(50);
  });

  it('chunks date ranges into ≤90-day slices', () => {
    const slices = _internals.chunkDateRange(
      new Date('2026-01-01T00:00:00Z'),
      new Date('2026-12-31T00:00:00Z'),
      90,
    );
    // 365 days / 90-day slices ⇒ 5 slices (4 full + 1 short).
    expect(slices.length).toBe(5);
    for (const s of slices) {
      const days = (s.end.getTime() - s.start.getTime()) / 86_400_000;
      expect(days).toBeLessThanOrEqual(90);
    }
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('eBay.listProgrammes', () => {
  it('returns campaigns mapped to canonical Programme shape', async () => {
    mockFetchQueue(withToken([fakeResponse(loadFixture('campaigns.json'))]));
    const programmes = await ebayAdapter.listProgrammes();
    expect(programmes.length).toBe(3);
    expect(programmes[0]?.network).toBe('ebay');
    expect(programmes[0]?.status).toBe('joined');
    expect(programmes[1]?.status).toBe('suspended');
    expect(programmes[2]?.status).toBe('pending');
  });

  it('applies the client-side search filter', async () => {
    mockFetchQueue(withToken([fakeResponse(loadFixture('campaigns.json'))]));
    const programmes = await ebayAdapter.listProgrammes({ search: 'us site' });
    expect(programmes.length).toBe(1);
    expect(programmes[0]?.id).toBe('5338000002');
  });

  it('applies the status filter', async () => {
    mockFetchQueue(withToken([fakeResponse(loadFixture('campaigns.json'))]));
    const programmes = await ebayAdapter.listProgrammes({ status: ['suspended'] });
    expect(programmes.length).toBe(1);
    expect(programmes[0]?.id).toBe('5338000002');
  });
});

// ---------------------------------------------------------------------------
// listTransactions — unpaid-age + reversed visibility (§15.9, §15.10)
// ---------------------------------------------------------------------------

describe('eBay.listTransactions', () => {
  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockFetchQueue(withToken([fakeResponse(loadFixture('transactions.json'))]));
    const recent = await ebayAdapter.listTransactions({
      from: '2026-04-21T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
      minAgeDays: 365,
    });
    for (const t of recent) {
      expect(t.ageDays).toBeGreaterThanOrEqual(365);
    }
    expect(recent.length).toBeGreaterThan(0);
  });

  it('includes reversed transactions with reason populated (§15.10)', async () => {
    mockFetchQueue(withToken([fakeResponse(loadFixture('transactions.json'))]));
    const all = await ebayAdapter.listTransactions({
      from: '2026-04-21T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
    });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toBe('Buyer cancelled within return window');
  });

  it('chunks date ranges wider than 90 days into multiple calls', async () => {
    // 365 days → 5 slices. Each slice does one API request (returns empty,
    // breaks pagination). Plus one token exchange.
    const spy = mockFetchQueue(
      withToken([
        fakeResponse({ transactions: [] }),
        fakeResponse({ transactions: [] }),
        fakeResponse({ transactions: [] }),
        fakeResponse({ transactions: [] }),
        fakeResponse({ transactions: [] }),
      ]),
    );
    await ebayAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-12-31T00:00:00Z',
    });
    // 1 token + 5 slice calls = 6 fetches.
    expect(spy.mock.calls.length).toBe(6);
  });

  it('filters by status when caller passes status[]', async () => {
    mockFetchQueue(withToken([fakeResponse(loadFixture('transactions.json'))]));
    const only = await ebayAdapter.listTransactions({
      from: '2026-04-21T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('emits an error envelope when the client credentials are missing (§15.4)', async () => {
    delete process.env['EBAY_CLIENT_ID'];
    await expect(ebayAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listClicks — EPN DOES expose this
// ---------------------------------------------------------------------------

describe('eBay.listClicks', () => {
  it('returns clicks mapped to the canonical shape', async () => {
    mockFetchQueue(withToken([fakeResponse(loadFixture('clicks.json'))]));
    const clicks = await ebayAdapter.listClicks({
      from: '2026-05-01T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
    });
    expect(clicks.length).toBe(3);
    expect(clicks[0]?.network).toBe('ebay');
    expect(clicks[0]?.destinationUrl).toContain('ebay.co.uk');
    expect(clicks[0]?.programmeId).toBe('5338000001');
  });

  it('filters clicks by programmeId', async () => {
    mockFetchQueue(withToken([fakeResponse(loadFixture('clicks.json'))]));
    const clicks = await ebayAdapter.listClicks({
      from: '2026-05-01T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
      programmeId: '5338000002',
    });
    expect(clicks.length).toBe(1);
    expect(clicks[0]?.programmeId).toBe('5338000002');
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — deterministic URL construction
// ---------------------------------------------------------------------------

describe('eBay.generateTrackingLink', () => {
  it('constructs the rover URL with the configured campaign ID', async () => {
    const link = await ebayAdapter.generateTrackingLink({
      programmeId: '5338000001',
      destinationUrl: 'https://www.ebay.co.uk/itm/385123456789',
    });
    expect(link.trackingUrl).toContain('https://rover.ebay.com/rover/1/');
    expect(link.trackingUrl).toContain('campid=5338000001');
    expect(link.trackingUrl).toContain('toolid=10001');
    expect(link.trackingUrl).toContain('mpre=https%3A%2F%2Fwww.ebay.co.uk%2Fitm%2F385123456789');
    expect(link.network).toBe('ebay');
    expect(link.programmeId).toBe('5338000001');
  });

  it('honours EBAY_ROTATION_ID override', async () => {
    process.env['EBAY_ROTATION_ID'] = '999-12345-99999-0';
    const link = await ebayAdapter.generateTrackingLink({
      programmeId: '5338000001',
      destinationUrl: 'https://www.ebay.co.uk/itm/1',
    });
    expect(link.trackingUrl).toContain('/rover/1/999-12345-99999-0/1');
  });

  it('URL-encodes destinations containing spaces, ampersands, and non-ASCII', async () => {
    const link = await ebayAdapter.generateTrackingLink({
      programmeId: '5338000001',
      destinationUrl: 'https://www.ebay.co.uk/sch/i.html?_nkw=a b&_sop=ü',
    });
    expect(link.trackingUrl).toContain('mpre=https%3A%2F%2Fwww.ebay.co.uk%2Fsch%2Fi.html%3F_nkw%3Da%20b%26_sop%3D%C3%BC');
  });

  it('throws a config_error envelope when programmeId is missing', async () => {
    await expect(
      ebayAdapter.generateTrackingLink({
        programmeId: '',
        destinationUrl: 'https://x.example.com',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error envelope when destinationUrl is missing', async () => {
    await expect(
      ebayAdapter.generateTrackingLink({
        programmeId: '5338000001',
        destinationUrl: '',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('does NOT call fetch (deterministic construction)', async () => {
    const spy = mockFetchQueue([]);
    await ebayAdapter.generateTrackingLink({
      programmeId: '5338000001',
      destinationUrl: 'https://www.ebay.co.uk/itm/1',
    });
    expect(spy.mock.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth — exercises the OAuth2 token exchange
// ---------------------------------------------------------------------------

describe('eBay.verifyAuth', () => {
  it('returns ok:true and identity when the token exchange succeeds', async () => {
    mockFetchQueue([fakeResponse(loadFixture('token.json'))]);
    const r = await ebayAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('ebay/');
    }
  });

  it('surfaces a 401 from the token endpoint as ok:false', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_client"}', { status: 401 }),
    ]);
    const r = await ebayAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      // The reason carries the upstream message (HTTP 401 line).
      expect(r.reason).toMatch(/401|invalid_client/);
    }
  });

  it('returns ok:false with a config_error reason when EBAY_CLIENT_ID is missing', async () => {
    delete process.env['EBAY_CLIENT_ID'];
    const r = await ebayAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain('EBAY_CLIENT_ID');
    }
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('eBay.validateCredential', () => {
  it('rejects short / malformed client IDs', async () => {
    const r1 = await ebayAdapter.validateCredential('EBAY_CLIENT_ID', 'short');
    expect(r1.ok).toBe(false);
    const r2 = await ebayAdapter.validateCredential('EBAY_CLIENT_ID', 'has spaces are invalid');
    expect(r2.ok).toBe(false);
  });

  it('accepts well-formed client IDs but defers live validation', async () => {
    const r = await ebayAdapter.validateCredential('EBAY_CLIENT_ID', 'AtollsB-affil-PRD-deadbeef-12345');
    expect(r.ok).toBe(true);
    expect(r.message).toContain('after the secret');
  });

  it('validates EBAY_CLIENT_SECRET via the token endpoint', async () => {
    mockFetchQueue([fakeResponse(loadFixture('token.json'))]);
    const r = await ebayAdapter.validateCredential('EBAY_CLIENT_SECRET', 'fresh-secret-value');
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with a hint when the token exchange fails', async () => {
    mockFetchQueue([fakeResponse('{"error":"invalid_client"}', { status: 401 })]);
    const r = await ebayAdapter.validateCredential('EBAY_CLIENT_SECRET', 'bad-secret');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('rejects non-numeric campaign IDs', async () => {
    const r1 = await ebayAdapter.validateCredential('EBAY_CAMPAIGN_ID', 'abc');
    expect(r1.ok).toBe(false);
    const r2 = await ebayAdapter.validateCredential('EBAY_CAMPAIGN_ID', '-5');
    expect(r2.ok).toBe(false);
    const r3 = await ebayAdapter.validateCredential('EBAY_CAMPAIGN_ID', '0');
    expect(r3.ok).toBe(false);
  });

  it('accepts a well-formed campaign ID', async () => {
    const r = await ebayAdapter.validateCredential('EBAY_CAMPAIGN_ID', '5338000001');
    expect(r.ok).toBe(true);
  });

  it('returns a structured error for an unknown field', async () => {
    const r = await ebayAdapter.validateCredential('EBAY_NONSENSE', 'x');
    expect(r.ok).toBe(false);
    expect(r.message).toContain('Unknown credential field');
  });
});

// ---------------------------------------------------------------------------
// OAuth token caching
// ---------------------------------------------------------------------------

describe('eBay OAuth token caching', () => {
  it('reuses the cached token across multiple adapter calls', async () => {
    // One token exchange + two API responses; the second adapter call MUST
    // reuse the cached token (no second token exchange).
    const spy = mockFetchQueue([
      fakeResponse(loadFixture('token.json')),
      fakeResponse(loadFixture('campaigns.json')),
      fakeResponse({ campaigns: [] }), // second adapter call exhausts pagination immediately
    ]);
    await ebayAdapter.listProgrammes();
    await ebayAdapter.listProgrammes();
    // 1 token + 2 API calls = 3 fetches. NOT 4 (no re-exchange).
    expect(spy.mock.calls.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim eBay response body on a 500', async () => {
    const errBody = '{"errors":[{"errorId":12345,"longMessage":"reporting backend overloaded"}]}';
    mockFetchQueue(
      withToken([
        fakeResponse(errBody, { status: 500, rawBody: errBody }),
        fakeResponse(errBody, { status: 500, rawBody: errBody }),
        fakeResponse(errBody, { status: 500, rawBody: errBody }),
        fakeResponse(errBody, { status: 500, rawBody: errBody }),
      ]),
    );
    try {
      await ebayAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('ebay');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('reporting backend overloaded');
    }
  });

  it('classifies 401 from a data endpoint as auth_error', async () => {
    mockFetchQueue(
      withToken([fakeResponse('forbidden', { status: 401, rawBody: 'forbidden' })]),
    );
    try {
      await ebayAdapter.listProgrammes();
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

describe('eBay.capabilitiesCheck', () => {
  it('records listClicks as supported (EPN exposes click data)', async () => {
    // Stub: token + listProgrammes + listTransactions + getEarningsSummary
    // (which calls listTransactions internally) + listClicks + verifyAuth
    // forces a token refresh ⇒ one extra token exchange at the very end.
    mockFetchQueue([
      fakeResponse(loadFixture('token.json')),       // initial token
      fakeResponse({ campaigns: [] }),               // listProgrammes
      fakeResponse({ transactions: [] }),            // listTransactions probe
      fakeResponse({ transactions: [] }),            // getEarningsSummary → listTransactions
      fakeResponse({ clicks: [] }),                  // listClicks probe
      fakeResponse(loadFixture('token.json')),       // verifyAuth forces refresh
    ]);
    const caps = await ebayAdapter.capabilitiesCheck();
    expect(caps.network).toBe('ebay');
    expect(caps.operations['listClicks']?.supported).toBe(true);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(true);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
