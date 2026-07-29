/**
 * Free-tier meter client for the hosted MCP transport
 * (`docs/decisions/2026-07-18-hosted-freemium-metered-tier.md`).
 *
 * Consumes one free-tier report window from the hosted Worker's
 * `POST /billing/meter` (`hosted/src/routes/billing.ts`, backed by
 * `hosted/src/meter.ts`), reusing the caller's OWN session bearer token — the
 * identical pattern `entitlement-client.ts` and `vault-client.ts` already
 * established for this transport: never a service credential, never a call that
 * could resolve or consume a different user's meter.
 *
 * Called only for a `free`-tier caller (`mcp-server.ts` gates on the resolved
 * tier); a paid caller is never metered, so this endpoint is never hit for
 * them. The durable, per-user rolling-window counting all lives in the Worker;
 * this client only relays the decision.
 */

/** The meter's decision for one free-tier tool call. Shape mirrors
 * `MeterDecision` in `hosted/src/meter.ts`; kept as its own local type so the
 * transport does not import across the workspace boundary into the Worker. */
export interface MeterDecision {
  allowed: boolean;
  remaining: number;
  resetAt: number | null;
}

/** Thrown when the hosted Worker's meter surface cannot be reached or returns something other
 * than a clean decision body — distinct from `allowed: false` so a meter-service outage is never
 * mistaken for "this caller is out of free reports". Mirrors `HostedEntitlementUnavailableError`
 * and `VaultUnavailableError` in this same module family. */
export class MeterUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeterUnavailableError';
  }
}

/**
 * Consume one free-tier report window for the caller. `authUrl` is the same
 * base URL used for session verification and entitlement reads —
 * `/billing/meter` lives on the same hosted Worker.
 */
export async function consumeFreeWindow(bearerToken: string, authUrl: string): Promise<MeterDecision> {
  let res: Response;
  try {
    res = await fetch(`${authUrl}/billing/meter`, {
      method: 'POST',
      headers: { authorization: `Bearer ${bearerToken}` },
    });
  } catch (err) {
    throw new MeterUnavailableError(`could not reach the hosted meter service: ${(err as Error).message}`);
  }

  if (res.status === 401) {
    // The transport already verified this same token moments earlier; a 401
    // here means it expired in the brief window between calls, or the two
    // services disagree — the same reasoning `entitlement-client.ts` applies.
    // Surfacing "unavailable" rather than silently treating the caller as out
    // of free reports keeps the failure honest.
    throw new MeterUnavailableError('the hosted meter service rejected the session token used to reach it');
  }
  if (!res.ok) {
    throw new MeterUnavailableError(`the hosted meter service returned HTTP ${res.status}`);
  }

  const body = (await res.json()) as { allowed?: unknown; remaining?: unknown; resetAt?: unknown };
  if (
    typeof body.allowed !== 'boolean' ||
    typeof body.remaining !== 'number' ||
    (body.resetAt !== null && typeof body.resetAt !== 'number')
  ) {
    throw new MeterUnavailableError('the hosted meter service returned a malformed decision body');
  }
  return { allowed: body.allowed, remaining: body.remaining, resetAt: body.resetAt };
}
