import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  generateAllTools,
  generateMetaTools,
  generateToolsFor,
} from '../../src/tools/generate.js';
import { _clearRegistry } from '../../src/shared/registry.js';
import { saveBrands } from '../../src/shared/brands.js';
import { BrandNotRegistered } from '../../src/shared/errors.js';
import type { NetworkAdapter } from '../../src/shared/types.js';

let tmp: string;
let originalConfigDir: string | undefined;

beforeEach(() => {
  _clearRegistry();
  tmp = mkdtempSync(path.join(tmpdir(), 'amcp-tool-gen-'));
  originalConfigDir = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  process.env['AFFILIATE_MCP_CONFIG_DIR'] = tmp;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
  else process.env['AFFILIATE_MCP_CONFIG_DIR'] = originalConfigDir;
});

/**
 * Build a minimal fake adapter for description-generation tests. We never call
 * the handlers — we only inspect the produced description strings.
 */
function fakeAdapter(slug: string, name: string): NetworkAdapter {
  const stub = async (): Promise<never> => {
    throw new Error('not called in this test');
  };
  return {
    slug,
    name,
    meta: {
      slug,
      name,
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
    listTransactions: stub,
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
}

describe('tool generator', () => {
  it('always emits the three meta tools', () => {
    const meta = generateMetaTools();
    const names = meta.map((t) => t.name).sort();
    expect(names).toEqual([
      'affiliate_list_networks',
      'affiliate_resolve_brand',
      'affiliate_run_diagnostic',
    ]);
  });

  it('with no adapters registered, only meta tools are present', () => {
    const all = generateAllTools();
    expect(all.map((t) => t.name).sort()).toEqual([
      'affiliate_list_networks',
      'affiliate_resolve_brand',
      'affiliate_run_diagnostic',
    ]);
  });

  it('each meta tool description follows the three-sentence pattern', () => {
    for (const t of generateMetaTools()) {
      const periods = (t.description.match(/\. /g) ?? []).length;
      expect(periods, `meta tool ${t.name} description must have at least three sentences`)
        .toBeGreaterThanOrEqual(2);
    }
  });

  // PRD §15.19 — every generated per-network tool description must:
  //   1. contain at least three sentences (two `. ` separators);
  //   2. mention the network's display name.
  it('every generated per-network tool description has three sentences and names the network (§15.19)', () => {
    const adapter = fakeAdapter('demonet', 'DemoNet');
    const tools = generateToolsFor(adapter);
    expect(tools.length).toBe(7);
    for (const t of tools) {
      const periods = (t.description.match(/\. /g) ?? []).length;
      expect(
        periods,
        `tool ${t.name} description must have at least three sentences; got: ${t.description}`,
      ).toBeGreaterThanOrEqual(2);
      expect(
        t.description,
        `tool ${t.name} description must mention the network name "DemoNet"`,
      ).toMatch(/DemoNet/);
    }
  });

  it('per-network tool descriptions mention a pairing tool (§5.5)', () => {
    const adapter = fakeAdapter('demonet', 'DemoNet');
    for (const t of generateToolsFor(adapter)) {
      expect(
        t.description.toLowerCase(),
        `tool ${t.name} description should mention a pairing tool ("pair with ...")`,
      ).toMatch(/pair[s]? with|pairs naturally|pair with/);
    }
  });
});

describe('affiliate_resolve_brand meta-tool', () => {
  function findResolveBrand() {
    return generateMetaTools().find((t) => t.name === 'affiliate_resolve_brand')!;
  }

  it('returns [] when brands.json is missing', async () => {
    const tool = findResolveBrand();
    expect(await tool.handle({})).toEqual([]);
  });

  it('returns every binding shaped as {brand, network, networkBrandId}', async () => {
    saveBrands({
      version: 1,
      brands: {
        acme: [
          { network: 'impact-advertiser', credentialId: 'default', networkBrandId: 'IA-1' },
          { network: 'cj-advertiser', credentialId: 'default', networkBrandId: 'CJ-1' },
        ],
        globex: [
          { network: 'impact-advertiser', credentialId: 'default', networkBrandId: 'IA-9' },
        ],
      },
    });
    const tool = findResolveBrand();
    const rows = (await tool.handle({})) as Array<{ brand: string; network: string; networkBrandId: string }>;
    expect(rows).toHaveLength(3);
    const sorted = [...rows].sort((a, b) => a.brand.localeCompare(b.brand) || a.network.localeCompare(b.network));
    expect(sorted).toEqual([
      { brand: 'acme', network: 'cj-advertiser', networkBrandId: 'CJ-1' },
      { brand: 'acme', network: 'impact-advertiser', networkBrandId: 'IA-1' },
      { brand: 'globex', network: 'impact-advertiser', networkBrandId: 'IA-9' },
    ]);
  });

  it('filters by network when the optional argument is supplied', async () => {
    saveBrands({
      version: 1,
      brands: {
        acme: [
          { network: 'impact-advertiser', credentialId: 'default', networkBrandId: 'IA-1' },
          { network: 'cj-advertiser', credentialId: 'default', networkBrandId: 'CJ-1' },
        ],
      },
    });
    const tool = findResolveBrand();
    const rows = (await tool.handle({ network: 'impact-advertiser' })) as Array<{ network: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.network).toBe('impact-advertiser');
  });
});

describe('advertiser-side tool generation', () => {
  function advertiserAdapter(): NetworkAdapter {
    const a = fakeAdapter('imp-adv', 'Impact Advertiser');
    (a as { meta: { side: string; credentialScope: string } }).meta.side = 'advertiser';
    (a as { meta: { side: string; credentialScope: string } }).meta.credentialScope = 'multi-brand';
    a.listBrands = async () => [];
    // Override listProgrammes to return a sentinel so we can assert the
    // adapter call still fires after the brand resolution step.
    (a as unknown as { listProgrammes: () => Promise<unknown> }).listProgrammes = async () => 'OK';
    return a;
  }

  it('adds a required `brand` field to every per-network tool schema', () => {
    const tools = generateToolsFor(advertiserAdapter());
    for (const t of tools) {
      const schema = t.inputSchema as {
        properties: Record<string, unknown>;
        required?: string[];
      };
      expect(schema.properties).toHaveProperty('brand');
      expect(schema.required ?? []).toContain('brand');
    }
  });

  it('resolves brand via brands.json before invoking the adapter', async () => {
    saveBrands({
      version: 1,
      brands: {
        acme: [{ network: 'imp-adv', credentialId: 'default', networkBrandId: 'IA-1' }],
      },
    });
    const tools = generateToolsFor(advertiserAdapter());
    const listProgrammes = tools.find((t) => t.name === 'affiliate_imp-adv_list_programmes')!;
    const result = await listProgrammes.handle({ brand: 'acme' });
    expect(result).toBe('OK');
  });

  it('throws BrandNotRegistered when the brand is unknown', async () => {
    const tools = generateToolsFor(advertiserAdapter());
    const listProgrammes = tools.find((t) => t.name === 'affiliate_imp-adv_list_programmes')!;
    await expect(listProgrammes.handle({ brand: 'unknown' })).rejects.toBeInstanceOf(
      BrandNotRegistered,
    );
  });

  it('publisher-side tools never gain a brand argument', () => {
    const a = fakeAdapter('alpha', 'Alpha');
    const tools = generateToolsFor(a);
    for (const t of tools) {
      const schema = t.inputSchema as { properties?: Record<string, unknown> };
      expect(schema.properties ?? {}).not.toHaveProperty('brand');
    }
  });
});

// ---------------------------------------------------------------------------
// Workstream 1: affiliate_list_networks surfaces per-op claimStatus
// ---------------------------------------------------------------------------

describe('affiliate_list_networks — operationClaimStatuses (review feedback)', () => {
  function adapterWithCaps(slug: string, name: string): NetworkAdapter {
    const a = fakeAdapter(slug, name);
    (a as { capabilitiesCheck: () => Promise<unknown> }).capabilitiesCheck = async () => ({
      network: slug,
      generatedAt: new Date().toISOString(),
      operations: {
        listProgrammes: { supported: true },
        getProgrammePerformance: {
          supported: true,
          claimStatus: 'experimental',
        },
        listBrands: { supported: false, claimStatus: 'partial' },
      },
      knownLimitations: [],
    });
    return a;
  }

  it('surfaces per-op claimStatus on the list_networks response without removing meta fields', async () => {
    const { registerAdapter } = await import('../../src/shared/registry.js');
    registerAdapter(adapterWithCaps('demo-adv', 'Demo Advertiser'));

    const tool = generateMetaTools().find((t) => t.name === 'affiliate_list_networks')!;
    const rows = (await tool.handle({})) as Array<{
      slug: string;
      name: string;
      claimStatus: string;
      operationClaimStatuses: Record<string, string>;
    }>;

    expect(rows).toHaveLength(1);
    const row = rows[0]!;

    // Original NetworkMeta fields preserved (additive).
    expect(row.slug).toBe('demo-adv');
    expect(row.name).toBe('Demo Advertiser');
    expect(row.claimStatus).toBe('experimental');

    // New field carries the per-op overrides.
    expect(row.operationClaimStatuses).toEqual({
      getProgrammePerformance: 'experimental',
      listBrands: 'partial',
    });
  });

  it('emits an empty operationClaimStatuses object when no ops declare overrides', async () => {
    const a = fakeAdapter('plain', 'Plain Network');
    (a as { capabilitiesCheck: () => Promise<unknown> }).capabilitiesCheck = async () => ({
      network: 'plain',
      generatedAt: new Date().toISOString(),
      operations: {
        listProgrammes: { supported: true },
        listTransactions: { supported: true },
      },
      knownLimitations: [],
    });
    const { registerAdapter } = await import('../../src/shared/registry.js');
    registerAdapter(a);

    const tool = generateMetaTools().find((t) => t.name === 'affiliate_list_networks')!;
    const rows = (await tool.handle({})) as Array<{
      slug: string;
      operationClaimStatuses: Record<string, string>;
    }>;
    expect(rows[0]!.operationClaimStatuses).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Workstream 1: affiliate_run_diagnostic preserves per-op claimStatus
// ---------------------------------------------------------------------------

describe('affiliate_run_diagnostic — preserves per-op claimStatus (review feedback)', () => {
  it('threads OperationCapability.claimStatus through to the diagnostic payload', async () => {
    const a = fakeAdapter('diag-adv', 'Diag Advertiser');
    (a as { capabilitiesCheck: () => Promise<unknown> }).capabilitiesCheck = async () => ({
      network: 'diag-adv',
      generatedAt: new Date().toISOString(),
      operations: {
        listProgrammes: { supported: true },
        getProgrammePerformance: {
          supported: true,
          claimStatus: 'experimental',
          note: 'async ResultUri polling unverified',
        },
      },
      knownLimitations: [],
    });
    const { registerAdapter } = await import('../../src/shared/registry.js');
    registerAdapter(a);

    const tool = generateMetaTools().find((t) => t.name === 'affiliate_run_diagnostic')!;
    const result = (await tool.handle({ network: 'diag-adv' })) as {
      results: Array<{
        network: string;
        capabilities?: {
          operations: Record<string, { supported: boolean; claimStatus?: string }>;
        };
      }>;
    };

    const ops = result.results[0]!.capabilities!.operations;
    expect(ops['getProgrammePerformance']!.claimStatus).toBe('experimental');
    expect(ops['listProgrammes']!.claimStatus).toBeUndefined();
  });
});
