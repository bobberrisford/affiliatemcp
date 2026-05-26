/**
 * Impact adapter — unit tests.
 *
 * Per AGENTS.md and PRD §9.3, Impact is NOT a pattern source. These tests
 * therefore include scenarios that exercise the resilience layer harder than
 * Awin's tests (5xx retry, circuit breaker, no-retry on 4xx, 429 retry,
 * null-body normalisation) because Impact's flakiness is what justifies the
 * resilience layer existing. The PRD-relevant tests are tagged with `§15.x`
 * in their `it` strings so a future contributor can grep for the requirement
 * they break.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { impactAdapter, _internals } from '../../../src/networks/impact/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'impact');

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
  process.env['IMPACT_ACCOUNT_SID'] = 'IRTEST123ACCOUNT';
  process.env['IMPACT_AUTH_TOKEN'] = 'test-token-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['IMPACT_ACCOUNT_SID'];
  delete process.env['IMPACT_AUTH_TOKEN'];
});

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

describe('Impact transformers (status normalisation, raw preservation)', () => {
  it('maps Impact action states PENDING|APPROVED|REVERSED|LOCKED|PAID to canonical statuses', () => {
    const actions = (loadFixture('actions.json') as { Actions: Array<Record<string, unknown>> }).Actions;
    const approved = _internals.toTransaction(actions[0] as never);
    const pending = _internals.toTransaction(actions[1] as never);
    const reversed = _internals.toTransaction(actions[2] as never);
    const paid = _internals.toTransaction(actions[3] as never);
    const locked = _internals.toTransaction(actions[4] as never);
    expect(approved.status).toBe('approved');
    expect(pending.status).toBe('pending');
    expect(reversed.status).toBe('reversed');
    expect(paid.status).toBe('paid');
    // LOCKED → approved (documented mapping in adapter header).
    expect(locked.status).toBe('approved');
  });

  it('preserves the raw Impact payload under rawNetworkData', () => {
    const raw = (loadFixture('actions.json') as { Actions: Array<Record<string, unknown>> }).Actions[0];
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('surfaces reversalReason on reversed transactions (§15.10)', () => {
    const raw = (loadFixture('actions.json') as { Actions: Array<Record<string, unknown>> }).Actions[2];
    const out = _internals.toTransaction(raw as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Customer returned the item within 14 days');
  });

  it('maps Impact ContractStatus values to canonical ProgrammeStatus', () => {
    expect(_internals.mapCampaignStatus({ ContractStatus: 'Active' })).toBe('joined');
    expect(_internals.mapCampaignStatus({ ContractStatus: 'Pending' })).toBe('pending');
    expect(_internals.mapCampaignStatus({ ContractStatus: 'Declined' })).toBe('declined');
    expect(_internals.mapCampaignStatus({ ContractStatus: 'NotEnrolled' })).toBe('available');
    expect(_internals.mapCampaignStatus({ ContractStatus: 'Paused' })).toBe('suspended');
    expect(_internals.mapCampaignStatus({ ContractStatus: 'something-novel' })).toBe('unknown');
  });

  it('parses Impact dates in all three observed shapes', () => {
    // Offset form.
    expect(_internals.parseImpactDate('2026-05-15T10:00:00-05:00')).toBe('2026-05-15T15:00:00.000Z');
    // Millisecond-precision UTC.
    expect(_internals.parseImpactDate('2026-05-15T10:00:00.123Z')).toBe('2026-05-15T10:00:00.123Z');
    // Bare ISO with no offset — heuristic appends Z (treats as UTC).
    expect(_internals.parseImpactDate('2026-05-15T10:00:00')).toBe('2026-05-15T10:00:00.000Z');
    // Unparseable → undefined (never fabricate).
    expect(_internals.parseImpactDate('not-a-date')).toBeUndefined();
    expect(_internals.parseImpactDate('')).toBeUndefined();
    expect(_internals.parseImpactDate(undefined)).toBeUndefined();
  });

  it('computes ageDays anchored on LockingDate (preferred) then EventDate', () => {
    const now = new Date('2026-05-21T00:00:00Z');
    // LockingDate present — should anchor on it.
    const age1 = _internals.computeAgeDays(
      { LockingDate: '2026-01-01T00:00:00Z', EventDate: '2026-04-01T00:00:00Z' },
      now,
    );
    expect(age1).toBe(140);
    // Only EventDate → anchor on it.
    const age2 = _internals.computeAgeDays({ EventDate: '2026-04-01T00:00:00Z' }, now);
    expect(age2).toBe(50);
  });

  it('strips the /Mediapartners/{SID} prefix from @nextpageuri', () => {
    const out = _internals.stripMediapartnersPrefix(
      '/Mediapartners/IRTEST123ACCOUNT/Actions?Page=2',
      'IRTEST123ACCOUNT',
    );
    expect(out).toBe('/Actions?Page=2');
    // Also works on a fully-qualified URL.
    const out2 = _internals.stripMediapartnersPrefix(
      'https://api.impact.com/Mediapartners/IRTEST123ACCOUNT/Clicks?Page=2',
      'IRTEST123ACCOUNT',
    );
    expect(out2).toBe('/Clicks?Page=2');
  });
});

// ---------------------------------------------------------------------------
// listTransactions — §15.9 unpaid-age + §15.10 reversed visibility
// ---------------------------------------------------------------------------

describe('Impact.listTransactions', () => {
  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    const fixture = loadFixture('actions.json');
    mockFetchQueue([fakeResponse(fixture)]);
    const recent = await impactAdapter.listTransactions({
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
    const fixture = loadFixture('actions.json');
    mockFetchQueue([fakeResponse(fixture)]);
    const all = await impactAdapter.listTransactions({
      from: '2026-04-21T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
    });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toBe('Customer returned the item within 14 days');
  });

  it('chunks date ranges wider than 30 days into multiple calls', async () => {
    const spy = mockFetchQueue([
      fakeResponse({ Actions: [] }),
      fakeResponse({ Actions: [] }),
      fakeResponse({ Actions: [] }),
    ]);
    await impactAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-03-31T00:00:00Z', // ~90 days → 3 slices
    });
    expect(spy.mock.calls.length).toBe(3);
  });

  it('filters by status when caller passes status[]', async () => {
    const fixture = loadFixture('actions.json');
    mockFetchQueue([fakeResponse(fixture)]);
    const only = await impactAdapter.listTransactions({
      from: '2026-04-21T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('emits an error envelope when IMPACT_AUTH_TOKEN is missing (§15.4)', async () => {
    delete process.env['IMPACT_AUTH_TOKEN'];
    await expect(impactAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });

  // IMPACT-WORKAROUND test: empty-list normalisation. Impact sometimes
  // returns a literal `null` body; the client normalises to `{}` and the
  // adapter must treat that as zero rows rather than crashing on `.Actions`.
  it('treats a null Impact response body as an empty list', async () => {
    mockFetchQueue([fakeResponse(null, { rawBody: 'null' })]);
    const out = await impactAdapter.listTransactions({
      from: '2026-04-21T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
    });
    expect(out).toEqual([]);
  });

  // IMPACT-WORKAROUND test: pagination via @nextpageuri.
  it('follows @nextpageuri across pages and aggregates results', async () => {
    const fixture = loadFixture('actions.json') as { Actions: unknown[] };
    // Page 1 returns first row + nextpageuri; page 2 returns the rest.
    mockFetchQueue([
      fakeResponse({
        Actions: [fixture.Actions[0]],
        '@nextpageuri': '/Mediapartners/IRTEST123ACCOUNT/Actions?Page=2',
      }),
      fakeResponse({
        Actions: fixture.Actions.slice(1),
      }),
    ]);
    const out = await impactAdapter.listTransactions({
      from: '2026-04-21T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
    });
    expect(out.length).toBe(fixture.Actions.length);
  });
});

// ---------------------------------------------------------------------------
// listClicks — Impact DOES expose click data (unlike Awin)
// ---------------------------------------------------------------------------

describe('Impact.listClicks (supported, unlike Awin)', () => {
  it('returns clicks parsed from /Clicks', async () => {
    mockFetchQueue([fakeResponse(loadFixture('clicks.json'))]);
    const clicks = await impactAdapter.listClicks({
      from: '2026-05-01T00:00:00Z',
      to: '2026-05-20T00:00:00Z',
    });
    expect(clicks.length).toBe(2);
    expect(clicks[0]?.programmeId).toBe('11111');
    expect(clicks[0]?.destinationUrl).toContain('atolls-bookshop');
  });

  it('does NOT throw NotImplementedError (Impact exposes /Clicks)', async () => {
    mockFetchQueue([fakeResponse({ Clicks: [] })]);
    await expect(
      impactAdapter.listClicks({
        from: '2026-05-01T00:00:00Z',
        to: '2026-05-20T00:00:00Z',
      }),
    ).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — POSTs to /TrackingValueRequests (not deterministic)
// ---------------------------------------------------------------------------

describe('Impact.generateTrackingLink', () => {
  it('POSTs to /TrackingValueRequests and returns the TrackingURL', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('tracking-link.json'))]);
    const link = await impactAdapter.generateTrackingLink({
      programmeId: '11111',
      destinationUrl: 'https://www.atolls-bookshop.example.com/products/42',
    });
    expect(link.network).toBe('impact');
    expect(link.programmeId).toBe('11111');
    expect(link.trackingUrl).toContain('atolls-test.7eer.net');
    // Verify the POST + form-encoded body.
    const [calledUrl, calledInit] = spy.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toContain('/TrackingValueRequests');
    expect(calledInit.method).toBe('POST');
    expect(String(calledInit.body)).toContain('ProgramId=11111');
    expect(String(calledInit.body)).toContain('DeepLink=');
    expect((calledInit.headers as Record<string, string>)['Content-Type']).toBe(
      'application/x-www-form-urlencoded',
    );
  });

  it('throws a config_error envelope when programmeId is missing', async () => {
    await expect(
      impactAdapter.generateTrackingLink({
        programmeId: '',
        destinationUrl: 'https://x.example.com',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws when Impact returns 2xx but no TrackingURL (honest about a partial response)', async () => {
    mockFetchQueue([fakeResponse({ Uri: '/somewhere' })]);
    await expect(
      impactAdapter.generateTrackingLink({
        programmeId: '11111',
        destinationUrl: 'https://x.example.com',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('Impact.verifyAuth', () => {
  it('returns ok:true with identity when /Campaigns responds 200', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const r = await impactAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('impact/IRTEST123ACCOUNT');
    }
  });

  it('surfaces a NetworkErrorEnvelope reason on 401', async () => {
    mockFetchQueue([fakeResponse('{"Message":"unauthorized"}', { status: 401 })]);
    const r = await impactAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/HTTP 401|401/);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('Impact.validateCredential', () => {
  it('rejects empty Account SID', async () => {
    const r = await impactAdapter.validateCredential('IMPACT_ACCOUNT_SID', '');
    expect(r.ok).toBe(false);
  });

  it('accepts a well-formed Account SID without an API call', async () => {
    const r = await impactAdapter.validateCredential(
      'IMPACT_ACCOUNT_SID',
      'IRTEST123ACCOUNT',
    );
    expect(r.ok).toBe(true);
  });

  it('validates IMPACT_AUTH_TOKEN by calling /Campaigns when SID is present', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const r = await impactAdapter.validateCredential('IMPACT_AUTH_TOKEN', 'fresh-token');
    expect(r.ok).toBe(true);
  });

  it('defers live token validation when SID is not yet set (returns ok with a hint message)', async () => {
    delete process.env['IMPACT_ACCOUNT_SID'];
    const r = await impactAdapter.validateCredential('IMPACT_AUTH_TOKEN', 'fresh-token');
    // Format-pass: ok:true but message conveys deferral. The wizard re-validates later.
    expect(r.ok).toBe(true);
    expect(r.message).toContain('deferred');
  });

  it('returns ok:false with a hint when token validation fails', async () => {
    mockFetchQueue([fakeResponse('{"Message":"bad token"}', { status: 401 })]);
    const r = await impactAdapter.validateCredential('IMPACT_AUTH_TOKEN', 'bad-token');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Admin operations + listProgrammes filtering
// ---------------------------------------------------------------------------

describe('Impact.listProgrammes', () => {
  it('returns programmes filtered by search term', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const out = await impactAdapter.listProgrammes({ search: 'atolls' });
    expect(out.length).toBe(1);
    expect(out[0]?.name).toBe('Atolls Bookshop');
  });

  it('returns programmes filtered by status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const out = await impactAdapter.listProgrammes({ status: 'pending' });
    expect(out.every((p) => p.status === 'pending')).toBe(true);
  });
});

describe('Impact admin operations (v0.2 scaffolds)', () => {
  it('listPublishers throws NotImplementedError', async () => {
    await expect(impactAdapter.listPublishers()).rejects.toBeInstanceOf(NotImplementedError);
  });
  it('listPublisherSectors throws NotImplementedError', async () => {
    await expect(impactAdapter.listPublisherSectors()).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// §15.4 error transparency — verbatim body, classified type
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim Impact response body on a 500', async () => {
    const body = '{"Message":"upstream broke at 03:14:15","trace":"abc"}';
    // 500 is NOT in DEFAULT_RESILIENCE.retryOn, so a single call exhausts.
    mockFetchQueue([fakeResponse(body, { status: 500, rawBody: body })]);
    try {
      await impactAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('impact');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream broke');
    }
  });

  it('classifies 401 as auth_error', async () => {
    mockFetchQueue([fakeResponse('forbidden', { status: 401, rawBody: 'forbidden' })]);
    try {
      await impactAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('auth_error');
    }
  });
});

// ---------------------------------------------------------------------------
// §15.6 retry — 502 → 200 succeeds after one retry (this is the canonical
// Impact-flakiness exercise for the resilience layer per PRD §9.3).
// ---------------------------------------------------------------------------

describe('§15.6 resilience-layer retry on Impact 5xx', () => {
  it('retries listTransactions on 502 and succeeds on the second attempt', async () => {
    const fixture = loadFixture('actions.json');
    // First fetch: 502 (retryable per DEFAULT_RESILIENCE.retryOn).
    // Second fetch: 200 with the actions fixture.
    const spy = mockFetchQueue([
      fakeResponse('Bad Gateway', { status: 502, rawBody: '<html>502</html>' }),
      fakeResponse(fixture),
    ]);
    const out = await impactAdapter.listTransactions({
      from: '2026-04-21T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
    });
    expect(out.length).toBeGreaterThan(0);
    // Exactly two fetches: the failing 502 and the successful retry.
    expect(spy.mock.calls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// §15.7 no retry on 4xx — a 400 with a body returns an envelope after exactly
// one fetch call.
// ---------------------------------------------------------------------------

describe('§15.7 no-retry on 4xx', () => {
  it('returns a NetworkError envelope after exactly one fetch on 400', async () => {
    const spy = mockFetchQueue([
      fakeResponse('{"Message":"bad request"}', { status: 400 }),
    ]);
    try {
      await impactAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.httpStatus).toBe(400);
      expect(env.networkErrorBody).toContain('bad request');
    }
    expect(spy.mock.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// §15.8 rate limit — 429 triggers a retry.
// ---------------------------------------------------------------------------

describe('§15.8 rate-limit retry', () => {
  it('retries on 429 and succeeds on the second attempt', async () => {
    const spy = mockFetchQueue([
      fakeResponse('{"Message":"too many requests"}', { status: 429 }),
      fakeResponse(loadFixture('campaigns.json')),
    ]);
    const out = await impactAdapter.listProgrammes({ limit: 5 });
    expect(out.length).toBeGreaterThan(0);
    expect(spy.mock.calls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// §15.5 circuit breaker — after 5 consecutive failures the 6th call fails
// fast with `circuit_open` and DOES NOT invoke fetch.
//
// We use listProgrammes (which uses DEFAULT_RESILIENCE — threshold 5,
// retries 2, retryOn [429, 502, 503, 504]) and throw 500 (NOT in retryOn) so
// each call counts as exactly one failure with no retries. After 5 calls the
// breaker opens.
// ---------------------------------------------------------------------------

describe('§15.5 circuit breaker', () => {
  it('opens after 5 consecutive 500s; the 6th call returns circuit_open without invoking fetch', async () => {
    const body = '{"Message":"upstream broke"}';
    // Queue exactly 5 failing responses. If the breaker is correct, the 6th
    // call must NOT touch the queue at all (so we don't need a 6th entry).
    const spy = mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);

    for (let i = 0; i < 5; i++) {
      await expect(impactAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
    }
    // 6th call — breaker open. Must surface circuit_open and skip fetch.
    try {
      await impactAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('circuit_open');
      expect(env.network).toBe('impact');
      expect(env.operation).toBe('listProgrammes');
    }
    // Critically: fetch was invoked exactly 5 times, NOT 6.
    expect(spy.mock.calls.length).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck — listClicks is supported for Impact.
// ---------------------------------------------------------------------------

describe('Impact.capabilitiesCheck', () => {
  it('records listClicks.supported = true (Impact exposes /Clicks)', async () => {
    // Stub enough fetches: listProgrammes, listTransactions probe,
    // getEarningsSummary → listTransactions, listClicks probe, verifyAuth.
    mockFetchQueue([
      fakeResponse({ Campaigns: [] }), // listProgrammes
      fakeResponse({ Actions: [] }),   // listTransactions
      fakeResponse({ Actions: [] }),   // getEarningsSummary -> listTransactions
      fakeResponse({ Clicks: [] }),    // listClicks probe
      fakeResponse(loadFixture('campaigns.json')), // verifyAuth
    ]);
    const caps = await impactAdapter.capabilitiesCheck();
    expect(caps.network).toBe('impact');
    expect(caps.operations['listClicks']?.supported).toBe(true);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});

describe('Impact.applyToProgram — API gap + browser handoff', () => {
  it('never throws; returns a structured api-gap response with a browser fallback', async () => {
    const res = await impactAdapter.applyToProgram({
      campaignId: '12345',
      promotionalMethods: ['blog', 'email'],
      notes: 'UK lifestyle audience, 40k monthly readers.',
    });

    expect(res.kind).toBe('api-gap');
    expect(res.network).toBe('impact');
    expect(res.operation).toBe('applyToProgram');
    expect(res.reason).toMatch(/does not expose/i);

    // userMessage carries the rules from CONTRIBUTING.md → API gaps:
    //  - names the network factually, offers a fallback, hedges with "try",
    //    surfaces the confirm step, and ends with a question.
    expect(res.userMessage).toMatch(/Impact's API/);
    expect(res.userMessage).toMatch(/browser agent|Claude for Chrome/);
    expect(res.userMessage).toMatch(/before anything is clicked/);
    expect(res.userMessage.trim().endsWith('?')).toBe(true);

    const handoff = res.browserFallback;
    expect(handoff).not.toBeNull();
    expect(handoff?.mutates).toBe(true);
    expect(handoff?.startingUrl).toContain('12345');
    expect(handoff?.inputs).toMatchObject({
      campaignId: '12345',
      promotionalMethods: ['blog', 'email'],
    });
    expect(handoff?.constraints.some((c) => /confirmation/i.test(c))).toBe(true);
    expect(handoff?.verify.expect).toMatch(/12345/);
  });

  it('emits a handoff even when optional inputs are omitted', async () => {
    const res = await impactAdapter.applyToProgram({ campaignId: '999' });
    expect(res.browserFallback?.inputs).toMatchObject({
      campaignId: '999',
      promotionalMethods: [],
      notes: '',
    });
  });
});
