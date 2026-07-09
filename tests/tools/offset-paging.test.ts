import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateToolsFor } from '../../src/tools/generate.js';
import type { NetworkAdapter, Transaction } from '../../src/shared/types.js';

let configDir: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ['AFFILIATE_MCP_CONFIG_DIR', 'AFFILIATE_MCP_CACHE']) {
    savedEnv[key] = process.env[key];
  }
  configDir = mkdtempSync(path.join(tmpdir(), 'amcp-paging-'));
  process.env['AFFILIATE_MCP_CONFIG_DIR'] = configDir;
  process.env['AFFILIATE_MCP_CACHE'] = 'on';
});

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(configDir, { recursive: true, force: true });
});

function makeTxns(count: number): Transaction[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `txn-${i}`,
    network: 'mock',
    programmeId: 'p1',
    programmeName: 'Programme One',
    status: 'approved' as const,
    amount: 100,
    currency: 'GBP',
    commission: 10,
    dateConverted: '2026-01-15T12:00:00Z',
    ageDays: 30,
    rawNetworkData: {},
  }));
}

/** A publisher adapter whose listTransactions honours `limit` and counts calls. */
function pagingAdapter(rows: Transaction[]): { adapter: NetworkAdapter; calls: () => number } {
  let callCount = 0;
  const stub = async (): Promise<never> => {
    throw new Error('not called in this test');
  };
  const adapter: NetworkAdapter = {
    slug: 'mock',
    name: 'Mock',
    meta: {
      slug: 'mock',
      name: 'Mock',
      baseUrl: 'https://example.test',
      authModel: 'bearer',
      adapterVersion: '0.0.0',
      claimStatus: 'experimental',
      knownLimitations: [],
      supportsBrandOps: false,
      setupTimeEstimateMinutes: 0,
      setupRequiresApproval: false,
      side: 'publisher',
      credentialScope: 'single-brand',
    },
    resilienceConfig: {
      default: {
        timeoutMs: 1000,
        retries: 0,
        retryOn: [],
        circuitBreaker: { threshold: 5, cooldownMs: 1000 },
      },
    },
    listProgrammes: stub,
    getProgramme: stub,
    listTransactions: async (query) => {
      callCount += 1;
      const limit = query?.limit;
      return typeof limit === 'number' ? rows.slice(0, limit) : rows;
    },
    getEarningsSummary: stub,
    listClicks: stub,
    generateTrackingLink: stub,
    verifyAuth: stub,
    listPublishers: stub,
    listPublisherSectors: stub,
    validateCredential: stub,
    setupSteps: () => [],
    capabilitiesCheck: stub,
  };
  return { adapter, calls: () => callCount };
}

// A closed past window so pickTtl elects to cache the full pull.
const WINDOW = { from: '2026-01-01', to: '2026-01-31' };

describe('offset paging at the tool layer', () => {
  it('slices pages locally and serves later pages from the cache, not the network', async () => {
    const { adapter, calls } = pagingAdapter(makeTxns(250));
    const tool = generateToolsFor(adapter).find(
      (t) => t.name === 'affiliate_mock_list_transactions',
    );
    expect(tool).toBeDefined();

    const page1 = (await tool?.handle({ ...WINDOW, offset: 0, limit: 100 })) as Transaction[];
    expect(page1).toHaveLength(100);
    expect(page1[0]?.id).toBe('txn-0');
    expect(calls()).toBe(1);

    const page2 = (await tool?.handle({ ...WINDOW, offset: 100, limit: 100 })) as Transaction[];
    expect(page2).toHaveLength(100);
    expect(page2[0]?.id).toBe('txn-100');
    // Page two came from the shared cache entry: no second upstream pull.
    expect(calls()).toBe(1);

    const page3 = (await tool?.handle({ ...WINDOW, offset: 200, limit: 100 })) as Transaction[];
    expect(page3).toHaveLength(50);
    expect(page3[49]?.id).toBe('txn-249');
    expect(calls()).toBe(1);
  });

  it('keeps limit upstream and the result shape bare when offset is absent', async () => {
    const { adapter, calls } = pagingAdapter(makeTxns(250));
    const tool = generateToolsFor(adapter).find(
      (t) => t.name === 'affiliate_mock_list_transactions',
    );
    const result = (await tool?.handle({ ...WINDOW, limit: 5 })) as Transaction[];
    // The fake honours limit, proving it reached the adapter unchanged.
    expect(result).toHaveLength(5);
    expect(Array.isArray(result)).toBe(true);
    expect(calls()).toBe(1);
  });

  it('slices past the end to an empty page rather than erroring', async () => {
    const { adapter } = pagingAdapter(makeTxns(10));
    const tool = generateToolsFor(adapter).find(
      (t) => t.name === 'affiliate_mock_list_transactions',
    );
    const page = (await tool?.handle({ ...WINDOW, offset: 50, limit: 10 })) as Transaction[];
    expect(page).toEqual([]);
  });

  it('exposes offset in the input schema for list ops only', () => {
    const { adapter } = pagingAdapter([]);
    const tools = generateToolsFor(adapter);
    const listSchema = tools.find((t) => t.name === 'affiliate_mock_list_transactions')
      ?.inputSchema as { properties: Record<string, unknown> };
    const summarySchema = tools.find((t) => t.name === 'affiliate_mock_get_earnings_summary')
      ?.inputSchema as { properties: Record<string, unknown> };
    const linkSchema = tools.find((t) => t.name === 'affiliate_mock_generate_tracking_link')
      ?.inputSchema as { properties: Record<string, unknown> };
    expect(listSchema.properties['offset']).toBeDefined();
    expect(summarySchema.properties['offset']).toBeUndefined();
    expect(linkSchema.properties['offset']).toBeUndefined();
  });

  it('rejects offset on non-list ops at the schema boundary', async () => {
    const { adapter } = pagingAdapter([]);
    const summary = generateToolsFor(adapter).find(
      (t) => t.name === 'affiliate_mock_get_earnings_summary',
    );
    await expect(summary?.handle({ ...WINDOW, offset: 10 })).rejects.toThrow();
  });

  it('withholds offset from excluded (network, op) pairs and keeps it elsewhere', async () => {
    const { adapter } = pagingAdapter(makeTxns(5));
    // Same fake adapter, but wearing an excluded slug: skimlinks'
    // listTransactions has an unverified upstream default page size (no
    // paging parameter sent against a documented-paginated endpoint).
    // everflow was the previous example here; its exclusion was lifted when
    // the adapter began paginating to completion on absent limit (#316).
    const skimlinksLike = {
      ...adapter,
      slug: 'skimlinks',
      meta: { ...adapter.meta, slug: 'skimlinks' },
    };
    const tools = generateToolsFor(skimlinksLike);
    const txns = tools.find((t) => t.name === 'affiliate_skimlinks_list_transactions');
    const clicks = tools.find((t) => t.name === 'affiliate_skimlinks_list_clicks');
    expect(
      (txns?.inputSchema as { properties: Record<string, unknown> }).properties['offset'],
    ).toBeUndefined();
    // listClicks is not excluded for skimlinks, so paging stays available there.
    expect(
      (clicks?.inputSchema as { properties: Record<string, unknown> }).properties['offset'],
    ).toBeDefined();
    // A paging attempt on the excluded op fails loudly, never a silent slice.
    await expect(txns?.handle({ ...WINDOW, offset: 100 })).rejects.toThrow();
  });
});
