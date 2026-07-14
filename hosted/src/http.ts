/**
 * Small response and CORS helpers shared by `src/index.ts` (H2 auth routes)
 * and `src/routes/*` (H3 vault routes). Pulled out here, unchanged in
 * behaviour, so both route sets build responses the same way rather than
 * each re-implementing them.
 */

import type { Env } from './env.js';

const DEFAULT_SITE_ORIGIN = 'https://agenticaffiliate.ai';

// Every response this Worker serves is per-user and credential- or
// token-adjacent (the vault reveal body carries decrypted credentials, the
// auth callback page carries a session token), so nothing may ever be
// cached by a fronting proxy or a zone-level cache rule. no-store on every
// response is the structural guarantee, not a per-route opt-in.
const NO_STORE = 'no-store';

export function json(body: unknown, init: ResponseInit = {}, cors: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json',
      'cache-control': NO_STORE,
      ...cors,
      ...(init.headers ?? {}),
    },
  });
}

export function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': NO_STORE,
    },
  });
}

/**
 * Only reflects the configured site origin (never `*`): every route this
 * covers is reachable from a browser tab, so cross-origin reads must stay
 * opt-in.
 */
export function corsHeaders(requestOrigin: string | null, env: Env): Record<string, string> {
  const allowedOrigin = env.SITE_ORIGIN || DEFAULT_SITE_ORIGIN;
  const headers: Record<string, string> = {
    'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
  if (requestOrigin && requestOrigin === allowedOrigin) {
    headers['access-control-allow-origin'] = allowedOrigin;
  }
  return headers;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Extract a bearer token from `Authorization: Bearer <token>`, or `null`. */
export function bearerToken(request: Request): string | null {
  const header = request.headers.get('authorization');
  if (!header || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length).trim();
  return token.length > 0 ? token : null;
}
