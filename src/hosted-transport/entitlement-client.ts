/**
 * Subscription-state client for the hosted MCP transport (workstream slice
 * H6: `docs/product/hosted-mvp-workstream.md`).
 *
 * Reads one caller's billing tier from the hosted Worker's
 * `GET /billing/entitlement` (`hosted/src/routes/billing.ts`), reusing the
 * caller's OWN session bearer token — the identical pattern
 * `session-auth.ts` and `vault-client.ts` already established for this
 * transport: never a service credential, never a call that could resolve a
 * different user's state.
 */

const VALID_TIERS = new Set(['none', 'free', 'solo', 'pro']);

export type HostedTier = 'none' | 'free' | 'solo' | 'pro';

export interface HostedEntitlement {
  tier: HostedTier;
  status: string;
}

/** Thrown when the hosted Worker's billing surface cannot be reached or returns something other
 * than a clean entitlement body — distinct from "tier is none" so a billing-service outage is
 * never mistaken for "this caller is not subscribed". Mirrors `VaultUnavailableError` and
 * `HostedAuthUnavailableError`'s existing shape in this same module family. */
export class HostedEntitlementUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostedEntitlementUnavailableError';
  }
}

/**
 * Fetch the caller's hosted billing entitlement. `authUrl` is the same base
 * URL used for session verification — `/billing/entitlement` lives on the
 * same hosted Worker as `/auth/session/verify`.
 */
export async function fetchHostedEntitlement(bearerToken: string, authUrl: string): Promise<HostedEntitlement> {
  let res: Response;
  try {
    res = await fetch(`${authUrl}/billing/entitlement`, {
      method: 'GET',
      headers: { authorization: `Bearer ${bearerToken}` },
    });
  } catch (err) {
    throw new HostedEntitlementUnavailableError(`could not reach the hosted billing service: ${(err as Error).message}`);
  }

  if (res.status === 401) {
    // The transport already verified this same token moments earlier
    // (`verifySessionRemote`); a 401 here means it expired in the brief
    // window between the two calls, or the two services disagree — the same
    // reasoning `vault-client.ts` applies to its own 401 case. Surfacing
    // this as "unavailable" rather than silently treating the caller as
    // unentitled keeps the failure honest.
    throw new HostedEntitlementUnavailableError('the hosted billing service rejected the session token used to reach it');
  }
  if (!res.ok) {
    throw new HostedEntitlementUnavailableError(`the hosted billing service returned HTTP ${res.status}`);
  }

  const body = (await res.json()) as { tier?: unknown; status?: unknown };
  if (typeof body.tier !== 'string' || !VALID_TIERS.has(body.tier) || typeof body.status !== 'string') {
    throw new HostedEntitlementUnavailableError('the hosted billing service returned a malformed entitlement body');
  }
  return { tier: body.tier as HostedTier, status: body.status };
}
