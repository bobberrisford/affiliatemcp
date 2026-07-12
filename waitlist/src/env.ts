/**
 * Worker environment bindings. RESEND_API_KEY is injected by Wrangler as a
 * secret; RESEND_AUDIENCE_ID and SITE_ORIGIN come from wrangler.toml `[vars]`
 * or the dashboard. This Worker holds NO affiliate credentials and NO
 * affiliate data — only the waitlist email address (and the accepted-but-
 * not-forwarded networks/side answers, see src/index.ts) passes through it.
 */

export interface Env {
  // ── Secrets (wrangler secret put) ──────────────────────────────────────
  /** Resend API key (re_…). */
  RESEND_API_KEY: string;

  // ── Vars ───────────────────────────────────────────────────────────────
  /** Resend audience id (aud_…) that waitlist sign-ups are added to. */
  RESEND_AUDIENCE_ID: string;
  /**
   * Origin allowed to POST /waitlist via CORS: the pricing-page form origin.
   * Defaults to the production site if unset.
   */
  SITE_ORIGIN?: string;
}
