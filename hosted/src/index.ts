/**
 * affiliate-mcp hosted Worker (workstream slice H2:
 * `docs/product/hosted-mvp-workstream.md`).
 *
 * Scaffold and user auth ONLY. This Worker holds NO affiliate credentials and
 * NO affiliate data — it knows a user id and an email-hash lookup, nothing
 * else. The encrypted credential vault is H3, gated on its own KMS decision
 * (`docs/decisions/2026-07-12-hosted-credential-custody.md`); nothing in this
 * file stores, decrypts, or forwards a network API key. H4 (remote MCP
 * transport) is the first consumer of the session token this Worker issues.
 *
 * Endpoints:
 *   POST /auth/request-link   { email } → creates a single-use, 15-minute
 *                              sign-in token, stores only its hash in KV, and
 *                              emails the magic link via Resend's transactional
 *                              send API. Always 200 with a neutral body for any
 *                              validly-shaped email, whether or not an account
 *                              exists — see `handleRequestLink` for the exact
 *                              boundary between this and a 400 (shape errors
 *                              carry no account-existence signal, so they stay
 *                              a 400, matching the waitlist Worker's
 *                              precedent).
 *   GET  /auth/callback       ?token=… → verifies and consumes the sign-in
 *                              token (single-use: its KV record is deleted on
 *                              first use), creates the user record if new,
 *                              and returns a minimal HTML page carrying a
 *                              freshly-issued 30-day session token. See the
 *                              file-header note in `renderSessionPage` for why
 *                              this is a copyable page rather than a
 *                              Set-Cookie.
 *   POST /auth/session/verify { token } → the primitive H4's transport will
 *                              call: validates a session token and returns
 *                              { userId, exp }.
 *   GET  /health               → liveness.
 *
 * Resend note: the rescinded waitlist-Resend decision
 * (`docs/decisions/2026-07-12-waitlist-email-resend.md`) was specifically
 * about marketing capture, and was rescinded only because the pre-sell gate
 * it served was dropped
 * (`docs/decisions/2026-07-13-build-hosted-without-presell.md`). That same
 * pivot record explicitly names transactional email as a reusable follow-on
 * of the waitlist Worker's pattern — "the pattern and CI job are reusable for
 * transactional email later, for example magic-link sign-in" — which is
 * exactly what this file does: a plain `fetch` to Resend's send API, the
 * Worker's own secret, no new dependency.
 */

import type { Env } from './env.js';
import {
  emailLookupKey,
  generateLinkToken,
  hashLinkToken,
  isValidEmail,
  normaliseEmail,
} from './identity.js';
import { buildSessionPayload, generateUserId, signSession, verifySession } from './token.js';

const DEFAULT_SITE_ORIGIN = 'https://agenticaffiliate.ai';
const RESEND_API_BASE = 'https://api.resend.com';
const SIGN_IN_FROM_ADDRESS = 'affiliate-mcp <sign-in@agenticaffiliate.ai>';

const LINK_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes, per the workstream brief.
const SESSION_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days.

interface UserRecord {
  id: string;
  createdAt: number;
}

interface PendingLinkRecord {
  emailHash: string;
  expiresAt: number;
}

// ── small helpers ────────────────────────────────────────────────────────

function json(body: unknown, init: ResponseInit = {}, cors: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...cors, ...(init.headers ?? {}) },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

