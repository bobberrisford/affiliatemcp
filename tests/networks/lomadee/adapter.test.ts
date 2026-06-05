/**
 * Lomadee adapter — unit tests.
 *
 * Pattern-matched to `tests/networks/skimlinks/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - Circuit breakers are reset in `beforeEach` so no test bleeds state.
 *   - Fake credentials are injected via `process.env` (obvious non-secret values).
 *   - Fixtures live under `tests/fixtures/lomadee/`.
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 *
 * Lomadee specifics:
 *   - The offers and deeplink APIs return JSON.
 *   - The sales-report API returns XML (wrapped in a JSON `{ xml }` fixture).
 *   - listTransactions issues TWO fetches: createToken (JSON) then the report (XML).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { lomadeeAdapter, _internals } from '../../../src/networks/lomadee/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';
import { _resetReportTokenCache } from '../../../src/networks/lomadee/auth.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'lomadee');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

/** Load the XML string out of a `{ xml }` JSON fixture. */
function loadReportXml(name: string): string {
  return (loadFixture(name) as { xml: string }).xml;
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

/** Report ops issue createToken (JSON) then reportTransaction (XML). */
function mockReport(xml: string): ReturnType<typeof vi.fn> {
  return mockFetchQueue([
    fakeResponse(loadFixture('createtoken.json')),
    fakeResponse(xml, { rawBody: xml }),
  ]);
}

beforeEach(() => {
  _resetBreakers();
  _resetReportTokenCache();
  process.env['LOMADEE_APP_TOKEN'] = 'test-app-token-please-ignore';
  process.env['LOMADEE_SOURCE_ID'] = '12345678';
  process.env['LOMADEE_PUBLISHER_ID'] = '654321';
  process.env['LOMADEE_REPORT_USER'] = 'tester@example.test';
  process.env['LOMADEE_REPORT_PASSWORD'] = 'test-password-please-ignore';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['LOMADEE_APP_TOKEN'];
  delete process.env['LOMADEE_SOURCE_ID'];
  delete process.env['LOMADEE_PUBLISHER_ID'];
  delete process.env['LOMADEE_REPORT_USER'];
  delete process.env['LOMADEE_REPORT_PASSWORD'];
  _resetReportTokenCache();
});

// ---------------------------------------------------------------------------
// Transformer unit tests (status normalisation + raw preservation + XML parse)
// ---------------------------------------------------------------------------

describe('Lomadee transformers (status normalisation, raw preservation)', () => {
  it('maps Lomadee (pt-BR) sales statuses to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus({ status: 'Pendente' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'Aguardando' })).toBe('pending');
    expect(_internals.mapTransactionStatus({ status: 'Aprovada' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'Confirmada' })).toBe('approved');
    expect(_internals.mapTransactionStatus({ status: 'Paga' })).toBe('paid');
    expect(_internals.mapTransactionStatus({ status: 'Cancelada' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'Recusada' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'Estornada' })).toBe('reversed');
    expect(_internals.mapTransactionStatus({ status: 'algo-novo' })).toBe('other');
    expect(_internals.mapTransactionStatus({})).toBe('other');
  });

  it('maps Lomadee programme statuses, defaulting to available (store is promotable)', () => {
    expect(_internals.mapProgrammeStatus({ status: 'ativo' })).toBe('joined');
    expect(_internals.mapProgrammeStatus({ status: 'pendente' })).toBe('pending');
    expect(_internals.mapProgrammeStatus({ status: 'recusado' })).toBe('declined');
    expect(_internals.mapProgrammeStatus({ status: 'disponivel' })).toBe('available');
    expect(_internals.mapProgrammeStatus({ status: 'suspenso' })).toBe('suspended');
    expect(_internals.mapProgrammeStatus({ status: 'algo-novo' })).toBe('unknown');
    // Absent status → available, because Offers API stores are promotable.
    expect(_internals.mapProgrammeStatus({})).toBe('available');
  });

  it('normalises pt-BR comma-decimal and plain amounts', () => {
    expect(_internals.toAmount('64,99')).toBeCloseTo(64.99, 2);
    expect(_internals.toAmount('1.299,90')).toBeCloseTo(1299.9, 2);
    expect(_internals.toAmount(12.75)).toBe(12.75);
    expect(_internals.toAmount(undefined)).toBe(0);
    expect(_internals.toAmount('not-a-number')).toBe(0);
  });

  it('parses reportTransaction XML into per-record field maps and preserves raw', () => {
    const records = _internals.parseReportXml(loadReportXml('report.json'));
    expect(records.length).toBe(4);
    expect(records[0]?.id).toBe('500001');
    expect(records[0]?.status).toBe('Pendente');
    expect(records[2]?.reason).toBe('Pedido cancelado pelo cliente');

    const out = _internals.toTransaction(records[2] as never);
    // rawNetworkData is the exact parsed record.
    expect(out.rawNetworkData).toBe(records[2]);
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Pedido cancelado pelo cliente');
  });

  it('returns an empty list for an empty report XML body', () => {
    expect(_internals.parseReportXml(loadReportXml('report_empty.json'))).toHaveLength(0);
    expect(_internals.parseReportXml('')).toHaveLength(0);
  });

  it('computes ageDays from validationDate (preferred), then transactionDate (§15.9)', () => {
    const now = new Date('2026-06-04T00:00:00Z');
    // validationDate 2026-04-10 → 55 days
    const age1 = _internals.computeAgeDays(
      { validationDate: '2026-04-10T00:00:00Z', transactionDate: '2026-04-01T00:00:00Z' },
      now,
    );
    expect(age1).toBe(55);
    // No validationDate → transactionDate 2026-05-20 → 15 days
    const age2 = _internals.computeAgeDays({ transactionDate: '2026-05-20T00:00:00Z' }, now);
    expect(age2).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes / getProgramme — derived from the Offers API
// ---------------------------------------------------------------------------

describe('LomadeeAdapter.listProgrammes', () => {
  it('de-duplicates stores from offers into programmes with available status', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const programmes = await lomadeeAdapter.listProgrammes({});
    // Two distinct stores (2001, 2002); the offer with no store is skipped.
    expect(programmes.length).toBe(2);
    const ids = programmes.map((p) => p.id).sort();
    expect(ids).toEqual(['2001', '2002']);
    for (const p of programmes) {
      expect(p.network).toBe('lomadee');
      expect(p.status).toBe('available');
    }
    const electronics = programmes.find((p) => p.id === '2001');
    expect(electronics?.name).toBe('Loja Exemplo Eletronicos');
    expect(electronics?.categories).toContain('Eletronicos');
  });

  it('preserves the raw store payload in rawNetworkData', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const programmes = await lomadeeAdapter.listProgrammes({});
    const raw = programmes[0]?.rawNetworkData as { store?: { id?: string } };
    expect(raw.store?.id).toBeDefined();
  });

  it('respects limit', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const programmes = await lomadeeAdapter.listProgrammes({ limit: 1 });
    expect(programmes.length).toBe(1);
  });

  it('returns an empty list when offers are empty', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers_empty.json'))]);
    const programmes = await lomadeeAdapter.listProgrammes({});
    expect(programmes).toHaveLength(0);
  });

  it('emits a NetworkError when LOMADEE_APP_TOKEN is missing', async () => {
    delete process.env['LOMADEE_APP_TOKEN'];
    await expect(lomadeeAdapter.listProgrammes({})).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('LomadeeAdapter.getProgramme', () => {
  it('returns the matching store programme', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const programme = await lomadeeAdapter.getProgramme('2002');
    expect(programme.id).toBe('2002');
    expect(programme.name).toBe('Livraria Exemplo');
  });

  it('throws a config_error NetworkError when programmeId is empty', async () => {
    await expect(lomadeeAdapter.getProgramme('')).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a NetworkError when the store id is not found in the offers surface', async () => {
    mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    await expect(lomadeeAdapter.getProgramme('999999')).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listTransactions — report XML, filters, unpaid-age, reversed visibility
// ---------------------------------------------------------------------------

describe('LomadeeAdapter.listTransactions', () => {
  it('parses the report and returns all transactions in the window', async () => {
    mockReport(loadReportXml('report.json'));
    const txns = await lomadeeAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    expect(txns.length).toBe(4);
    expect(txns.every((t) => t.network === 'lomadee')).toBe(true);
    expect(txns.every((t) => t.currency === 'BRL')).toBe(true);
  });

  it('includes reversed transactions with reason (§15.10)', async () => {
    mockReport(loadReportXml('report.json'));
    const txns = await lomadeeAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    const reversed = txns.filter((t) => t.status === 'reversed');
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.reversalReason).toBe('Pedido cancelado pelo cliente');
  });

  it('filters by status when caller passes status[]', async () => {
    mockReport(loadReportXml('report.json'));
    const only = await lomadeeAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
      status: ['paid'],
    });
    expect(only.length).toBe(1);
    expect(only.every((t) => t.status === 'paid')).toBe(true);
  });

  it('filters by programmeId', async () => {
    mockReport(loadReportXml('report.json'));
    const store2001 = await lomadeeAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
      programmeId: '2001',
    });
    expect(store2001.length).toBe(2);
    expect(store2001.every((t) => t.programmeId === '2001')).toBe(true);
  });

  it('respects limit after all other filters', async () => {
    mockReport(loadReportXml('report.json'));
    const limited = await lomadeeAdapter.listTransactions({
      from: '2026-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
      limit: 2,
    });
    expect(limited.length).toBe(2);
  });

  it('emits a NetworkError when LOMADEE_PUBLISHER_ID is missing', async () => {
    delete process.env['LOMADEE_PUBLISHER_ID'];
    await expect(lomadeeAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });

  it('emits a NetworkError when report credentials are missing', async () => {
    delete process.env['LOMADEE_REPORT_USER'];
    await expect(lomadeeAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary — derived from listTransactions
// ---------------------------------------------------------------------------

describe('LomadeeAdapter.getEarningsSummary', () => {
  it('aggregates commissions correctly from the report fixture', async () => {
    mockReport(loadReportXml('report.json'));
    const summary = await lomadeeAdapter.getEarningsSummary({
      from: '2026-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    expect(summary.network).toBe('lomadee');
    expect(summary.currency).toBe('BRL');
    expect(summary.totalEarnings).toBeCloseTo(64.99 + 9.99 + 2.5 + 8.0, 2);
    expect(summary.byStatus.pending).toBeCloseTo(64.99, 2);
    expect(summary.byStatus.approved).toBeCloseTo(9.99, 2);
    expect(summary.byStatus.reversed).toBeCloseTo(2.5, 2);
    expect(summary.byStatus.paid).toBeCloseTo(8.0, 2);
    expect(summary.byProgramme.length).toBe(2);
  });

  it('sets oldestUnpaidAgeDays from a pending/approved transaction (§15.9)', async () => {
    mockReport(loadReportXml('report.json'));
    const summary = await lomadeeAdapter.getEarningsSummary({
      from: '2026-01-01T00:00:00Z',
      to: '2026-06-04T00:00:00Z',
    });
    expect(summary.oldestUnpaidAgeDays).toBeDefined();
    expect(summary.oldestUnpaidAgeDays ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('returns an empty summary when the report has no sales', async () => {
    mockReport(loadReportXml('report_empty.json'));
    const summary = await lomadeeAdapter.getEarningsSummary({});
    expect(summary.totalEarnings).toBe(0);
    expect(summary.byProgramme).toHaveLength(0);
    expect(summary.oldestUnpaidAgeDays).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// generateTrackingLink — real API call to the deeplink endpoint
// ---------------------------------------------------------------------------

describe('LomadeeAdapter.generateTrackingLink', () => {
  it('mints a deeplink via createLinks and returns the redirect link', async () => {
    mockFetchQueue([fakeResponse(loadFixture('createlink.json'))]);
    const link = await lomadeeAdapter.generateTrackingLink({
      programmeId: '2001',
      destinationUrl: 'https://www.exemplo-loja.test/smartphone-xyz',
    });
    expect(link.network).toBe('lomadee');
    expect(link.trackingUrl).toBe('https://redir.lomadee.com/v2/d/abc123');
    expect(link.destinationUrl).toBe('https://www.exemplo-loja.test/smartphone-xyz');
    expect(link.programmeId).toBe('2001');
    expect(link.rawNetworkData).toBeTruthy();
  });

  it('sends the destination URL to the createLinks endpoint', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('createlink.json'))]);
    await lomadeeAdapter.generateTrackingLink({
      programmeId: '2001',
      destinationUrl: 'https://www.exemplo-loja.test/page?q=1',
    });
    const calledUrl = String((spy.mock.calls[0] as unknown[])[0]);
    expect(calledUrl).toContain('/service/createLinks/lomadee/');
    expect(calledUrl).toContain('sourceId=12345678');
    expect(calledUrl).toContain('link1=');
  });

  it('throws config_error when destinationUrl is empty', async () => {
    await expect(
      lomadeeAdapter.generateTrackingLink({ programmeId: '2001', destinationUrl: '' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a NetworkError when createLinks returns no link', async () => {
    mockFetchQueue([fakeResponse({ requestInfo: { status: 'ERROR' }, links: [] })]);
    await expect(
      lomadeeAdapter.generateTrackingLink({
        programmeId: '2001',
        destinationUrl: 'https://www.exemplo-loja.test/x',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws a NetworkError when LOMADEE_APP_TOKEN is missing', async () => {
    delete process.env['LOMADEE_APP_TOKEN'];
    await expect(
      lomadeeAdapter.generateTrackingLink({
        programmeId: '2001',
        destinationUrl: 'https://www.exemplo-loja.test/x',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listClicks — not exposed
// ---------------------------------------------------------------------------

describe('LomadeeAdapter.listClicks', () => {
  it('throws NotImplementedError with a Lomadee-specific reason', async () => {
    await expect(lomadeeAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await lomadeeAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click-level data');
    }
  });
});

// ---------------------------------------------------------------------------
// Admin ops — scaffolded, must throw NotImplementedError
// ---------------------------------------------------------------------------

describe('LomadeeAdapter admin ops', () => {
  it('listPublishers throws NotImplementedError', async () => {
    await expect(lomadeeAdapter.listPublishers()).rejects.toBeInstanceOf(NotImplementedError);
  });
  it('listPublisherSectors throws NotImplementedError', async () => {
    await expect(lomadeeAdapter.listPublisherSectors()).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth — happy + failure paths
// ---------------------------------------------------------------------------

describe('LomadeeAdapter.verifyAuth', () => {
  it('returns ok:true and identity when createLinks succeeds', async () => {
    mockFetchQueue([fakeResponse(loadFixture('createlink.json'))]);
    const r = await lomadeeAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('lomadee/source:12345678');
    }
  });

  it('returns ok:false (does not throw) when createLinks returns no link', async () => {
    mockFetchQueue([fakeResponse({ requestInfo: { status: 'ERROR' }, links: [] })]);
    const r = await lomadeeAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBeTruthy();
    }
  });

  it('returns ok:false (does not throw) on HTTP 401', async () => {
    mockFetchQueue([fakeResponse('Unauthorized', { status: 401, rawBody: 'Unauthorized' })]);
    await expect(lomadeeAdapter.verifyAuth()).resolves.toMatchObject({ ok: false });
  });

  it('returns ok:false when LOMADEE_APP_TOKEN is missing', async () => {
    delete process.env['LOMADEE_APP_TOKEN'];
    const r = await lomadeeAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('LomadeeAdapter.validateCredential', () => {
  it('accepts a non-empty LOMADEE_APP_TOKEN without an API call', async () => {
    const r = await lomadeeAdapter.validateCredential('LOMADEE_APP_TOKEN', 'any-token');
    expect(r.ok).toBe(true);
  });

  it('rejects an empty LOMADEE_APP_TOKEN', async () => {
    const r = await lomadeeAdapter.validateCredential('LOMADEE_APP_TOKEN', '');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('validates LOMADEE_SOURCE_ID via a live deeplink probe', async () => {
    mockFetchQueue([fakeResponse(loadFixture('createlink.json'))]);
    const r = await lomadeeAdapter.validateCredential('LOMADEE_SOURCE_ID', '12345678');
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with hint when the source/app-token pair is rejected', async () => {
    mockFetchQueue([fakeResponse('Unauthorized', { status: 401, rawBody: 'Unauthorized' })]);
    const r = await lomadeeAdapter.validateCredential('LOMADEE_SOURCE_ID', 'bad-source');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('accepts a positive integer LOMADEE_PUBLISHER_ID', async () => {
    const r = await lomadeeAdapter.validateCredential('LOMADEE_PUBLISHER_ID', '654321');
    expect(r.ok).toBe(true);
  });

  it('rejects a non-numeric LOMADEE_PUBLISHER_ID', async () => {
    const r1 = await lomadeeAdapter.validateCredential('LOMADEE_PUBLISHER_ID', 'abc');
    expect(r1.ok).toBe(false);
    const r2 = await lomadeeAdapter.validateCredential('LOMADEE_PUBLISHER_ID', '0');
    expect(r2.ok).toBe(false);
  });

  it('validates LOMADEE_REPORT_PASSWORD via a live createToken probe', async () => {
    mockFetchQueue([fakeResponse(loadFixture('createtoken.json'))]);
    const r = await lomadeeAdapter.validateCredential('LOMADEE_REPORT_PASSWORD', 'test-password');
    expect(r.ok).toBe(true);
  });

  it('returns ok:false for unknown credential fields', async () => {
    const r = await lomadeeAdapter.validateCredential('LOMADEE_UNKNOWN_FIELD', 'value');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces verbatim response body on a 500 from the report endpoint', async () => {
    const body = '{"error":"upstream exploded","trace":"xyz"}';
    mockFetchQueue([
      fakeResponse(loadFixture('createtoken.json')), // createToken succeeds
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
      fakeResponse(body, { status: 500, rawBody: body }),
    ]);
    try {
      await lomadeeAdapter.listTransactions({});
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('lomadee');
      expect(env.operation).toBe('listTransactions');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream exploded');
    }
  });

  it('classifies 401 on the offers endpoint as auth_error', async () => {
    mockFetchQueue([fakeResponse('Forbidden', { status: 401, rawBody: 'Forbidden' })]);
    try {
      await lomadeeAdapter.listProgrammes({});
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

describe('LomadeeAdapter.capabilitiesCheck', () => {
  it('records listClicks as not supported and probes the rest', async () => {
    // Order of probes: verifyAuth (createLinks), listProgrammes (offers),
    // listTransactions (createToken + report), getEarningsSummary (createToken + report).
    mockFetchQueue([
      fakeResponse(loadFixture('createlink.json')), // verifyAuth
      fakeResponse(loadFixture('offers.json')), // listProgrammes
      fakeResponse(loadFixture('createtoken.json')), // listTransactions token
      fakeResponse(loadReportXml('report_empty.json'), { rawBody: loadReportXml('report_empty.json') }), // listTransactions data
      fakeResponse(loadFixture('createtoken.json')), // getEarningsSummary token
      fakeResponse(loadReportXml('report_empty.json'), { rawBody: loadReportXml('report_empty.json') }), // getEarningsSummary data
    ]);
    const caps = await lomadeeAdapter.capabilitiesCheck();
    expect(caps.network).toBe('lomadee');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['verifyAuth']?.supported).toBe(true);
    expect(caps.operations['listProgrammes']?.supported).toBe(true);
    expect(caps.operations['listTransactions']?.supported).toBe(true);
    expect(caps.operations['getEarningsSummary']?.supported).toBe(true);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
