/**
 * Brand-resolution layer.
 *
 * Sits between MCP tool dispatch and adapter calls for advertiser-side tools.
 * Advertiser-side tools take an explicit `brand` argument (a logical brand
 * slug owned by the operator, e.g. `acme`); the resolver translates that
 * `(brand, network)` pair into a `networkBrandId` via `brands.json` and hands
 * the result to the adapter call.
 *
 * Publisher-side tools do not pass through this layer — they continue to read
 * credentials from the env file and address a single publisher account.
 *
 * Registry note: a multi-brand adapter (i.e. `meta.credentialScope === 'multi-brand'`)
 * is required at runtime to implement `listBrands()`. `assertMultiBrandAdapter`
 * enforces that contract; the wizard's brand-discovery sub-flow and any future
 * registry guard call into it.
 */

import { resolveBrand } from './brands.js';
import { BrandNotRegistered } from './errors.js';
import type { NetworkAdapter, NetworkSlug } from './types.js';

export interface ResolvedBrand {
  /** The logical brand slug the caller asked about (echoed for logging). */
  brand: string;
  /** The network slug the brand was resolved against (echoed for logging). */
  network: NetworkSlug;
  /** The credential set id stored in `brands.json` for this binding. */
  credentialId: string;
  /** The network's own brand id (e.g. Impact `CampaignId`). */
  networkBrandId: string;
}

/**
 * Resolve `(brand, network)` to a concrete `(credentialId, networkBrandId)`.
 * Throws `BrandNotRegistered` if the brand has not been bound to that network
 * in `brands.json`. Pure function — reads the file once via `resolveBrand`.
 */
export function resolveBrandForNetwork(
  brand: string,
  network: NetworkSlug,
): ResolvedBrand {
  if (!brand || typeof brand !== 'string') {
    // Tool schemas mark `brand` as required; defensive coverage in case a
    // future caller bypasses Zod validation.
    throw new BrandNotRegistered(String(brand ?? ''), network);
  }
  const binding = resolveBrand(brand, network);
  if (!binding) {
    throw new BrandNotRegistered(brand, network);
  }
  return {
    brand,
    network,
    credentialId: binding.credentialId,
    networkBrandId: binding.networkBrandId,
  };
}

/**
 * Runtime guard: a multi-brand adapter must implement `listBrands`. We assert
 * this at the boundary where the wizard would actually call it, so a missing
 * implementation surfaces with a clear, actionable error rather than a
 * `TypeError: adapter.listBrands is not a function` deep inside the wizard.
 */
export function assertMultiBrandAdapter(adapter: NetworkAdapter): void {
  if (adapter.meta.credentialScope !== 'multi-brand') return;
  if (typeof adapter.listBrands !== 'function') {
    throw new Error(
      `Adapter "${adapter.slug}" declares credentialScope: 'multi-brand' but does not implement listBrands(). ` +
        `Multi-brand adapters are required to expose listBrands() so the setup wizard can discover ` +
        `which brands a credential set addresses. See src/shared/types.ts NetworkAdapter.`,
    );
  }
}
