/**
 * Brand-store interface (hosted workstream H1,
 * `docs/product/hosted-mvp-workstream.md`).
 *
 * Extracts the operations `src/shared/brands.ts` already exposes into an
 * interface, and binds the existing file-backed functions as the default
 * implementation (`localFileBrandStore`). Behaviour is unchanged: nothing in
 * `brands.ts` is modified, and `getActiveBrandStore()` returns
 * `localFileBrandStore` whenever no request context supplies an override,
 * which is every call today.
 *
 * A hosted per-tenant `BrandStore` (backed by the H3 encrypted vault rather
 * than `brands.json`) is out of scope for this slice; this file only defines
 * the seam so H3 has an interface to implement against.
 */

import {
  listBrandsForNetwork,
  loadBrands,
  registerBrand,
  resolveBrand,
  saveBrands,
} from './brands.js';
import { getRequestContext } from './request-context.js';
import type { BrandsFile, NetworkSlug } from './types.js';

export interface BrandStore {
  load(): BrandsFile;
  save(file: BrandsFile): void;
  resolve(
    brandSlug: string,
    network: NetworkSlug,
  ): { credentialId: string; networkBrandId: string } | null;
  listForNetwork(
    network: NetworkSlug,
  ): Array<{ slug: string; credentialId: string; networkBrandId: string }>;
  register(slug: string, network: NetworkSlug, credentialId: string, networkBrandId: string): void;
}

/** The current, and only, implementation: `brands.json` on the local filesystem. */
export const localFileBrandStore: BrandStore = {
  load: loadBrands,
  save: saveBrands,
  resolve: resolveBrand,
  listForNetwork: listBrandsForNetwork,
  register: registerBrand,
};

/**
 * The store to use for the active request. Falls back to
 * `localFileBrandStore` when no request context is active, or the active
 * context does not override it — the local path today.
 */
export function getActiveBrandStore(): BrandStore {
  return getRequestContext()?.brandStore ?? localFileBrandStore;
}
