/**
 * Afilio adapter — unit tests.
 *
 * Pattern-matched to `tests/networks/skimlinks/adapter.test.ts`:
 *   - We mock `globalThis.fetch` directly to exercise the full client +
 *     resilience + transformer stack with no live HTTP.
 *   - Circuit breakers are reset in `beforeEach` so no test bleeds state.
 *   - Fake credentials are injected via `process.env` (obvious non-secret values).
 *   - Fixtures live under `tests/fixtures/afilio/` as XML strings wrapped in JSON
 *     (the project keeps fixtures as *.json; the Afilio API returns XML).
 *   - PRD-relevant tests are tagged with `§15.x` in their `it` strings.
 *
 * Afilio's listTransactions issues TWO requests (type=sale then type=lead) via
 * Promise.all, so a transactions mock must queue the sale response first, then
 * the lead response.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afilioAdapter, _internals } from '../../../src/networks/afilio/adapter.js';
import { parseAfilioXmlRows, decodeXmlEntities } from '../../../src/networks/afilio/client.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'afilio');

/** Load a fixture and return the XML string inside it. */
function loadXml(name: string): string {
  const parsed = JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8')) as { xml: string };
  return parsed.xml;
}

/** Find a parsed row by a field value, failing the test if it is absent. */
function rowWhere(
  rows: Array<Record<string, string>>,
  field: string,
  value: string,
): Record<string, string> {
  const found = rows.find((r) => r[field] === value);
  if (!found) throw new Error(`fixture row with ${field}=${value} not found`);
  return found;
}

