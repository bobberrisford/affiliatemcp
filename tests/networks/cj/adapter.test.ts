/**
 * CJ Affiliate adapter — unit tests.
 *
 * Pattern-matched to `tests/networks/awin/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 *   - Fixtures live under `tests/fixtures/cj/` and approximate the shape of
 *     real CJ GraphQL responses. No real tokens, no real data.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { cjAdapter, _internals } from '../../../src/networks/cj/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'cj');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

/**
 * Mint a fake `Response`. CJ's GraphQL responses are JSON envelopes; we
 * accept either an envelope or a raw body for failure-path tests.
 */
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
  process.env['CJ_API_TOKEN'] = 'test-token-please-ignore';
  process.env['CJ_COMPANY_ID'] = '1234567';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['CJ_API_TOKEN'];
  delete process.env['CJ_COMPANY_ID'];
});

// ---------------------------------------------------------------------------
// Transformation (status mapping + raw preservation)
// ---------------------------------------------------------------------------

describe('CJ transformers (status normalisation, raw preservation)', () => {
  it('maps CJ actionStatus NEW|LOCKED|CLOSED|EXTENDED → canonical statuses', () => {
    // Construct minimal raw shapes — the transformer only reads actionStatus
    // + the paid signals here.
    const locked = _internals.toTransaction({ actionStatus: 'LOCKED' } as never);
    const newC = _internals.toTransaction({ actionStatus: 'NEW' } as never);
    const closed = _internals.toTransaction({
      actionStatus: 'CLOSED',
      correctionReason: 'reason',
    } as never);
    const extended = _internals.toTransaction({ actionStatus: 'EXTENDED' } as never);
    const paid = _internals.toTransaction({
      actionStatus: 'LOCKED',
      clearedDate: '2024-02-15T00:00:00Z',
    } as never);
    expect(locked.status).toBe('approved');
    expect(newC.status).toBe('pending');
    // §15.4 / §15.10: CLOSED must map to 'reversed' (the user-facing intent).
    expect(closed.status).toBe('reversed');
    expect(extended.status).toBe('pending');
    // clearedDate overrides actionStatus (same pattern as Awin's paidToPublisher).
    expect(paid.status).toBe('paid');
  });

  it('preserves the raw CJ payload under rawNetworkData', () => {
    const records = (loadFixture('commissions.json') as { data: { publisherCommissions: { records: unknown[] } } })
      .data.publisherCommissions.records;
    const raw = records[0] as Record<string, unknown>;
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('surfaces reversalReason from correctionReason on reversed transactions (§15.10)', () => {
    const records = (loadFixture('commissions.json') as { data: { publisherCommissions: { records: unknown[] } } })
      .data.publisherCommissions.records;
    // Fixture index 2 is the CLOSED + corrected commission.
    const closed = records[2] as Record<string, unknown>;
    const out = _internals.toTransaction(closed as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Customer returned the item within 14 days');
  });

  it('maps CJ relationship statuses to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ status: 'joined' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ status: 'declined' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ status: 'not joined' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ status: 'paused' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'inactive' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'never-seen-before' })).toBe('unknown');
  });

  it('computes ageDays from lockingDate (preferred), then postingDate, then eventDate', () => {
    const now = new Date('2026-05-21T00:00:00Z');
    const age1 = _internals.computeAgeDays({ lockingDate: '2026-01-01T00:00:00Z' } as never, now);
    expect(age1).toBe(140);
    const age2 = _internals.computeAgeDays({ postingDate: '2026-04-01T00:00:00Z' } as never, now);
    expect(age2).toBe(50);
    const age3 = _internals.computeAgeDays({ eventDate: '2026-03-01T00:00:00Z' } as never, now);
    expect(age3).toBe(81);
  });
});

// ---------------------------------------------------------------------------
// listTransactions — unpaid-age + reversed visibility (§15.9, §15.10)
// ---------------------------------------------------------------------------

describe('CJ.listTransactions', () => {
  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    // The full fixture is returned regardless of the date variables we send;
    // the adapter's age filter is what we're testing. With minAgeDays=365 we
    // expect the Jan 2024 + Sep 2024 records to qualify (and only those).
    mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);

    const aged = await cjAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
      minAgeDays: 365,
    });
    for (const t of aged) {
      expect(t.ageDays).toBeGreaterThanOrEqual(365);
    }
    expect(aged.length).toBeGreaterThan(0);
  });

  it('includes reversed transactions with reason populated (§15.10)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);
    const all = await cjAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
    });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toBe('Customer returned the item within 14 days');
  });

  it('filters by status when caller passes status[]', async () => {
    mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);
    const only = await cjAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('emits an error envelope when the token is missing (§15.4)', async () => {
    delete process.env['CJ_API_TOKEN'];
    await expect(cjAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listClicks
// ---------------------------------------------------------------------------

describe('CJ.listClicks', () => {
  it('throws NotImplementedError with a CJ-specific reason', async () => {
    await expect(cjAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await cjAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('CJ does not expose click-level data');
    }
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — deterministic URL construction
// ---------------------------------------------------------------------------

describe('CJ.generateTrackingLink', () => {
  it('constructs the dpbolvw.net deep-link with URL-encoded destination', async () => {
    const link = await cjAdapter.generateTrackingLink({
      programmeId: '7777',
      destinationUrl: 'https://www.atolls-bookshop.example.com/path?q=a b&c=ü',
    });
    expect(link.trackingUrl).toContain('https://www.dpbolvw.net/click-1234567-7777');
    expect(link.trackingUrl).toContain(
      'url=https%3A%2F%2Fwww.atolls-bookshop.example.com%2Fpath%3Fq%3Da%20b%26c%3D%C3%BC',
    );
    expect(link.network).toBe('cj');
    expect(link.programmeId).toBe('7777');
  });

  it('throws a config_error envelope when programmeId is missing', async () => {
    await expect(
      cjAdapter.generateTrackingLink({
        programmeId: '',
        destinationUrl: 'https://x.example.com',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('does NOT call fetch (deterministic construction)', async () => {
    const spy = mockFetchQueue([]);
    await cjAdapter.generateTrackingLink({
      programmeId: '7777',
      destinationUrl: 'https://x.example.com',
    });
    expect(spy.mock.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth + derivedValues
// ---------------------------------------------------------------------------

describe('CJ.verifyAuth (happy path)', () => {
  it('returns ok:true and identity when { me } responds 200', async () => {
    delete process.env['CJ_COMPANY_ID']; // exercise derivation
    mockFetchQueue([fakeResponse(loadFixture('me.json'))]);
    const r = await cjAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('cj/1234567');
    }
  });

  it('surfaces a NetworkErrorEnvelope shape on 401 (§15.4)', async () => {
    mockFetchQueue([
      fakeResponse('{"error":"invalid_token"}', { status: 401, rawBody: '{"error":"invalid_token"}' }),
    ]);
    const r = await cjAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/HTTP 401|401/);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('CJ.validateCredential', () => {
  it('rejects malformed company IDs', async () => {
    const r1 = await cjAdapter.validateCredential('CJ_COMPANY_ID', 'abc');
    expect(r1.ok).toBe(false);
    const r2 = await cjAdapter.validateCredential('CJ_COMPANY_ID', '-5');
    expect(r2.ok).toBe(false);
    const r3 = await cjAdapter.validateCredential('CJ_COMPANY_ID', '0');
    expect(r3.ok).toBe(false);
  });

  it('accepts well-formed company IDs', async () => {
    const r = await cjAdapter.validateCredential('CJ_COMPANY_ID', '1234567');
    expect(r.ok).toBe(true);
  });

  it('validates CJ_API_TOKEN by calling { me }', async () => {
    mockFetchQueue([fakeResponse(loadFixture('me.json'))]);
    const r = await cjAdapter.validateCredential('CJ_API_TOKEN', 'fresh-token');
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with a hint when CJ_API_TOKEN validation fails', async () => {
    mockFetchQueue([fakeResponse('{"error":"bad"}', { status: 401, rawBody: '{"error":"bad"}' })]);
    const r = await cjAdapter.validateCredential('CJ_API_TOKEN', 'bad-token');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('CJ.capabilitiesCheck', () => {
  it('records listClicks.supported = false with the known-limitation note', async () => {
    // Stub fetches for: listProgrammes, listTransactions probe,
    // getEarningsSummary (calls listTransactions internally), verifyAuth.
    mockFetchQueue([
      fakeResponse({ data: { advertisers: { resultList: [] } } }), // listProgrammes
      fakeResponse({ data: { publisherCommissions: { records: [] } } }), // listTransactions probe
      fakeResponse({ data: { publisherCommissions: { records: [] } } }), // getEarningsSummary → listTransactions
      fakeResponse(loadFixture('me.json')), // verifyAuth
    ]);
    const caps = await cjAdapter.capabilitiesCheck();
    expect(caps.network).toBe('cj');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['listClicks']?.note).toContain('click-level data');
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim CJ response body on a 500', async () => {
    const body = '{"error":"upstream broke at 03:14:15","trace":"abc"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await cjAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('cj');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream broke');
    }
  });

  it('classifies 401 as auth_error (§15.4)', async () => {
    mockFetchQueue([fakeResponse('forbidden', { status: 401, rawBody: 'forbidden' })]);
    try {
      await cjAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('auth_error');
    }
  });

  it('surfaces GraphQL `errors` payloads verbatim even on HTTP 200', async () => {
    // CJ may return a 200 with an `errors` array — the GraphQL spec permits
    // this. We assert the verbatim body still reaches the envelope so the
    // user sees CJ's actual error message.
    const body = JSON.stringify({
      errors: [{ message: 'Variable $companyId of required type ID! was not provided.' }],
    });
    mockFetchQueue([fakeResponse(body, { status: 200, rawBody: body })]);
    try {
      await cjAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('cj');
      expect(env.operation).toBe('listProgrammes');
      expect(env.networkErrorBody).toContain('Variable $companyId');
    }
  });
});
