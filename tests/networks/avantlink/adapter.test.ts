/**
 * AvantLink adapter — unit tests.
 *
 * Pattern matched to `tests/networks/awin/adapter.test.ts` and
 * `tests/networks/everflow/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 *   - Fixtures approximate the shape of real AvantLink module responses. They
 *     contain no real credentials, merchant data, or order IDs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { avantlinkAdapter, _internals } from '../../../src/networks/avantlink/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'networks', 'avantlink', 'fixtures');

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as Record<string, unknown>;
}

function txnRows(): Array<Record<string, unknown>> {
  return loadFixture('transactions.json')['transactions'] as Array<Record<string, unknown>>;
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
  process.env['AVANTLINK_AFFILIATE_ID'] = '123456';
  process.env['AVANTLINK_API_KEY'] = 'test-auth-key-please-ignore-00000000';
  process.env['AVANTLINK_WEBSITE_ID'] = '789012';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['AVANTLINK_AFFILIATE_ID'];
  delete process.env['AVANTLINK_API_KEY'];
  delete process.env['AVANTLINK_WEBSITE_ID'];
});

// ---------------------------------------------------------------------------
// Transformation (status mapping + raw preservation)
// ---------------------------------------------------------------------------

describe('AvantLink transformers (status normalisation, raw preservation)', () => {
  it('maps association statuses to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus({ association_status: 'Active' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ association_status: 'Pending' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ association_status: 'Declined' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ association_status: 'Available' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ association_status: 'Paused' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ association_status: 'never-seen-before' })).toBe(
      'unknown',
    );
  });

  it('maps transaction statuses pending|approved|reversed|paid → canonical statuses', () => {
    const rows = txnRows();
    expect(_internals.toTransaction(rows[0] as never).status).toBe('approved'); // Confirmed
    expect(_internals.toTransaction(rows[1] as never).status).toBe('pending'); // Open
    // §15.4: a reversed/returned sale maps to 'reversed' (the user-facing intent).
    expect(_internals.toTransaction(rows[2] as never).status).toBe('reversed'); // Reversed
    expect(_internals.toTransaction(rows[3] as never).status).toBe('paid'); // Paid
  });

  it('parses decimal-string money fields into numbers', () => {
    const out = _internals.toTransaction(txnRows()[0] as never);
    expect(out.amount).toBe(120);
    expect(out.commission).toBe(9.6);
    expect(out.currency).toBe('USD');
  });

  it('preserves the raw AvantLink row under rawNetworkData', () => {
    const raw = txnRows()[0];
    const out = _internals.toTransaction(raw as never);
    expect(out.rawNetworkData).toBe(raw);
  });

  it('surfaces reversalReason on reversed transactions (§15.10)', () => {
    const out = _internals.toTransaction(txnRows()[2] as never);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Customer returned the item within 30 days');
  });

  it('computes ageDays from the transaction date', () => {
    const now = new Date('2026-06-05T00:00:00Z');
    const age = _internals.computeAgeDays({ transaction_date: '2026-01-01' }, now);
    expect(age).toBe(155);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('AvantLink.listProgrammes', () => {
  it('lists merchant associations and applies a client-side status filter', async () => {
    mockFetchQueue([fakeResponse(loadFixture('associations.json'))]);
    const joined = await avantlinkAdapter.listProgrammes({ status: 'joined' });
    expect(joined.length).toBe(1);
    expect(joined[0]?.name).toBe('Backcountry Outfitters');
    expect(joined[0]?.network).toBe('avantlink');
  });

  it('applies a client-side search filter', async () => {
    mockFetchQueue([fakeResponse(loadFixture('associations.json'))]);
    const found = await avantlinkAdapter.listProgrammes({ search: 'trailhead' });
    expect(found.length).toBe(1);
    expect(found[0]?.id).toBe('10061');
  });

  it('emits a NetworkError when a credential is missing (§15.4)', async () => {
    delete process.env['AVANTLINK_API_KEY'];
    await expect(avantlinkAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getProgramme
// ---------------------------------------------------------------------------

describe('AvantLink.getProgramme', () => {
  it('selects the matching merchant by ID', async () => {
    mockFetchQueue([fakeResponse(loadFixture('associations.json'))]);
    const p = await avantlinkAdapter.getProgramme('10062');
    expect(p.id).toBe('10062');
    expect(p.status).toBe('declined');
  });

  it('throws a config_error envelope for a non-numeric ID', async () => {
    await expect(avantlinkAdapter.getProgramme('not-a-number')).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listTransactions — unpaid-age + reversed visibility (§15.9, §15.10)
// ---------------------------------------------------------------------------

describe('AvantLink.listTransactions', () => {
  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const aged = await avantlinkAdapter.listTransactions({
      from: '2026-05-06T00:00:00Z',
      to: '2026-06-05T00:00:00Z',
      minAgeDays: 365,
    });
    for (const t of aged) {
      expect(t.ageDays).toBeGreaterThanOrEqual(365);
    }
    expect(aged.length).toBeGreaterThan(0);
  });

  it('includes reversed transactions with reason populated (§15.10)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const all = await avantlinkAdapter.listTransactions({
      from: '2026-05-06T00:00:00Z',
      to: '2026-06-05T00:00:00Z',
    });
    const reversed = all.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toBe('Customer returned the item within 30 days');
  });

  it('chunks date ranges wider than 31 days into multiple calls', async () => {
    const spy = mockFetchQueue([
      fakeResponse({ transactions: [] }),
      fakeResponse({ transactions: [] }),
      fakeResponse({ transactions: [] }),
    ]);
    await avantlinkAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-03-31T00:00:00Z', // ~90 days → 3 slices
    });
    expect(spy.mock.calls.length).toBe(3);
  });

  it('filters by status when caller passes status[]', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const only = await avantlinkAdapter.listTransactions({
      from: '2026-05-06T00:00:00Z',
      to: '2026-06-05T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
    expect(only.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('AvantLink.getEarningsSummary', () => {
  it('aggregates commission by status and programme from listTransactions', async () => {
    // Single ≤31-day window so the adapter makes exactly one upstream call;
    // the fixture echoes all rows regardless of date.
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const summary = await avantlinkAdapter.getEarningsSummary({
      from: '2026-05-10T00:00:00Z',
      to: '2026-06-05T00:00:00Z',
    });
    expect(summary.network).toBe('avantlink');
    // 9.60 + 8.00 + 10.00 + 4.80
    expect(summary.totalEarnings).toBeCloseTo(32.4, 2);
    expect(summary.byStatus.reversed).toBeCloseTo(10, 2);
    expect(summary.byStatus.paid).toBeCloseTo(4.8, 2);
    expect(summary.byProgramme.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// listClicks
// ---------------------------------------------------------------------------

describe('AvantLink.listClicks', () => {
  it('throws NotImplementedError with the documented reason', async () => {
    await expect(avantlinkAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await avantlinkAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('does not expose per-click data');
    }
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — CustomLink module returns a bare URL string
// ---------------------------------------------------------------------------

describe('AvantLink.generateTrackingLink', () => {
  it('returns the tracking URL from the CustomLink module', async () => {
    const url = 'https://www.avantlink.com/click.php?tt=cl&mi=10060&pw=789012&url=https%3A%2F%2Fx.test';
    mockFetchQueue([fakeResponse(url, { rawBody: url })]);
    const link = await avantlinkAdapter.generateTrackingLink({
      programmeId: '10060',
      destinationUrl: 'https://x.test/product',
    });
    expect(link.trackingUrl).toBe(url);
    expect(link.programmeId).toBe('10060');
    expect(link.network).toBe('avantlink');
  });

  it('throws a config_error envelope when programmeId is missing', async () => {
    await expect(
      avantlinkAdapter.generateTrackingLink({ programmeId: '', destinationUrl: 'https://x.test' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a network_api_error envelope when CustomLink returns no URL', async () => {
    mockFetchQueue([fakeResponse('ERROR: not associated', { rawBody: 'ERROR: not associated' })]);
    await expect(
      avantlinkAdapter.generateTrackingLink({
        programmeId: '10060',
        destinationUrl: 'https://x.test/product',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth + validateCredential
// ---------------------------------------------------------------------------

describe('AvantLink.verifyAuth', () => {
  it('returns ok:true and an identity when AssociationFeed responds 200', async () => {
    mockFetchQueue([fakeResponse(loadFixture('associations.json'))]);
    const r = await avantlinkAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toContain('avantlink/affiliate/123456');
  });

  it('surfaces a failure reason on a 401', async () => {
    mockFetchQueue([fakeResponse('Invalid auth_key', { status: 401, rawBody: 'Invalid auth_key' })]);
    const r = await avantlinkAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/401/);
  });
});

describe('AvantLink.validateCredential', () => {
  it('rejects malformed affiliate / website IDs', async () => {
    expect((await avantlinkAdapter.validateCredential('AVANTLINK_AFFILIATE_ID', 'abc')).ok).toBe(false);
    expect((await avantlinkAdapter.validateCredential('AVANTLINK_WEBSITE_ID', '-1')).ok).toBe(false);
  });

  it('accepts well-formed numeric IDs', async () => {
    expect((await avantlinkAdapter.validateCredential('AVANTLINK_AFFILIATE_ID', '123456')).ok).toBe(true);
  });

  it('validates the API key by calling AssociationFeed', async () => {
    mockFetchQueue([fakeResponse(loadFixture('associations.json'))]);
    const r = await avantlinkAdapter.validateCredential('AVANTLINK_API_KEY', 'fresh-key');
    expect(r.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('AvantLink.capabilitiesCheck', () => {
  it('records listClicks.supported = false with the known-limitation note', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('associations.json')), // listProgrammes
      fakeResponse({ transactions: [] }), // listTransactions probe
      fakeResponse({ transactions: [] }), // getEarningsSummary → listTransactions
      fakeResponse(loadFixture('associations.json')), // verifyAuth
    ]);
    const caps = await avantlinkAdapter.capabilitiesCheck();
    expect(caps.network).toBe('avantlink');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['listClicks']?.note).toContain('per-click data');
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim AvantLink response body on a 500', async () => {
    const body = '{"error":"report engine unavailable"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await avantlinkAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('avantlink');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('report engine unavailable');
    }
  });

  it('classifies 401 as auth_error', async () => {
    mockFetchQueue([fakeResponse('forbidden', { status: 401, rawBody: 'forbidden' })]);
    try {
      await avantlinkAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('auth_error');
    }
  });
});
