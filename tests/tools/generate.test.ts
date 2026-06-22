import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  generateAllTools,
  generateMetaTools,
  generateToolsFor,
} from '../../src/tools/generate.js';
import { _clearRegistry } from '../../src/shared/registry.js';
import { saveBrands } from '../../src/shared/brands.js';
import { resolveKpiFile, resolveStrategyFile } from '../../src/shared/client-strategy.js';
import { BrandNotRegistered } from '../../src/shared/errors.js';
import type { NetworkAdapter } from '../../src/shared/types.js';

let tmp: string;
let originalConfigDir: string | undefined;
let originalCacheSetting: string | undefined;
let originalImpactSid: string | undefined;
let originalImpactToken: string | undefined;

beforeEach(() => {
  _clearRegistry();
  tmp = mkdtempSync(path.join(tmpdir(), 'amcp-tool-gen-'));
  originalConfigDir = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  originalCacheSetting = process.env['AFFILIATE_MCP_CACHE'];
  originalImpactSid = process.env['IMPACT_ADVERTISER_ACCOUNT_SID'];
  originalImpactToken = process.env['IMPACT_ADVERTISER_AUTH_TOKEN'];
  process.env['AFFILIATE_MCP_CONFIG_DIR'] = tmp;
  process.env['AFFILIATE_MCP_CACHE'] = 'on';
  delete process.env['IMPACT_ADVERTISER_ACCOUNT_SID'];
  delete process.env['IMPACT_ADVERTISER_AUTH_TOKEN'];
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
  else process.env['AFFILIATE_MCP_CONFIG_DIR'] = originalConfigDir;
  if (originalCacheSetting === undefined) delete process.env['AFFILIATE_MCP_CACHE'];
  else process.env['AFFILIATE_MCP_CACHE'] = originalCacheSetting;
  if (originalImpactSid === undefined) delete process.env['IMPACT_ADVERTISER_ACCOUNT_SID'];
  else process.env['IMPACT_ADVERTISER_ACCOUNT_SID'] = originalImpactSid;
  if (originalImpactToken === undefined) delete process.env['IMPACT_ADVERTISER_AUTH_TOKEN'];
  else process.env['IMPACT_ADVERTISER_AUTH_TOKEN'] = originalImpactToken;
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
  it('always emits the meta tools', () => {
    const meta = generateMetaTools();
    const names = meta.map((t) => t.name).sort();
    expect(names).toEqual([
      'affiliate_get_client_strategy',
      'affiliate_list_actions',
      'affiliate_list_client_strategies',
      'affiliate_list_networks',
      'affiliate_resolve_brand',
      'affiliate_run_diagnostic',
      'affiliate_set_client_strategy',
    ]);
  });

  it('with no adapters registered, only meta tools are present', () => {
    const all = generateAllTools();
    expect(all.map((t) => t.name).sort()).toEqual([
      'affiliate_get_client_strategy',
      'affiliate_list_actions',
      'affiliate_list_client_strategies',
      'affiliate_list_networks',
      'affiliate_resolve_brand',
      'affiliate_run_diagnostic',
      'affiliate_set_client_strategy',
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

describe('affiliate_get_client_strategy meta-tool', () => {
  const get = () => generateMetaTools().find((t) => t.name === 'affiliate_get_client_strategy')!;
  const set = () => generateMetaTools().find((t) => t.name === 'affiliate_set_client_strategy')!;

  it('reports absent files without error', async () => {
    const result = (await get().handle({ brand: 'acme' })) as {
      brand: string;
      orphan: boolean;
      strategy: { present: boolean };
      kpi: { present: boolean; targets: unknown[]; parseErrors: unknown[] };
    };
    expect(result).toMatchObject({
      brand: 'acme',
      orphan: false,
      strategy: { present: false },
      kpi: { present: false, targets: [], parseErrors: [] },
    });
  });

  it('returns parsed targets after a valid write', async () => {
    await set().handle({
      brand: 'acme',
      strategyMarkdown: 'Premium partners preferred.',
      kpiMarkdown: '```kpi\nversion: 1\nrevenue: >= 400000 GBP per quarter\n```',
    });
    const result = (await get().handle({ brand: 'acme' })) as {
      strategy: { present: boolean; markdown?: string };
      kpi: {
        present: boolean;
        markdown?: string;
        version?: number;
        targets: unknown[];
        parseErrors: unknown[];
      };
    };
    expect(result.strategy.markdown).toMatch(/Premium partners/);
    expect(result.kpi).toMatchObject({ present: true, version: 1, parseErrors: [] });
    expect(result.kpi.markdown).toBeUndefined();
    expect(result.kpi.targets).toContainEqual({
      metric: 'revenue',
      comparator: '>=',
      value: 400000,
      unit: 'GBP',
      period: 'quarter',
    });
  });

  it('surfaces parse errors for an already-written malformed block', async () => {
    // A direct hand-edit could leave a malformed block on disk; the reader must
    // surface it rather than crash or guess.
    const { saveKpi } = await import('../../src/shared/client-strategy.js');
    saveKpi('acme', '```kpi\nrevenue: >= 100 GBP\n```'); // missing version
    const result = (await get().handle({ brand: 'acme' })) as {
      kpi: { parseErrors: Array<{ reason: string }> };
    };
    expect(result.kpi.parseErrors[0]?.reason).toMatch(/version: 1/);
  });
});

describe('affiliate_set_client_strategy meta-tool', () => {
  const set = () => generateMetaTools().find((t) => t.name === 'affiliate_set_client_strategy')!;

  it('writes both files and reports what was written', async () => {
    const result = (await set().handle({
      brand: 'acme',
      strategyMarkdown: 'Prose.',
      kpiMarkdown: '```kpi\nversion: 1\nconversions: >= 1200 per month\n```',
    })) as { written: boolean; wrote: { strategy: boolean; kpi: boolean } };
    expect(result).toMatchObject({ written: true, wrote: { strategy: true, kpi: true } });
    expect(existsSync(resolveStrategyFile('acme'))).toBe(true);
    expect(existsSync(resolveKpiFile('acme'))).toBe(true);
  });

  it('rejects a malformed KPI block without writing anything', async () => {
    const result = (await set().handle({
      brand: 'acme',
      kpiMarkdown: '```kpi\nversion: 1\nmargin: >= 20%\n```', // unknown metric
    })) as { written: boolean; parseErrors: Array<{ reason: string }> };
    expect(result.written).toBe(false);
    expect(result.parseErrors[0]?.reason).toMatch(/unknown metric "margin"/);
    expect(existsSync(resolveKpiFile('acme'))).toBe(false);
  });

  it('rejects malformed KPI before writing a paired strategy update', async () => {
    const result = (await set().handle({
      brand: 'acme',
      strategyMarkdown: 'Do not persist this when KPI is invalid.',
      kpiMarkdown: '```kpi\nversion: 1\nmargin: >= 20%\n```',
    })) as { written: boolean; parseErrors: Array<{ reason: string }> };
    expect(result.written).toBe(false);
    expect(result.parseErrors[0]?.reason).toMatch(/unknown metric "margin"/);
    expect(existsSync(resolveStrategyFile('acme'))).toBe(false);
    expect(existsSync(resolveKpiFile('acme'))).toBe(false);
  });

  it('rejects an invalid brand slug without writing', async () => {
    const result = (await set().handle({ brand: 'Bad Slug!', strategyMarkdown: 'x' })) as {
      written: boolean;
      reason: string;
    };
    expect(result.written).toBe(false);
    expect(result.reason).toMatch(/invalid brand slug/i);
  });

  it('requires at least one of strategyMarkdown or kpiMarkdown', async () => {
    await expect(set().handle({ brand: 'acme' })).rejects.toThrow();
  });
});

describe('affiliate_list_client_strategies meta-tool', () => {
  const list = () =>
    generateMetaTools().find((t) => t.name === 'affiliate_list_client_strategies')!;

  it('returns [] when nothing is registered or on disk', async () => {
    expect(await list().handle({})).toEqual([]);
  });

  it('flags a registered brand with no strategy recorded', async () => {
    saveBrands({
      version: 1,
      brands: {
        acme: [{ network: 'impact-advertiser', credentialId: 'default', networkBrandId: 'IA-1' }],
      },
    });
    const rows = (await list().handle({})) as Array<{
      slug: string;
      hasStrategy: boolean;
      registered: boolean;
    }>;
    expect(rows).toContainEqual(
      expect.objectContaining({ slug: 'acme', hasStrategy: false, registered: true }),
    );
  });
});

describe('affiliate_list_actions meta-tool', () => {
  type ActionRow = {
    descriptor: { id: string; network: string; channel: string; effect: string };
    readiness: string;
    credentials: Array<{ label: string; configured: boolean }>;
    liveHealthVia: string;
  };
  type Unsupported = { unsupportedScope: { dimension: string; value: string }; message: string };

  const find = () => generateMetaTools().find((t) => t.name === 'affiliate_list_actions')!;

  // The collector ties descriptors to registration; register the real Impact
  // adapter so its proposeContract descriptor is in scope. (Outer beforeEach
  // clears the registry first.)
  beforeEach(async () => {
    const { registerAdapter } = await import('../../src/shared/registry.js');
    const { impactAdvertiserAdapter } = await import(
      '../../src/networks/impact-advertiser/adapter.js'
    );
    registerAdapter(impactAdvertiserAdapter);
  });

  it('returns the advisement + two write entries, fail-closed to unknown with no brand', async () => {
    const rows = (await find().handle({})) as ActionRow[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.map((r) => r.descriptor.id)).toEqual([
      'impact-advertiser.proposeContract',
      'impact-advertiser.applyContract',
      'impact-advertiser.removeContract',
    ]);
    expect(rows.map((r) => r.descriptor.effect)).toEqual(['advisement', 'write', 'write']);
    // No brand filter → every entry is fail-closed unknown.
    expect(rows.every((r) => r.readiness === 'unknown')).toBe(true);
    expect(rows[0]!.liveHealthVia).toBe('affiliate_run_diagnostic');
  });

  it('reports missing credentials for a bound brand without exposing values', async () => {
    saveBrands({
      version: 1,
      brands: {
        acme: [{ network: 'impact-advertiser', credentialId: 'default', networkBrandId: 'IA-1' }],
      },
    });
    const rows = (await find().handle({ brand: 'acme' })) as ActionRow[];
    expect(rows[0]!.readiness).toBe('missing_credentials');
    expect(JSON.stringify(rows)).not.toContain('networkBrandId');
  });

  it('reports ready only when the brand is bound and both read credentials are present', async () => {
    process.env['IMPACT_ADVERTISER_ACCOUNT_SID'] = 'secret-sid';
    process.env['IMPACT_ADVERTISER_AUTH_TOKEN'] = 'secret-token';
    saveBrands({
      version: 1,
      brands: {
        acme: [{ network: 'impact-advertiser', credentialId: 'default', networkBrandId: 'IA-1' }],
      },
    });
    const rows = (await find().handle({ brand: 'acme' })) as ActionRow[];
    const byId = Object.fromEntries(rows.map((r) => [r.descriptor.id, r]));
    // proposeContract only needs the read creds → ready.
    expect(byId['impact-advertiser.proposeContract']!.readiness).toBe('ready');
    expect(byId['impact-advertiser.proposeContract']!.credentials.every((c) => c.configured)).toBe(
      true,
    );
    // The writes also need the opt-in IMPACT_ADV_WRITE_TOKEN (not set) → visible
    // but missing_credentials, so the operator sees the blast radius before opting in.
    expect(byId['impact-advertiser.applyContract']!.readiness).toBe('missing_credentials');
    expect(byId['impact-advertiser.removeContract']!.readiness).toBe('missing_credentials');
    expect(JSON.stringify(rows)).not.toContain('secret-sid');
    expect(JSON.stringify(rows)).not.toContain('secret-token');
  });

  it('returns an explicit unsupportedScope for an unknown network, not []', async () => {
    const r = (await find().handle({ network: 'does-not-exist' })) as Unsupported;
    expect(r.unsupportedScope).toEqual({ dimension: 'network', value: 'does-not-exist' });
    expect(Array.isArray(r)).toBe(false);
  });

  it('returns an explicit unsupportedScope for an unbound brand', async () => {
    const r = (await find().handle({ brand: 'ghost-brand' })) as Unsupported;
    expect(r.unsupportedScope).toEqual({ dimension: 'brand', value: 'ghost-brand' });
  });

  it('returns an explicit unsupportedScope for a stale brand binding', async () => {
    saveBrands({
      version: 1,
      brands: {
        stale: [{ network: 'not-registered', credentialId: 'default', networkBrandId: 'OLD-1' }],
      },
    });
    const r = (await find().handle({ brand: 'stale' })) as Unsupported;
    expect(r.unsupportedScope).toEqual({ dimension: 'brand', value: 'stale' });
    expect(r.message).toMatch(/no binding to a registered adapter/i);
  });

  it('returns an explicit unsupportedScope for a valid brand/network mismatch', async () => {
    saveBrands({
      version: 1,
      brands: {
        acme: [{ network: 'impact-advertiser', credentialId: 'default', networkBrandId: 'IA-1' }],
      },
    });
    const { registerAdapter } = await import('../../src/shared/registry.js');
    registerAdapter(fakeAdapter('quiet-network', 'Quiet Network'));
    const r = (await find().handle({ brand: 'acme', network: 'quiet-network' })) as Unsupported;
    expect(r.unsupportedScope).toEqual({
      dimension: 'brand_network',
      value: 'acme@quiet-network',
    });
  });

  it('returns [] when a valid brand scope has no declared actions', async () => {
    const { registerAdapter } = await import('../../src/shared/registry.js');
    registerAdapter(fakeAdapter('quiet-network', 'Quiet Network'));
    saveBrands({
      version: 1,
      brands: {
        quiet: [{ network: 'quiet-network', credentialId: 'default', networkBrandId: 'QN-1' }],
      },
    });
    expect(await find().handle({ brand: 'quiet' })).toEqual([]);
  });

  it('filters by effect and channel', async () => {
    const writes = (await find().handle({ effect: 'write' })) as ActionRow[];
    expect(writes.map((r) => r.descriptor.id).sort()).toEqual([
      'impact-advertiser.applyContract',
      'impact-advertiser.removeContract',
    ]);
    expect(await find().handle({ channel: 'browser' })).toEqual([]); // none declared
    const adv = (await find().handle({ effect: 'advisement' })) as ActionRow[];
    expect(adv).toHaveLength(1);
    expect(adv[0]!.descriptor.id).toBe('impact-advertiser.proposeContract');
  });

  it('is non-probing — issues no network call', async () => {
    const original = globalThis.fetch;
    const spy = vi.fn();
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      await find().handle({});
      await find().handle({ effect: 'advisement' });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });

  it('declares itself read-only to MCP hosts', () => {
    expect(find().annotations?.readOnlyHint).toBe(true);
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

  // The Anthropic API rejects any MCP tool whose name exceeds 64 characters,
  // and one over-length name makes a client discard the entire tool list. The
  // longest combo today is the commission-factory advertiser performance tool.
  it('never emits a tool name longer than 64 characters', () => {
    const a = fakeAdapter('commission-factory-advertiser', 'Commission Factory Advertiser');
    (a as { meta: { side: string; credentialScope: string } }).meta.side = 'advertiser';
    (a as { meta: { side: string; credentialScope: string } }).meta.credentialScope =
      'multi-brand';
    a.listBrands = async () => [];
    const tools = generateToolsFor(a);
    for (const t of tools) {
      expect(t.name.length, `${t.name} is ${t.name.length} chars`).toBeLessThanOrEqual(64);
    }
    // The overflowing name is shortened by abbreviating `-advertiser` → `-adv`.
    expect(tools.map((t) => t.name)).toContain(
      'affiliate_commission-factory-adv_get_programme_performance',
    );
    // Names that already fit keep the full `-advertiser` slug untouched.
    expect(tools.map((t) => t.name)).toContain(
      'affiliate_commission-factory-advertiser_generate_tracking_link',
    );
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

// ---------------------------------------------------------------------------
// Cache integration — the handler in generateToolsFor wraps adapter calls in
// withCache so repeat questions don't pay another round-trip. The top-level
// beforeEach already sets AFFILIATE_MCP_CONFIG_DIR to a tmp dir, so the cache
// for each test lands under its own isolated directory.
// ---------------------------------------------------------------------------

describe('tool handler cache integration', () => {
  function adapterWithSpy(slug: string, name: string, method: keyof NetworkAdapter, value: unknown) {
    const adapter = fakeAdapter(slug, name);
    const spy = vi.fn(async () => value);
    (adapter as unknown as Record<string, unknown>)[method] = spy;
    return { adapter, spy };
  }

  it('caches listProgrammes (24h TTL) — second call does not re-invoke', async () => {
    const { adapter, spy } = adapterWithSpy('demonet', 'DemoNet', 'listProgrammes', []);
    const tools = generateToolsFor(adapter);
    const tool = tools.find((t) => t.name === 'affiliate_demonet_list_programmes')!;
    await tool.handle({});
    await tool.handle({});
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache verifyAuth — every call invokes the adapter', async () => {
    const { adapter, spy } = adapterWithSpy('demonet', 'DemoNet', 'verifyAuth', { ok: true });
    const tool = generateToolsFor(adapter).find(
      (t) => t.name === 'affiliate_demonet_verify_auth',
    )!;
    await tool.handle({});
    await tool.handle({});
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does NOT cache listTransactions when the window includes now (no `to`)', async () => {
    const { adapter, spy } = adapterWithSpy('demonet', 'DemoNet', 'listTransactions', []);
    const tool = generateToolsFor(adapter).find(
      (t) => t.name === 'affiliate_demonet_list_transactions',
    )!;
    await tool.handle({ from: '2025-01-01' });
    await tool.handle({ from: '2025-01-01' });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('caches listTransactions for a closed past window', async () => {
    const { adapter, spy } = adapterWithSpy('demonet', 'DemoNet', 'listTransactions', []);
    const tool = generateToolsFor(adapter).find(
      (t) => t.name === 'affiliate_demonet_list_transactions',
    )!;
    // `to` well before now — pickTtl decides to cache for 30d.
    await tool.handle({ from: '2020-01-01', to: '2020-02-01' });
    await tool.handle({ from: '2020-01-01', to: '2020-02-01' });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache advertiser-side operations at v1', async () => {
    const adapter = fakeAdapter('imp-adv', 'Impact Advertiser');
    (adapter as { meta: { side: string; credentialScope: string } }).meta.side = 'advertiser';
    (adapter as { meta: { side: string; credentialScope: string } }).meta.credentialScope =
      'multi-brand';
    adapter.listBrands = async () => [];
    const spy = vi.fn(async () => []);
    adapter.listProgrammes = spy;
    saveBrands({
      version: 1,
      brands: {
        acme: [{ network: 'imp-adv', credentialId: 'default', networkBrandId: 'IA-1' }],
      },
    });
    const tool = generateToolsFor(adapter).find(
      (t) => t.name === 'affiliate_imp-adv_list_programmes',
    )!;
    await tool.handle({ brand: 'acme' });
    await tool.handle({ brand: 'acme' });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('rotating credentials invalidates the cache (different cred hash → different key)', async () => {
    process.env['DEMONET_TOKEN'] = 'first';
    try {
      const { adapter, spy } = adapterWithSpy('demonet', 'DemoNet', 'listProgrammes', []);
      const tool = generateToolsFor(adapter).find(
        (t) => t.name === 'affiliate_demonet_list_programmes',
      )!;
      await tool.handle({});
      process.env['DEMONET_TOKEN'] = 'second';
      await tool.handle({});
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      delete process.env['DEMONET_TOKEN'];
    }
  });
});
