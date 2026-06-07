/**
 * Worker environment bindings. Secrets are injected by Wrangler at runtime;
 * vars come from wrangler.toml `[vars]` or the dashboard. The KV namespace is
 * the only durable store — purchase records only, NO affiliate credentials.
 */

export interface Env {
  /** KV namespace holding purchase records (email→licence, lid→email, evt ids). */
  LICENCES: KVNamespace;

  // ── Secrets (wrangler secret put) ──────────────────────────────────────
  /** Stripe secret key (sk_live_… / sk_test_…). */
  STRIPE_SECRET_KEY: string;
  /** Stripe webhook signing secret (whsec_…). */
  STRIPE_WEBHOOK_SECRET: string;
  /** Ed25519 PRIVATE key, PKCS8 DER base64. */
  LICENCE_SIGNING_KEY: string;
  /** Resend API key (re_…). Optional — unset → emails are logged, not sent. */
  RESEND_API_KEY?: string;

  // ── Vars ───────────────────────────────────────────────────────────────
  /** From address for licence emails (verified Resend sender). */
  LICENCE_FROM_EMAIL: string;
  /** Base success URL; ?session_id={CHECKOUT_SESSION_ID} is appended. */
  SUCCESS_URL: string;
  /** Cancel URL for the Checkout Session. */
  CANCEL_URL: string;
  /** Optional pre-created Stripe Price id; if unset, inline £39 price_data is used. */
  STRIPE_PRICE_ID?: string;
  /** Optional comma-separated extra CORS origins to allow. */
  EXTRA_CORS_ORIGINS?: string;
}
