/**
 * Small response and CORS helpers shared by `src/index.ts` (H2 auth routes)
 * and `src/routes/*` (H3 vault routes). Pulled out here, unchanged in
 * behaviour, so both route sets build responses the same way rather than
 * each re-implementing them.
 */

import type { Env } from './env.js';

const DEFAULT_SITE_ORIGIN = 'https://agenticaffiliate.ai';

export function json(body: unknown, init: ResponseInit = {}, cors: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...cors, ...(init.headers ?? {}) },
  });
}

export function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
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
