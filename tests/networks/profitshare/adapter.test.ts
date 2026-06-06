/**
 * Profitshare adapter — unit tests.
 *
 * Mirrors the Awin test patterns:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - Each test stubs only the responses it needs.
 *
 * Profitshare-specific: a dedicated test asserts the HMAC signature and Date
 * headers are present and deterministic for a fixed input (the key auth quirk).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import path from 'node:path';

import { profitshareAdapter, _internals } from '../../../src/networks/profitshare/adapter.js';
import { signRequest, formatProfitshareDate } from '../../../src/networks/profitshare/client.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'profitshare');

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
  process.env['PROFITSHARE_API_USER'] = 'affiliate@example.test';
  process.env['PROFITSHARE_API_KEY'] = 'test-key-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['PROFITSHARE_API_USER'];
  delete process.env['PROFITSHARE_API_KEY'];
});

// ---------------------------------------------------------------------------
// HMAC signing — the Profitshare auth quirk
// ---------------------------------------------------------------------------

describe('Profitshare HMAC signing', () => {
  it('produces deterministic Date + X-PS-Auth headers for a fixed input', () => {
    const date = new Date('2026-01-15T10:30:45.000Z');
    const credentials = { apiUser: 'affiliate@example.test', apiKey: 'secret-key' };
    const headers = signRequest({
      method: 'GET',
      resource: 'affiliate-advertisers',
      queryString: '',
      credentials,
      date,
    });

    // Headers present.
    expect(headers['X-PS-Client']).toBe('affiliate@example.test');
    expect(headers['X-PS-Accept']).toBe('json');
    expect(headers['Date']).toBe('Thu, 15 Jan 2026 10:30:45 GMT');
    expect(headers['X-PS-Auth']).toBeTruthy();

    // Signature recomputed independently must match (deterministic).
    const dateHeader = formatProfitshareDate(date);
    const signatureString =
      'GET' + 'affiliate-advertisers' + '/?' + '' + '/' + credentials.apiUser + dateHeader;
    const expected = createHmac('sha1', credentials.apiKey).update(signatureString).digest('hex');
    expect(headers['X-PS-Auth']).toBe(expected);

    // Calling again with the same input yields the same signature.
    const again = signRequest({
      method: 'GET',
      resource: 'affiliate-advertisers',
      queryString: '',
      credentials,
      date,
    });
    expect(again['X-PS-Auth']).toBe(headers['X-PS-Auth']);
  });

  it('changes the signature when the query string changes', () => {
    const date = new Date('2026-01-15T10:30:45.000Z');
    const credentials = { apiUser: 'u', apiKey: 'k' };
    const a = signRequest({ method: 'GET', resource: 'affiliate-commissions', queryString: 'page=1', credentials, date });
    const b = signRequest({ method: 'GET', resource: 'affiliate-commissions', queryString: 'page=2', credentials, date });
    expect(a['X-PS-Auth']).not.toBe(b['X-PS-Auth']);
  });
});

// ---------------------------------------------------------------------------
// Transformers
// ---------------------------------------------------------------------------

describe('Profitshare transformers (status normalisation, raw preservation)', () => {
  it('maps commission statuses to canonical statuses', () => {
    const rows = (loadFixture('commissions.json') as { result: Array<Record<string, unknown>> }).result;
    expect(_internals.toTransaction(rows[0] as never).status).toBe('approved'); // accepted
    expect(_internals.toTransaction(rows[1] as never).status).toBe('pending');
    expect(_internals.toTransaction(rows[2] as never).status).toBe('reversed'); // rejected
    expect(_internals.toTransaction(rows[3] as never).status).toBe('paid');
  });

  it('preserves the raw commission payload under rawNetworkData', () => {
    const row = (loadFixture('commissions.json') as { result: Array<Record<string, unknown>> }).result[0];
    const out = _internals.toTransaction(row as never);
    expect(out.rawNetworkData).toBe(row);
  });

  it('parses string amounts (comma or dot) into numbers', () => {
    expect(_internals.toNumber('9.64')).toBeCloseTo(9.64);
    expect(_internals.toNumber('9,64')).toBeCloseTo(9.64);
    expect(_internals.toNumber(12)).toBe(12);
    expect(_internals.toNumber(undefined)).toBe(0);
  });

  it('maps advertiser status to canonical ProgrammeStatus', () => {
    expect(_internals.mapAdvertiserStatus({ status: 'active' })).toBe('joined');
    expect(_internals.mapAdvertiserStatus({ status: '' })).toBe('joined');
    expect(_internals.mapAdvertiserStatus({ status: 'suspended' })).toBe('suspended');
    expect(_internals.mapAdvertiserStatus({ status: 'never-seen' })).toBe('unknown');
  });

  it('computes ageDays from the conversion date', () => {
    const now = new Date('2026-05-21T00:00:00Z');
    expect(_internals.computeAgeDays({ date: '2026-01-01T00:00:00Z' }, now)).toBe(140);
  });

  it('defaults currency to RON when a row omits it', () => {
    const out = _internals.toTransaction({ id: 1, status: 'pending', commission: '5' });
    expect(out.currency).toBe('RON');
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('Profitshare.listProgrammes', () => {
  it('unwraps result and maps advertisers to programmes', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    const programmes = await profitshareAdapter.listProgrammes();
    expect(programmes.length).toBe(2);
    expect(programmes[0]?.network).toBe('profitshare');
    expect(programmes[0]?.name).toBe('Atolls Bookshop RO');
  });

  it('applies a client-side search filter', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    const programmes = await profitshareAdapter.listProgrammes({ search: 'electronics' });
    expect(programmes.length).toBe(1);
    expect(programmes[0]?.id).toBe('102');
  });

  it('emits a config_error envelope when credentials are missing', async () => {
    delete process.env['PROFITSHARE_API_KEY'];
    await expect(profitshareAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getProgramme
// ---------------------------------------------------------------------------

describe('Profitshare.getProgramme', () => {
  it('returns a single advertiser derived from the list', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    const p = await profitshareAdapter.getProgramme('101');
    expect(p.id).toBe('101');
    expect(p.name).toBe('Atolls Bookshop RO');
  });

  it('throws when the advertiser id is unknown', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    await expect(profitshareAdapter.getProgramme('999')).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a config_error envelope when id is empty', async () => {
    await expect(profitshareAdapter.getProgramme('')).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('Profitshare.listTransactions', () => {
  it('returns commissions and filters by status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);
    const reversed = await profitshareAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-06-01T00:00:00Z',
      status: ['reversed'],
    });
    expect(reversed.every((t) => t.status === 'reversed')).toBe(true);
    expect(reversed.length).toBe(1);
  });

  it('filters by minAgeDays (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);
    const aged = await profitshareAdapter.listTransactions({
      from: '2025-11-01T00:00:00Z',
      to: '2026-06-01T00:00:00Z',
      minAgeDays: 36500, // ~100 years — nothing should match
    });
    expect(aged.length).toBe(0);
  });

  it('stops paging when total_pages is reached (single page)', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);
    await profitshareAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-06-01T00:00:00Z',
    });
    // total_pages is 1 in the fixture, so exactly one fetch.
    expect(spy.mock.calls.length).toBe(1);
  });

  it('emits an error envelope when credentials are missing', async () => {
    delete process.env['PROFITSHARE_API_USER'];
    await expect(profitshareAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('Profitshare.getEarningsSummary', () => {
  it('aggregates commission by status and programme (client-side)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('commissions.json'))]);
    const summary = await profitshareAdapter.getEarningsSummary({
      from: '2025-11-01T00:00:00Z',
      to: '2026-06-01T00:00:00Z',
    });
    expect(summary.network).toBe('profitshare');
    expect(summary.currency).toBe('RON');
    // Two advertisers in the fixture.
    expect(summary.byProgramme.length).toBe(2);
    expect(summary.byStatus.approved).toBeCloseTo(9.64);
    expect(summary.byStatus.paid).toBeCloseTo(8.75);
  });
});

// ---------------------------------------------------------------------------
// listClicks + generateTrackingLink (NotImplemented)
// ---------------------------------------------------------------------------

describe('Profitshare unsupported operations', () => {
  it('listClicks throws NotImplementedError', async () => {
    await expect(profitshareAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
  });

  it('generateTrackingLink throws NotImplementedError', async () => {
    await expect(
      profitshareAdapter.generateTrackingLink({ programmeId: '101', destinationUrl: 'https://x.example.ro' }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('Profitshare.verifyAuth', () => {
  it('returns ok:true and identity on a 200 signed call', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    const r = await profitshareAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toContain('profitshare/');
  });

  it('returns ok:false on a 401', async () => {
    mockFetchQueue([fakeResponse('{"error":{"message":"InvalidSignature"}}', { status: 401 })]);
    const r = await profitshareAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/401|InvalidSignature/);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('Profitshare.validateCredential', () => {
  it('rejects an empty API user', async () => {
    const r = await profitshareAdapter.validateCredential('PROFITSHARE_API_USER', '');
    expect(r.ok).toBe(false);
  });

  it('accepts a non-empty API user', async () => {
    const r = await profitshareAdapter.validateCredential('PROFITSHARE_API_USER', 'me@example.test');
    expect(r.ok).toBe(true);
  });

  it('validates the API key by making a signed call', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertisers.json'))]);
    const r = await profitshareAdapter.validateCredential('PROFITSHARE_API_KEY', 'fresh-key');
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with a hint when the key fails', async () => {
    mockFetchQueue([fakeResponse('{"error":{"message":"InvalidSignature"}}', { status: 401 })]);
    const r = await profitshareAdapter.validateCredential('PROFITSHARE_API_KEY', 'bad-key');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('Profitshare.capabilitiesCheck', () => {
  it('records listClicks + generateTrackingLink as unsupported', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('advertisers.json')), // listProgrammes
      fakeResponse(loadFixture('commissions.json')), // listTransactions probe
      fakeResponse(loadFixture('commissions.json')), // getEarningsSummary → listTransactions
      fakeResponse(loadFixture('advertisers.json')), // verifyAuth
    ]);
    const caps = await profitshareAdapter.capabilitiesCheck();
    expect(caps.network).toBe('profitshare');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim Profitshare body on a 500', async () => {
    const body = '{"error":{"message":"upstream broke"}}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await profitshareAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('profitshare');
      expect(env.operation).toBe('listProgrammes');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream broke');
    }
  });

  it('classifies 401 as auth_error', async () => {
    mockFetchQueue([fakeResponse('forbidden', { status: 401, rawBody: 'forbidden' })]);
    try {
      await profitshareAdapter.listProgrammes();
      throw new Error('expected to throw');
    } catch (err) {
      const env = (err as NetworkError).envelope;
      expect(env.type).toBe('auth_error');
    }
  });
});
