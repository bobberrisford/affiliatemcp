import { beforeEach, describe, expect, it } from 'vitest';
import {
  generateAllTools,
  generateMetaTools,
  generateToolsFor,
} from '../../src/tools/generate.js';
import { _clearRegistry } from '../../src/shared/registry.js';
import type { NetworkAdapter } from '../../src/shared/types.js';

beforeEach(() => _clearRegistry());

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
  it('always emits the two meta tools', () => {
    const meta = generateMetaTools();
    const names = meta.map((t) => t.name).sort();
    expect(names).toEqual(['affiliate_list_networks', 'affiliate_run_diagnostic']);
  });

  it('with no adapters registered, only meta tools are present', () => {
    const all = generateAllTools();
    expect(all.map((t) => t.name).sort()).toEqual([
      'affiliate_list_networks',
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
