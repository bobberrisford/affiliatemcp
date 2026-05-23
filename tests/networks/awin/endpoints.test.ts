import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  downloadProductFeed,
  generateLink,
  generateLinksBatch,
  getAdvertiserPerformance,
  getCampaignPerformance,
  getCreativePerformance,
  getLinkBuilderQuota,
  getProgrammeDetails,
  getTransactionsByIds,
  listAccounts,
  listCommissionGroups,
  listCommissionSharingRules,
  listOffers,
  listProductFeeds,
  listTransactionQueries,
  submitProofOfPurchaseTransaction,
} from '../../../src/networks/awin/endpoints/index.js';
import { _resetBreakers } from '../../../src/shared/resilience.js';

const FIXTURES = path.join(process.cwd(), 'tests', 'fixtures', 'awin');

function loadFixture(name: string): unknown {
  return JSON.parse(readFileSync(path.join(FIXTURES, name), 'utf8'));
}

function fakeResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
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

function firstUrl(spy: ReturnType<typeof vi.fn>): URL {
  const call = spy.mock.calls[0];
  if (!call) throw new Error('expected fetch to be called');
  return new URL(String(call[0]));
}

function firstBody(spy: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = spy.mock.calls[0];
  if (!call) throw new Error('expected fetch to be called');
  const init = call[1] as RequestInit | undefined;
  return JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
}

beforeEach(() => {
  _resetBreakers();
  process.env['AWIN_API_TOKEN'] = 'test-token-please-ignore';
  process.env['AWIN_PUBLISHER_ID'] = '123456';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['AWIN_API_TOKEN'];
  delete process.env['AWIN_PUBLISHER_ID'];
});

