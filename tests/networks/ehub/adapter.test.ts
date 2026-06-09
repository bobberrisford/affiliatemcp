/**
 * eHUB adapter — unit tests.
 *
 * Patterned on `tests/networks/awin/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - Transformer-level tests run the documented eHUB shapes through the
 *     `_internals` helpers.
 *   - No live calls; all responses are minted from the documented API shapes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { ehubAdapter, _internals } from '../../../src/networks/ehub/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'networks', 'ehub', 'fixtures');

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
  process.env['EHUB_API_KEY'] = 'test-key-please-ignore';
  process.env['EHUB_PUBLISHER_ID'] = '412289c2';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['EHUB_API_KEY'];
  delete process.env['EHUB_PUBLISHER_ID'];
});

// ---------------------------------------------------------------------------
// Transformers (status normalisation + raw preservation + amount parsing)
// ---------------------------------------------------------------------------

describe('eHUB transformers', () => {
  it('maps eHUB transaction statuses to canonical statuses', () => {
    const { transactions } = loadFixture('transactions.json') as {
      transactions: Array<Record<string, unknown>>;
    };
    expect(_internals.toTransaction(transactions[0] as never).status).toBe('approved');
    expect(_internals.toTransaction(transactions[1] as never).status).toBe('pending');
    // declined → reversed (the user-facing intent: no payout).
    expect(_internals.toTransaction(transactions[2] as never).status).toBe('reversed');
    // datePaid populated overrides status → paid.
    expect(_internals.toTransaction(transactions[3] as never).status).toBe('paid');
    // pre-approved is provisional → pending (money not yet payable).
    expect(_internals.toTransaction(transactions[4] as never).status).toBe('pending');
  });

  it('maps unknown statuses to "other" rather than guessing', () => {
    expect(_internals.mapTransactionStatus({ status: 'something-new' })).toBe('other');
  });

  it('preserves the raw eHUB response under rawNetworkData', () => {
    const raw = (loadFixture('transactions.json') as { transactions: Array<Record<string, unknown>> })
      .transactions[0];
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('surfaces reversalReason on reversed transactions (§15.10)', () => {
    const declined = (loadFixture('transactions.json') as {
      transactions: Array<Record<string, unknown>>;
    }).transactions[2];
    const out = _internals.toTransaction(declined as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Customer returned the item within 14 days');
  });

  it('parses numeric and locale-formatted string amounts', () => {
    expect(_internals.toAmount(199)).toBe(199);
    expect(_internals.toAmount('129,95')).toBeCloseTo(129.95);
    expect(_internals.toAmount('1 299,50')).toBeCloseTo(1299.5);
    expect(_internals.toAmount(undefined)).toBe(0);
  });

  it('maps campaign relationship to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ approved: true })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ status: 'declined' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ status: 'available' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ status: 'paused' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'never-seen-before' })).toBe('unknown');
  });

  it('computes ageDays from dateApproved (preferred) or dateInsert', () => {
    const now = new Date('2026-05-21T00:00:00Z');
    const age1 = _internals.computeAgeDays({ dateApproved: '2026-01-01T00:00:00Z' }, now);
    expect(age1).toBe(140);
    const age2 = _internals.computeAgeDays({ dateInsert: '2026-04-01T00:00:00Z' }, now);
    expect(age2).toBe(50);
  });

  it('maps canonical statuses to eHUB server-side filter values where unambiguous', () => {
    expect(_internals.canonicalToEhubStatus('approved')).toBe('approved');
    expect(_internals.canonicalToEhubStatus('reversed')).toBe('declined');
    // 'pending' covers both pending and pre-approved upstream → filter client-side.
    expect(_internals.canonicalToEhubStatus('pending')).toBeUndefined();
    expect(_internals.canonicalToEhubStatus('paid')).toBeUndefined();
  });

  it('maps clicks, reading either referer/referrer and url/destination keys', () => {
    const { clicks } = loadFixture('clicks.json') as { clicks: Array<Record<string, unknown>> };
    const c1 = _internals.toClick(clicks[0] as never);
    const c2 = _internals.toClick(clicks[1] as never);
    expect(c1.programmeId).toBe('55');
    expect(c1.referrer).toBe('https://blog.example.com/post');
    expect(c1.destinationUrl).toBe('https://www.trenyrkarna.cz/sale');
    expect(c2.referrer).toBe('https://blog.example.com/books');
    expect(c2.destinationUrl).toBe('https://www.knihy.cz/novinky');
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('eHUB.listProgrammes', () => {
  it('lists campaigns and unwraps the { campaigns: [] } envelope', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const programmes = await ehubAdapter.listProgrammes();
    expect(programmes.length).toBe(3);
    expect(programmes[0]?.name).toBe('Trenyrkarna.cz');
    expect(programmes[0]?.status).toBe('joined');
    expect(programmes[0]?.network).toBe('ehub');
  });

  it('applies client-side search + status + limit filters', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const joined = await ehubAdapter.listProgrammes({ status: 'joined' });
    expect(joined.every((p) => p.status === 'joined')).toBe(true);
    expect(joined.length).toBe(1);

    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const search = await ehubAdapter.listProgrammes({ search: 'knihy' });
    expect(search.length).toBe(1);
    expect(search[0]?.id).toBe('77');
  });

  it('sends the apiKey as a query parameter', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    await ehubAdapter.listProgrammes();
    const calledUrl = String(spy.mock.calls[0]?.[0]);
    expect(calledUrl).toContain('https://api.ehub.cz/v3/campaigns');
    expect(calledUrl).toContain('apiKey=test-key-please-ignore');
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('eHUB.listTransactions', () => {
  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const aged = await ehubAdapter.listTransactions({
      from: '2024-01-01',
      to: '2026-06-01',
      minAgeDays: 365,
    });
    for (const t of aged) {
      expect(t.ageDays).toBeGreaterThanOrEqual(365);
    }
    expect(aged.length).toBeGreaterThan(0);
  });

  it('includes reversed transactions with reason populated (§15.10)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const all = await ehubAdapter.listTransactions({ from: '2024-01-01', to: '2026-06-01' });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toBe('Customer returned the item within 14 days');
  });

  it('filters by status client-side when caller passes status[]', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const only = await ehubAdapter.listTransactions({
      from: '2024-01-01',
      to: '2026-06-01',
      status: ['paid'],
    });
    expect(only.every((t) => t.status === 'paid')).toBe(true);
    expect(only.length).toBe(1);
  });

  it('pages until a short page is returned', async () => {
    // First page is full (100 rows), second page short → two calls.
    const fullPage = { code: 200, transactions: Array.from({ length: 100 }, (_v, i) => ({
      id: i,
      campaignId: 1,
      status: 'pending',
      type: 'sale',
      totalCost: 10,
      commission: 1,
      currency: 'CZK',
      dateInsert: '2026-05-01T00:00:00Z',
    })) };
    const shortPage = { code: 200, transactions: [{ id: 100, campaignId: 1, status: 'pending', dateInsert: '2026-05-01T00:00:00Z' }] };
    const spy = mockFetchQueue([fakeResponse(fullPage), fakeResponse(shortPage)]);
    const txns = await ehubAdapter.listTransactions({ from: '2026-05-01', to: '2026-05-31' });
    expect(spy.mock.calls.length).toBe(2);
    expect(txns.length).toBe(101);
  });

  it('emits a NetworkError when the API key is missing', async () => {
    delete process.env['EHUB_API_KEY'];
    await expect(ehubAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('eHUB.getEarningsSummary', () => {
  it('derives totals + byStatus + oldestUnpaidAgeDays from transactions', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const summary = await ehubAdapter.getEarningsSummary({ from: '2024-01-01', to: '2026-06-01' });
    expect(summary.network).toBe('ehub');
    // commission totals: 199 + 50 + 30 + 25 + 129.95
    expect(summary.totalEarnings).toBeCloseTo(433.95);
    expect(summary.byStatus.approved).toBeCloseTo(199);
    expect(summary.byStatus.reversed).toBeCloseTo(30);
    expect(summary.byStatus.paid).toBeCloseTo(25);
    // pending = 50 + 129.95 (pre-approved bucketed as pending)
    expect(summary.byStatus.pending).toBeCloseTo(179.95);
    expect(summary.byProgramme.length).toBeGreaterThan(0);
    expect(summary.oldestUnpaidAgeDays).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// listClicks — eHUB exposes click data
// ---------------------------------------------------------------------------

describe('eHUB.listClicks', () => {
  it('returns click rows (eHUB exposes click data)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('clicks.json'))]);
    const clicks = await ehubAdapter.listClicks({ from: '2026-06-01', to: '2026-06-03' });
    expect(clicks.length).toBe(2);
    expect(clicks[0]?.network).toBe('ehub');
    expect(clicks[0]?.programmeId).toBe('55');
  });

  it('filters clicks by programmeId', async () => {
    mockFetchQueue([fakeResponse(loadFixture('clicks.json'))]);
    const clicks = await ehubAdapter.listClicks({ programmeId: '77' });
    expect(clicks.length).toBe(1);
    expect(clicks[0]?.programmeId).toBe('77');
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — deterministic construction
// ---------------------------------------------------------------------------

describe('eHUB.generateTrackingLink', () => {
  it('constructs the click.php URL with a_aid, a_bid, and encoded desturl', async () => {
    const link = await ehubAdapter.generateTrackingLink({
      programmeId: '0002258B',
      destinationUrl: 'https://www.trenyrkarna.cz/path?q=a b&c=ü',
    });
    expect(link.trackingUrl).toContain('https://ehub.cz/system/scripts/click.php?a_aid=412289c2');
    expect(link.trackingUrl).toContain('a_bid=0002258B');
    expect(link.trackingUrl).toContain(
      'desturl=https%3A%2F%2Fwww.trenyrkarna.cz%2Fpath%3Fq%3Da%20b%26c%3D%C3%BC',
    );
    expect(link.network).toBe('ehub');
    expect(link.programmeId).toBe('0002258B');
  });

  it('throws a config_error when programmeId is missing', async () => {
    await expect(
      ehubAdapter.generateTrackingLink({ programmeId: '', destinationUrl: 'https://x.example.com' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws when EHUB_PUBLISHER_ID is not configured', async () => {
    delete process.env['EHUB_PUBLISHER_ID'];
    await expect(
      ehubAdapter.generateTrackingLink({
        programmeId: '0002258B',
        destinationUrl: 'https://x.example.com',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('does NOT call fetch (deterministic construction)', async () => {
    const spy = mockFetchQueue([]);
    await ehubAdapter.generateTrackingLink({
      programmeId: '0002258B',
      destinationUrl: 'https://x.example.com',
    });
    expect(spy.mock.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('eHUB.verifyAuth', () => {
  it('returns ok:true when /campaigns responds 200', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const r = await ehubAdapter.verifyAuth();
    expect(r.ok).toBe(true);
  });

  it('returns ok:false on 401', async () => {
    mockFetchQueue([fakeResponse('{"error":"invalid_key"}', { status: 401 })]);
    const r = await ehubAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/401/);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('eHUB.validateCredential', () => {
  it('rejects an empty publisher id', async () => {
    const r = await ehubAdapter.validateCredential('EHUB_PUBLISHER_ID', '');
    expect(r.ok).toBe(false);
  });

  it('accepts a non-empty publisher id', async () => {
    const r = await ehubAdapter.validateCredential('EHUB_PUBLISHER_ID', '412289c2');
    expect(r.ok).toBe(true);
  });

  it('validates EHUB_API_KEY by calling /campaigns', async () => {
    mockFetchQueue([fakeResponse(loadFixture('campaigns.json'))]);
    const r = await ehubAdapter.validateCredential('EHUB_API_KEY', 'fresh-key');
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with a hint when EHUB_API_KEY validation fails', async () => {
    mockFetchQueue([fakeResponse('{"error":"bad"}', { status: 401 })]);
    const r = await ehubAdapter.validateCredential('EHUB_API_KEY', 'bad-key');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Admin stubs + capabilitiesCheck
// ---------------------------------------------------------------------------

describe('eHUB admin stubs', () => {
  it('listPublishers / listPublisherSectors throw NotImplementedError', async () => {
    await expect(ehubAdapter.listPublishers()).rejects.toBeInstanceOf(NotImplementedError);
    await expect(ehubAdapter.listPublisherSectors()).rejects.toBeInstanceOf(NotImplementedError);
  });
});

describe('eHUB.capabilitiesCheck', () => {
  it('records listClicks as supported (eHUB exposes click data)', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('campaigns.json')), // listProgrammes
      fakeResponse(loadFixture('transactions.json')), // listTransactions probe
      fakeResponse(loadFixture('transactions.json')), // getEarningsSummary → listTransactions
      fakeResponse(loadFixture('clicks.json')), // listClicks probe
      fakeResponse(loadFixture('campaigns.json')), // verifyAuth
    ]);
    const caps = await ehubAdapter.capabilitiesCheck();
    expect(caps.network).toBe('ehub');
    expect(caps.operations['listClicks']?.supported).toBe(true);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(true);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim eHUB body on a 500', async () => {
    const body = '{"error":"upstream broke","trace":"abc"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await ehubAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('ehub');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream broke');
    }
  });

  it('classifies 401 as auth_error', async () => {
    mockFetchQueue([fakeResponse('forbidden', { status: 401, rawBody: 'forbidden' })]);
    try {
      await ehubAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('auth_error');
    }
  });
});
