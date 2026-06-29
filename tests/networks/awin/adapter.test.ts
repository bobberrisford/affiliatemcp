/**
 * Awin adapter — unit tests.
 *
 * Patterns to mirror in future network adapters:
 *   - We mock `globalThis.fetch` directly. This is the seam between the
 *     adapter and the network; mocking it exercises the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - Each test stubs ONLY the fetch responses it needs. We avoid recording
 *     long fixture chains because adapter behaviour drifts faster than
 *     fixtures do.
 *   - The PRD-relevant tests are tagged with `§15.x` in their `it` strings so
 *     a future contributor can grep for the requirement they break.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { awinAdapter, _internals } from '../../../src/networks/awin/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'awin');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

/**
 * Mint a fake `Response` that the global fetch mock returns. We accept either
 * a JSON-encodable body or a raw string body. Status defaults to 200.
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
 * Replace `globalThis.fetch` with a queue-driven mock. Each call shifts the
 * next response off the queue. Returns the spy for assertions.
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
  process.env['AWIN_API_TOKEN'] = 'test-token-please-ignore';
  process.env['AWIN_PUBLISHER_ID'] = '123456';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['AWIN_API_TOKEN'];
  delete process.env['AWIN_PUBLISHER_ID'];
});

// ---------------------------------------------------------------------------
// Transformation (status mapping + raw preservation)
// ---------------------------------------------------------------------------

describe('Awin transformers (status normalisation, raw preservation)', () => {
  it('maps Awin commissionStatus pending|approved|declined → canonical statuses', () => {
    const txns = loadFixture('transactions.json') as Array<Record<string, unknown>>;
    const approved = _internals.toTransaction(txns[0] as never);
    const pending = _internals.toTransaction(txns[1] as never);
    const declined = _internals.toTransaction(txns[2] as never);
    const paid = _internals.toTransaction(txns[3] as never);
    expect(approved.status).toBe('approved');
    expect(pending.status).toBe('pending');
    // PRD §15.4: 'declined' must map to 'reversed' (the user-facing intent).
    expect(declined.status).toBe('reversed');
    // paidToPublisher=true overrides commissionStatus.
    expect(paid.status).toBe('paid');
  });

  it('preserves the raw Awin response under rawNetworkData', () => {
    const raw = (loadFixture('transactions.json') as Array<Record<string, unknown>>)[0];
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('surfaces reversalReason on reversed transactions (§15.10)', () => {
    const declined = (loadFixture('transactions.json') as Array<Record<string, unknown>>)[2];
    const out = _internals.toTransaction(declined as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Customer returned the item within 14 days');
  });

  it('maps programme relationships to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ status: 'joined' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ status: 'declined' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ status: 'notjoined' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ status: 'paused' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'never-seen-before' })).toBe('unknown');
  });

  it('derives status from membershipStatus when /programmedetails omits status', () => {
    // The single-fetch (getProgramme) response carries neither `status` nor the
    // queried `relationship`; only `membershipStatus`. Without this fallback a
    // joined programme fetched by id mapped to 'unknown'.
    expect(_internals.mapProgrammeStatus({ membershipStatus: 'Joined' })).toBe('joined');
    expect(_internals.toProgramme({ id: 307, membershipStatus: 'Joined' }).status).toBe('joined');
    // Explicit `status`/`relationship` still take precedence over membershipStatus.
    expect(
      _internals.mapProgrammeStatus({ status: 'pending', membershipStatus: 'Joined' }),
    ).toBe('pending');
  });

  it('computes ageDays from validationDate (preferred) or transactionDate', () => {
    const now = new Date('2026-05-21T00:00:00Z');
    const age1 = _internals.computeAgeDays(
      { validationDate: '2026-01-01T00:00:00Z' },
      now,
    );
    expect(age1).toBe(140);
    const age2 = _internals.computeAgeDays(
      { transactionDate: '2026-04-01T00:00:00Z' },
      now,
    );
    expect(age2).toBe(50);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes: relationship → canonical status
//
// Regression guard for the discovery bug fixed 2026-06-29: real Awin rows carry
// the ADVERTISER programme status ("Active"), never the publisher relationship.
// The canonical status must come from the relationship we queried, otherwise
// every not-joined/pending row maps to 'joined' and the client-side status
// filter deletes the entire joinable catalogue (status:'available' → []).
// ---------------------------------------------------------------------------

describe('Awin.listProgrammes relationship → status', () => {
  // Real-shaped Awin rows: status is "Active" (advertiser status), no per-row
  // relationship field — exactly what the live API returns.
  const awinRows = [
    { id: 111, name: 'Joinable One', status: 'Active', currencyCode: 'GBP' },
    { id: 222, name: 'Joinable Two', status: 'Active', currencyCode: 'USD' },
  ];

  it('returns joinable programmes stamped available (not []) for status:available', async () => {
    const spy = mockFetchQueue([fakeResponse(awinRows)]);
    const programmes = await awinAdapter.listProgrammes({ status: ['available'] });
    expect(programmes.length).toBe(2);
    expect(programmes.every((p) => p.status === 'available')).toBe(true);
    // The server-side filter must use relationship=notjoined.
    expect(String(spy.mock.calls[0]?.[0])).toContain('relationship=notjoined');
  });

  it('stamps joined for the default (no status) query', async () => {
    const spy = mockFetchQueue([fakeResponse(awinRows)]);
    const programmes = await awinAdapter.listProgrammes();
    expect(programmes.length).toBe(2);
    expect(programmes.every((p) => p.status === 'joined')).toBe(true);
    expect(String(spy.mock.calls[0]?.[0])).toContain('relationship=joined');
  });

  it('stamps pending for status:pending', async () => {
    mockFetchQueue([fakeResponse(awinRows)]);
    const programmes = await awinAdapter.listProgrammes({ status: ['pending'] });
    expect(programmes.length).toBe(2);
    expect(programmes.every((p) => p.status === 'pending')).toBe(true);
  });

  it('fetches only the highest-precedence relationship for a mixed-status query', async () => {
    // Documents the known limitation: one relationship is fetched per request.
    const spy = mockFetchQueue([fakeResponse(awinRows)]);
    const programmes = await awinAdapter.listProgrammes({ status: ['available', 'joined'] });
    expect(String(spy.mock.calls[0]?.[0])).toContain('relationship=joined');
    expect(programmes.every((p) => p.status === 'joined')).toBe(true);
  });

  it('maps a queried relationship to the canonical status', () => {
    expect(_internals.relationshipToStatus('notjoined')).toBe('available');
    expect(_internals.relationshipToStatus('joined')).toBe('joined');
    expect(_internals.relationshipToStatus('pending')).toBe('pending');
    expect(_internals.relationshipToStatus('suspended')).toBe('suspended');
    expect(_internals.relationshipToStatus('rejected')).toBe('declined');
    expect(_internals.relationshipToStatus('anything-else')).toBe('joined');
  });

  it('picks the Awin relationship param from a canonical status set', () => {
    expect(_internals.pickAwinRelationship(['available'])).toBe('notjoined');
    expect(_internals.pickAwinRelationship(['pending'])).toBe('pending');
    expect(_internals.pickAwinRelationship(['suspended'])).toBe('suspended');
    expect(_internals.pickAwinRelationship(['declined'])).toBe('rejected');
    expect(_internals.pickAwinRelationship()).toBe('joined');
  });
});

// ---------------------------------------------------------------------------
// Cross-network normalisation fields (rollout: Awin reference)
//
// Five additive OPTIONAL fields land here first:
//   - meta.networkTimezone        (NetworkMeta)
//   - Programme.merchantKey + merchantKeySource
//   - Transaction.statusRaw
//   - Transaction.merchantKey
// See docs/contributing/normalisation-rollout.md for the per-field pattern.
// ---------------------------------------------------------------------------

describe('Awin normalisation fields', () => {
  it('declares networkTimezone = Europe/London (adapter owns naïve→UTC)', () => {
    expect(awinAdapter.meta.networkTimezone).toBe('Europe/London');
  });

  it('converts NAIVE Awin timestamps from Europe/London to canonical UTC', () => {
    // Fixture transaction[0] has naïve "2024-09-01T10:30:00" (BST, UTC+1) →
    // 09:30Z; transaction[3] has naïve "2024-01-05T12:30:00" (GMT, UTC+0) →
    // 12:30Z. A naïve parse in the host zone would drift; the adapter must not.
    const txns = loadFixture('transactions.json') as Array<Record<string, unknown>>;
    const bst = _internals.toTransaction(txns[0] as never);
    expect(bst.dateConverted).toBe('2024-09-01T09:30:00.000Z');
    // clickDate 10:00 BST → 09:00Z
    expect(bst.dateClicked).toBe('2024-09-01T09:00:00.000Z');

    const gmt = _internals.toTransaction(txns[3] as never);
    expect(gmt.dateConverted).toBe('2024-01-05T12:30:00.000Z');
  });

  it('parseAwinTimestamp preserves an already offset-qualified instant verbatim', () => {
    expect(_internals.parseAwinTimestamp('2024-06-01T10:00:00Z')).toBe('2024-06-01T10:00:00.000Z');
    expect(_internals.parseAwinTimestamp('2024-06-01T10:00:00+02:00')).toBe(
      '2024-06-01T08:00:00.000Z',
    );
    expect(_internals.parseAwinTimestamp(undefined)).toBeUndefined();
    expect(_internals.parseAwinTimestamp('not-a-date')).toBeUndefined();
  });

  it('populates statusRaw with the verbatim Awin commissionStatus token', () => {
    const txns = loadFixture('transactions.json') as Array<Record<string, unknown>>;
    expect(_internals.toTransaction(txns[0] as never).statusRaw).toBe('approved');
    expect(_internals.toTransaction(txns[1] as never).statusRaw).toBe('pending');
    // declined → canonical 'reversed', but statusRaw keeps the upstream word.
    const declined = _internals.toTransaction(txns[2] as never);
    expect(declined.status).toBe('reversed');
    expect(declined.statusRaw).toBe('declined');
    // paidToPublisher overrides the canonical status; statusRaw still reports
    // the upstream commissionStatus string Awin actually sent.
    const paid = _internals.toTransaction(txns[3] as never);
    expect(paid.status).toBe('paid');
    expect(paid.statusRaw).toBe('approved');
  });

  it('derives Programme.merchantKey from the advertiser domain (eTLD+1)', () => {
    const programmes = loadFixture('programmes.json') as Array<Record<string, unknown>>;
    const bookshop = _internals.toProgramme(programmes[0] as never);
    // displayUrl https://www.atolls-bookshop.example.com → example.com (eTLD+1).
    expect(bookshop.merchantKey).toBe('example.com');
    expect(bookshop.merchantKeySource).toBe('fallback-domain');
  });

  it('falls back to a slugified name when no advertiser URL is present', () => {
    const { merchantKey, merchantKeySource } = _internals.deriveMerchantKey(
      undefined,
      'Atolls Bookshop',
    );
    expect(merchantKey).toBe('atolls-bookshop');
    expect(merchantKeySource).toBe('fallback-name');
  });

  it('reports merchantKeySource none when neither URL nor name is available', () => {
    const { merchantKey, merchantKeySource } = _internals.deriveMerchantKey(undefined, undefined);
    expect(merchantKey).toBeUndefined();
    expect(merchantKeySource).toBe('none');
  });

  it('inherits merchantKey onto the transaction from the merchant landing url', () => {
    const txns = loadFixture('transactions.json') as Array<Record<string, unknown>>;
    // transaction[0] carries url https://www.atolls-bookshop.example.com/landing
    const t = _internals.toTransaction(txns[0] as never);
    expect(t.merchantKey).toBe('example.com');
  });

  it('registrableDomain handles two-part TLDs and strips www', () => {
    expect(_internals.registrableDomain('https://www.shop.co.uk/x')).toBe('shop.co.uk');
    expect(_internals.registrableDomain('https://deep.sub.example.com')).toBe('example.com');
    expect(_internals.registrableDomain('not a url')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listTransactions — unpaid-age + reversed visibility (§15.9, §15.10)
// ---------------------------------------------------------------------------

describe('Awin.listTransactions', () => {
  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    // We use a single 30-day window so the adapter makes exactly one
    // upstream call; the fixture returned regardless of date echoes the
    // full set of transactions, after which the adapter's age filter is
    // what we're actually testing.
    const fixture = loadFixture('transactions.json');
    mockFetchQueue([fakeResponse(fixture)]);

    const recent = await awinAdapter.listTransactions({
      from: '2026-04-21T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
      minAgeDays: 365,
    });
    // The Jan 2024 transaction is >2 years old, the Sept 2024 one is >1 year,
    // the Dec 2025 pending one is <6 months. Aug 2025 declined is >9 months.
    // With minAgeDays=365 we want the >1-year-old records.
    for (const t of recent) {
      expect(t.ageDays).toBeGreaterThanOrEqual(365);
    }
    expect(recent.length).toBeGreaterThan(0);
  });

  it('includes reversed transactions with reason populated (§15.10)', async () => {
    const fixture = loadFixture('transactions.json');
    mockFetchQueue([fakeResponse(fixture)]);
    const all = await awinAdapter.listTransactions({
      from: '2026-04-21T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
    });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toBe('Customer returned the item within 14 days');
  });

  it('chunks date ranges wider than 31 days into multiple calls', async () => {
    const spy = mockFetchQueue([
      fakeResponse([]),
      fakeResponse([]),
      fakeResponse([]),
    ]);
    await awinAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-03-31T00:00:00Z', // ~90 days → 3 slices
    });
    expect(spy.mock.calls.length).toBe(3);
  });

  it('filters by status when caller passes status[]', async () => {
    const fixture = loadFixture('transactions.json');
    mockFetchQueue([fakeResponse(fixture)]);
    const only = await awinAdapter.listTransactions({
      from: '2026-04-21T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('emits an error envelope when the token is missing (§15.4)', async () => {
    delete process.env['AWIN_API_TOKEN'];
    await expect(awinAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listClicks
// ---------------------------------------------------------------------------

describe('Awin.listClicks', () => {
  it('throws NotImplementedError with the documented reason', async () => {
    await expect(awinAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await awinAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain(
        'Awin does not expose click-level data',
      );
    }
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — deterministic URL construction
// ---------------------------------------------------------------------------

describe('Awin.generateTrackingLink', () => {
  it('constructs the deep-link URL with URL-encoded destination', async () => {
    const link = await awinAdapter.generateTrackingLink({
      programmeId: '7777',
      destinationUrl: 'https://www.atolls-bookshop.example.com/path?q=a b&c=ü',
    });
    expect(link.trackingUrl).toContain('https://www.awin1.com/cread.php?awinmid=7777');
    expect(link.trackingUrl).toContain('awinaffid=123456');
    // The space, '&', and 'ü' must be percent-encoded.
    expect(link.trackingUrl).toContain('ued=https%3A%2F%2Fwww.atolls-bookshop.example.com%2Fpath%3Fq%3Da%20b%26c%3D%C3%BC');
    expect(link.network).toBe('awin');
    expect(link.programmeId).toBe('7777');
  });

  it('throws a config_error envelope when programmeId is missing', async () => {
    await expect(
      awinAdapter.generateTrackingLink({
        programmeId: '',
        destinationUrl: 'https://x.example.com',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('does NOT call fetch (deterministic construction)', async () => {
    const spy = mockFetchQueue([]);
    await awinAdapter.generateTrackingLink({
      programmeId: '7777',
      destinationUrl: 'https://x.example.com',
    });
    expect(spy.mock.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth + derivedValues
// ---------------------------------------------------------------------------

describe('Awin.verifyAuth (happy path)', () => {
  it('returns ok:true and identity when /accounts responds 200', async () => {
    delete process.env['AWIN_PUBLISHER_ID']; // exercise derivation
    mockFetchQueue([fakeResponse(loadFixture('accounts.json'))]);
    const r = await awinAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('awin/123456');
    }
  });

  it('surfaces a NetworkErrorEnvelope shape on 401', async () => {
    mockFetchQueue([fakeResponse('{"error":"invalid_token"}', { status: 401 })]);
    const r = await awinAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/HTTP 401|401/);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('Awin.validateCredential', () => {
  it('rejects malformed publisher IDs', async () => {
    const r1 = await awinAdapter.validateCredential('AWIN_PUBLISHER_ID', 'abc');
    expect(r1.ok).toBe(false);
    const r2 = await awinAdapter.validateCredential('AWIN_PUBLISHER_ID', '-5');
    expect(r2.ok).toBe(false);
    const r3 = await awinAdapter.validateCredential('AWIN_PUBLISHER_ID', '0');
    expect(r3.ok).toBe(false);
  });

  it('accepts well-formed publisher IDs', async () => {
    const r = await awinAdapter.validateCredential('AWIN_PUBLISHER_ID', '123456');
    expect(r.ok).toBe(true);
  });

  it('validates AWIN_API_TOKEN by calling /accounts', async () => {
    mockFetchQueue([fakeResponse(loadFixture('accounts.json'))]);
    const r = await awinAdapter.validateCredential('AWIN_API_TOKEN', 'fresh-token');
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with a hint when AWIN_API_TOKEN validation fails', async () => {
    mockFetchQueue([fakeResponse('{"error":"bad"}', { status: 401 })]);
    const r = await awinAdapter.validateCredential('AWIN_API_TOKEN', 'bad-token');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('Awin.capabilitiesCheck', () => {
  it('records listClicks.supported = false with the known-limitation note', async () => {
    // Stub enough fetches for the probes (listProgrammes, listTransactions, getEarningsSummary, verifyAuth).
    // getEarningsSummary itself calls listTransactions internally — so it consumes one slice fetch.
    mockFetchQueue([
      fakeResponse([]), // listProgrammes
      fakeResponse([]), // listTransactions probe
      fakeResponse([]), // getEarningsSummary → listTransactions
      fakeResponse(loadFixture('accounts.json')), // verifyAuth
    ]);
    const caps = await awinAdapter.capabilitiesCheck();
    expect(caps.network).toBe('awin');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['listClicks']?.note).toContain('click-level data');
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim Awin response body on a 500', async () => {
    const body = '{"error":"upstream broke at 03:14:15","trace":"abc"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await awinAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('awin');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream broke');
    }
  });

  it('classifies 401 as auth_error', async () => {
    mockFetchQueue([fakeResponse('forbidden', { status: 401, rawBody: 'forbidden' })]);
    try {
      await awinAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('auth_error');
    }
  });
});
