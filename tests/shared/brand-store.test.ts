/**
 * Brand-store interface (hosted workstream H1).
 *
 * Covers:
 *   - `localFileBrandStore` has parity with calling `brands.ts` directly
 *     (same file, same answers);
 *   - `getActiveBrandStore()` returns the local file store when no request
 *     context is active, or the active context does not override it;
 *   - a request-context override is honoured, and does not touch the local
 *     file at all.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { loadBrands, registerBrand, resolveBrand } from '../../src/shared/brands.js';
import { getActiveBrandStore, localFileBrandStore, type BrandStore } from '../../src/shared/brand-store.js';
import { runInRequestContext } from '../../src/shared/request-context.js';
import type { BrandsFile, NetworkSlug } from '../../src/shared/types.js';

let tmp: string;
let originalConfigDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'amcp-brand-store-'));
  originalConfigDir = process.env['AFFILIATE_MCP_CONFIG_DIR'];
  process.env['AFFILIATE_MCP_CONFIG_DIR'] = tmp;
});

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env['AFFILIATE_MCP_CONFIG_DIR'];
  else process.env['AFFILIATE_MCP_CONFIG_DIR'] = originalConfigDir;
});

describe('localFileBrandStore — parity with brands.ts', () => {
  it('register + resolve through the store matches calling brands.ts directly', () => {
    localFileBrandStore.register('acme', 'awin', 'default', 'AW-1');
    expect(localFileBrandStore.resolve('acme', 'awin')).toEqual(resolveBrand('acme', 'awin'));
    expect(localFileBrandStore.load()).toEqual(loadBrands());
  });

  it('listForNetwork through the store matches the direct function', () => {
    registerBrand('acme', 'cj', 'default', 'CJ-1');
    registerBrand('other', 'cj', 'default', 'CJ-2');
    expect(localFileBrandStore.listForNetwork('cj')).toEqual([
      { slug: 'acme', credentialId: 'default', networkBrandId: 'CJ-1' },
      { slug: 'other', credentialId: 'default', networkBrandId: 'CJ-2' },
    ]);
  });

  it('save through the store writes the same file save() would', () => {
    const file: BrandsFile = {
      version: 1,
      brands: { acme: [{ network: 'impact', credentialId: 'default', networkBrandId: 'IM-1' }] },
    };
    localFileBrandStore.save(file);
    expect(loadBrands()).toEqual(file);
  });
});

describe('getActiveBrandStore()', () => {
  it('returns the local file store when no request context is active', () => {
    expect(getActiveBrandStore()).toBe(localFileBrandStore);
  });

  it('returns the local file store when the active context does not override it', () => {
    const store = runInRequestContext({ identity: 'tenant-a' }, () => getActiveBrandStore());
    expect(store).toBe(localFileBrandStore);
  });

  it('returns a request-context override in place of the local file store', () => {
    const calls: string[] = [];
    const fakeStore: BrandStore = {
      load: () => ({ version: 1, brands: {} }),
      save: () => calls.push('save'),
      resolve: (slug: string, network: NetworkSlug) => {
        calls.push(`resolve:${slug}:${network}`);
        return { credentialId: 'vault', networkBrandId: 'V-1' };
      },
      listForNetwork: () => [],
      register: () => calls.push('register'),
    };

    const result = runInRequestContext({ identity: 'tenant-a', brandStore: fakeStore }, () =>
      getActiveBrandStore().resolve('acme', 'awin'),
    );

    expect(result).toEqual({ credentialId: 'vault', networkBrandId: 'V-1' });
    expect(calls).toEqual(['resolve:acme:awin']);
    // The override never touched brands.json.
    expect(loadBrands()).toEqual({ version: 1, brands: {} });
  });
});
