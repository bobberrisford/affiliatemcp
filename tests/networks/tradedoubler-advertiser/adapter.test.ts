/**
 * Tradedoubler advertiser adapter — unit tests.
 *
 * Exercises every implemented operation, confirms status mapping, XML parsing,
 * and validates that auth failures surface as structured envelopes.
 *
 * No live credentials are used. `globalThis.fetch` is mocked throughout.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  tradedoublerAdvertiserAdapter,
  _internals,
} from '../../../src/networks/tradedoubler-advertiser/adapter.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'tradedoubler-advertiser');

function loadFixture(name: string): string {
  return readFileSync(path.join(FIXTURES, name), 'utf8');
}

function fakeResponse(body: string, init: { status?: number; contentType?: string } = {}): Response {
  const status = init.status ?? 200;
  const contentType = init.contentType ?? 'application/xml';
  return new Response(body, {
    status,
    headers: { 'content-type': contentType },
  });
}

function mockFetch(responses: Response[]): { spy: ReturnType<typeof vi.fn>; urls: string[] } {
  const urls: string[] = [];
  const spy = vi.fn(async (input: string | URL | Request) => {
    urls.push(typeof input === 'string' ? input : input.toString());
    const r = responses.shift();
    if (!r) throw new Error('mock fetch queue exhausted');
    return r;
  });
  globalThis.fetch = spy as unknown as typeof fetch;
  return { spy, urls };
}

beforeEach(() => {
  _resetBreakers();
  process.env['TRADEDOUBLER_ADV_TOKEN'] = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
  process.env['TRADEDOUBLER_ADV_ORGANIZATION_ID'] = '123456';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['TRADEDOUBLER_ADV_TOKEN'];
  delete process.env['TRADEDOUBLER_ADV_ORGANIZATION_ID'];
});

// ---------------------------------------------------------------------------
// Internal helpers — status mapping, XML parsing, date parsing
// ---------------------------------------------------------------------------

describe('Tradedoubler advertiser internal helpers', () => {
  describe('mapProgrammeStatus', () => {
    it('maps A → joined, P → pending, D → declined, S → suspended', () => {
      expect(_internals.mapProgrammeStatus('A')).toBe('joined');
      expect(_internals.mapProgrammeStatus('ACTIVE')).toBe('joined');
      expect(_internals.mapProgrammeStatus('P')).toBe('pending');
      expect(_internals.mapProgrammeStatus('PENDING')).toBe('pending');
      expect(_internals.mapProgrammeStatus('D')).toBe('declined');
      expect(_internals.mapProgrammeStatus('S')).toBe('suspended');
      expect(_internals.mapProgrammeStatus('UNKNOWN')).toBe('unknown');
      expect(_internals.mapProgrammeStatus('')).toBe('unknown');
    });
  });

  describe('mapMediaPartnerStatus', () => {
    it('maps A → active, P → pending, D → inactive', () => {
      expect(_internals.mapMediaPartnerStatus('A')).toBe('active');
      expect(_internals.mapMediaPartnerStatus('APPROVED')).toBe('active');
      expect(_internals.mapMediaPartnerStatus('P')).toBe('pending');
      expect(_internals.mapMediaPartnerStatus('D')).toBe('inactive');
      expect(_internals.mapMediaPartnerStatus('DECLINED')).toBe('inactive');
      expect(_internals.mapMediaPartnerStatus('WEIRD')).toBe('unknown');
    });
  });

  describe('mapPerformanceRowStatus', () => {
    it('maps A → approved, D → reversed, everything else → pending', () => {
      expect(_internals.mapPerformanceRowStatus('A')).toBe('approved');
      expect(_internals.mapPerformanceRowStatus('APPROVED')).toBe('approved');
      expect(_internals.mapPerformanceRowStatus('D')).toBe('reversed');
      expect(_internals.mapPerformanceRowStatus('CANCELLED')).toBe('reversed');
      expect(_internals.mapPerformanceRowStatus('P')).toBe('pending');
      expect(_internals.mapPerformanceRowStatus('')).toBe('pending');
    });
  });

  describe('parseTdDate', () => {
    it('parses d.m.Y Tradedoubler date format', () => {
      const iso = _internals.parseTdDate('01.05.2026');
      expect(iso).toBeDefined();
      expect(iso?.startsWith('2026-05-01')).toBe(true);
    });

    it('parses d.m.y two-digit year', () => {
      const iso = _internals.parseTdDate('01.05.26');
      expect(iso).toBeDefined();
      expect(iso?.startsWith('2026-05-01')).toBe(true);
    });

    it('returns undefined for empty input', () => {
      expect(_internals.parseTdDate('')).toBeUndefined();
      expect(_internals.parseTdDate(undefined)).toBeUndefined();
    });

    it('parses ISO-style dates', () => {
      const iso = _internals.parseTdDate('2026-05-15');
      expect(iso).toBeDefined();
      expect(iso?.startsWith('2026-05-15')).toBe(true);
    });
  });

  describe('computeAgeDays', () => {
    it('returns 0 for undefined date', () => {
      expect(_internals.computeAgeDays(undefined)).toBe(0);
    });

    it('returns positive age for a past date', () => {
      const pastDate = new Date();
      pastDate.setUTCDate(pastDate.getUTCDate() - 10);
      const age = _internals.computeAgeDays(pastDate.toISOString());
      expect(age).toBeGreaterThanOrEqual(9);
      expect(age).toBeLessThanOrEqual(11);
    });

    it('accepts an injected now for deterministic tests', () => {
      const now = new Date('2026-05-28T00:00:00Z');
      const age = _internals.computeAgeDays('2026-05-01T00:00:00Z', now);
      expect(age).toBe(27);
    });
  });

  describe('toTdDateStr', () => {
    it('formats a date to dd.mm.YYYY', () => {
      const d = new Date('2026-05-01T00:00:00Z');
      expect(_internals.toTdDateStr(d)).toBe('01.05.2026');
    });
  });

  describe('toTdDateStrFromIso', () => {
    it('converts ISO YYYY-MM-DD to Tradedoubler format', () => {
      expect(_internals.toTdDateStrFromIso('2026-05-15')).toBe('15.05.2026');
    });
  });
});

// ---------------------------------------------------------------------------
// toProgramme transformer
// ---------------------------------------------------------------------------

describe('Tradedoubler advertiser toProgramme', () => {
  it('maps a % commission row correctly', () => {
    const row = {
      programId: '11111',
      programName: 'Acme Widgets UK',
      status: 'A',
      programTariffPercentage: '5.00',
      programTariffAmount: '0',
      programTariffCurrency: 'GBP',
    };
    const p = _internals.toProgramme(row);
    expect(p.id).toBe('11111');
    expect(p.name).toBe('Acme Widgets UK');
    expect(p.status).toBe('joined');
    expect(p.currency).toBe('GBP');
    expect(typeof p.commissionRate).toBe('object');
    if (typeof p.commissionRate === 'object' && p.commissionRate !== null && 'type' in p.commissionRate) {
      expect(p.commissionRate.type).toBe('percent');
      expect(p.commissionRate.value).toBe(5);
    }
    expect(p.rawNetworkData).toBe(row);
  });

  it('maps a flat commission row correctly', () => {
    const row = {
      programId: '22222',
      programName: 'Globex Electronics',
      status: 'A',
      programTariffPercentage: '0',
      programTariffAmount: '2.50',
      programTariffCurrency: 'EUR',
    };
    const p = _internals.toProgramme(row);
    if (typeof p.commissionRate === 'object' && p.commissionRate !== null && 'type' in p.commissionRate) {
      expect(p.commissionRate.type).toBe('flat');
      expect(p.commissionRate.value).toBe(2.5);
    }
  });

  it('maps suspended status', () => {
    const row = {
      programId: '33333',
      programName: 'Initech Software',
      status: 'S',
      programTariffPercentage: '8.00',
      programTariffAmount: '0',
      programTariffCurrency: 'GBP',
    };
    const p = _internals.toProgramme(row);
    expect(p.status).toBe('suspended');
  });

  it('preserves rawNetworkData', () => {
    const row = { programId: '99', programName: 'Test', status: 'A' };
    const p = _internals.toProgramme(row);
    expect(p.rawNetworkData).toBe(row);
  });
});

// ---------------------------------------------------------------------------
// toMediaPartner transformer
// ---------------------------------------------------------------------------

describe('Tradedoubler advertiser toMediaPartner', () => {
  it('maps active publisher', () => {
    const row = { siteId: '5001', siteName: 'BestDeals.co.uk', pendingStatus: 'A' };
    const mp = _internals.toMediaPartner(row);
    expect(mp.id).toBe('5001');
    expect(mp.name).toBe('BestDeals.co.uk');
    expect(mp.status).toBe('active');
    expect(mp.rawNetworkData).toBe(row);
  });

  it('maps pending publisher', () => {
    const row = { siteId: '5002', siteName: 'VoucherWorld', pendingStatus: 'P' };
    const mp = _internals.toMediaPartner(row);
    expect(mp.status).toBe('pending');
  });

  it('maps declined/reversed publisher as inactive', () => {
    const row = { siteId: '5003', siteName: 'CashbackSite', pendingStatus: 'D' };
    const mp = _internals.toMediaPartner(row);
    expect(mp.status).toBe('inactive');
  });
});

// ---------------------------------------------------------------------------
// toPerformanceRow transformer
// ---------------------------------------------------------------------------

describe('Tradedoubler advertiser toPerformanceRow', () => {
  it('maps an approved event row correctly', () => {
    const row = {
      timeOfEvent: '01.05.2026',
      siteId: '5001',
      siteName: 'BestDeals.co.uk',
      pendingStatus: 'A',
      orderValue: '150.00',
      affiliateCommission: '7.50',
      programId: '11111',
      eventName: 'Sale',
      currencyId: 'GBP',
    };
    const now = new Date('2026-05-28T00:00:00Z');
    const r = _internals.toPerformanceRow(row, now);
    expect(r.date).toBe('2026-05-01');
    expect(r.publisherId).toBe('5001');
    expect(r.publisherName).toBe('BestDeals.co.uk');
    expect(r.status).toBe('approved');
    expect(r.grossSale).toBe(150);
    expect(r.commission).toBe(7.5);
    expect(r.currency).toBe('GBP');
    expect(r.conversions).toBe(1);
    expect(r.clicks).toBe(0); // no click data in event reports
    expect(r.rawNetworkData).toBe(row);
  });

  it('maps a reversed event row', () => {
    const row = {
      timeOfEvent: '05.05.2026',
      siteId: '5003',
      siteName: 'CashbackSite',
      pendingStatus: 'D',
      orderValue: '200.00',
      affiliateCommission: '10.00',
      programId: '22222',
      eventName: 'Sale',
      currencyId: 'EUR',
    };
    const r = _internals.toPerformanceRow(row);
    expect(r.status).toBe('reversed');
    expect(r.grossSale).toBe(200);
    expect(r.commission).toBe(10);
    expect(r.currency).toBe('EUR');
  });
});

// ---------------------------------------------------------------------------
// toDiscoveredBrand transformer
// ---------------------------------------------------------------------------

describe('Tradedoubler advertiser toDiscoveredBrand', () => {
  it('maps a programme row to DiscoveredBrand', () => {
    const row = { programId: '11111', programName: 'Acme Widgets UK', status: 'A' };
    const b = _internals.toDiscoveredBrand(row);
    expect(b.networkBrandId).toBe('11111');
    expect(b.displayName).toBe('Acme Widgets UK');
    expect(b.apiEnabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth
// ---------------------------------------------------------------------------

describe('Tradedoubler advertiser.verifyAuth', () => {
  it('returns ok=true when the API responds with XML', async () => {
    mockFetch([fakeResponse(loadFixture('programmes.xml'))]);
    const r = await tradedoublerAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('tradedoubler-advertiser/org/');
    }
  });

  it('returns ok=false when the API responds with HTML (bad token)', async () => {
    mockFetch([
      fakeResponse(loadFixture('auth-html-response.html'), { contentType: 'text/html' }),
    ]);
    const r = await tradedoublerAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/HTML|login page|token/i);
    }
  });

  it('returns ok=false when TRADEDOUBLER_ADV_TOKEN is missing', async () => {
    delete process.env['TRADEDOUBLER_ADV_TOKEN'];
    const r = await tradedoublerAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toMatch(/TRADEDOUBLER_ADV_TOKEN/);
    }
  });

  it('returns ok=false on HTTP error', async () => {
    mockFetch([fakeResponse('Internal Server Error', { status: 500 })]);
    const r = await tradedoublerAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// listBrands
// ---------------------------------------------------------------------------

describe('Tradedoubler advertiser.listBrands', () => {
  it('returns discovered brands from programmes report', async () => {
    mockFetch([fakeResponse(loadFixture('programmes.xml'))]);
    const brands = await tradedoublerAdvertiserAdapter.listBrands();
    expect(brands).toHaveLength(3);
    expect(brands[0]?.networkBrandId).toBe('11111');
    expect(brands[0]?.displayName).toBe('Acme Widgets UK');
    expect(brands[0]?.apiEnabled).toBe(true);
  });

  it('injects the token in the request URL', async () => {
    const { urls } = mockFetch([fakeResponse(loadFixture('programmes.xml'))]);
    await tradedoublerAdvertiserAdapter.listBrands();
    expect(urls[0]).toContain('token=');
    expect(urls[0]).toContain('aAffiliateMyProgramsReport');
  });

  it('throws NetworkError when credentials are missing', async () => {
    delete process.env['TRADEDOUBLER_ADV_TOKEN'];
    await expect(tradedoublerAdvertiserAdapter.listBrands()).rejects.toBeInstanceOf(NetworkError);
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('Tradedoubler advertiser.listProgrammes', () => {
  it('returns all three programmes from the fixture', async () => {
    mockFetch([fakeResponse(loadFixture('programmes.xml'))]);
    const programmes = await tradedoublerAdvertiserAdapter.listProgrammes();
    expect(programmes).toHaveLength(3);
    expect(programmes.map((p) => p.status).sort()).toEqual(['joined', 'joined', 'suspended']);
  });

  it('filters by status', async () => {
    mockFetch([fakeResponse(loadFixture('programmes.xml'))]);
    const programmes = await tradedoublerAdvertiserAdapter.listProgrammes({ status: 'joined' });
    expect(programmes).toHaveLength(2);
  });

  it('filters by search string', async () => {
    mockFetch([fakeResponse(loadFixture('programmes.xml'))]);
    const programmes = await tradedoublerAdvertiserAdapter.listProgrammes({ search: 'Acme' });
    expect(programmes).toHaveLength(1);
    expect(programmes[0]?.name).toBe('Acme Widgets UK');
  });

  it('respects the limit parameter', async () => {
    mockFetch([fakeResponse(loadFixture('programmes.xml'))]);
    const programmes = await tradedoublerAdvertiserAdapter.listProgrammes({ limit: 2 });
    expect(programmes).toHaveLength(2);
  });

  it('filters by ctx.networkBrandId', async () => {
    mockFetch([fakeResponse(loadFixture('programmes.xml'))]);
    const programmes = await tradedoublerAdvertiserAdapter.listProgrammes(undefined, {
      networkBrandId: '11111',
    });
    expect(programmes).toHaveLength(1);
    expect(programmes[0]?.id).toBe('11111');
  });

  it('preserves rawNetworkData on each programme', async () => {
    mockFetch([fakeResponse(loadFixture('programmes.xml'))]);
    const programmes = await tradedoublerAdvertiserAdapter.listProgrammes();
    for (const p of programmes) {
      expect(p.rawNetworkData).toBeDefined();
    }
  });

  it('surfaces auth failure as NetworkError when HTML is returned', async () => {
    mockFetch([fakeResponse(loadFixture('auth-html-response.html'))]);
    await expect(tradedoublerAdvertiserAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
    try {
      mockFetch([fakeResponse(loadFixture('auth-html-response.html'))]);
      await tradedoublerAdvertiserAdapter.listProgrammes();
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('auth_error');
    }
  });
});

// ---------------------------------------------------------------------------
// listMediaPartners
// ---------------------------------------------------------------------------

describe('Tradedoubler advertiser.listMediaPartners', () => {
  it('deduplicates publishers across multiple events', async () => {
    mockFetch([fakeResponse(loadFixture('events.xml'))]);
    const partners = await tradedoublerAdvertiserAdapter.listMediaPartners();
    // siteId 5001 appears twice in events.xml — should be deduplicated.
    expect(partners.length).toBe(3);
    const ids = partners.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length); // all unique
  });

  it('filters by status', async () => {
    mockFetch([fakeResponse(loadFixture('events.xml'))]);
    const partners = await tradedoublerAdvertiserAdapter.listMediaPartners({ status: 'active' });
    expect(partners.every((p) => p.status === 'active')).toBe(true);
  });

  it('filters by search string on name', async () => {
    mockFetch([fakeResponse(loadFixture('events.xml'))]);
    const partners = await tradedoublerAdvertiserAdapter.listMediaPartners({ search: 'BestDeals' });
    expect(partners).toHaveLength(1);
    expect(partners[0]?.name).toBe('BestDeals.co.uk');
  });

  it('respects the limit', async () => {
    mockFetch([fakeResponse(loadFixture('events.xml'))]);
    const partners = await tradedoublerAdvertiserAdapter.listMediaPartners({ limit: 1 });
    expect(partners).toHaveLength(1);
  });

  it('preserves rawNetworkData', async () => {
    mockFetch([fakeResponse(loadFixture('events.xml'))]);
    const partners = await tradedoublerAdvertiserAdapter.listMediaPartners();
    for (const p of partners) {
      expect(p.rawNetworkData).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// getProgrammePerformance
// ---------------------------------------------------------------------------

describe('Tradedoubler advertiser.getProgrammePerformance', () => {
  it('returns event rows with correct fields', async () => {
    mockFetch([fakeResponse(loadFixture('events.xml'))]);
    const rows = await tradedoublerAdvertiserAdapter.getProgrammePerformance({
      from: '2026-05-01',
      to: '2026-05-31',
    });
    expect(rows.length).toBeGreaterThan(0);
    const first = rows[0];
    expect(first).toBeDefined();
    expect(first?.date).toBe('2026-05-01');
    expect(first?.publisherId).toBe('5001');
    expect(first?.publisherName).toBe('BestDeals.co.uk');
    expect(first?.status).toBe('approved');
    expect(first?.grossSale).toBe(150);
    expect(first?.commission).toBe(7.5);
    expect(first?.currency).toBe('GBP');
    expect(first?.conversions).toBe(1);
  });

  it('filters by publisherId', async () => {
    mockFetch([fakeResponse(loadFixture('events.xml'))]);
    const rows = await tradedoublerAdvertiserAdapter.getProgrammePerformance(
      { publisherId: '5002' },
    );
    expect(rows.every((r) => r.publisherId === '5002')).toBe(true);
  });

  it('respects limit', async () => {
    mockFetch([fakeResponse(loadFixture('events.xml'))]);
    const rows = await tradedoublerAdvertiserAdapter.getProgrammePerformance({ limit: 2 });
    expect(rows).toHaveLength(2);
  });

  it('preserves rawNetworkData on each row', async () => {
    mockFetch([fakeResponse(loadFixture('events.xml'))]);
    const rows = await tradedoublerAdvertiserAdapter.getProgrammePerformance();
    for (const r of rows) {
      expect(r.rawNetworkData).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Unimplemented operations
// ---------------------------------------------------------------------------

describe('Tradedoubler advertiser unimplemented ops', () => {
  it('getProgramme throws NotImplementedError', async () => {
    await expect(tradedoublerAdvertiserAdapter.getProgramme('X')).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });

  it('listTransactions throws NotImplementedError', async () => {
    await expect(tradedoublerAdvertiserAdapter.listTransactions()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });

  it('getEarningsSummary throws NotImplementedError', async () => {
    await expect(tradedoublerAdvertiserAdapter.getEarningsSummary()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });

  it('listClicks throws NotImplementedError', async () => {
    await expect(tradedoublerAdvertiserAdapter.listClicks()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
  });

  it('generateTrackingLink throws NotImplementedError', async () => {
    await expect(
      tradedoublerAdvertiserAdapter.generateTrackingLink({
        programmeId: 'X',
        destinationUrl: 'https://example.com',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// capabilitiesCheck — per-op claimStatus
// ---------------------------------------------------------------------------

describe('Tradedoubler advertiser.capabilitiesCheck', () => {
  it('marks implemented ops as supported with experimental claimStatus', async () => {
    const caps = await tradedoublerAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['listBrands']?.supported).toBe(true);
    expect(caps.operations['listBrands']?.claimStatus).toBe('experimental');
    expect(caps.operations['listProgrammes']?.supported).toBe(true);
    expect(caps.operations['listProgrammes']?.claimStatus).toBe('experimental');
    expect(caps.operations['listMediaPartners']?.supported).toBe(true);
    expect(caps.operations['getProgrammePerformance']?.supported).toBe(true);
  });

  it('marks unimplemented ops as not supported', async () => {
    const caps = await tradedoublerAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['getProgramme']?.supported).toBe(false);
    expect(caps.operations['listTransactions']?.supported).toBe(false);
    expect(caps.operations['getEarningsSummary']?.supported).toBe(false);
    expect(caps.operations['listClicks']?.supported).toBe(false);
    expect(caps.operations['generateTrackingLink']?.supported).toBe(false);
  });

  it('verifyAuth is marked as supported', async () => {
    const caps = await tradedoublerAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['verifyAuth']?.supported).toBe(true);
  });
});
