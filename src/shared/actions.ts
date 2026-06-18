/**
 * Action capability map — assembly.
 *
 * See docs/decisions/2026-06-18-action-capability-map.md. Assembles the
 * channel-aware inventory of what registered adapters can DO from the adapter
 * set. This is the doing-layer analogue of `affiliate_list_networks`: the
 * readable answer to "what can I do here, and what will it cost me in
 * approvals?".
 *
 * This module is descriptive only. It computes no network state and drives no
 * write; it reports what is possible and how each action is gated.
 *
 * At this stage it declares only the seven existing canonical reads (Tier 0,
 * `api`/`read`). Adapters begin declaring their own actions (advisement, write,
 * and browser-channel) in the per-adapter rollout that follows; until then the
 * map is complete-but-reads-only, not "writes hidden".
 */

import type { ActionDescriptor, ActionMapEntry, NetworkAdapter } from './types.js';
import { getAdapters } from './registry.js';

/**
 * The seven canonical, provider-neutral read operations every adapter
 * implements. Registered as `channel: 'api'`, `effect: 'read'`,
 * `defaultTier: 0` so the map is complete rather than writes-only, with no
 * behaviour change. Advertiser-only reads (`listMediaPartners`,
 * `getProgrammePerformance`) are intentionally excluded here: a publisher
 * adapter does not implement them, so declaring them for every network would
 * invent capability. They join the map when an advertiser adapter declares
 * them in the rollout.
 *
 * `action` reuses the canonical `AdapterOperation` vocabulary so the policy
 * artefact, audit log, and host annotations bind to one identifier.
 */
export const CANONICAL_READ_ACTIONS: readonly ActionDescriptor[] = [
  {
    action: 'listProgrammes',
    channel: 'api',
    effect: 'read',
    defaultTier: 0,
    description: 'List affiliate programmes joined (or available to join) on the network.',
  },
  {
    action: 'getProgramme',
    channel: 'api',
    effect: 'read',
    defaultTier: 0,
    description: 'Fetch a single programme on the network by its programme id.',
  },
  {
    action: 'listTransactions',
    channel: 'api',
    effect: 'read',
    defaultTier: 0,
    description: 'List transactions on the network within a date and status window.',
  },
  {
    action: 'getEarningsSummary',
    channel: 'api',
    effect: 'read',
    defaultTier: 0,
    description: 'Summarise earnings on the network by programme and by status.',
  },
  {
    action: 'listClicks',
    channel: 'api',
    effect: 'read',
    defaultTier: 0,
    description: 'List click events on the network within a date window.',
  },
  {
    action: 'generateTrackingLink',
    channel: 'api',
    effect: 'read',
    defaultTier: 0,
    description: 'Build a tracking link for a programme and destination URL on the network.',
  },
  {
    action: 'verifyAuth',
    channel: 'api',
    effect: 'read',
    defaultTier: 0,
    description: 'Verify that the configured credentials authenticate against the network.',
  },
] as const;

/**
 * Assemble the action capability map across the given adapters (defaults to the
 * registered set). Each adapter contributes the seven canonical reads, bound to
 * its slug. Reads are `available` wherever the adapter is registered: they
 * require only the network's normal credential, which is the precondition for
 * registration. Future write and advisement actions will carry their own
 * availability (e.g. an opt-in write token), computed here when adapters
 * declare them.
 *
 * Optionally scope to a single network slug.
 */
export function assembleActionMap(
  adapters: NetworkAdapter[] = getAdapters(),
  opts: { network?: string } = {},
): ActionMapEntry[] {
  const scoped = opts.network
    ? adapters.filter((a) => a.slug === opts.network)
    : adapters;

  return scoped.flatMap((adapter) =>
    CANONICAL_READ_ACTIONS.map((descriptor) => ({
      ...descriptor,
      network: adapter.slug,
      available: true,
    })),
  );
}
