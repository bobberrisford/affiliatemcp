/**
 * ShareASale adapter — unit tests.
 *
 * Mirrors the Awin / Profitshare test patterns:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - Each test stubs only the responses it needs.
 *
 * ShareASale-specific: a dedicated test asserts the HMAC-SHA256 signature and
 * x-ShareASale-Date headers are present and deterministic for a fixed input
 * (the key auth quirk), pinned against the published worked example.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { shareasaleAdapter, _internals } from '../../../src/networks/shareasale/adapter.js';
import { signRequest, formatShareasaleDate } from '../../../src/networks/shareasale/client.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'shareasale');

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
  process.env['SHAREASALE_AFFILIATE_ID'] = '1234567';
  process.env['SHAREASALE_API_TOKEN'] = 'test-token-please-ignore';
  process.env['SHAREASALE_API_SECRET'] = 'test-secret-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['SHAREASALE_AFFILIATE_ID'];
  delete process.env['SHAREASALE_API_TOKEN'];
  delete process.env['SHAREASALE_API_SECRET'];
  delete process.env['SHAREASALE_DEFAULT_BANNER_ID'];
});

// ---------------------------------------------------------------------------
// HMAC signing — the ShareASale auth quirk
// ---------------------------------------------------------------------------

describe('ShareASale HMAC signing', () => {
  it('produces deterministic x-ShareASale-Date + x-ShareASale-Authentication headers', () => {
    const date = new Date('2026-01-15T10:30:45.000Z');
    const credentials = { affiliateId: '1234567', token: 'public-token', secretKey: 'secret-key' };
    const headers = signRequest({ action: 'merchantStatus', credentials, date });

    expect(headers['x-ShareASale-Date']).toBe('Thu, 15 Jan 2026 10:30:45 GMT');
    expect(headers['x-ShareASale-Authentication']).toBeTruthy();

    // Signature recomputed independently must match (deterministic).
    const dateHeader = formatShareasaleDate(date);
    const sig = `${credentials.token}:${dateHeader}:merchantStatus:${credentials.secretKey}`;
    const expected = createHash('sha256').update(sig).digest('hex');
    expect(headers['x-ShareASale-Authentication']).toBe(expected);

    // Calling again with the same input yields the same signature.
    const again = signRequest({ action: 'merchantStatus', credentials, date });
    expect(again['x-ShareASale-Authentication']).toBe(headers['x-ShareASale-Authentication']);
  });

  it('matches the published worked example vector (case-insensitive hex)', () => {
    // From the ShareASale API documentation worked example:
    //   token  = "NGc6dg5e9URups5o"
    //   secret = "ATj7vd8b7CCjeq9yQUo8cc2w3OThqe2e"
    //   action = "bannerList"
    //   date   = "Thu, 14 Apr 2011 22:44:22 GMT"
    //   hash   = "78D54A3051AE0AAAF022AA2DA230B97D5219D82183FEFF71E2D53DEC6057D9F1"
    const date = new Date('2011-04-14T22:44:22.000Z');
    const credentials = {
      affiliateId: '999',
      token: 'NGc6dg5e9URups5o',
      secretKey: 'ATj7vd8b7CCjeq9yQUo8cc2w3OThqe2e',
    };
    const headers = signRequest({ action: 'bannerList', credentials, date });
    expect(headers['x-ShareASale-Date']).toBe('Thu, 14 Apr 2011 22:44:22 GMT');
    expect(headers['x-ShareASale-Authentication']?.toUpperCase()).toBe(
      '78D54A3051AE0AAAF022AA2DA230B97D5219D82183FEFF71E2D53DEC6057D9F1',
    );
  });

  it('changes the signature when the action changes', () => {
    const date = new Date('2026-01-15T10:30:45.000Z');
    const credentials = { affiliateId: '1', token: 't', secretKey: 'k' };
    const a = signRequest({ action: 'merchantStatus', credentials, date });
    const b = signRequest({ action: 'activity', credentials, date });
    expect(a['x-ShareASale-Authentication']).not.toBe(b['x-ShareASale-Authentication']);
  });
});

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

describe('ShareASale transformers (status normalisation, raw preservation)', () => {
  it('maps activity statuses to canonical statuses', () => {
    const rows = (loadFixture('activity.json') as { result: Array<Record<string, unknown>> }).result;
    expect(_internals.toTransaction(rows[0] as never).status).toBe('approved'); // locked
    expect(_internals.toTransaction(rows[1] as never).status).toBe('pending');
    expect(_internals.toTransaction(rows[2] as never).status).toBe('reversed'); // voided
    expect(_internals.toTransaction(rows[3] as never).status).toBe('paid');
  });

  it('surfaces a void reason on reversed rows', () => {
    const rows = (loadFixture('activity.json') as { result: Array<Record<string, unknown>> }).result;
    const reversed = _internals.toTransaction(rows[2] as never);
    expect(reversed.status).toBe('reversed');
    expect(reversed.reversalReason).toBe('Order returned by customer');
  });

  it('preserves the raw activity payload under rawNetworkData', () => {
    const row = (loadFixture('activity.json') as { result: Array<Record<string, unknown>> }).result[0];
    const out = _internals.toTransaction(row as never);
    expect(out.rawNetworkData).toBe(row);
  });

  it('parses string amounts (with currency symbols) into numbers', () => {
    expect(_internals.toNumber('9.64')).toBeCloseTo(9.64);
    expect(_internals.toNumber('$1,234.56')).toBeCloseTo(1234.56);
    expect(_internals.toNumber(12)).toBe(12);
    expect(_internals.toNumber(undefined)).toBe(0);
  });

  it('maps merchant relationship to canonical ProgrammeStatus', () => {
    expect(_internals.mapMerchantStatus({ status: 'approved' })).toBe('joined');
    expect(_internals.mapMerchantStatus({ status: 'pending' })).toBe('pending');
    expect(_internals.mapMerchantStatus({ status: 'declined' })).toBe('declined');
    expect(_internals.mapMerchantStatus({ status: 'never-seen' })).toBe('unknown');
  });

  it('treats the voided flag as authoritative over the status text', () => {
    expect(_internals.mapActivityStatus({ status: 'locked', voided: 'true' })).toBe('reversed');
    expect(_internals.mapActivityStatus({ status: 'locked', paid: '1' })).toBe('paid');
  });

  it('computes ageDays from the conversion date', () => {
    const now = new Date('2026-05-21T00:00:00Z');
    expect(_internals.computeAgeDays({ transDate: '2026-01-01T00:00:00Z' }, now)).toBe(140);
  });

  it('defaults currency to USD when a row omits it', () => {
    const out = _internals.toTransaction({ transID: 1, status: 'pending', commission: '5' });
    expect(out.currency).toBe('USD');
  });

  it('formats dates as MM/DD/YYYY', () => {
    expect(_internals.toShareasaleDate(new Date('2026-01-09T00:00:00Z'))).toBe('01/09/2026');
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('ShareASale.listProgrammes', () => {
  it('unwraps result and maps merchants to programmes', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchants.json'))]);
    const programmes = await shareasaleAdapter.listProgrammes();
    expect(programmes.length).toBe(3);
    expect(programmes[0]?.network).toBe('shareasale');
    expect(programmes[0]?.name).toBe('Atolls Outdoors US');
    expect(programmes[0]?.status).toBe('joined');
  });

  it('applies a client-side search filter', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchants.json'))]);
    const programmes = await shareasaleAdapter.listProgrammes({ search: 'electronics' });
    expect(programmes.length).toBe(1);
    expect(programmes[0]?.id).toBe('51172');
  });

  it('filters by programme status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchants.json'))]);
    const pending = await shareasaleAdapter.listProgrammes({ status: ['pending'] });
    expect(pending.length).toBe(1);
    expect(pending[0]?.id).toBe('51172');
  });

  it('emits a config_error envelope when credentials are missing', async () => {
    delete process.env['SHAREASALE_API_SECRET'];
    await expect(shareasaleAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getProgramme
// ---------------------------------------------------------------------------

describe('ShareASale.getProgramme', () => {
  it('returns a single merchant derived from the list', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchants.json'))]);
    const p = await shareasaleAdapter.getProgramme('46483');
    expect(p.id).toBe('46483');
    expect(p.name).toBe('Atolls Outdoors US');
  });

  it('throws when the merchant id is unknown', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchants.json'))]);
    await expect(shareasaleAdapter.getProgramme('999999')).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error envelope when id is empty', async () => {
    await expect(shareasaleAdapter.getProgramme('')).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('ShareASale.listTransactions', () => {
  it('returns activity and filters by status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('activity.json'))]);
    const reversed = await shareasaleAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-20T00:00:00Z',
      status: ['reversed'],
    });
    expect(reversed.every((t) => t.status === 'reversed')).toBe(true);
    expect(reversed.length).toBe(1);
  });

  it('filters by minAgeDays (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('activity.json'))]);
    const aged = await shareasaleAdapter.listTransactions({
      from: '2025-12-01T00:00:00Z',
      to: '2025-12-20T00:00:00Z',
      minAgeDays: 36500, // ~100 years — nothing should match
    });
    expect(aged.length).toBe(0);
  });

  it('chunks a wide date window into multiple signed calls', async () => {
    // ~90 days → at least 3 chunks of ≤31 days. Each chunk gets the same fixture.
    const spy = mockFetchQueue([
      fakeResponse({ result: [] }),
      fakeResponse({ result: [] }),
      fakeResponse({ result: [] }),
      fakeResponse({ result: [] }),
    ]);
    await shareasaleAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-04-01T00:00:00Z',
    });
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('emits an error envelope when credentials are missing', async () => {
    delete process.env['SHAREASALE_API_TOKEN'];
    await expect(shareasaleAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('ShareASale.getEarningsSummary', () => {
  it('aggregates commission by status and programme (client-side)', async () => {
    // A narrow window resolves to a single 31-day chunk → one fetch. The
    // fixture returns all rows regardless of the requested dates.
    mockFetchQueue([fakeResponse(loadFixture('activity.json'))]);
    const summary = await shareasaleAdapter.getEarningsSummary({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-20T00:00:00Z',
    });
    expect(summary.network).toBe('shareasale');
    expect(summary.currency).toBe('USD');
    // Two merchants in the fixture.
    expect(summary.byProgramme.length).toBe(2);
    expect(summary.byStatus.approved).toBeCloseTo(9.64);
    expect(summary.byStatus.paid).toBeCloseTo(8.75);
    expect(summary.byStatus.reversed).toBeCloseTo(3.6);
  });
});

// ---------------------------------------------------------------------------
// listClicks (NotImplemented) + generateTrackingLink (deterministic)
// ---------------------------------------------------------------------------

describe('ShareASale.listClicks', () => {
  it('throws NotImplementedError', async () => {
    await expect(shareasaleAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
  });
});

describe('ShareASale.generateTrackingLink', () => {
  it('builds a deterministic r.cfm deep link', async () => {
    const link = await shareasaleAdapter.generateTrackingLink({
      programmeId: '46483',
      destinationUrl: 'https://www.atolls-outdoors.example.com/tents',
    });
    expect(link.network).toBe('shareasale');
    expect(link.trackingUrl).toContain('https://shareasale.com/r.cfm');
    expect(link.trackingUrl).toContain('u=1234567');
    expect(link.trackingUrl).toContain('m=46483');
    expect(link.trackingUrl).toContain('b=0');
    expect(link.trackingUrl).toContain(
      'urllink=' + encodeURIComponent('https://www.atolls-outdoors.example.com/tents'),
    );
  });

  it('honours SHAREASALE_DEFAULT_BANNER_ID when set', async () => {
    process.env['SHAREASALE_DEFAULT_BANNER_ID'] = '467188';
    const link = await shareasaleAdapter.generateTrackingLink({
      programmeId: '46483',
      destinationUrl: 'https://www.atolls-outdoors.example.com',
    });
    expect(link.trackingUrl).toContain('b=467188');
  });

  it('throws a config_error envelope when programmeId is missing', async () => {
    await expect(
      shareasaleAdapter.generateTrackingLink({ programmeId: '', destinationUrl: 'https://x.example.com' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('ShareASale.verifyAuth', () => {
  it('returns ok:true and identity on a 200 signed call', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchants.json'))]);
    const r = await shareasaleAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toContain('shareasale/');
  });

  it('returns ok:false on a 401', async () => {
    mockFetchQueue([fakeResponse('Invalid Authentication', { status: 401, rawBody: 'Invalid Authentication' })]);
    const r = await shareasaleAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/401|Authentication/);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('ShareASale.validateCredential', () => {
  it('rejects a non-numeric affiliate id', async () => {
    const r = await shareasaleAdapter.validateCredential('SHAREASALE_AFFILIATE_ID', 'abc');
    expect(r.ok).toBe(false);
  });

  it('accepts a numeric affiliate id', async () => {
    const r = await shareasaleAdapter.validateCredential('SHAREASALE_AFFILIATE_ID', '1234567');
    expect(r.ok).toBe(true);
  });

  it('validates the secret by making a signed call', async () => {
    mockFetchQueue([fakeResponse(loadFixture('merchants.json'))]);
    const r = await shareasaleAdapter.validateCredential('SHAREASALE_API_SECRET', 'fresh-secret');
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with a hint when the secret fails', async () => {
    mockFetchQueue([fakeResponse('Invalid Authentication', { status: 401, rawBody: 'Invalid Authentication' })]);
    const r = await shareasaleAdapter.validateCredential('SHAREASALE_API_SECRET', 'bad-secret');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('ShareASale.capabilitiesCheck', () => {
  it('records listClicks unsupported and generateTrackingLink supported', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('merchants.json')), // listProgrammes
      fakeResponse(loadFixture('activity.json')), // listTransactions probe
      fakeResponse(loadFixture('activity.json')), // getEarningsSummary → listTransactions
      fakeResponse(loadFixture('merchants.json')), // verifyAuth
    ]);
    const caps = await shareasaleAdapter.capabilitiesCheck();
    expect(caps.network).toBe('shareasale');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(true);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim ShareASale body on a 500', async () => {
    const body = 'Error: report engine unavailable';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await shareasaleAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('shareasale');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('report engine unavailable');
    }
  });

  it('classifies 401 as auth_error', async () => {
    mockFetchQueue([fakeResponse('forbidden', { status: 401, rawBody: 'forbidden' })]);
    try {
      await shareasaleAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('auth_error');
    }
  });
});
