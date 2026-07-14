/**
 * Worker environment bindings. Secrets are injected by Wrangler at runtime;
 * vars come from wrangler.toml `[vars]` or the dashboard. The KV namespace is
 * the only durable store this slice (H2) uses, and it holds NO affiliate
 * credentials and NO affiliate data — only account identity (user records and
 * an email-hash lookup) and short-lived pending sign-in tokens. See
 * `hosted/README.md` for the exact key shapes.
 */

export interface Env {
  /**
   * KV namespace holding hosted-account identity, keyed as:
   *   user:<userId>              -> JSON { id, createdAt }
   *   email-hash:<hmacHex>       -> <userId>   (HMAC-keyed lookup; see README)
   *   pending-link:<sha256Hex>   -> JSON { emailHash, expiresAt } (TTL'd, single-use)
   *   rl:email-hash:<hmacHex>    -> counter    (request-link rate limit, TTL'd)
   *   rl:ip:<sha256Hex>          -> counter    (request-link rate limit, TTL'd)
   */
  HOSTED_USERS: KVNamespace;

  // ── Secrets (wrangler secret put) ──────────────────────────────────────
  /** Resend API key (re_…), used to send the magic-link sign-in email. */
  RESEND_API_KEY: string;
  /**
   * Ed25519 PRIVATE key, PKCS8 DER base64 — signs and (by deriving the public
   * key from it at request time) verifies hosted session tokens. Unlike the
   * issuer Worker, no separate public key needs distributing anywhere: this
   * same Worker signs and verifies, so the public half never needs to leave
   * the process. See `src/token.ts`.
   */
  SESSION_SIGNING_KEY: string;

  // ── Vars ───────────────────────────────────────────────────────────────
  /**
   * The Worker's own public base URL, used to build the magic-link callback
   * URL placed in sign-in emails. Configured explicitly rather than derived
   * from `new URL(request.url).origin` so a proxy or misrouted Host header in
   * front of the Worker can never poison the emailed link (host-header
   * injection into a magic link is a link-hijack primitive). Validated by
   * `publicBaseUrl` below before any link is minted.
   */
  PUBLIC_BASE_URL: string;
  /**
   * Origin allowed to call `/auth/request-link` and `/auth/session/verify`
   * via CORS: the hosted product's front-end origin. Defaults to the
   * production site if unset, matching the waitlist Worker's convention.
   */
  SITE_ORIGIN?: string;
}

/**
 * Parse and validate `PUBLIC_BASE_URL`, returning its origin (no trailing
 * slash, no path). Throws a descriptive error when the var is missing or not
 * an absolute http(s) URL — callers surface that as a 500, which is safe: a
 * configuration error is identical for every caller and every address, so it
 * carries no account-enumeration signal.
 */
export function publicBaseUrl(env: Env): string {
  const raw = env.PUBLIC_BASE_URL;
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error('PUBLIC_BASE_URL is not configured');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('PUBLIC_BASE_URL is not a valid absolute URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('PUBLIC_BASE_URL must be an http(s) URL');
  }
  return parsed.origin;
}
