/**
 * Impact advertiser adapter — unit tests.
 *
 * Exercises every operation, asserts the URL path shape (agency-passthrough
 * vs brand-direct), confirms status mapping, and confirms the read-only
 * guard refuses non-GETs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  impactAdvertiserAdapter,
  impactAdvertiserActionDescriptors,
  _internals,
} from '../../../src/networks/impact-advertiser/adapter.js';
import { _resetCredentialCache } from '../../../src/networks/impact-advertiser/auth.js';
import { buildUrl, impactAdvRequest } from '../../../src/networks/impact-advertiser/client.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';
import { NetworkError } from '../../../src/shared/errors.js';
import { NotImplementedError } from '../../../src/shared/types.js';
import { DEFAULT_RESILIENCE } from '../../../src/shared/resilience.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'impact-advertiser');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(body: unknown, init: { status?: number } = {}): Response {
  const status = init.status ?? 200;
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return new Response(text, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Queue mock fetch and capture the URLs called. We make the FIRST response the
 * shape-detection probe response (configurable per-test), then subsequent
 * responses for the actual API calls.
 */
function mockFetchQueue(responses: Response[]): {
  spy: ReturnType<typeof vi.fn>;
  urls: string[];
} {
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

// Useful shorthands for the two credential tiers. The shape-detection probe
// reads /Agencies/{SID}; we either succeed (agency) or 404 (brand-direct).
function expectAgency(): Response {
  return fakeResponse({ Id: 'IRA-AGENCY-1', Name: 'Test Agency' });
}
function expectBrandDirect(): Response {
  return fakeResponse('not found', { status: 404 });
}

beforeEach(() => {
  _resetBreakers();
  _resetCredentialCache();
  process.env['IMPACT_ADVERTISER_ACCOUNT_SID'] = 'IRA-AGENCY-1';
  process.env['IMPACT_ADVERTISER_AUTH_TOKEN'] = 'fake-token';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['IMPACT_ADVERTISER_ACCOUNT_SID'];
  delete process.env['IMPACT_ADVERTISER_AUTH_TOKEN'];
  _resetCredentialCache();
});

// ---------------------------------------------------------------------------
// Transformers and helpers
// ---------------------------------------------------------------------------

describe('Impact advertiser transformers', () => {
  it('maps Impact action State to canonical TransactionStatus', () => {
    expect(_internals.mapActionStatus({ State: 'PENDING' })).toBe('pending');
    expect(_internals.mapActionStatus({ State: 'APPROVED' })).toBe('approved');
    expect(_internals.mapActionStatus({ State: 'LOCKED' })).toBe('approved');
    expect(_internals.mapActionStatus({ State: 'REVERSED' })).toBe('reversed');
    expect(_internals.mapActionStatus({ State: 'PAID' })).toBe('paid');
    expect(_internals.mapActionStatus({ State: 'WEIRD' })).toBe('other');
  });

  it('maps media-partner status to active|pending|inactive|unknown', () => {
    expect(_internals.mapMediaPartnerStatus({ AccountStatus: 'Active' })).toBe('active');
    expect(_internals.mapMediaPartnerStatus({ AccountStatus: 'Pending' })).toBe('pending');
    expect(_internals.mapMediaPartnerStatus({ AccountStatus: 'Inactive' })).toBe('inactive');
    expect(_internals.mapMediaPartnerStatus({ AccountStatus: 'Declined' })).toBe('inactive');
    expect(_internals.mapMediaPartnerStatus({ AccountStatus: 'unrecognised' })).toBe('unknown');
  });

  it('preserves raw network data on every domain transform', () => {
    const raw = (loadFixture('actions.json') as { Actions: Array<Record<string, unknown>> })
      .Actions[0];
    const t = _internals.toTransaction(raw as never);
    expect(t.rawNetworkData).toBe(raw);

    const mp = (loadFixture('media-partners.json') as { MediaPartners: Array<Record<string, unknown>> })
      .MediaPartners[0];
    const p = _internals.toMediaPartner(mp as never);
    expect(p.rawNetworkData).toBe(mp);
  });

  it('surfaces reversalReason on reversed transactions', () => {
    const raw = (loadFixture('actions.json') as { Actions: Array<Record<string, unknown>> })
      .Actions[2];
    const t = _internals.toTransaction(raw as never);
    expect(t.status).toBe('reversed');
    expect(t.reversalReason).toBe('Customer returned the item within 14 days');
  });

  it('normalises performance report dates to yyyy-mm-dd', () => {
    const row = _internals.toPerformanceRow({
      Date: '2026-05-01T00:00:00Z',
      MediaPartnerId: 'MP-1',
      MediaPartner: 'BestDeals',
      Clicks: 100,
      Actions: 5,
      SaleAmount: '500.00',
      Payout: '50.00',
      Currency: 'USD',
      State: 'APPROVED',
    });
    expect(row.date).toBe('2026-05-01');
    expect(row.clicks).toBe(100);
    expect(row.conversions).toBe(5);
    expect(row.grossSale).toBe(500);
    expect(row.commission).toBe(50);
    expect(row.status).toBe('approved');
  });
});

// ---------------------------------------------------------------------------
// URL shape — the agency vs brand-direct pathing is the highest-risk piece
// ---------------------------------------------------------------------------

describe('Impact advertiser URL shape', () => {
  it('agency tier builds /Agencies/{AgencySID}/Advertisers/{BrandSID}/Campaigns', () => {
    const url = buildUrl(
      'agency',
      'IRA-AGENCY-1',
      '/Campaigns',
      undefined,
      'BRAND-42',
    );
    expect(url).toBe(
      'https://api.impact.com/Agencies/IRA-AGENCY-1/Advertisers/BRAND-42/Campaigns',
    );
  });

  it('brand-direct tier builds /Advertisers/{BrandSID}/Campaigns', () => {
    const url = buildUrl(
      'brand-direct',
      'IRA-BRAND-1',
      '/Campaigns',
      undefined,
      'IRA-BRAND-1',
    );
    expect(url).toBe('https://api.impact.com/Advertisers/IRA-BRAND-1/Campaigns');
  });

  it('agencyPath is reserved for agency credentials', () => {
    expect(() =>
      buildUrl('brand-direct', 'X', undefined, '/Advertisers', undefined),
    ).toThrow(/agency-tier/);
  });

  it('rejects both paths or neither', () => {
    expect(() => buildUrl('agency', 'X', '/Campaigns', '/Advertisers', 'Y')).toThrow();
    expect(() => buildUrl('agency', 'X', undefined, undefined, undefined)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Read-only guard
// ---------------------------------------------------------------------------

describe('Impact advertiser read-only guard', () => {
  it('refuses any non-GET method with a config_error envelope', async () => {
    // We pass method via type assertion since the public type only allows
    // 'GET' — the guard exists for runtime safety regardless.
    const promise = impactAdvRequest({
      operation: 'verifyAuth',
      brandPath: '/Foo',
      networkBrandId: 'X',
      method: 'POST' as 'GET',
      resilience: DEFAULT_RESILIENCE,
    });
    await expect(promise).rejects.toBeInstanceOf(NetworkError);
    try {
      await promise;
    } catch (err) {
      const e = err as NetworkError;
      expect(e.envelope.type).toBe('config_error');
      expect(e.envelope.message).toMatch(/read-only/);
    }
  });
});

// ---------------------------------------------------------------------------
// listBrands — agency tier and brand-direct tier
// ---------------------------------------------------------------------------

describe('Impact advertiser.listBrands', () => {
  it('agency tier enumerates brands via GET /Agencies/{SID}/Advertisers', async () => {
    const advertisers = loadFixture('agencies-advertisers.json');
    const { urls } = mockFetchQueue([expectAgency(), fakeResponse(advertisers)]);

    const brands = await impactAdvertiserAdapter.listBrands();
    expect(brands).toHaveLength(3);
    expect(brands[0]?.networkBrandId).toBe('IA-1001');
    expect(brands[0]?.displayName).toBe('Acme Widgets');
    expect(brands[2]?.apiEnabled).toBe(false);

    // The second URL (after detection) MUST be the agency advertisers path.
    expect(urls[1]).toContain('/Agencies/IRA-AGENCY-1/Advertisers');
  });

  it('brand-direct tier returns a single synthetic entry', async () => {
    const { urls } = mockFetchQueue([
      expectBrandDirect(),
      // /Company lookup
      fakeResponse({ CompanyName: 'Acme Widgets' }),
    ]);

    const brands = await impactAdvertiserAdapter.listBrands();
    expect(brands).toHaveLength(1);
    expect(brands[0]?.networkBrandId).toBe('IRA-AGENCY-1');
    expect(brands[0]?.displayName).toBe('Acme Widgets');

    // The /Company lookup is under /Advertisers/{SID}/Company — no /Agencies prefix.
    expect(urls[1]).toContain('/Advertisers/IRA-AGENCY-1/Company');
    expect(urls[1]).not.toContain('/Agencies/');
  });

  it('brand-direct tier falls back to a synthetic name when /Company fails', async () => {
    mockFetchQueue([
      expectBrandDirect(),
      // /Company lookup fails with 404 — we expect the resilience layer to give up
      fakeResponse('not found', { status: 404 }),
      fakeResponse('not found', { status: 404 }),
      fakeResponse('not found', { status: 404 }),
    ]);

    const brands = await impactAdvertiserAdapter.listBrands();
    expect(brands).toHaveLength(1);
    expect(brands[0]?.displayName).toContain('Impact advertiser');
  });
});

// ---------------------------------------------------------------------------
// listProgrammes
// ---------------------------------------------------------------------------

describe('Impact advertiser.listProgrammes', () => {
  it('uses agency-passthrough path when creds are agency-tier', async () => {
    const { urls } = mockFetchQueue([expectAgency(), fakeResponse(loadFixture('campaigns.json'))]);

    const r = await impactAdvertiserAdapter.listProgrammes(undefined, {
      networkBrandId: 'BRAND-42',
    });
    expect(r).toHaveLength(2);
    expect(urls[1]).toContain('/Agencies/IRA-AGENCY-1/Advertisers/BRAND-42/Campaigns');
  });

  it('uses brand-direct path when creds are brand-direct', async () => {
    const { urls } = mockFetchQueue([
      expectBrandDirect(),
      fakeResponse(loadFixture('campaigns.json')),
    ]);
    await impactAdvertiserAdapter.listProgrammes(undefined, { networkBrandId: 'BRAND-42' });
    expect(urls[1]).toContain('/Advertisers/BRAND-42/Campaigns');
    expect(urls[1]).not.toContain('/Agencies/');
  });

  it('refuses to run without a brand context (config_error)', async () => {
    // Even with creds in env, missing ctx must surface as config_error.
    await expect(impactAdvertiserAdapter.listProgrammes()).rejects.toBeInstanceOf(NetworkError);
    try {
      await impactAdvertiserAdapter.listProgrammes();
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('config_error');
    }
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------

describe('Impact advertiser.listTransactions', () => {
  it('returns transformed actions for a brand under agency creds', async () => {
    mockFetchQueue([expectAgency(), fakeResponse(loadFixture('actions.json'))]);
    const r = await impactAdvertiserAdapter.listTransactions(undefined, {
      networkBrandId: 'BRAND-42',
    });
    expect(r).toHaveLength(3);
    expect(r.map((t) => t.status).sort()).toEqual(['approved', 'pending', 'reversed']);
  });

  it('filters by status client-side', async () => {
    mockFetchQueue([expectAgency(), fakeResponse(loadFixture('actions.json'))]);
    const r = await impactAdvertiserAdapter.listTransactions(
      { status: 'reversed' },
      { networkBrandId: 'BRAND-42' },
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.reversalReason).toBe('Customer returned the item within 14 days');
  });
});

// ---------------------------------------------------------------------------
// listMediaPartners
// ---------------------------------------------------------------------------

describe('Impact advertiser.listMediaPartners', () => {
  it('returns the brand publisher roster with normalised status', async () => {
    const { urls } = mockFetchQueue([
      expectAgency(),
      fakeResponse(loadFixture('media-partners.json')),
    ]);
    const r = await impactAdvertiserAdapter.listMediaPartners(undefined, {
      networkBrandId: 'BRAND-42',
    });
    expect(r).toHaveLength(3);
    expect(r.map((p) => p.status).sort()).toEqual(['active', 'inactive', 'pending']);
    expect(urls[1]).toContain('/Advertisers/BRAND-42/MediaPartners');
  });

  it('filters by status array', async () => {
    mockFetchQueue([expectAgency(), fakeResponse(loadFixture('media-partners.json'))]);
    const r = await impactAdvertiserAdapter.listMediaPartners(
      { status: ['active'] },
      { networkBrandId: 'BRAND-42' },
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.name).toBe('BestDeals.com');
  });
});

// ---------------------------------------------------------------------------
// getProgrammePerformance — sync path and async-polling path
// ---------------------------------------------------------------------------

describe('Impact advertiser.getProgrammePerformance', () => {
  it('returns rows inline when the report is synchronous', async () => {
    const { urls } = mockFetchQueue([
      expectAgency(),
      fakeResponse(loadFixture('performance-report-sync.json')),
    ]);
    const r = await impactAdvertiserAdapter.getProgrammePerformance(
      { from: '2026-05-01', to: '2026-05-31' },
      { networkBrandId: 'BRAND-42' },
    );
    expect(r).toHaveLength(2);
    expect(r[0]?.publisherName).toBe('BestDeals.com');
    expect(r[0]?.clicks).toBe(1200);
    expect(urls[1]).toContain('/Advertisers/BRAND-42/Reports/adv_performance_by_media');
  });

  it(
    'follows ResultUri when the report runs asynchronously',
    async () => {
      // First call returns {ResultUri}, then poll-1 returns the rows.
      mockFetchQueue([
        expectAgency(),
        fakeResponse({ ResultUri: '/ReportExport/abc123', Status: 'queued' }),
        fakeResponse(loadFixture('performance-report-sync.json')),
      ]);
      const r = await impactAdvertiserAdapter.getProgrammePerformance(undefined, {
        networkBrandId: 'BRAND-42',
      });
      expect(r).toHaveLength(2);
    },
    10_000,
  );
});

// ---------------------------------------------------------------------------
// listContracts / getContract — read-only contract surface
// ---------------------------------------------------------------------------

describe('Impact advertiser contract transformers', () => {
  it('maps contract status to active|pending|expired|inactive|unknown', () => {
    expect(_internals.mapContractStatus({ Status: 'Active' })).toBe('active');
    expect(_internals.mapContractStatus({ Status: 'Pending' })).toBe('pending');
    expect(_internals.mapContractStatus({ Status: 'Expired' })).toBe('expired');
    expect(_internals.mapContractStatus({ Status: 'Terminated' })).toBe('inactive');
    expect(_internals.mapContractStatus({ Status: 'whatever' })).toBe('unknown');
  });

  it('transforms a raw contract and preserves raw network data', () => {
    const raw = (loadFixture('contracts.json') as { Contracts: Array<Record<string, unknown>> })
      .Contracts[0];
    const ct = _internals.toContract(raw as never);
    expect(ct.id).toBe('CT-5001');
    expect(ct.programmeId).toBe('CMP-42');
    expect(ct.mediaPartnerName).toBe('BestDeals.com');
    expect(ct.status).toBe('active');
    expect(ct.payoutTerms).toContain('8%');
    expect(ct.effectiveDate).toBe('2026-01-01T00:00:00.000Z');
    expect(ct.rawNetworkData).toBe(raw);
  });
});

describe('Impact advertiser.listContracts', () => {
  it('lists contracts under a campaign and builds the right path', async () => {
    const { urls } = mockFetchQueue([expectAgency(), fakeResponse(loadFixture('contracts.json'))]);
    const r = await impactAdvertiserAdapter.listContracts(
      { programmeId: 'CMP-42', cursor: '2', limit: 50 },
      { networkBrandId: 'BRAND-42' },
    );
    expect(r).toHaveLength(3);
    expect(urls[1]).toContain('/Agencies/IRA-AGENCY-1/Advertisers/BRAND-42/Campaigns/CMP-42/Contracts');
    expect(urls[1]).toContain('PageSize=50');
    expect(urls[1]).toContain('Page=2');
  });

  it('filters by status client-side', async () => {
    mockFetchQueue([expectAgency(), fakeResponse(loadFixture('contracts.json'))]);
    const r = await impactAdvertiserAdapter.listContracts(
      { programmeId: 'CMP-42', status: 'pending' },
      { networkBrandId: 'BRAND-42' },
    );
    expect(r).toHaveLength(1);
    expect(r[0]?.mediaPartnerName).toBe('CouponCove');
  });

  it('uses the brand-direct credential path when agency detection returns 404', async () => {
    const { urls } = mockFetchQueue([
      expectBrandDirect(),
      fakeResponse(loadFixture('contracts.json')),
    ]);
    await impactAdvertiserAdapter.listContracts(
      { programmeId: 'CMP-42' },
      { networkBrandId: 'BRAND-42' },
    );
    expect(urls[1]).toContain('/Advertisers/BRAND-42/Campaigns/CMP-42/Contracts');
    expect(urls[1]).not.toContain('/Agencies/');
  });

  it('rejects a successful payload that cannot identify a listed contract', async () => {
    mockFetchQueue([expectAgency(), fakeResponse({ Contracts: [{ Status: 'Active' }] })]);
    try {
      await impactAdvertiserAdapter.listContracts(
        { programmeId: 'CMP-42' },
        { networkBrandId: 'BRAND-42' },
      );
      throw new Error('expected listContracts to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).envelope.type).toBe('network_api_error');
      expect((err as NetworkError).envelope.operation).toBe('listContracts');
    }
  });

  it('refuses to run without a brand context (config_error)', async () => {
    await expect(
      impactAdvertiserAdapter.listContracts({ programmeId: 'CMP-42' }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('refuses to run without a programmeId (config_error)', async () => {
    await expect(
      impactAdvertiserAdapter.listContracts(undefined, { networkBrandId: 'BRAND-42' }),
    ).rejects.toBeInstanceOf(NetworkError);
    try {
      await impactAdvertiserAdapter.listContracts(undefined, { networkBrandId: 'BRAND-42' });
    } catch (err) {
      expect((err as NetworkError).envelope.type).toBe('config_error');
    }
  });
});

describe('Impact advertiser.getContract', () => {
  it('fetches a single contract and builds the right path', async () => {
    const { urls } = mockFetchQueue([expectAgency(), fakeResponse(loadFixture('contract.json'))]);
    const ct = await impactAdvertiserAdapter.getContract(
      { programmeId: 'CMP-42', contractId: 'CT-5001' },
      { networkBrandId: 'BRAND-42' },
    );
    expect(ct.id).toBe('CT-5001');
    expect(ct.status).toBe('active');
    expect(urls[1]).toContain('/Campaigns/CMP-42/Contracts/CT-5001');
  });

  it('uses requested ids when the single-contract payload omits them', async () => {
    mockFetchQueue([expectAgency(), fakeResponse({ Contract: { Status: 'Active' } })]);
    const ct = await impactAdvertiserAdapter.getContract(
      { programmeId: 'CMP-42', contractId: 'CT-5001' },
      { networkBrandId: 'BRAND-42' },
    );
    expect(ct.id).toBe('CT-5001');
    expect(ct.programmeId).toBe('CMP-42');
    expect(ct.rawNetworkData).toEqual({ Status: 'Active' });
  });

  it('refuses to run without a contractId (config_error)', async () => {
    try {
      await impactAdvertiserAdapter.getContract(
        { programmeId: 'CMP-42', contractId: '' },
        { networkBrandId: 'BRAND-42' },
      );
      throw new Error('expected getContract to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).envelope.type).toBe('config_error');
    }
  });
});

describe('Impact advertiser.proposeContract (advisement)', () => {
  it('plans a removal: reads before-state via GET only, no write, irreversibility warning + token', async () => {
    const { spy, urls } = mockFetchQueue([
      expectAgency(),
      fakeResponse(loadFixture('contract.json')),
    ]);
    const plan = await impactAdvertiserAdapter.proposeContract(
      { action: 'remove', brand: 'acme', programmeId: 'CMP-42', contractId: 'CT-5001' },
      { networkBrandId: 'BRAND-42' },
    );
    expect(plan.action).toBe('remove');
    expect(plan.network).toBe('impact-advertiser');
    expect(plan.brand).toBe('acme'); // logical slug echoed, never the networkBrandId
    expect(plan.before?.id).toBe('CT-5001');
    expect(plan.after).toBeUndefined();
    expect(plan.warnings.join(' ')).toMatch(/irreversible/i);
    expect(plan.confirmationToken).toMatch(/^[0-9a-f]{64}$/);
    expect(plan.expiresAt).toBeNull();
    expect(plan.experimental).toBe(true);
    // GET-only: every request issued used GET (no POST/DELETE reaches the client).
    const allGet = spy.mock.calls.every(
      (c) => ((c[1] as { method?: string } | undefined)?.method ?? 'GET') === 'GET',
    );
    expect(allGet).toBe(true);
    expect(urls.some((u) => u.includes('/Contracts/CT-5001'))).toBe(true);
  });

  it('plans a create (no contractId): reads current contracts via GET, no write, pending after', async () => {
    const { spy } = mockFetchQueue([
      expectAgency(),
      fakeResponse(loadFixture('contracts.json')),
    ]);
    const plan = await impactAdvertiserAdapter.proposeContract(
      {
        action: 'apply',
        brand: 'acme',
        programmeId: 'CMP-42',
        payoutTerms: '12% of sale',
        mediaPartnerId: 'MP-1',
      },
      { networkBrandId: 'BRAND-42' },
    );
    expect(plan.before).toBeUndefined();
    expect(plan.observedContracts.length).toBeGreaterThan(0);
    expect(plan.after?.status).toBe('pending');
    expect(plan.after?.payoutTerms).toBe('12% of sale');
    expect(plan.after?.mediaPartnerId).toBe('MP-1');
    expect((plan.after as { rawNetworkData?: unknown }).rawNetworkData).toBeUndefined();
    expect(plan.warnings.join(' ')).toMatch(/creates a new contract/i);
    expect(
      spy.mock.calls.every(
        (call) => ((call[1] as { method?: string } | undefined)?.method ?? 'GET') === 'GET',
      ),
    ).toBe(true);
  });

  it('plans an update to an active contract: warns about live partner payouts', async () => {
    mockFetchQueue([expectAgency(), fakeResponse(loadFixture('contract.json'))]);
    const plan = await impactAdvertiserAdapter.proposeContract(
      {
        action: 'apply',
        brand: 'acme',
        programmeId: 'CMP-42',
        contractId: 'CT-5001',
        payoutTerms: '15% of sale',
      },
      { networkBrandId: 'BRAND-42' },
    );
    expect(plan.before?.status).toBe('active');
    expect(plan.after?.payoutTerms).toBe('15% of sale');
    expect(plan.warnings.join(' ')).toMatch(/active contract affects live partner payouts/i);
  });

  it('computes a deterministic token over the intent and before-state', () => {
    const intent = {
      action: 'remove' as const,
      brand: 'acme',
      programmeId: 'CMP-42',
      contractId: 'CT-5001',
    };
    const before1 = {
      id: 'CT-5001',
      network: 'impact-advertiser' as const,
      programmeId: 'CMP-42',
      status: 'active' as const,
      payoutTerms: '8%',
      rawNetworkData: {},
    };
    const before2 = { ...before1, payoutTerms: '9%' };
    const otherBrand = { ...intent, brand: 'globex' };
    const otherContract = { ...intent, contractId: 'CT-5002' };
    const otherChange = { ...intent, action: 'apply' as const, payoutTerms: '8%' };
    const t1 = _internals.computeConfirmationToken(intent, 'CMP-42', before1 as never);
    const t1again = _internals.computeConfirmationToken(intent, 'CMP-42', before1 as never);
    const t2 = _internals.computeConfirmationToken(intent, 'CMP-42', before2 as never);
    const brandToken = _internals.computeConfirmationToken(otherBrand, 'CMP-42', before1 as never);
    const contractToken = _internals.computeConfirmationToken(
      otherContract,
      'CMP-42',
      before1 as never,
    );
    const changeToken = _internals.computeConfirmationToken(
      otherChange,
      'CMP-42',
      before1 as never,
    );
    expect(t1).toBe(t1again); // deterministic
    expect(t2).not.toBe(t1); // before-state participates
    expect(brandToken).not.toBe(t1); // cannot reuse across logical brands
    expect(contractToken).not.toBe(t1); // cannot reuse across target contracts
    expect(changeToken).not.toBe(t1); // cannot reuse across intended changes
  });

  it('refuses a remove without a contractId (config_error)', async () => {
    try {
      await impactAdvertiserAdapter.proposeContract(
        { action: 'remove', brand: 'acme', programmeId: 'CMP-42' },
        { networkBrandId: 'BRAND-42' },
      );
      throw new Error('expected proposeContract to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(NetworkError);
      expect((err as NetworkError).envelope.type).toBe('config_error');
      expect((err as NetworkError).envelope.operation).toBe('proposeContract');
    }
  });

  it('refuses an apply proposal with no concrete change (config_error)', async () => {
    await expect(
      impactAdvertiserAdapter.proposeContract(
        { action: 'apply', brand: 'acme', programmeId: 'CMP-42' },
        { networkBrandId: 'BRAND-42' },
      ),
    ).rejects.toMatchObject({ envelope: { type: 'config_error', operation: 'proposeContract' } });
  });

  it('refuses without brand context or without programmeId (config_error)', async () => {
    await expect(
      impactAdvertiserAdapter.proposeContract({
        action: 'apply',
        brand: 'acme',
        programmeId: 'CMP-42',
      }),
    ).rejects.toBeInstanceOf(NetworkError);
    await expect(
      impactAdvertiserAdapter.proposeContract(
        { action: 'apply', brand: 'acme', programmeId: '' },
        { networkBrandId: 'BRAND-42' },
      ),
    ).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('Impact advertiser action descriptors', () => {
  it('declares exactly proposeContract (advisement/api/Tier 1), no read or write catalogue', () => {
    expect(impactAdvertiserActionDescriptors).toHaveLength(1);
    const d = impactAdvertiserActionDescriptors[0]!;
    expect(d.id).toBe('impact-advertiser.proposeContract');
    expect(d.network).toBe('impact-advertiser');
    expect(d.channel).toBe('api');
    expect(d.effect).toBe('advisement');
    expect(d.defaultAuthorityTier).toBe(1);
    expect(d.credentialRequirements).toEqual([
      { label: 'IMPACT_ADVERTISER_ACCOUNT_SID' },
      { label: 'IMPACT_ADVERTISER_AUTH_TOKEN' },
    ]);
    const ids = impactAdvertiserActionDescriptors.map((x) => x.id);
    // The write half is not built, so it is not declared (#231 §5); reads are
    // never catalogued here.
    expect(ids).not.toContain('impact-advertiser.applyContract');
    expect(ids).not.toContain('impact-advertiser.removeContract');
    expect(ids).not.toContain('impact-advertiser.listContracts');
  });
});

// ---------------------------------------------------------------------------
// Ops not implemented at v0.1
// ---------------------------------------------------------------------------

describe('Impact advertiser unimplemented ops', () => {
  it('throws NotImplementedError on getProgramme / getEarningsSummary / listClicks / generateTrackingLink', async () => {
    await expect(impactAdvertiserAdapter.getProgramme('X')).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(impactAdvertiserAdapter.getEarningsSummary()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(impactAdvertiserAdapter.listClicks()).rejects.toBeInstanceOf(
      NotImplementedError,
    );
    await expect(
      impactAdvertiserAdapter.generateTrackingLink({
        programmeId: 'X',
        destinationUrl: 'https://example.com',
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

// ---------------------------------------------------------------------------
// verifyAuth uses shape detection
// ---------------------------------------------------------------------------

describe('Impact advertiser.verifyAuth', () => {
  it('returns ok with detected shape identity on success', async () => {
    mockFetchQueue([expectAgency()]);
    const r = await impactAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('agency');
      expect(r.identity).toContain('IRA-AGENCY-1');
    }
  });

  it('returns ok with brand-direct identity on a 404 to /Agencies', async () => {
    mockFetchQueue([expectBrandDirect()]);
    const r = await impactAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.identity).toContain('brand-direct');
    }
  });

  it('returns {ok:false} on 401', async () => {
    mockFetchQueue([fakeResponse('unauthorized', { status: 401 })]);
    const r = await impactAdvertiserAdapter.verifyAuth();
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-operation claimStatus (review feedback workstream 1)
// ---------------------------------------------------------------------------

describe('Impact advertiser.capabilitiesCheck — per-op claimStatus', () => {
  it('marks listBrands as experimental (brand-direct /Company shape unverified)', async () => {
    const caps = await impactAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['listBrands']?.claimStatus).toBe('experimental');
  });

  it('marks getProgrammePerformance as experimental (async ResultUri polling unverified)', async () => {
    const caps = await impactAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['getProgrammePerformance']?.claimStatus).toBe('experimental');
  });

  it('does NOT mark every op — listProgrammes and listTransactions have no override', async () => {
    const caps = await impactAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['listProgrammes']?.claimStatus).toBeUndefined();
    expect(caps.operations['listTransactions']?.claimStatus).toBeUndefined();
    expect(caps.operations['listMediaPartners']?.claimStatus).toBeUndefined();
  });

  it('marks contract reads as supported but experimental (endpoint TODO(verify))', async () => {
    const caps = await impactAdvertiserAdapter.capabilitiesCheck();
    expect(caps.operations['listContracts']?.supported).toBe(true);
    expect(caps.operations['listContracts']?.claimStatus).toBe('experimental');
    expect(caps.operations['getContract']?.supported).toBe(true);
    expect(caps.operations['getContract']?.claimStatus).toBe('experimental');
    expect(caps.operations['proposeContract']?.supported).toBe(true);
    expect(caps.operations['proposeContract']?.claimStatus).toBe('experimental');
  });
});