function xmlResponse(xml: string, init: { status?: number } = {}): Response {
  return new Response(xml, {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/xml' },
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

/** Queue the sale response then the lead response for one listTransactions call. */
function mockTransactions(salesFixture: string, leadsFixture: string): ReturnType<typeof vi.fn> {
  return mockFetchQueue([xmlResponse(loadXml(salesFixture)), xmlResponse(loadXml(leadsFixture))]);
}

beforeEach(() => {
  _resetBreakers();
  process.env['AFILIO_AFFILIATE_TOKEN'] = 'test-token-please-ignore';
  process.env['AFILIO_AFF_ID'] = '123456';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['AFILIO_AFFILIATE_TOKEN'];
  delete process.env['AFILIO_AFF_ID'];
});

// ---------------------------------------------------------------------------
// XML parser
// ---------------------------------------------------------------------------

describe('Afilio XML parsing', () => {
  it('extracts rows by the first matching row tag', () => {
    const rows = parseAfilioXmlRows(loadXml('sales.json'), ['sale', 'lead', 'record']);
    expect(rows.length).toBe(4);
    expect(rows[0]?.transactionid).toBe('S-1001');
    expect(rows[0]?.status).toBe('pendente');
  });

  it('decodes XML entities in leaf values', () => {
    expect(decodeXmlEntities('Loja Exemplo &amp; testes')).toBe('Loja Exemplo & testes');
    const rows = parseAfilioXmlRows(loadXml('campaigns.json'), ['campaign']);
    const loja = rows.find((r) => r.id === '5001');
    expect(loja?.descricao).toBe('Loja de exemplo & testes');
  });

  it('returns an empty array for a document with no rows', () => {
    expect(parseAfilioXmlRows(loadXml('sales_empty.json'), ['sale'])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Transformers (status normalisation, raw preservation, amounts)
// ---------------------------------------------------------------------------

describe('Afilio transformers', () => {
  it('maps Afilio sale/lead statuses to canonical TransactionStatus', () => {
    expect(_internals.mapTransactionStatus('pendente')).toBe('pending');
    expect(_internals.mapTransactionStatus('pending')).toBe('pending');
    expect(_internals.mapTransactionStatus('aprovado')).toBe('approved');
    expect(_internals.mapTransactionStatus('validado')).toBe('approved');
    expect(_internals.mapTransactionStatus('pago')).toBe('paid');
    // cancelado / estornado → reversed (the sale did not pay out).
    expect(_internals.mapTransactionStatus('cancelado')).toBe('reversed');
    expect(_internals.mapTransactionStatus('estornado')).toBe('reversed');
    expect(_internals.mapTransactionStatus('algo-novo')).toBe('other');
    expect(_internals.mapTransactionStatus(undefined)).toBe('other');
  });

  it('maps Afilio campaign statuses to canonical ProgrammeStatus', () => {
    expect(_internals.mapProgrammeStatus('ativo')).toBe('joined');
    expect(_internals.mapProgrammeStatus('active')).toBe('joined');
    expect(_internals.mapProgrammeStatus('pendente')).toBe('pending');
    expect(_internals.mapProgrammeStatus('recusado')).toBe('declined');
    expect(_internals.mapProgrammeStatus('disponivel')).toBe('available');
    expect(_internals.mapProgrammeStatus('pausado')).toBe('suspended');
    expect(_internals.mapProgrammeStatus('algo-novo')).toBe('unknown');
    expect(_internals.mapProgrammeStatus(undefined)).toBe('unknown');
  });

  it('parses Brazilian comma-decimal and dotted-thousand amounts', () => {
    expect(_internals.toAmount('15,50')).toBe(15.5);
    expect(_internals.toAmount('1.234,56')).toBe(1234.56);
    expect(_internals.toAmount('80.00')).toBe(80);
    expect(_internals.toAmount('8')).toBe(8);
    expect(_internals.toAmount(undefined)).toBe(0);
    expect(_internals.toAmount('not-a-number')).toBe(0);
  });

  it('preserves the raw row in rawNetworkData and tags the kind', () => {
    const rows = parseAfilioXmlRows(loadXml('sales.json'), ['sale']);
    const out = _internals.toTransaction(rowWhere(rows, 'transactionid', 'S-1001'), 'sale');
    expect(out.rawNetworkData).toMatchObject({ kind: 'sale', transactionid: 'S-1001' });
    expect(out.id).toBe('S-1001');
    expect(out.programmeId).toBe('5001');
    expect(out.commission).toBe(15.5);
    expect(out.amount).toBe(155);
    expect(out.currency).toBe('BRL');
  });

  it('surfaces reversalReason for cancelled sales (§15.10)', () => {
    const rows = parseAfilioXmlRows(loadXml('sales.json'), ['sale']);
    const cancelled = rowWhere(rows, 'transactionid', 'S-1003');
    const out = _internals.toTransaction(cancelled, 'sale');
    expect(out.status).toBe('reversed');
    expect(out.reversalReason).toBe('Pedido cancelado pelo cliente');
  });

  it('computes ageDays from the conversion date with an injectable now', () => {
    const now = new Date('2026-05-11T00:00:00Z');
    const age = _internals.computeAgeDays({ data: '2026-05-01 10:15:00' }, now);
    expect(age).toBe(9);
  });

  it('builds a Programme with the headline commission picked from Saleprice', () => {
    const rows = parseAfilioXmlRows(loadXml('campaigns.json'), ['campaign']);
    const loja = rowWhere(rows, 'id', '5001');
    const prog = _internals.toProgramme(loja);
    expect(prog.id).toBe('5001');
    expect(prog.name).toBe('Loja Exemplo');
    expect(prog.status).toBe('joined');
    expect(prog.advertiserUrl).toBe('https://www.loja-exemplo.test');
    expect(prog.commissionRate).toMatchObject({ type: 'flat', value: 10 });
    expect(prog.rawNetworkData).toBe(loja);
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('AfilioAdapter.listTransactions', () => {
  it('merges sales and leads into one stream', async () => {
    mockTransactions('sales.json', 'leads.json');
    const txns = await afilioAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-01T00:00:00Z',
    });
    expect(txns.length).toBe(6); // 4 sales + 2 leads
    expect(txns.some((t) => t.id === 'S-1001')).toBe(true);
    expect(txns.some((t) => t.id === 'L-2001')).toBe(true);
  });

  it('returns only aged transactions when minAgeDays is set (§15.9)', async () => {
    mockTransactions('sales.json', 'leads.json');
    const aged = await afilioAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-01T00:00:00Z',
      minAgeDays: 365,
    });
    expect(aged.length).toBeGreaterThan(0);
    for (const t of aged) expect(t.ageDays).toBeGreaterThanOrEqual(365);
  });

  it('filters by canonical status[] (§15.10)', async () => {
    mockTransactions('sales.json', 'leads.json');
    const reversed = await afilioAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-01T00:00:00Z',
      status: ['reversed'],
    });
    expect(reversed.length).toBe(1);
    expect(reversed[0]?.status).toBe('reversed');
  });

  it('filters by programmeId', async () => {
    mockTransactions('sales.json', 'leads.json');
    const only = await afilioAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-01T00:00:00Z',
      programmeId: '5003',
    });
    expect(only.length).toBe(2); // the two leads
    expect(only.every((t) => t.programmeId === '5003')).toBe(true);
  });

  it('respects limit after all other filters are applied', async () => {
    mockTransactions('sales.json', 'leads.json');
    const limited = await afilioAdapter.listTransactions({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-01T00:00:00Z',
      limit: 2,
    });
    expect(limited.length).toBe(2);
  });

  it('emits a NetworkError when AFILIO_AFFILIATE_TOKEN is missing', async () => {
    delete process.env['AFILIO_AFFILIATE_TOKEN'];
    await expect(afilioAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });

  it('emits a NetworkError when AFILIO_AFF_ID is missing', async () => {
    delete process.env['AFILIO_AFF_ID'];
    await expect(afilioAdapter.listTransactions({})).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// getEarningsSummary — derived from listTransactions
// ---------------------------------------------------------------------------

describe('AfilioAdapter.getEarningsSummary', () => {
  it('aggregates commissions across sales and leads by status and programme', async () => {
    mockTransactions('sales.json', 'leads.json');
    const summary = await afilioAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-01T00:00:00Z',
    });
    expect(summary.network).toBe('afilio');
    expect(summary.currency).toBe('BRL');
    // 15.50 + 32.75 + 3.20 + 8.00 (sales) + 5.00 + 5.00 (leads)
    expect(summary.totalEarnings).toBeCloseTo(69.45, 2);
    expect(summary.byStatus.pending).toBeCloseTo(15.5 + 5.0, 2);
    expect(summary.byStatus.approved).toBeCloseTo(32.75 + 5.0, 2);
    expect(summary.byStatus.reversed).toBeCloseTo(3.2, 2);
    expect(summary.byStatus.paid).toBeCloseTo(8.0, 2);
    // programmes 5001, 5002, 5003
    expect(summary.byProgramme.length).toBe(3);
  });

  it('sets oldestUnpaidAgeDays from the longest-pending/approved transaction (§15.9)', async () => {
    mockTransactions('sales.json', 'leads.json');
    const summary = await afilioAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-01T00:00:00Z',
    });
    expect(summary.oldestUnpaidAgeDays).toBeDefined();
    // The approved sale S-1002 converted on 2024-01-15 — over a year old.
    expect(summary.oldestUnpaidAgeDays ?? 0).toBeGreaterThan(365);
  });

  it('does not pass limit through to the underlying transactions (no undercount)', async () => {
    // If limit leaked through, only 1 of 6 transactions would be summed.
    mockTransactions('sales.json', 'leads.json');
    const summary = await afilioAdapter.getEarningsSummary({
      from: '2024-01-01T00:00:00Z',
      to: '2026-06-01T00:00:00Z',
      limit: 1,
    });
    expect(summary.totalEarnings).toBeCloseTo(69.45, 2);
  });

  it('returns an empty summary when no transactions match', async () => {
    mockTransactions('sales_empty.json', 'leads_empty.json');
    const summary = await afilioAdapter.getEarningsSummary({});
    expect(summary.totalEarnings).toBe(0);
    expect(summary.byProgramme).toHaveLength(0);
    expect(summary.oldestUnpaidAgeDays).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listProgrammes / getProgramme — Campaign Description API
// ---------------------------------------------------------------------------

describe('AfilioAdapter.listProgrammes', () => {
  it('maps campaigns to programmes', async () => {
    mockFetchQueue([xmlResponse(loadXml('campaigns.json'))]);
    const programmes = await afilioAdapter.listProgrammes();
    expect(programmes.length).toBe(3);
    expect(programmes.map((p) => p.id).sort()).toEqual(['5001', '5002', '5003']);
  });

  it('filters by status client-side', async () => {
    mockFetchQueue([xmlResponse(loadXml('campaigns.json'))]);
    const suspended = await afilioAdapter.listProgrammes({ status: 'suspended' });
    expect(suspended.length).toBe(1);
    expect(suspended[0]?.id).toBe('5002');
  });

  it('filters by search term client-side', async () => {
    mockFetchQueue([xmlResponse(loadXml('campaigns.json'))]);
    const found = await afilioAdapter.listProgrammes({ search: 'seguros' });
    expect(found.length).toBe(1);
    expect(found[0]?.id).toBe('5003');
  });
});

describe('AfilioAdapter.getProgramme', () => {
  it('returns the matching campaign', async () => {
    mockFetchQueue([xmlResponse(loadXml('campaigns.json'))]);
    const prog = await afilioAdapter.getProgramme('5002');
    expect(prog.id).toBe('5002');
    expect(prog.name).toBe('Eletronicos Teste');
  });

  it('throws NetworkError when the campaign id is not found', async () => {
    mockFetchQueue([xmlResponse(loadXml('campaigns.json'))]);
    await expect(afilioAdapter.getProgramme('9999')).rejects.toBeInstanceOf(NetworkError);
  });

  it('throws NetworkError (config_error) when programmeId is empty', async () => {
    await expect(afilioAdapter.getProgramme('')).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// NotImplemented operations
// ---------------------------------------------------------------------------

describe('AfilioAdapter NotImplemented operations', () => {
  it('listClicks throws NotImplementedError with an Afilio-specific reason', async () => {
    await expect(afilioAdapter.listClicks({})).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await afilioAdapter.listClicks({});
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('click-level');
    }
  });

  it('generateTrackingLink throws NotImplementedError with a reason', async () => {
    await expect(
      afilioAdapter.generateTrackingLink({ programmeId: '5001', destinationUrl: 'https://x.test' }),
    ).rejects.toBeInstanceOf(NotImplementedError);
    try {
      await afilioAdapter.generateTrackingLink({ programmeId: '5001', destinationUrl: 'https://x.test' });
    } catch (err) {
      expect((err as NotImplementedError).reason).toContain('deterministic');
    }
  });

  it('listPublishers / listPublisherSectors throw NotImplementedError', async () => {
    await expect(afilioAdapter.listPublishers()).rejects.toBeInstanceOf(NotImplementedError);
    await expect(afilioAdapter.listPublisherSectors()).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth — happy + failure paths
// ---------------------------------------------------------------------------

describe('AfilioAdapter.verifyAuth', () => {
  it('returns ok:true and identity on a 2xx XML response', async () => {
    mockFetchQueue([xmlResponse(loadXml('sales_empty.json'))]);
    const r = await afilioAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toBe('afilio/affid:123456');
  });

  it('returns ok:false (does not throw) on a 401', async () => {
    mockFetchQueue([xmlResponse('Unauthorized', { status: 401 })]);
    await expect(afilioAdapter.verifyAuth()).resolves.toMatchObject({ ok: false });
  });

  it('returns ok:false when the API replies with an <error> document on 200', async () => {
    mockFetchQueue([xmlResponse('<error>token invalido</error>')]);
    const r = await afilioAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });

  it('returns ok:false when credentials are missing', async () => {
    delete process.env['AFILIO_AFFILIATE_TOKEN'];
    const r = await afilioAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Error envelope transparency (§15.4)
// ---------------------------------------------------------------------------

describe('§15.4 error transparency', () => {
  it('surfaces the verbatim response body on a 500', async () => {
    const body = '<error>upstream exploded</error>';
    // listTransactions fires sale + lead concurrently; both fail, retries exhaust.
    mockFetchQueue([
      xmlResponse(body, { status: 500 }),
      xmlResponse(body, { status: 500 }),
      xmlResponse(body, { status: 500 }),
      xmlResponse(body, { status: 500 }),
      xmlResponse(body, { status: 500 }),
      xmlResponse(body, { status: 500 }),
      xmlResponse(body, { status: 500 }),
      xmlResponse(body, { status: 500 }),
    ]);
    try {
      await afilioAdapter.listTransactions({
        from: '2024-01-01T00:00:00Z',
        to: '2026-06-01T00:00:00Z',
      });
      throw new Error('expected to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      const env = (err as NetworkError).envelope;
      expect(env.network).toBe('afilio');
      expect(env.operation).toBe('listTransactions');
      expect(env.httpStatus).toBe(500);
      expect(env.networkErrorBody).toContain('upstream exploded');
    }
  });
});

// ---------------------------------------------------------------------------
// validateCredential
// ---------------------------------------------------------------------------

describe('AfilioAdapter.validateCredential', () => {
  it('accepts a positive integer AFILIO_AFF_ID', async () => {
    const r = await afilioAdapter.validateCredential('AFILIO_AFF_ID', '123456');
    expect(r.ok).toBe(true);
  });

  it('rejects a non-numeric AFILIO_AFF_ID', async () => {
    const r1 = await afilioAdapter.validateCredential('AFILIO_AFF_ID', 'abc');
    expect(r1.ok).toBe(false);
    const r2 = await afilioAdapter.validateCredential('AFILIO_AFF_ID', '0');
    expect(r2.ok).toBe(false);
    expect(r2.hint).toBeTruthy();
  });

  it('rejects an empty AFILIO_AFFILIATE_TOKEN', async () => {
    const r = await afilioAdapter.validateCredential('AFILIO_AFFILIATE_TOKEN', '');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('validates AFILIO_AFFILIATE_TOKEN via a live Sales API probe when Aff ID is set', async () => {
    mockFetchQueue([xmlResponse(loadXml('sales_empty.json'))]);
    const r = await afilioAdapter.validateCredential('AFILIO_AFFILIATE_TOKEN', 'good-token');
    expect(r.ok).toBe(true);
  });

  it('returns ok:false with a hint when the token probe fails', async () => {
    mockFetchQueue([xmlResponse('Forbidden', { status: 403 })]);
    const r = await afilioAdapter.validateCredential('AFILIO_AFFILIATE_TOKEN', 'bad-token');
    expect(r.ok).toBe(false);
    expect(r.hint).toBeTruthy();
  });

  it('returns ok:false for unknown credential fields', async () => {
    const r = await afilioAdapter.validateCredential('AFILIO_UNKNOWN_FIELD', 'value');
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck
// ---------------------------------------------------------------------------

describe('AfilioAdapter.capabilitiesCheck', () => {
  it('records listClicks and generateTrackingLink as not supported', async () => {
    // Probes: verifyAuth (1 fetch), listProgrammes (1 fetch),
    // listTransactions (2 fetches: sale+lead), getEarningsSummary (2 fetches).
    mockFetchQueue([
      xmlResponse(loadXml('sales_empty.json')), // verifyAuth
      xmlResponse(loadXml('campaigns.json')), // listProgrammes
      xmlResponse(loadXml('sales_empty.json')), // listTransactions sale
      xmlResponse(loadXml('leads_empty.json')), // listTransactions lead
      xmlResponse(loadXml('sales_empty.json')), // getEarningsSummary sale
      xmlResponse(loadXml('leads_empty.json')), // getEarningsSummary lead
    ]);
    const caps = await afilioAdapter.capabilitiesCheck();
    expect(caps.network).toBe('afilio');
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
    expect(caps.operations['listProgrammes']?.supported).toBe(true);
    expect(caps.operations['listTransactions']?.supported).toBe(true);
    expect(caps.knownLimitations.length).toBeGreaterThan(0);
  });
});
