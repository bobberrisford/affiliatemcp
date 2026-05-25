import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { generateAwinTools } from '../../../src/networks/awin/tools.js';
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

function mockFetchQueue(responses: Response[]): void {
  const spy = vi.fn(async () => {
    const r = responses.shift();
    if (!r) throw new Error('mock fetch queue exhausted');
    return r;
  });
  globalThis.fetch = spy as unknown as typeof fetch;
}

function tool(name: string) {
  const found = generateAwinTools().find((candidate) => candidate.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
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

describe('Awin fixture-backed user journeys', () => {
  it('connects an account and surfaces the publisher ID', async () => {
    mockFetchQueue([fakeResponse(loadFixture('accounts.json'))]);
    const result = await tool('affiliate_awin_list_accounts').handle({});
    expect((result as { accounts: Array<{ id: string }> }).accounts[0]?.id).toBe('123456');
  });

  it('builds the data inputs for a daily performance brief', async () => {
    mockFetchQueue([fakeResponse(loadFixture('advertiser-performance.json'))]);
    const result = await tool('affiliate_awin_get_advertiser_performance').handle({
      from: '2026-05-01',
      to: '2026-05-22',
      region: 'GB',
    });
    const rows = (result as { rows: unknown[] }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ advertiserName: 'Atolls Bookshop', totalComm: 76.5 });
  });

  it('investigates a transaction by ID and related transaction queries', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('transactions.json')),
      fakeResponse(loadFixture('transaction-queries.json')),
    ]);
    const transactions = await tool('affiliate_awin_get_transactions_by_id').handle({
      ids: [12345],
    });
    const queries = await tool('affiliate_awin_list_transaction_queries').handle({
      advertiserIds: [1001],
      statuses: ['pending'],
    });
    expect((transactions as { transactions: unknown[] }).transactions.length).toBeGreaterThan(0);
    expect((queries as { queries: unknown[] }).queries[0]).toMatchObject({
      enquiryStatus: 'pending',
      enquiryType: 'untracked',
    });
  });

  it('discovers joined offers and generates a tracking link', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('offers.json')),
      fakeResponse(loadFixture('link-builder-batch.json')),
    ]);
    const offers = await tool('affiliate_awin_list_offers').handle({
      membership: 'joined',
      type: 'voucher',
      regionCodes: ['GB'],
    });
    const link = await tool('affiliate_awin_generate_tracking_links').handle({
      requests: [
        {
          advertiserId: 1001,
          destinationUrl: 'https://www.atolls-bookshop.example.com/paperbacks',
        },
        {
          advertiserId: 1001,
          destinationUrl: 'https://www.atolls-bookshop.example.com/stationery',
        },
      ],
    });
    expect((offers as { offers: unknown[] }).offers).toHaveLength(1);
    expect((link as { responses: unknown[] }).responses).toHaveLength(2);
  });

  it('inspects programme details and commission groups before promotion', async () => {
    mockFetchQueue([
      fakeResponse(loadFixture('programme-details.json')),
      fakeResponse(loadFixture('commission-groups.json')),
    ]);
    const details = await tool('affiliate_awin_get_programme_details').handle({
      advertiserId: 1001,
      relationship: 'any',
    });
    const groups = await tool('affiliate_awin_list_commission_groups').handle({
      advertiserId: 1001,
    });
    expect((details as { programmeInfo: { deeplinkEnabled?: boolean } }).programmeInfo.deeplinkEnabled)
      .toBe(true);
    expect((groups as { commissionGroups: unknown[] }).commissionGroups).toHaveLength(2);
  });

  it('fails gated Product Feed and Proof of Purchase flows safely', async () => {
    const feeds = await tool('affiliate_awin_list_product_feeds').handle({});
    const proof = await tool('affiliate_awin_submit_proof_of_purchase_transaction').handle({
      advertiserId: 1001,
    });
    expect(feeds).toMatchObject({ ok: false, status: 'requires_feed_api_key' });
    expect(proof).toMatchObject({ ok: false, status: 'activation_required' });
  });
});
