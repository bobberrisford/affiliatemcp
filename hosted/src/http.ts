/**
 * Small response and CORS helpers shared by `src/index.ts` (H2 auth routes)
 * and `src/routes/*` (H3 vault routes). Pulled out here, unchanged in
 * behaviour, so both route sets build responses the same way rather than
 * each re-implementing them.
 */

import type { Env } from './env.js';
import { publicBaseUrl } from './env.js';

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

// ── Browser dashboard session cookie (OAuth slice 3) ────────────────────────
// The connect/manage dashboard (`src/routes/connect.ts`,
// `src/routes/billing-page.ts`) authenticates the BROWSER via an HttpOnly
// cookie, set once at the magic-link callback and re-presented automatically
// by the browser on every same-site dashboard navigation. This is deliberately
// distinct from the API routes (`/vault/*`, `/account`, `/billing/*`, and
// `/auth/session/verify`), which keep their `Authorization: Bearer` auth
// (`src/routes/guard.ts`) because a non-browser MCP client and the transport
// present the token in a header, never a cookie. See
// `docs/decisions/2026-07-15-hosted-connector-oauth.md`.
export const SESSION_COOKIE_NAME = 'hosted_session';

/**
 * Build the `Set-Cookie` value that establishes the browser dashboard session.
 * `HttpOnly` keeps the token out of page scripts and `Secure` keeps it off
 * plain HTTP.
 *
 * `SameSite=Lax` (NOT Strict) is required for the magic-link flow to work. The
 * link is opened from an email or webmail client, so the arrival at
 * `/auth/callback` is a CROSS-SITE top-level navigation. The callback sets this
 * cookie and 303-redirects to `/connect`; a `Strict` cookie is withheld on that
 * redirected request because the navigation chain originated cross-site, so
 * `/connect` sees no session and re-prompts. `Lax` IS sent on top-level GET
 * navigations, so the redirected `/connect` load carries it.
 *
 * CSRF is still covered: `Lax` is not sent on cross-site POSTs or subresource
 * requests, and every state-changing POST additionally enforces a same-origin
 * `Origin`/`Referer` check (`sameOriginPost`). The OAuth authorize/consent flow
 * reads no cookie at all (`src/routes/oauth.ts`), so this does not affect it.
 * The one behaviour change: the Stripe-return landing (a cross-site top-level
 * GET) now arrives signed IN rather than signed out; the billing page still
 * treats `GET /billing/entitlement` as the source of truth, never the redirect.
 */
export function setSessionCookieHeader(token: string, maxAgeSeconds: number): string {
  return `${SESSION_COOKIE_NAME}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

/** Build the `Set-Cookie` value that clears the browser dashboard session
 * (sign-out): the same attributes as `setSessionCookieHeader` with `Max-Age=0`,
 * so a browser drops it immediately. */
export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE_NAME}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

/** Read the `hosted_session` cookie value from the request's `Cookie` header,
 * or `null`. Parses defensively: splits on `;`, trims each pair, and matches
 * the exact cookie name, ignoring any other cookies present. */
export function cookieToken(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq).trim() !== SESSION_COOKIE_NAME) continue;
    const value = trimmed.slice(eq + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}

/**
 * Same-origin check for a state-changing dashboard POST (CSRF defence in depth
 * on top of `SameSite=Lax`). Returns true only when the request's `Origin`
 * header (or, when `Origin` is absent, the `Referer`) has the same origin as
 * the Worker's configured `PUBLIC_BASE_URL`. Fails closed: if both headers are
 * absent, or `PUBLIC_BASE_URL` is unusable, or `Referer` will not parse, it
 * returns false rather than assume the request is trustworthy.
 */
export function sameOriginPost(request: Request, env: Env): boolean {
  let expected: string;
  try {
    expected = publicBaseUrl(env);
  } catch {
    return false;
  }
  const origin = request.headers.get('origin');
  if (origin) return origin === expected;
  const referer = request.headers.get('referer');
  if (!referer) return false;
  try {
    return new URL(referer).origin === expected;
  } catch {
    return false;
  }
}
