/**
 * Digistore24 adapter — unit tests.
 *
 * Mirrors the Awin test patterns:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - Each test stubs only the responses it needs.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 *
 * No live calls are made.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { digistore24Adapter, _internals } from '../../../src/networks/digistore24/adapter.js';
import { NetworkJsonSchema } from '../../../scripts/validate-network-json.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'networks', 'digistore24', 'fixtures');

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
  process.env['DIGISTORE24_API_KEY'] = 'test-key-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['DIGISTORE24_API_KEY'];
  delete process.env['DIGISTORE24_AFFILIATE_ID'];
});

// ---------------------------------------------------------------------------
// network.json
// ---------------------------------------------------------------------------

describe('Digistore24 network.json', () => {
  const raw = JSON.parse(
    readFileSync(
      path.join(process.cwd(), 'src', 'networks', 'digistore24', 'network.json'),
      'utf8',
    ),
  ) as Record<string, unknown>;

  it('conforms to the canonical schema', () => {
    const r = NetworkJsonSchema.safeParse(raw);
    expect(r.success).toBe(true);
    if (!r.success) throw new Error(JSON.stringify(r.error.issues, null, 2));
  });

  it('declares custom auth, publisher side, single-brand scope, experimental status', () => {
    expect(raw.auth_model).toBe('custom');
    expect(raw.side).toBe('publisher');
    expect(raw.credential_scope).toBe('single-brand');
    expect(raw.claim_status).toBe('experimental');
    expect(raw.env_vars).toEqual(['DIGISTORE24_API_KEY']);
  });

  it('carries the mandated experimental, amount-unit and programmes-mapping limitations', () => {
    const limits = raw.known_limitations as string[];
    expect(limits).toContain(
      'Adapter built from public API documentation; not yet verified against a live Digistore24 account.',
    );
    expect(limits.some((l) => /major currency units/i.test(l))).toBe(true);
    expect(limits.some((l) => /no per-merchant programme/i.test(l))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Transformers (status mapping, amount parsing, raw preservation)
// ---------------------------------------------------------------------------

describe('Digistore24 transformers', () => {
  it('maps transaction_type pay→approved, refund/chargeback→reversed, other→other', () => {
    expect(_internals.mapTransactionStatus({ transaction_type: 'pay' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ transaction_type: 'payment' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ transaction_type: 'refund' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ transaction_type: 'refund_request' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ transaction_type: 'chargeback' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ transaction_type: 'mystery' })).toBe('other');
  });

  it('parses amounts as major units (no cents division)', () => {
    expect(_internals.parseAmount('49.00')).toBe(49);
    expect(_internals.parseAmount(29)).toBe(29);
    expect(_internals.parseAmount('1.234,56'.replace('.', '').replace(',', '.'))).toBeCloseTo(1234.56);
    expect(_internals.parseAmount(undefined)).toBe(0);
  });

  it('preserves the raw Digistore24 row under rawNetworkData', () => {
    const rows = _internals.extractRows(
      (loadFixture('transactions.json') as { data: unknown }).data as never,
    );
    const row0 = rows[0]!;
    const out = _internals.toTransaction(row0);
    expect(out.rawNetworkData).toBe(row0);
    expect(out.programmeId).toBe(_internals.PLATFORM_PROGRAMME_ID);
    expect(out.commission).toBe(24.5);
    expect(out.amount).toBe(49);
    expect(out.currency).toBe('EUR');
  });

  it('computes ageDays from created_at', () => {
    const now = new Date('2026-05-21T00:00:00Z');
    const age = _internals.computeAgeDays({ created_at: '2026-01-01 00:00:00' }, now);
    expect(age).toBe(140);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes / getProgramme (synthetic platform programme)
// ---------------------------------------------------------------------------

describe('Digistore24.listProgrammes / getProgramme', () => {
  it('returns a single synthetic platform programme without an HTTP call', async () => {
    const spy = mockFetchQueue([]);
    const progs = await digistore24Adapter.listProgrammes();
    expect(progs.length).toBe(1);
    expect(progs[0]?.id).toBe(_internals.PLATFORM_PROGRAMME_ID);
    expect(progs[0]?.status).toBe('joined');
    expect(spy.mock.calls.length).toBe(0);
  });

  it('getProgramme rejects an unknown id with a config_error envelope', async () => {
    await expect(digistore24Adapter.getProgramme('not-the-platform')).rejects.toBeInstanceOf(
      NetworkError,
    );
    try {
      await digistore24Adapter.getProgramme('not-the-platform');
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('config_error');
    }
  });

  it('getProgramme returns the platform programme for the platform id', async () => {
    const p = await digistore24Adapter.getProgramme(_internals.PLATFORM_PROGRAMME_ID);
    expect(p.id).toBe(_internals.PLATFORM_PROGRAMME_ID);
  });

  it('emits a config_error envelope when the API key is missing', async () => {
    delete process.env['DIGISTORE24_API_KEY'];
    await expect(digistore24Adapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('Digistore24.listTransactions', () => {
  it('lists and normalises transactions (one short page → one call)', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const txns = await digistore24Adapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
    });
    expect(txns.length).toBe(4);
    expect(spy.mock.calls.length).toBe(1);
    expect(txns.filter((t) => t.status === 'reversed').length).toBe(2);
    expect(txns.filter((t) => t.status === 'approved').length).toBe(2);
  });

  it('sends the X-DS-API-KEY header and search[role]=affiliate', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    await digistore24Adapter.listTransactions({
      from: '2026-05-01T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
    });
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/call/listTransactions');
    expect(url).toContain('search%5Brole%5D=affiliate');
    const headers = init.headers as Record<string, string>;
    expect(headers['X-DS-API-KEY']).toBe('test-key-please-ignore');
  });

  it('filters by status (§15.10 reversed visibility)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const only = await digistore24Adapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
      status: ['reversed'],
    });
    expect(only.length).toBe(2);
    expect(only.every((t) => t.status === 'reversed')).toBe(true);
  });

  it('applies minAgeDays after status filtering (§15.9)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const aged = await digistore24Adapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
      minAgeDays: 365,
    });
    expect(aged.length).toBeGreaterThan(0);
    for (const t of aged) expect(t.ageDays).toBeGreaterThanOrEqual(365);
  });

  it('surfaces a result:error 200 body as a NetworkError (§15.4)', async () => {
    mockFetchQueue([fakeResponse(loadFixture('error.json'))]);
    try {
      await digistore24Adapter.listTransactions({
        from: '2026-05-01T00:00:00Z',
        to: '2026-05-21T00:00:00Z',
      });
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('digistore24');
      expect(env.operation).toBe('listTransactions');
      expect(env.type).toBe('auth_error');
      expect(env.networkErrorBody).toContain('invalid or has been revoked');
    }
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary
// ---------------------------------------------------------------------------

describe('Digistore24.getEarningsSummary', () => {
  it('aggregates commission by status and surfaces oldest unpaid age', async () => {
    mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const summary = await digistore24Adapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-05-21T00:00:00Z',
    });
    expect(summary.network).toBe('digistore24');
    // approved: 24.50 + 14.50 = 39; reversed: -24.50 + -60.00 = -84.50
    expect(summary.byStatus.approved).toBeCloseTo(39);
    expect(summary.byStatus.reversed).toBeCloseTo(-84.5);
    expect(summary.totalEarnings).toBeCloseTo(-45.5);
    expect(summary.byProgramme.length).toBe(1);
    expect(summary.oldestUnpaidAgeDays).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// listClicks
// ---------------------------------------------------------------------------

describe('Digistore24.listClicks', () => {
  it('throws NotImplementedError with the documented reason', async () => {
    await expect(digistore24Adapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await digistore24Adapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click-level data');
    }
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink (deterministic promolink)
// ---------------------------------------------------------------------------

describe('Digistore24.generateTrackingLink', () => {
  it('constructs a promolink with the product id and affiliate segment', async () => {
    process.env['DIGISTORE24_AFFILIATE_ID'] = '987654';
    const spy = mockFetchQueue([]);
    const link = await digistore24Adapter.generateTrackingLink({
      programmeId: '555111',
      destinationUrl: 'https://vendor.example.com/sales',
    });
    expect(link.trackingUrl).toBe('https://www.checkout-ds24.com/redir/555111/987654');
    expect(link.network).toBe('digistore24');
    expect(link.programmeId).toBe('555111');
    expect(spy.mock.calls.length).toBe(0);
  });

  it('omits the affiliate segment when DIGISTORE24_AFFILIATE_ID is unset', async () => {
    mockFetchQueue([]);
    const link = await digistore24Adapter.generateTrackingLink({
      programmeId: '555111',
      destinationUrl: 'https://vendor.example.com/sales',
    });
    expect(link.trackingUrl).toBe('https://www.checkout-ds24.com/redir/555111');
  });

  it('rejects an empty product id with a config_error envelope', async () => {
    await expect(
      digistore24Adapter.generateTrackingLink({ programmeId: '', destinationUrl: 'https://x.example.com' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('rejects the synthetic platform programme id', async () => {
    await expect(
      digistore24Adapter.generateTrackingLink({
        programmeId: _internals.PLATFORM_PROGRAMME_ID,
        destinationUrl: 'https://x.example.com',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('Digistore24.verifyAuth', () => {
  it('returns ok:true with identity on a successful getUserInfo', async () => {
    mockFetchQueue([fakeResponse(loadFixture('getuserinfo.json'))]);
    const r = await digistore24Adapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toContain('digistore24/987654');
  });

  it('returns ok:false on a result:error envelope', async () => {
    mockFetchQueue([fakeResponse(loadFixture('error.json'))]);
    const r = await digistore24Adapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('invalid or has been revoked');
  });

  it('returns ok:false on a 401 transport error', async () => {
    mockFetchQueue([fakeResponse('unauthorised', { status: 401, rawBody: 'unauthorised' })]);
    const r = await digistore24Adapter.verifyAuth();
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('Digistore24.validateCredential', () => {
  it('validates DIGISTORE24_API_KEY via getUserInfo', async () => {
    mockFetchQueue([fakeResponse(loadFixture('getuserinfo.json'))]);
    const r = await digistore24Adapter.validateCredential('DIGISTORE24_API_KEY', 'fresh-key');
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with a hint on a bad key', async () => {
    mockFetchQueue([fakeResponse(loadFixture('error.json'))]);
    const r = await digistore24Adapter.validateCredential('DIGISTORE24_API_KEY', 'bad-key');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('rejects an unknown field', async () => {
    const r = await digistore24Adapter.validateCredential('NOPE', 'x');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('Digistore24.capabilitiesCheck', () => {
  it('records listClicks unsupported and programmes as experimental', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('transactions.json')), // listTransactions probe
      fakeResponse(loadFixture('transactions.json')), // getEarningsSummary → listTransactions
      fakeResponse(loadFixture('getuserinfo.json')), // verifyAuth
    ]);
    const caps = await digistore24Adapter.capabilitiesCheck();
    expect(caps.network).toBe('digistore24');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['listProgrammes']?.claimStatus).toBe('experimental');
    expect(caps.operations['generateTrackingLink']?.supported).toBe(true);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim body on a 500', async () => {
    const body = '{"error":"upstream broke","trace":"abc"}';
    mockFetchQueue([
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await digistore24Adapter.listTransactions({
        from: '2026-05-01T00:00:00Z',
        to: '2026-05-21T00:00:00Z',
      });
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('digistore24');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream broke');
    }
  });
});
