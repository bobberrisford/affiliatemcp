/**
 * Session guards shared by every session-gated route. This is the one place
 * "authenticated" is written, so it cannot drift between routes.
 *
 * Two guards since H6 introduced token scopes (`src/token.ts`,
 * `SessionScope`):
 *
 * - `requireSession` accepts ANY valid session — full or digest-scoped. Used
 *   ONLY by the two read routes the scheduled digest actually needs (vault
 *   list and vault reveal, `src/routes/vault.ts`), both of which still serve
 *   only the token's own userId.
 * - `requireFullSession` additionally rejects digest-scoped tokens with a
 *   403 `insufficient_scope`. Used by everything else: vault store/delete,
 *   account deletion, billing checkout/entitlement. (The H5 connect pages do
 *   their own session resolution for browser-flavoured error pages —
 *   `resolveBrowserSession` in `src/routes/connect.ts` — and enforce the
 *   same full-scope requirement there.)
 *
 * Default-deny by construction: a NEW session-gated route added without
 * thinking about scopes should use `requireFullSession`; `requireSession`'s
 * doc comment names the only two routes entitled to it.
 */

import type { Env } from '../env.js';
import { bearerToken, json } from '../http.js';
import { resolveValidSession, sessionScope, type SessionScope } from '../token.js';

export interface AuthenticatedRequest {
  userId: string;
  scope: SessionScope;
}

/**
 * Verifies the `Authorization: Bearer <session token>` header, accepting any
 * scope. Returns the authenticated identity on success, or a ready-to-return
 * `401` `Response` when the header is missing, the token is malformed or
 * tampered, or the token has expired. Callers do:
 *
 *   const auth = await requireSession(request, env, cors);
 *   if (auth instanceof Response) return auth;
 */
export async function requireSession(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<AuthenticatedRequest | Response> {
  const token = bearerToken(request);
  if (!token) {
    return json({ error: 'missing_session' }, { status: 401 }, cors);
  }
  const payload = await resolveValidSession(token, env.SESSION_SIGNING_KEY);
  if (!payload) {
    return json({ error: 'invalid_session' }, { status: 401 }, cors);
  }
  return { userId: payload.sub, scope: sessionScope(payload) };
}

/**
 * `requireSession` plus a full-scope requirement: a digest-scoped token is
 * refused with a 403 `insufficient_scope` (a real, valid session that is
 * simply not entitled to this route — deliberately distinct from the 401 an
 * invalid token gets, so the two failures are never conflated).
 */
export async function requireFullSession(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<AuthenticatedRequest | Response> {
  const auth = await requireSession(request, env, cors);
  if (auth instanceof Response) return auth;
  if (auth.scope !== 'full') {
    return json({ error: 'insufficient_scope' }, { status: 403 }, cors);
  }
  return auth;
}
