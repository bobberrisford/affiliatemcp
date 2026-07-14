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
   * Origin allowed to call `/auth/request-link` and `/auth/session/verify`
   * via CORS: the hosted product's front-end origin. Defaults to the
   * production site if unset, matching the waitlist Worker's convention.
   */
  SITE_ORIGIN?: string;
}
