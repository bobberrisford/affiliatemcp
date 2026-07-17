/**
 * affiliate-mcp waitlist Worker.
 *
 * Captures the pricing-page waitlist sign-up and adds the address to a
 * Resend audience. Runs no feature and holds no affiliate credentials or
 * affiliate data — see the decision record:
 * docs/decisions/2026-07-12-waitlist-email-resend.md.
 *
 * Endpoints:
 *   POST /waitlist  → { email, networks?, side? } → validates the submission
 *                     and adds/updates a contact in the configured Resend
 *                     audience. A duplicate sign-up (Resend returns a
 *                     conflict) is mapped to a success response so the
 *                     pricing-page form never errors on re-signup.
 *   GET  /health     → liveness.
 *
 * Resend payload note: the payload this Worker sends is deliberately
 * EMAIL ONLY. Resend's documented create-contact fields are `email`,
 * `first_name`, `last_name`, and `unsubscribed`; whether/how arbitrary
 * custom properties (to carry the "which networks" answer) can be set via
 * this endpoint without first declaring them in the Resend dashboard was not
 * confirmed against live Resend docs at implementation time (the docs site
 * was unreachable from this environment's fetch tooling). Sending an
 * unconfirmed field risked either a silently-dropped value or a rejected
 * request, so `networks` and `side` are validated and accepted from the
 * form for forward compatibility, but are NOT forwarded to Resend — see
 * `buildResendContactPayload` below. Revisit once a live Resend account
 * confirms the custom-property contract for this audience.
 */

import type { Env } from './env.js';

const DEFAULT_SITE_ORIGIN = 'https://agenticaffiliate.ai';
const RESEND_API_BASE = 'https://api.resend.com';

// Deliberately permissive-but-sane: catches shape errors without chasing the
// full RFC 5322 grammar, which the form's <input type="email"> already checks
// client-side. This is the server-side backstop.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254; // RFC 5321 §4.5.3.1.3 total-length limit.
const MAX_NETWORKS_LENGTH = 500;
const VALID_SIDES = new Set(['publisher', 'brand', 'both']);

interface WaitlistRequestBody {
  email?: unknown;
  networks?: unknown;
  side?: unknown;
}

type Side = 'publisher' | 'brand' | 'both';

function isValidEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_EMAIL_LENGTH && EMAIL_RE.test(value);
}

function isValidSide(value: unknown): value is Side | undefined {
  return value === undefined || (typeof value === 'string' && VALID_SIDES.has(value));
}

function isValidNetworks(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length <= MAX_NETWORKS_LENGTH);
}

function corsHeaders(requestOrigin: string | null, env: Env): Record<string, string> {
  const allowedOrigin = env.SITE_ORIGIN || DEFAULT_SITE_ORIGIN;
  const headers: Record<string, string> = {
    'access-control-allow-methods': 'POST, GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  };
  // Only reflect the allowed site origin, never '*' or the caller's origin
  // verbatim — unlike issuer's desktop-app CORS, this endpoint is reachable
  // from any public browser tab, so cross-origin reads must stay opt-in.
  if (requestOrigin && requestOrigin === allowedOrigin) {
    headers['access-control-allow-origin'] = allowedOrigin;
  }
  return headers;
}

function json(body: unknown, init: ResponseInit = {}, cors: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...cors, ...(init.headers ?? {}) },
  });
}

/** Structured 400 for a bad submission. Never echoes the raw submitted value. */
function badRequest(error: string, cors: Record<string, string>): Response {
  return json({ ok: false, error }, { status: 400 }, cors);
}

/**
 * The Resend contact payload. Deliberately email-only; see the file header
 * for why `networks` and `side` are accepted from the form but not sent on.
 */
function buildResendContactPayload(email: string): { email: string } {
  return { email };
}

async function addToResendAudience(env: Env, email: string): Promise<Response> {
  return fetch(`${RESEND_API_BASE}/audiences/${env.RESEND_AUDIENCE_ID}/contacts`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(buildResendContactPayload(email)),
  });
}

// ── POST /waitlist ───────────────────────────────────────────────────────
async function handleWaitlist(request: Request, env: Env, cors: Record<string, string>): Promise<Response> {
  let body: WaitlistRequestBody;
  try {
    body = (await request.json()) as WaitlistRequestBody;
  } catch {
    return badRequest('invalid_json', cors);
  }

  if (!isValidEmail(body.email)) return badRequest('invalid_email', cors);
  if (!isValidSide(body.side)) return badRequest('invalid_side', cors);
  if (!isValidNetworks(body.networks)) return badRequest('invalid_networks', cors);

  const email = body.email;

  try {
    const resendRes = await addToResendAudience(env, email);
    if (resendRes.ok || resendRes.status === 409) {
      // 409 = the contact already exists in the audience. Re-signup is not a
      // user-facing error: map it to success per the accepted decision, so
      // the pricing-page form never errors on re-signup.
      return json({ ok: true }, { status: 200 }, cors);
    }
    // Log only the status — never the email address or the request/response
    // body, which could itself contain the address.
    console.error(`[waitlist] resend create-contact failed status=${resendRes.status}`);
    return json({ ok: false, error: 'waitlist_failed' }, { status: 502 }, cors);
  } catch (err) {
    console.error(`[waitlist] resend request error: ${(err as Error).message}`);
    return json({ ok: false, error: 'waitlist_failed' }, { status: 502 }, cors);
  }
}

// ── Router ──────────────────────────────────────────────────────────────────
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(request.headers.get('origin'), env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (url.pathname === '/waitlist' && request.method === 'POST') return handleWaitlist(request, env, cors);
    if ((url.pathname === '/' || url.pathname === '/health') && request.method === 'GET') {
      return new Response('affiliate-mcp waitlist', { status: 200 });
    }
    return new Response('not found', { status: 404 });
  },
};