function corsHeaders(requestOrigin: string | null, env: Env): Record<string, string> {
  const allowedOrigin = env.SITE_ORIGIN || DEFAULT_SITE_ORIGIN;
  const headers: Record<string, string> = {
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
  // Only reflect the configured site origin, matching the waitlist Worker's
  // stance: this is a public endpoint reachable from any browser tab, so
  // cross-origin reads must stay opt-in rather than '*'.
  if (requestOrigin && requestOrigin === allowedOrigin) {
    headers['access-control-allow-origin'] = allowedOrigin;
  }
  return headers;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

const userKey = (id: string) => `user:${id}`;
const pendingLinkKey = (tokenHash: string) => `pending-link:${tokenHash}`;

async function getUserByEmailHash(env: Env, emailHash: string): Promise<string | null> {
  return env.HOSTED_USERS.get(emailHash);
}

async function getOrCreateUser(env: Env, emailHash: string): Promise<string> {
  const existing = await getUserByEmailHash(env, emailHash);
  if (existing) return existing;
  const id = generateUserId();
  const record: UserRecord = { id, createdAt: nowSeconds() };
  await env.HOSTED_USERS.put(userKey(id), JSON.stringify(record));
  await env.HOSTED_USERS.put(emailHash, id);
  return id;
}

// ── POST /auth/request-link ─────────────────────────────────────────────
//
// Neutrality boundary: a malformed request (bad JSON, missing/malformed
// email) gets a 400 — that response depends only on what the caller typed,
// never on whether an account exists, so it is not an enumeration channel.
// Once the email is a validly-shaped address, every branch below returns 200
// with the same body, whether the address belongs to an existing user, a
// brand-new one, or nobody at all, and regardless of whether the Resend send
// itself succeeds — a differing status here would let a caller distinguish
// "this address has an account" from "this address doesn't" by racing the
// Resend failure mode, which is exactly the oracle this endpoint must not
// offer. Upstream failures are only observable server-side, via the status
// code (never the email address) on stderr.
async function handleRequestLink(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  let body: { email?: unknown };
  try {
    body = (await request.json()) as { email?: unknown };
  } catch {
    return json({ ok: false, error: 'invalid_json' }, { status: 400 }, cors);
  }
  if (!isValidEmail(body.email)) {
    return json({ ok: false, error: 'invalid_email' }, { status: 400 }, cors);
  }
  const email = normaliseEmail(body.email);

  const rawToken = generateLinkToken();
  const tokenHash = await hashLinkToken(rawToken);
  const emailHash = await emailLookupKey(email, env);
  const expiresAt = nowSeconds() + LINK_TOKEN_TTL_SECONDS;
  const pending: PendingLinkRecord = { emailHash, expiresAt };
  await env.HOSTED_USERS.put(pendingLinkKey(tokenHash), JSON.stringify(pending), {
    expirationTtl: LINK_TOKEN_TTL_SECONDS,
  });

  const callbackUrl = `${new URL(request.url).origin}/auth/callback?token=${rawToken}`;
  try {
    const res = await sendSignInEmail(env, email, callbackUrl);
    if (!res.ok) {
      // Status only — never the address, never the response body (which
      // could itself echo the address back).
      console.error(`[auth] resend send failed status=${res.status}`);
    }
  } catch (err) {
    console.error(`[auth] resend send error: ${(err as Error).message}`);
  }

  return json({ ok: true }, { status: 200 }, cors);
}

async function sendSignInEmail(env: Env, email: string, callbackUrl: string): Promise<Response> {
  return fetch(`${RESEND_API_BASE}/emails`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: SIGN_IN_FROM_ADDRESS,
      to: email,
      subject: 'Sign in to affiliate-mcp',
      text: `Sign in to affiliate-mcp: ${callbackUrl}\n\nThis link expires in 15 minutes and works once. If you did not request it, ignore this email.`,
      html: `<p>Sign in to affiliate-mcp:</p><p><a href="${callbackUrl}">${callbackUrl}</a></p><p>This link expires in 15 minutes and works once. If you did not request it, ignore this email.</p>`,
    }),
  });
}

// ── GET /auth/callback ───────────────────────────────────────────────────
async function handleCallback(request: Request, env: Env): Promise<Response> {
  const rawToken = new URL(request.url).searchParams.get('token');
  if (!rawToken) return renderErrorPage('This sign-in link is missing its token.');

  const tokenHash = await hashLinkToken(rawToken);
  const key = pendingLinkKey(tokenHash);
  const raw = await env.HOSTED_USERS.get(key);
  if (!raw) return renderErrorPage('This sign-in link is invalid or has already been used.');

  // Consume immediately (single-use), before any further work. KV's TTL is
  // the primary expiry mechanism, but the explicit `expiresAt` check below is
  // a defensive backstop against TTL propagation delay.
  await env.HOSTED_USERS.delete(key);

  const pending = JSON.parse(raw) as PendingLinkRecord;
  if (pending.expiresAt <= nowSeconds()) {
    return renderErrorPage('This sign-in link has expired. Request a new one.');
  }

  const userId = await getOrCreateUser(env, pending.emailHash);
  const iss = nowSeconds();
  const exp = iss + SESSION_TOKEN_TTL_SECONDS;
  const token = await signSession(buildSessionPayload({ sub: userId, iss, exp }), env.SESSION_SIGNING_KEY);

  return renderSessionPage(token, exp);
}

