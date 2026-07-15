/**
 * Magic-link sign-in dispatch — the single, shared implementation of "mint a
 * single-use sign-in token, store only its hash, and email the link", used by
 * both callers that need it:
 *
 *   - `POST /auth/request-link` (`src/index.ts`): the JSON API the front-end
 *     and any script calls.
 *   - `POST /authorize/email` (`src/routes/oauth.ts`): the OAuth authorization
 *     ceremony's sign-in step, which threads a pending authorization request
 *     id through the link so `/auth/callback` can resume into the consent page
 *     instead of the session page.
 *
 * Factored out of `src/index.ts` (where it originally lived inline in
 * `handleRequestLink`) specifically so the OAuth flow reuses the exact same
 * security-critical send — the same account-enumeration neutrality, the same
 * per-address/per-IP abuse limit, and the same "link origin comes from
 * PUBLIC_BASE_URL, never the request Host" guarantee — rather than a second,
 * drifting copy of it. Behaviour is byte-for-byte what `handleRequestLink`
 * did before; `test/worker.test.ts` continues to exercise it unchanged.
 *
 * Nothing here logs the email address, on success or failure.
 */

import type { Env } from './env.js';
import { publicBaseUrl } from './env.js';
import { nowSeconds } from './http.js';
import {
  emailLookupKey,
  generateLinkToken,
  hashLinkToken,
  ipRateLimitHash,
} from './identity.js';

const RESEND_API_BASE = 'https://api.resend.com';
const SIGN_IN_FROM_ADDRESS = 'affiliate-mcp <sign-in@agenticaffiliate.ai>';

export const LINK_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes, per the workstream brief.

// Basic abuse limits on the sign-in send. A cheap KV-counter backstop against
// email-bombing a victim address or burning Resend quota, NOT the product's
// real rate-limiting story (H4's transport-level per-user limits supersede
// these). Per-address is deliberately tight (a human retries a sign-in link a
// handful of times); per-IP is looser because NAT puts many legitimate users
// behind one address.
const RATE_LIMIT_WINDOW_SECONDS = 60 * 60;
const RATE_LIMIT_MAX_PER_EMAIL = 5;
const RATE_LIMIT_MAX_PER_IP = 20;

/**
 * A pending magic-link record. `authRequestId`, when present, is the id of a
 * pending OAuth authorization request (`oauth:req:<id>`, `src/oauth.ts`) that
 * the sign-in was started to complete: `/auth/callback` reads it and resumes
 * into the OAuth consent page rather than rendering the plain session page.
 * Absent for an ordinary sign-in — an old-shape record with no field behaves
 * exactly as before.
 */
export interface PendingLinkRecord {
  emailHash: string;
  expiresAt: number;
  authRequestId?: string;
}

export const pendingLinkKey = (tokenHash: string) => `pending-link:${tokenHash}`;

/** Thrown when `PUBLIC_BASE_URL` is missing or invalid — the one condition
 * that must stop a send before any token is minted. Callers map it to their
 * own response (a JSON 500 for the API route, an error page for the OAuth
 * route); a configuration error is identical for every caller and address, so
 * it carries no account-enumeration signal either way. */
export class MagicLinkConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MagicLinkConfigError';
  }
}

/**
 * Increment-and-check a KV rate-limit counter. Returns true when within `max`
 * for the current window; false (without incrementing further) once the limit
 * is reached. KV get/put is not atomic, so concurrent requests can slightly
 * overshoot, and each increment refreshes the window TTL — both acceptable for
 * a cheap abuse backstop H4's transport-level limits supersede. Exported so
 * other unauthenticated write endpoints (e.g. OAuth `/register`) can reuse the
 * same primitive rather than re-implementing it.
 */
export async function bumpRateLimit(
  env: Env,
  key: string,
  max: number,
  windowSeconds: number = RATE_LIMIT_WINDOW_SECONDS,
): Promise<boolean> {
  const raw = await env.HOSTED_USERS.get(key);
  const count = raw ? Number(raw) : 0;
  if (count >= max) return false;
  await env.HOSTED_USERS.put(key, String(count + 1), { expirationTtl: windowSeconds });
  return true;
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

/**
 * Mint a single-use sign-in token, store only its hash (optionally carrying a
 * pending OAuth authorization request id), and email the magic link. Neutral
 * by construction: returns normally whether the abuse limit was hit (send
 * skipped) or the Resend send failed — the caller learns nothing about account
 * existence or the limiter. Throws `MagicLinkConfigError` only when
 * `PUBLIC_BASE_URL` is unusable, before any token is minted.
 *
 * The emailed link's origin is always `PUBLIC_BASE_URL`, never the request's
 * own Host (host-header injection into a magic link is a link-hijack
 * primitive; see `src/env.ts`). `authRequestId` is stored in the pending
 * record, NOT placed in the emailed URL, so it never lands in logs, history,
 * or a Referer header.
 */
export async function dispatchMagicLink(
  request: Request,
  env: Env,
  email: string,
  authRequestId?: string,
): Promise<void> {
  let linkOrigin: string;
  try {
    linkOrigin = publicBaseUrl(env);
  } catch (err) {
    throw new MagicLinkConfigError((err as Error).message);
  }

  const emailHash = await emailLookupKey(email, env);
  const clientIp = request.headers.get('cf-connecting-ip') ?? 'unknown';
  const ipHash = await ipRateLimitHash(clientIp);
  const emailAllowed = await bumpRateLimit(env, `rl:${emailHash}`, RATE_LIMIT_MAX_PER_EMAIL);
  const ipAllowed = await bumpRateLimit(env, `rl:ip:${ipHash}`, RATE_LIMIT_MAX_PER_IP);
  if (!emailAllowed || !ipAllowed) {
    // Over-limit: skip the send. The caller returns its identical neutral
    // response regardless, so the limiter is not probeable.
    return;
  }

  const rawToken = generateLinkToken();
  const tokenHash = await hashLinkToken(rawToken);
  const expiresAt = nowSeconds() + LINK_TOKEN_TTL_SECONDS;
  const pending: PendingLinkRecord = {
    emailHash,
    expiresAt,
    ...(authRequestId ? { authRequestId } : {}),
  };
  await env.HOSTED_USERS.put(pendingLinkKey(tokenHash), JSON.stringify(pending), {
    expirationTtl: LINK_TOKEN_TTL_SECONDS,
  });

  const callbackUrl = `${linkOrigin}/auth/callback?token=${rawToken}`;
  try {
    const res = await sendSignInEmail(env, email, callbackUrl);
    if (!res.ok) {
      // Status only — never the address, never the response body (which could
      // itself echo the address back).
      console.error(`[auth] resend send failed status=${res.status}`);
    }
  } catch (err) {
    console.error(`[auth] resend send error: ${(err as Error).message}`);
  }
}
