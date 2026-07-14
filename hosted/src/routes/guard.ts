/**
 * Session guard shared by every H3 vault/account route. All three vault
 * routes and the account-deletion route require the SAME bearer-token check
 * as `POST /auth/session/verify` (`src/index.ts`) — this is the one place
 * that check is written, so "authenticated" cannot drift between routes.
 */

import type { Env } from '../env.js';
import { bearerToken, json } from '../http.js';
import { resolveValidSession } from '../token.js';

export interface AuthenticatedRequest {
  userId: string;
}

/**
 * Verifies the `Authorization: Bearer <session token>` header. Returns the
 * authenticated identity on success, or a ready-to-return `401` `Response`
 * when the header is missing, the token is malformed or tampered, or the
 * token has expired. Callers do:
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
  return { userId: payload.sub };
}
