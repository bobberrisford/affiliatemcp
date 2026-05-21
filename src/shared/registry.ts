/**
 * Adapter registry.
 *
 * Adapters register themselves at module load (`registerAdapter(new MyAdapter())`).
 * The MCP server and CLI consume adapters only via this module. At v0.1 nothing
 * is registered here — chunks 2/3/5/6 add Awin, CJ, Impact, Rakuten.
 */

import type { NetworkAdapter, NetworkSlug } from './types.js';

const adapters = new Map<NetworkSlug, NetworkAdapter>();

export function registerAdapter(adapter: NetworkAdapter): void {
  if (adapters.has(adapter.slug)) {
    throw new Error(`Adapter for network "${adapter.slug}" is already registered.`);
  }
  adapters.set(adapter.slug, adapter);
}

export function getAdapter(slug: NetworkSlug): NetworkAdapter | undefined {
  return adapters.get(slug);
}

export function getAdapters(): NetworkAdapter[] {
  return [...adapters.values()];
}

/** Test-only: remove all registered adapters. */
export function _clearRegistry(): void {
  adapters.clear();
}
