/**
 * Tests for the brand-resolution layer.
 *
 * Pure function tests — the resolver reads brands.json via `resolveBrand` and
 * throws `BrandNotRegistered` on every miss. The `assertMultiBrandAdapter`
 * guard enforces the runtime contract for adapters whose credentialScope is
 * 'multi-brand'.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { saveBrands } from '../../src/shared/brands.js';
import {
  assertMultiBrandAdapter,
  resolveBrandForNetwork,
} from '../../src/shared/brand-resolver.js';
import { BrandNotRegistered } from '../../src/shared/errors.js';
import type { NetworkAdapter, NetworkMeta } from '../../src/shared/types.js';

let tmp: string;
let originalConfigDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'amcp-brand-resolver-'));
  originalConfigDir = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  process.env['AFFILIATE_MCP_CONFIG_DIR'] = tmp;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
  else process.env['AFFILIATE_MCP_CONFIG_DIR'] = originalConfigDir;
});

function fakeAdapter(meta: Partial<NetworkMeta>, withListBrands: boolean): NetworkAdapter {
  const fullMeta: NetworkMeta = {
    slug: meta.slug ?? 'fake',
    name: meta.name ?? 'Fake',
    baseUrl: 'https://api.fake.example',
    authModel: 'bearer',
    adapterVersion: '0.0.0',
    claimStatus: 'experimental',
    knownLimitations: [],
    supportsBrandOps: false,
    setupTimeEstimateMinutes: 1,
    setupRequiresApproval: false,
    side: meta.side ?? 'publisher',
    credentialScope: meta.credentialScope ?? 'single-brand',
  };
  const stub = async (): Promise<never> => {
    throw new Error('not called in this test');
  };
  const base: NetworkAdapter = {
    slug: fullMeta.slug,
    name: fullMeta.name,
    meta: fullMeta,
    resilienceConfig: {
      default: {
        timeoutMs: 1000,
        retries: 0,
        retryOn: [],
        circuitBreaker: { threshold: 1, cooldownMs: 1 },
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
  if (withListBrands) {
    base.listBrands = async () => [];
  }
  return base;
}

describe('resolveBrandForNetwork', () => {
  it('returns the binding when the brand is registered', () => {
    saveBrands({
      version: 1,
      brands: {
        acme: [{ network: 'impact-advertiser', credentialId: 'default', networkBrandId: 'IA-1' }],
      },
    });
    const r = resolveBrandForNetwork('acme', 'impact-advertiser');
    expect(r).toEqual({
      brand: 'acme',
      network: 'impact-advertiser',
      credentialId: 'default',
      networkBrandId: 'IA-1',
    });
  });

  it('throws BrandNotRegistered when the brand is unknown', () => {
    expect(() => resolveBrandForNetwork('unknown', 'impact-advertiser')).toThrow(
      BrandNotRegistered,
    );
  });

  it('throws BrandNotRegistered when the brand exists for a different network', () => {
    saveBrands({
      version: 1,
      brands: {
        acme: [{ network: 'impact-advertiser', credentialId: 'default', networkBrandId: 'IA-1' }],
      },
    });
    expect(() => resolveBrandForNetwork('acme', 'cj-advertiser')).toThrow(BrandNotRegistered);
  });

  it('throws BrandNotRegistered with the brand and network attached', () => {
    try {
      resolveBrandForNetwork('acme', 'impact-advertiser');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(BrandNotRegistered);
      const e = err as BrandNotRegistered;
      expect(e.brand).toBe('acme');
      expect(e.network).toBe('impact-advertiser');
      expect(e.message).toContain('acme');
      expect(e.message).toContain('impact-advertiser');
    }
  });

  it('throws BrandNotRegistered when called with an empty brand', () => {
    expect(() => resolveBrandForNetwork('', 'impact-advertiser')).toThrow(BrandNotRegistered);
  });
});

describe('assertMultiBrandAdapter', () => {
  it('is a no-op for single-brand adapters', () => {
    const a = fakeAdapter({ side: 'publisher', credentialScope: 'single-brand' }, false);
    expect(() => assertMultiBrandAdapter(a)).not.toThrow();
  });

  it('passes for multi-brand adapters that implement listBrands', () => {
    const a = fakeAdapter({ side: 'advertiser', credentialScope: 'multi-brand' }, true);
    expect(() => assertMultiBrandAdapter(a)).not.toThrow();
  });

  it('throws when a multi-brand adapter omits listBrands', () => {
    const a = fakeAdapter({ side: 'advertiser', credentialScope: 'multi-brand' }, false);
    expect(() => assertMultiBrandAdapter(a)).toThrow(/listBrands/);
  });
});
