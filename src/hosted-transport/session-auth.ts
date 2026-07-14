/**
 * Session verification for the hosted MCP transport (H4).
 *
 * Design choice, recorded here because the workstream brief asked for it:
 * this calls the hosted Worker's `POST /auth/session/verify` over the network
 * on every request, rather than verifying the `amcps_…` token locally in this
 * process.
 *
 * Why remote, not local: H2's session token (`hosted/src/token.ts`) is
 * verified by deriving the Ed25519 public key from the SAME private key that
 * signs it (`derivePublicKey`), specifically so that private key never has to
 * be distributed anywhere else — the Worker that signs is the only thing that
 * ever needs to verify. Standing up local verification here would mean either
 * (a) copying `SESSION_SIGNING_KEY` (a private signing key) onto this Node
 * service, which recreates exactly the distribution problem H2's design
 * avoided, or (b) asking H2 to also expose a public verification key
 * somewhere, a public-contract change to a slice that already merged. A
 * network round-trip per call is the honest cost of keeping the private key
 * in exactly one place; `resolveValidSession` on the Worker side already does
 * the same expiry check this call relies on.
 */

import { createLogger } from '../shared/logging.js';

const log = createLogger('hosted-transport');

export interface VerifiedSession {
  userId: string;
  exp: number;
}

/**
 * Calls `POST {authUrl}/auth/session/verify` with the caller's bearer token.
 * Returns the verified identity on success, or `null` when the token is
 * missing, malformed, tampered, expired, or the Worker rejects it for any
 * other reason. Never throws for an auth rejection — only for a transport
 * failure reaching the Worker at all (network error, non-JSON body), which
 * the caller surfaces as its own distinct failure rather than a silent 401
 * (an unreachable auth service is not the same fact as "this token is
 * invalid").
 */
export async function verifySessionRemote(token: string, authUrl: string): Promise<VerifiedSession | null> {
  const res = await fetch(`${authUrl}/auth/session/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });

  if (res.status === 401) return null;
  if (!res.ok) {
    log.warn({ status: res.status }, 'hosted auth verify: unexpected status');
    throw new HostedAuthUnavailableError(`session verification returned HTTP ${res.status}`);
  }

  const body = (await res.json()) as { userId?: unknown; exp?: unknown; scope?: unknown };
  if (typeof body.userId !== 'string' || typeof body.exp !== 'number') return null;
  // Digest-scoped tokens (H6, `hosted/src/token.ts`) authorise exactly two
  // vault read routes for the scheduled digest's compose service — never
  // interactive MCP tool calls. Refusing them here keeps this transport's
  // credential surface identical to before scopes existed: only a real
  // sign-in session reaches it. Older Worker deploys omit `scope` entirely;
  // absence means a full session, so nothing pre-H6 changes behaviour.
  if (body.scope === 'digest') return null;
  return { userId: body.userId, exp: body.exp };
}

/** Thrown when the hosted auth Worker cannot be reached or returns an unexpected shape — distinct
 * from "the token is invalid" so callers never conflate an outage with a real 401. */
export class HostedAuthUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostedAuthUnavailableError';
  }
}
