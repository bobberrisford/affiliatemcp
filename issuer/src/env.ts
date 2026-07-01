/**
 * Worker environment bindings. Secrets are injected by Wrangler at runtime;
 * vars come from wrangler.toml `[vars]` or the dashboard. The KV namespace is
 * the only durable store — subscription/entitlement records only, NO affiliate
 * credentials and NO affiliate data ever touch this Worker.
 */

export interface Env {
  /**
   * KV namespace holding subscription records, keyed by account key. Stores:
   *   acc:<accountKey>   -> JSON { status, customerId, subscriptionId, email? }
   *   sub:<subId>        -> <accountKey>            (reverse index for webhooks)
   *   evt:<eventId>      -> "1"                     (idempotency marker, TTL'd)
   */
  ENTITLEMENTS: KVNamespace;

  // ── Secrets (wrangler secret put) ──────────────────────────────────────
  /** Stripe secret key (sk_live_… / sk_test_…). */
  STRIPE_SECRET_KEY: string;
  /** Stripe webhook signing secret (whsec_…). */
  STRIPE_WEBHOOK_SECRET: string;
  /** Ed25519 PRIVATE key, PKCS8 DER base64 — signs entitlement tokens. */
  LICENCE_SIGNING_KEY: string;

  // ── Vars ───────────────────────────────────────────────────────────────
  /** Stripe recurring Price id for the £20/mo subscription (price_…). */
  STRIPE_PRICE_ID: string;
  /** Base success URL for the Checkout redirect. */
  SUCCESS_URL: string;
  /** Cancel URL for the Checkout Session. */
  CANCEL_URL: string;
  /** Return URL for the Stripe billing portal. */
  PORTAL_RETURN_URL?: string;
  /**
   * Entitlement token lifetime in seconds. Defaults to 8 days — slightly longer
   * than the app's 7-day offline grace so a token always outlives one grace
   * window between refreshes. Keep it short; a lapsed subscription must stop
   * working within roughly this window.
   */
  ENTITLEMENT_TTL_SECONDS?: string;
}
