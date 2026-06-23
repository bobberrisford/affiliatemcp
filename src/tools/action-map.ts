/**
 * Action capability map — collector.
 *
 * Assembles the declared action descriptors from registered adapters. This
 * lives in the tool layer (not src/shared/) because it must know about specific
 * networks; src/shared/action-map.ts stays network-neutral. The slug-branch
 * assembly mirrors `generateAllTools()`'s tool-pack wiring, so an adapter only
 * contributes descriptors when it is registered and has real entries.
 */

import { getAdapters } from '../shared/registry.js';
import type { ActionDescriptor } from '../shared/types.js';
import { impactAdvertiserActionDescriptors } from '../networks/impact-advertiser/adapter.js';
import { awinAdvertiserActionDescriptors } from '../networks/awin-advertiser/actions.js';

export function collectActionDescriptors(): ActionDescriptor[] {
  const out: ActionDescriptor[] = [];
  for (const adapter of getAdapters()) {
    if (adapter.slug === 'impact-advertiser') out.push(...impactAdvertiserActionDescriptors);
    if (adapter.slug === 'awin-advertiser') out.push(...awinAdvertiserActionDescriptors);
  }
  return out;
}
