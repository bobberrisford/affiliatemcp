import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _clearRegistry } from '../../src/shared/registry.js';
import { generateMetaTools } from '../../src/tools/generate.js';
import { saveSnapshot } from '../../src/brand-data/store.js';
import type { BrandSnapshot } from '../../src/brand-data/model.js';

let configDir: string;
let original: string | undefined;

const snapshot: BrandSnapshot = {
  schemaVersion: 1,
  brandId: 'acme',
  generatedAt: '2026-06-30T12:00:00Z',
  timezone: 'Europe/London',
  windows: {} as BrandSnapshot['windows'],
  byNetwork: [{ network: 'awin-advertiser', state: 'ok' }],
  rowsTruncated: false,
};

const tool = () => generateMetaTools().find((t) => t.name === 'affiliate_get_brand_action_bundle')!;

function bindBrand(brand: string, networks: string[]): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    path.join(configDir, 'brands.json'),
    JSON.stringify({
      version: 1,
      brands: { [brand]: networks.map((network) => ({ network, credentialId: 'default', networkBrandId: 'B1' })) },
    }),
  );
}

beforeEach(() => {
  original = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  configDir = mkdtempSync(path.join(tmpdir(), 'bd-bundle-'));
  process.env['AFFILIATE_MCP_CONFIG_DIR'] = configDir;
  _clearRegistry();
});
afterEach(() => {
  if (original === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
  else process.env['AFFILIATE_MCP_CONFIG_DIR'] = original;
  rmSync(configDir, { recursive: true, force: true });
  _clearRegistry();
});

describe('affiliate_get_brand_action_bundle', () => {
  it('assembles snapshot, strategy, actions, and entitlement — never raw rows', async () => {
    bindBrand('acme', ['awin-advertiser']);
    saveSnapshot('acme', snapshot);

    const bundle = (await tool().handle({ brand: 'acme' })) as {
      brand: string;
      snapshotPresent: boolean;
      snapshot: BrandSnapshot;
      strategy: { brand: string };
      actions: unknown[];
      entitlement: { entitled: boolean };
      rows?: unknown;
    };

    expect(bundle.brand).toBe('acme');
    expect(bundle.snapshotPresent).toBe(true);
    expect(bundle.snapshot).toEqual(snapshot);
    expect(bundle.strategy.brand).toBe('acme');
    expect(Array.isArray(bundle.actions)).toBe(true);
    expect(bundle.entitlement).toHaveProperty('entitled');
    // Never carries the raw 30-day rows.
    expect(bundle).not.toHaveProperty('rows');
  });

  it('reports snapshotPresent=false when no snapshot has been built', async () => {
    bindBrand('acme', ['awin-advertiser']);
    const bundle = (await tool().handle({ brand: 'acme' })) as {
      snapshotPresent: boolean;
      snapshot: unknown;
    };
    expect(bundle.snapshotPresent).toBe(false);
    expect(bundle.snapshot).toBeNull();
  });
});
