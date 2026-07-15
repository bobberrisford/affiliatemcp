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
 *
 * Staged bearer migration
 * (`docs/decisions/2026-07-15-hosted-connector-oauth.md`). Since slice 1, an
 * OAuth access token IS a short-lived (one hour) full-scope `amcps_` session
 * token — byte-identical wire format to the legacy 30-day pasted sign-in
 * bearer, differing ONLY in lifetime — so this transport already accepts OAuth
 * access tokens with no change. "Dropping bearer acceptance" therefore means
 * rejecting the LONG-LIVED pasted bearers while keeping the short-lived OAuth
 * access tokens, and the one property that distinguishes them is lifetime
 * (`exp - iss`). While `maxTokenLifetimeSeconds` is unset the transport is in
 * the dual-accept window: both are accepted. Setting it (from
 * `HOSTED_MAX_TOKEN_LIFETIME_SECONDS`, `env.ts`) to a value comfortably above
 * the one-hour OAuth TTL and far below the 30-day bearer both performs the
 * cutover and serves as the documented revocation lever for every outstanding
 * pasted bearer at once.
 */

import { createLogger } from '../shared/logging.js';

const log = createLogger('hosted-transport');

export interface VerifiedSession {
  userId: string;
  exp: number;
  /** Issued-at (unix seconds), from the verify response. Paired with `exp` it
   * gives the token's lifetime, which is what tells a short-lived OAuth access
   * token apart from a long-lived pasted bearer during the staged migration. */
  iss: number;
}

/** Options for {@link verifySessionRemote}. */
export interface VerifySessionOptions {
  /**
   * Maximum permitted token lifetime in seconds. When set, a session whose
   * `exp - iss` exceeds this is rejected (returns `null`): it is a real, valid
   * session that is simply too long-lived to be an OAuth access token, i.e. a
   * legacy pasted bearer. When UNSET (the default), no cap is applied and both
   * OAuth access tokens and legacy bearers are accepted — the dual-accept
   * window of the staged migration.
   */
  maxLifetimeSeconds?: number;
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
 *
 * `iss` handling and the lifetime cap: the verify response carries `iss`
 * (issued-at) since the OAuth migration (`hosted/src/index.ts`). When
 * `opts.maxLifetimeSeconds` is set the token is rejected if its lifetime
 * (`exp - iss`) exceeds the cap, dropping long-lived pasted bearers while
 * keeping short-lived OAuth access tokens. Because the cap needs `iss`, an
 * absent or non-numeric `iss` fails CLOSED when the cap is being enforced
 * (returns `null`): a lifetime that cannot be computed cannot be shown to be
 * within bounds. When `maxLifetimeSeconds` is unset, `iss` is not needed to
 * make a decision, so its absence is not itself a rejection reason (the
 * dual-accept window stays permissive). Digest-scope refusal and
 * {@link HostedAuthUnavailableError} behaviour are unchanged.
 */
export async function verifySessionRemote(
  token: string,
  authUrl: string,
  opts?: VerifySessionOptions,
): Promise<VerifiedSession | null> {
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

  const body = (await res.json()) as { userId?: unknown; exp?: unknown; iss?: unknown; scope?: unknown };
  if (typeof body.userId !== 'string' || typeof body.exp !== 'number') return null;
  // Digest-scoped tokens (H6, `hosted/src/token.ts`) authorise exactly two
  // vault read routes for the scheduled digest's compose service — never
  // interactive MCP tool calls. Refusing them here keeps this transport's
  // credential surface identical to before scopes existed: only a real
  // sign-in session reaches it. Older Worker deploys omit `scope` entirely;
  // absence means a full session, so nothing pre-H6 changes behaviour.
  if (body.scope === 'digest') return null;

  const iss = typeof body.iss === 'number' ? body.iss : undefined;

  // Staged bearer-drop enforcement (see the file header). Only when a cap is
  // configured: reject any token whose lifetime exceeds it, and fail closed if
  // `iss` is missing/invalid so the lifetime cannot be computed. With no cap
  // configured we are in the dual-accept window and do not require `iss`.
  if (opts?.maxLifetimeSeconds !== undefined) {
    if (iss === undefined) {
      log.warn('hosted auth verify: lifetime cap set but verify response carried no numeric iss — rejecting');
      return null;
    }
    if (body.exp - iss > opts.maxLifetimeSeconds) return null;
  }

  return { userId: body.userId, exp: body.exp, iss: iss ?? 0 };
}

/** Thrown when the hosted auth Worker cannot be reached or returns an unexpected shape — distinct
 * from "the token is invalid" so callers never conflate an outage with a real 401. */
export class HostedAuthUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostedAuthUnavailableError';
  }
}
