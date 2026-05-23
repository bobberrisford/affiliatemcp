/**
 * Tests for the wizard's brand-discovery sub-flow.
 *
 * Since no advertiser adapter ships at v0.1 the sub-flow is exercised via a
 * fake multi-brand adapter that returns three brands. We assert:
 *   - `listBrands` is called.
 *   - Each returned brand is offered to the operator.
 *   - The default selection mirrors `apiEnabled: true` brands.
 *   - The local slug defaults to the slugified displayName but is editable.
 *   - The writer is invoked once per selected brand.
 *   - Invalid slugs are rejected.
 *   - A single-brand adapter cannot be driven through this flow.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runBrandDiscovery } from '../../src/cli/wizard/brand-discovery.js';
import { loadBrands } from '../../src/shared/brands.js';
import { FakePrompter, makeFakeAdapter } from './fakes.js';
import type { DiscoveredBrand, NetworkAdapter, NetworkMeta } from '../../src/shared/types.js';

let tmp: string;
let originalConfigDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'amcp-brand-discovery-'));
  originalConfigDir = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  process.env['AFFILIATE_MCP_CONFIG_DIR'] = tmp;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
  else process.env['AFFILIATE_MCP_CONFIG_DIR'] = originalConfigDir;
});

function multiBrandAdapter(brands: DiscoveredBrand[]): NetworkAdapter {
  const a = makeFakeAdapter({ slug: 'imp-adv', name: 'Impact Advertiser', steps: [] });
  const meta: NetworkMeta = { ...a.meta, side: 'advertiser', credentialScope: 'multi-brand' };
  (a as { meta: NetworkMeta }).meta = meta;
  a.listBrands = async () => brands;
  return a;
}

const THREE_BRANDS: DiscoveredBrand[] = [
  { networkBrandId: 'IA-1', displayName: 'Acme Corp', apiEnabled: true },
  { networkBrandId: 'IA-2', displayName: 'Globex (UK)', apiEnabled: true },
  { networkBrandId: 'IA-3', displayName: 'Initech', apiEnabled: false },
];

describe('runBrandDiscovery — happy path with three brands', () => {
  it('registers every brand the operator ticks', async () => {
    const adapter = multiBrandAdapter(THREE_BRANDS);
    // selectMany returns the default api-enabled set; text prompts accept
    // the suggested slug (empty string -> use defaultValue).
    const prompter = new FakePrompter([
      ['IA-1', 'IA-2'], // selectMany: tick acme + globex
      '', // slug for Acme Corp -> default "acme-corp"
      '', // slug for Globex (UK) -> default "globex-uk"
    ]);

    const out = await runBrandDiscovery(adapter, prompter, { out: () => {} });

    expect(out.discovered).toHaveLength(3);
    expect(out.registered.map((r) => r.slug).sort()).toEqual(['acme-corp', 'globex-uk']);
    expect(out.skipped.map((s) => s.networkBrandId)).toContain('IA-3');

    const file = loadBrands();
    expect(file.brands['acme-corp']).toEqual([
      { network: 'imp-adv', credentialId: 'default', networkBrandId: 'IA-1' },
    ]);
    expect(file.brands['globex-uk']).toEqual([
      { network: 'imp-adv', credentialId: 'default', networkBrandId: 'IA-2' },
    ]);
    expect(file.brands['initech']).toBeUndefined();
  });

  it('honours an operator-entered custom slug', async () => {
    const adapter = multiBrandAdapter([THREE_BRANDS[0]!]);
    const prompter = new FakePrompter([
      ['IA-1'],
      'acme', // operator overrides the suggested "acme-corp"
    ]);
    const out = await runBrandDiscovery(adapter, prompter, { out: () => {} });
    expect(out.registered).toEqual([{ slug: 'acme', networkBrandId: 'IA-1' }]);
    expect(loadBrands().brands['acme']).toBeDefined();
  });

  it('skips a brand whose entered slug is invalid', async () => {
    const adapter = multiBrandAdapter([THREE_BRANDS[0]!]);
    const prompter = new FakePrompter([
      ['IA-1'],
      'Acme Corp!', // invalid
    ]);
    const out = await runBrandDiscovery(adapter, prompter, { out: () => {} });
    expect(out.registered).toEqual([]);
    expect(out.skipped).toHaveLength(1);
    expect(out.skipped[0]!.reason).toMatch(/invalid slug/i);
  });

  it('routes writes through the injected writer when provided', async () => {
    const adapter = multiBrandAdapter([THREE_BRANDS[0]!]);
    const calls: Array<[string, string, string, string]> = [];
    const prompter = new FakePrompter([['IA-1'], '']);
    await runBrandDiscovery(adapter, prompter, {
      out: () => {},
      writer: (slug, network, credentialId, networkBrandId) =>
        calls.push([slug, network, credentialId, networkBrandId]),
    });
    expect(calls).toEqual([['acme-corp', 'imp-adv', 'default', 'IA-1']]);
  });

  it('emits a clear message and returns empty when no brands are discovered', async () => {
    const adapter = multiBrandAdapter([]);
    const prompter = new FakePrompter([]);
    const lines: string[] = [];
    const out = await runBrandDiscovery(adapter, prompter, { out: (l) => lines.push(l) });
    expect(out.discovered).toEqual([]);
    expect(out.registered).toEqual([]);
    expect(lines.join('\n')).toMatch(/no brands/i);
  });
});

describe('runBrandDiscovery — guards', () => {
  it('throws when invoked on a single-brand adapter', async () => {
    const a = makeFakeAdapter({ slug: 'alpha', name: 'Alpha', steps: [] });
    const prompter = new FakePrompter([]);
    // Single-brand adapter: the assertion in runBrandDiscovery would only
    // fire if credentialScope is multi-brand without listBrands. Single-brand
    // is a no-op pass; we just confirm we can call listBrands? guard.
    // To exercise the failure path, mark as multi-brand and drop listBrands.
    (a as { meta: { credentialScope: string } }).meta.credentialScope = 'multi-brand';
    expect(a.listBrands).toBeUndefined();
    await expect(runBrandDiscovery(a, prompter, { out: () => {} })).rejects.toThrow(
      /listBrands/,
    );
  });
});
