/**
 * Pure/testable helpers for the H6 billing-tier gate at the hosted MCP
 * transport's dispatch point (`mcp-server.ts`). Mirrors the shape of
 * `dispatch.ts`'s existing hosted-only decisions (credential overlay, rate
 * limit) and the brand-data entitlement gate's honest refusal shape
 * (`src/brand-data/entitlement.ts`), extended for the three hosted tiers
 * instead of a single free/paid flag.
 *
 * Per `docs/decisions/2026-07-12-pricing-billing-and-licence.md` and the
 * freemium amendment `docs/decisions/2026-07-18-hosted-freemium-metered-tier.md`:
 *   - `none`  — not a valid hosted session. Refused. In practice unreachable
 *     from the resolved entitlement (the hosted Worker's `resolveEntitlement`
 *     returns `free`, never `none`, for any authenticated caller); kept as a
 *     defensive refusal only.
 *   - `free`  — the metered free tier. `checkTierEntitlement` lets it proceed;
 *     the per-window meter (`meter-client.ts`, consulted in `mcp-server.ts`)
 *     is what bounds it, returning `free_quota_exceeded` when the rolling
 *     weekly allowance is spent.
 *   - `solo`  — hosted access capped at 5 distinct connected networks; no
 *     Pro-only scheduled features (today, no interactive tool is Pro-only —
 *     the digest job itself enforces the Solo/Pro split on which digest
 *     TYPES it composes and sends; see `src/hosted-digest/` and
 *     `hosted/src/routes/digest.ts`).
 *   - `pro`   — every hosted-eligible network, uncapped.
 */

import type { NetworkSlug } from '../shared/types.js';
import { META_NETWORK } from './dispatch.js';
import type { HostedTier } from './entitlement-client.js';

export type { HostedTier };

/** Solo tier's distinct-network cap, per the pricing decision ("up to 5 networks"). */
export const SOLO_NETWORK_CAP = 5;

/** The structured result returned when a hosted tool call is refused for a billing reason.
 * Deliberately NOT a `NetworkErrorEnvelope` — `NetworkErrorEnvelope.type` is a closed enum with
 * no billing-refusal member, and a billing refusal is not a network failure. Mirrors
 * `EntitlementRequired` (`src/brand-data/entitlement.ts`) in shape and in being returned as
 * plain tool-result JSON with `isError: true`, not thrown. */
export interface HostedTierRefusal {
  error: 'entitlement_required' | 'network_cap_exceeded' | 'free_quota_exceeded';
  entitled: false;
  tier: HostedTier;
  message: string;
  upgradeHint: string;
}

function buildRefusal(args: Pick<HostedTierRefusal, 'error' | 'tier' | 'message' | 'upgradeHint'>): HostedTierRefusal {
  return { ...args, entitled: false };
}

/**
 * The first, cheapest check: does this caller have ANY hosted tier at all?
 * Runs before the per-user rate limit and before any vault call, so an
 * unsubscribed caller never causes a vault round-trip. Returns `undefined`
 * (proceed) for `solo` and `pro`; a refusal for `none`.
 */
export function checkTierEntitlement(tier: HostedTier): HostedTierRefusal | undefined {
  if (tier !== 'none') return undefined;
  return buildRefusal({
    error: 'entitlement_required',
    tier,
    message: 'This request has no valid hosted session.',
    upgradeHint: 'Sign in to the hosted dashboard, then add the connector to your MCP client.',
  });
}

/**
 * The free-tier meter refusal, returned when a `free` caller has spent their
 * rolling weekly report allowance (`meter-client.ts` reports `allowed: false`).
 * Structured exactly like the other tier refusals — plain tool-result JSON with
 * `isError: true`, never a thrown transport error — so a client can render it
 * as an upgrade prompt. `resetAt` (unix ms, when the oldest window ages out) is
 * folded into the human message when known; the meter, not this builder, owns
 * the counting.
 */
export function buildFreeQuotaRefusal(resetAt: number | null): HostedTierRefusal {
  const resetSentence =
    resetAt !== null
      ? ` Your next free report is available on ${new Date(resetAt).toISOString().slice(0, 10)}.`
      : '';
  return buildRefusal({
    error: 'free_quota_exceeded',
    tier: 'free',
    message: `You have used all of this week's free reports on the hosted connector.${resetSentence}`,
    upgradeHint:
      'Subscribe to Solo (£34/mo: no weekly cap, up to 5 networks, weekly earnings digest) or Pro ' +
      '(£99/mo: all networks, anomaly watch, unpaid-commission digest, report actions, CSV export) ' +
      'to run reports without the free-tier limit. Manage your plan on the hosted billing page.',
  });
}

/**
 * The Solo-tier network cap. `connectedNetworks` is the caller's full set of
 * already-connected networks (from `listConnectedNetworks`); `network` is
 * the network this specific tool call targets. Allowed when: the tier is
 * `pro` (uncapped); the tool is a meta tool (no network to cap); the target
 * network is already among the connected set (using an existing connection
 * never counts against the cap); or the connected count is still under
 * `SOLO_NETWORK_CAP`. Refused only when a Solo caller's connected set is
 * already at the cap AND the target network is a NEW one outside it.
 */
export function checkNetworkCap(
  tier: HostedTier,
  network: NetworkSlug,
  connectedNetworks: readonly string[],
): HostedTierRefusal | undefined {
  if (tier !== 'solo') return undefined;
  if (network === META_NETWORK) return undefined;
  if (connectedNetworks.includes(network)) return undefined;
  if (connectedNetworks.length < SOLO_NETWORK_CAP) return undefined;

  return buildRefusal({
    error: 'network_cap_exceeded',
    tier,
    message: `The Solo tier is capped at ${SOLO_NETWORK_CAP} connected networks; this account already has ${connectedNetworks.length} connected and "${network}" is not one of them.`,
    upgradeHint: 'Disconnect an existing network to make room, or upgrade to Pro for every hosted-eligible network.',
  });
}