describe('Awin endpoint modules', () => {
  it('lists accessible publisher accounts via /accounts?type=publisher', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('accounts.json'))]);
    const result = await listAccounts();
    expect(result.accounts[0]?.id).toBe('123456');
    const url = firstUrl(spy);
    expect(url.pathname).toBe('/accounts');
    expect(url.searchParams.get('type')).toBe('publisher');
  });

  it('keeps legacy account rows that omit accountType', async () => {
    mockFetchQueue([
      fakeResponse([
        { publisherId: 98765, name: 'Legacy Publisher' },
        { id: 87654, name: 'Older Publisher' },
      ]),
    ]);
    const result = await listAccounts('publisher');
    expect(result.accounts.map((account) => account.id)).toEqual(['98765', '87654']);
  });

  it('fetches programme details with advertiserId and relationship', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('programme-details.json'))]);
    const result = await getProgrammeDetails({ advertiserId: 1001, relationship: 'any' });
    expect((result.programmeInfo as { name?: string }).name).toBe('Atolls Bookshop');
    const url = firstUrl(spy);
    expect(url.pathname).toBe('/publishers/123456/programmedetails');
    expect(url.searchParams.get('advertiserId')).toBe('1001');
    expect(url.searchParams.get('relationship')).toBe('any');
  });

  it('lists commission groups for an advertiser', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('commission-groups.json'))]);
    const result = await listCommissionGroups({
      advertiserId: '1001',
      extraConditionsDetails: true,
    });
    expect(result.commissionGroups).toHaveLength(2);
    const url = firstUrl(spy);
    expect(url.pathname).toBe('/publishers/123456/commissiongroups');
    expect(url.searchParams.get('extraConditionsDetails')).toBe('true');
  });

  it('lists commission-sharing rules without requiring advertiser context', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('commission-sharing-rules.json'))]);
    const result = await listCommissionSharingRules();
    expect(result.rules).toHaveLength(1);
    expect(firstUrl(spy).pathname).toBe('/publishers/123456/commissionsharingrules');
  });

  it('fetches transactions by comma-separated IDs', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('transactions.json'))]);
    const result = await getTransactionsByIds({ ids: [111, '222'], showBasketProducts: true });
    expect(result.transactions).toHaveLength(4);
    const url = firstUrl(spy);
    expect(url.pathname).toBe('/publishers/123456/transactions');
    expect(url.searchParams.get('ids')).toBe('111,222');
    expect(url.searchParams.get('showBasketProducts')).toBe('true');
  });

  it('lists transaction queries from the singular /publisher endpoint', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('transaction-queries.json'))]);
    const result = await listTransactionQueries({
      advertiserIds: [1001],
      statuses: ['pending'],
      pageSize: 100,
    });
    expect(result.queries).toHaveLength(1);
    expect(result.totalRowsAvailable).toBe(1);
    const url = firstUrl(spy);
    expect(url.pathname).toBe('/publisher/123456/transactionqueries');
    expect(url.searchParams.get('advertiserIds')).toBe('1001');
  });

  it('normalises advertiser, creative, and campaign report rows', async () => {
    const spy = mockFetchQueue([
      fakeResponse(loadFixture('advertiser-performance.json')),
      fakeResponse(loadFixture('creative-performance.json')),
      fakeResponse(loadFixture('campaign-performance.json')),
    ]);
    const advertiser = await getAdvertiserPerformance({ from: '2026-05-01', to: '2026-05-22' });
    const creative = await getCreativePerformance({ region: 'GB' });
    const campaign = await getCampaignPerformance({
      advertiserIds: [1001],
      campaign: 'newsletter',
      includeNumbersWithoutCampaign: true,
    });
    expect(advertiser.rows).toHaveLength(1);
    expect(creative.rows).toHaveLength(1);
    expect(campaign.rows).toHaveLength(1);
    expect(firstUrl(spy).pathname).toBe('/publishers/123456/reports/advertiser');
    const thirdUrl = new URL(String(spy.mock.calls[2]?.[0]));
    expect(thirdUrl.pathname).toBe('/publishers/123456/reports/campaign');
    expect(thirdUrl.searchParams.get('advertiserIds')).toBe('1001');
  });

  it('retrieves offers with filters in the POST body', async () => {
    const spy = mockFetchQueue([fakeResponse(loadFixture('offers.json'))]);
    const result = await listOffers({
      membership: 'joined',
      type: 'voucher',
      regionCodes: ['GB'],
      exclusiveOnly: true,
    });
    expect(result.offers).toHaveLength(1);
    expect(firstUrl(spy).pathname).toBe('/publisher/123456/promotions');
    const body = firstBody(spy);
    expect(body['filters']).toMatchObject({
      membership: 'joined',
      type: 'voucher',
      regionCodes: ['GB'],
      exclusiveOnly: true,
    });
  });

  it('uses official Link Builder endpoints for single, batch, and quota calls', async () => {
    const spy = mockFetchQueue([
      fakeResponse(loadFixture('link-builder.json')),
      fakeResponse(loadFixture('link-builder-batch.json')),
      fakeResponse(loadFixture('link-builder-quota.json')),
    ]);
    const single = await generateLink({
      advertiserId: 1001,
      destinationUrl: 'https://www.atolls-bookshop.example.com/paperbacks',
      shorten: false,
    });
    const batch = await generateLinksBatch([
      { advertiserId: 1001, destinationUrl: 'https://www.atolls-bookshop.example.com/' },
      { advertiserId: 1002, destinationUrl: 'https://no-deeplink.example.com/' },
    ]);
    const quota = await getLinkBuilderQuota();
    expect(single.trackingUrl).toContain('awin1.com');
    expect(batch.responses).toHaveLength(2);
    expect(quota.usage).toBe(12);
    expect(new URL(String(spy.mock.calls[0]?.[0])).pathname).toBe(
      '/publishers/123456/linkbuilder/generate',
    );
    expect(new URL(String(spy.mock.calls[1]?.[0])).pathname).toBe(
      '/publishers/123456/linkbuilder/generate-batch',
    );
    expect(new URL(String(spy.mock.calls[2]?.[0])).pathname).toBe(
      '/publishers/123456/linkbuilder/quota',
    );
  });

  it('returns config_error envelopes for local validation failures', async () => {
    await expect(generateLinksBatch([])).rejects.toMatchObject({
      envelope: { type: 'config_error', operation: 'generateLinksBatch' },
    });
    await expect(
      generateLinksBatch(
        Array.from({ length: 101 }, (_, i) => ({
          advertiserId: 1000 + i,
          destinationUrl: 'https://www.atolls-bookshop.example.com/',
        })),
      ),
    ).rejects.toMatchObject({
      envelope: { type: 'config_error', operation: 'generateLinksBatch' },
    });
    await expect(getTransactionsByIds({ ids: [] })).rejects.toMatchObject({
      envelope: { type: 'config_error', operation: 'getTransactionsByIds' },
    });
  });

  it('returns actionable stubs for gated product feed and Proof of Purchase APIs', () => {
    expect(listProductFeeds().status).toBe('requires_feed_api_key');
    expect(downloadProductFeed({ advertiserId: 1001, format: 'google-jsonl' }).endpoint).toContain(
      '/awinfeeds/download/1001-retail-en_GB.jsonl',
    );
    const proof = submitProofOfPurchaseTransaction({ advertiserId: 1001 });
    expect(proof.status).toBe('activation_required');
    expect(proof.requiredCredentials).toContain('AWIN_PROOF_OF_PURCHASE_API_KEY');
  });
});