/**
 * Delivery choice: a copyable HTML page, not a `Set-Cookie`. Documented here
 * because the workstream asked for whichever is simpler and testable:
 *
 * - The session token is a bearer credential for H4's remote MCP transport
 *   (an MCP client, not this browser tab, presents it on every call), so a
 *   value the user can copy into that client is directly useful; a cookie
 *   scoped to this Worker's origin would not reach a non-browser MCP client
 *   at all and would need a second "now copy this" step regardless.
 * - It sidesteps `Set-Cookie` attribute decisions (Domain, Secure, SameSite,
 *   partitioning) that matter a great deal for a real deploy but add
 *   surface-area risk with no benefit here, since nothing about this flow
 *   relies on the browser automatically re-presenting a cookie.
 * - It is trivial to unit-test: assert the response body contains the token,
 *   with no cookie-jar/attribute parsing involved.
 */
function renderSessionPage(token: string, exp: number): Response {
  const expIso = new Date(exp * 1000).toISOString();
  return html(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>signed in</title>
<style>
  body { font-family:'JetBrains Mono',ui-monospace,Menlo,monospace; background:#fff; color:#0a0a0a;
         margin:0; padding:40px 20px; display:flex; justify-content:center; }
  .card { width:100%; max-width:640px; border:2px solid #0a0a0a; padding:28px; box-shadow:6px 6px 0 #0a0a0a; }
  h1 { font-size:22px; font-weight:700; margin:0 0 4px; text-transform:lowercase; }
  p { font-size:14px; line-height:1.55; }
  .muted { color:#555; font-size:12px; }
  textarea { width:100%; box-sizing:border-box; font-family:inherit; font-size:12px; padding:10px;
             border:1px solid #0a0a0a; margin:12px 0; }
  button { font-family:inherit; font-size:13px; padding:8px 14px; border:2px solid #0a0a0a; background:#fff;
           cursor:pointer; }
</style></head>
<body><div class="card">
  <h1>you're signed in</h1>
  <p>Copy this session token into your MCP client's connection settings.</p>
  <textarea id="hosted-session-token" readonly rows="4">${token}</textarea>
  <button type="button" onclick="navigator.clipboard.writeText(document.getElementById('hosted-session-token').value)">copy token</button>
  <p class="muted">Expires ${expIso}. Do not share this token; anyone holding it can act as your account.</p>
</div></body></html>`);
}

function renderErrorPage(message: string): Response {
  return html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>sign-in error</title></head>
<body><p>${message}</p></body></html>`,
    400,
  );
}

// ── POST /auth/session/verify ────────────────────────────────────────────
async function handleSessionVerify(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  let body: { token?: unknown };
  try {
    body = (await request.json()) as { token?: unknown };
  } catch {
    return json({ error: 'invalid_request' }, { status: 400 }, cors);
  }
  if (typeof body.token !== 'string' || body.token.length === 0) {
    return json({ error: 'invalid_request' }, { status: 400 }, cors);
  }

  const payload = await verifySession(body.token, env.SESSION_SIGNING_KEY);
  if (!payload) return json({ error: 'invalid_token' }, { status: 401 }, cors);
  if (payload.exp <= nowSeconds()) return json({ error: 'expired_token' }, { status: 401 }, cors);

  return json({ userId: payload.sub, exp: payload.exp }, { status: 200 }, cors);
}

// ── Router ──────────────────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request.headers.get('origin'), env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname === '/auth/request-link' && request.method === 'POST') {
      return handleRequestLink(request, env, cors);
    }
    if (url.pathname === '/auth/callback' && request.method === 'GET') {
      return handleCallback(request, env);
    }
    if (url.pathname === '/auth/session/verify' && request.method === 'POST') {
      return handleSessionVerify(request, env, cors);
    }
    if ((url.pathname === '/' || url.pathname === '/health') && request.method === 'GET') {
      return new Response('affiliate-mcp hosted', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  },
};
