/**
 * Worker environment bindings. Secrets are injected by Wrangler at runtime;
 * vars come from wrangler.toml `[vars]` or the dashboard.
 *
 * Three KV namespaces, deliberately separate:
 *   - `HOSTED_USERS` (H2) holds NO affiliate credentials and NO affiliate
 *     data — only account identity (user records and an email-hash lookup)
 *     and short-lived pending sign-in tokens.
 *   - `HOSTED_VAULT` (H3) holds the encrypted credential vault: wrapped
 *     per-user data keys and encrypted per-network credential blobs. Nothing
 *     is ever written there in plaintext.
 *   - `HOSTED_BILLING` (H6) holds Stripe subscription state: tier, status,
 *     and (the one deliberate exception in this Worker) a billing email
 *     captured at Checkout. See `src/billing.ts` for the exact shapes and why
 *     the email exception is scoped to this namespace only.
 * Keeping them apart means every "no affiliate data in HOSTED_USERS" claim in
 * `hosted/README.md` and `src/index.ts` stays true by construction, not by
 * convention. See `hosted/README.md` for the exact key shapes of all three.
 */

import type { MasterKeyProvider } from './vault.js';
import { workerSecretMasterKey } from './vault.js';

export interface Env {
  /**
   * KV namespace holding hosted-account identity, keyed as:
   *   user:<userId>              -> JSON { id, createdAt, emailHash }
   *   email-hash:<hmacHex>       -> <userId>   (HMAC-keyed lookup; see README)
   *   pending-link:<sha256Hex>   -> JSON { emailHash, expiresAt } (TTL'd, single-use)
   *   rl:email-hash:<hmacHex>    -> counter    (request-link rate limit, TTL'd)
   *   rl:ip:<sha256Hex>          -> counter    (request-link rate limit, TTL'd)
   */
  HOSTED_USERS: KVNamespace;
  /**
   * KV namespace holding the encrypted credential vault (H3), keyed as:
   *   vault:key:<userId>              -> StoredWrappedKey (wrapped per-user data key)
   *   vault:cred:<userId>:<network>   -> StoredCredentialBlob (one per connected network)
   * See `src/vault.ts` for the exact shapes and the envelope-encryption design.
   */
  HOSTED_VAULT: KVNamespace;
  /**
   * KV namespace holding Stripe subscription state (H6), keyed as:
   *   sub:<userId>          -> JSON SubscriptionRecord (tier, status, email, …)
   *   stripe-sub:<subId>    -> <userId>   (reverse index for webhook events)
   *   evt:<eventId>         -> "1"        (idempotency marker, TTL'd)
   * See `src/billing.ts` for the exact shapes and the entitlement model.
   */
  HOSTED_BILLING: KVNamespace;

  // ── Secrets (wrangler secret put) ──────────────────────────────────────
  /** Resend API key (re_…), used to send the magic-link sign-in email and (H6) the scheduled digest. */
  RESEND_API_KEY: string;
  /**
   * Ed25519 PRIVATE key, PKCS8 DER base64 — signs and (by deriving the public
   * key from it at request time) verifies hosted session tokens. Unlike the
   * issuer Worker, no separate public key needs distributing anywhere: this
   * same Worker signs and verifies, so the public half never needs to leave
   * the process. See `src/token.ts`.
   */
  SESSION_SIGNING_KEY: string;
  /**
   * The master key that wraps every user's vault data key (`src/vault.ts`,
   * `workerSecretMasterKey`): base64 of 32 random bytes, used as an AES-256-GCM
   * key-encryption key. See `hosted/README.md` "Vault threat model" for what
   * this design does and does not protect against, and `npm run gen-vault-key`
   * to generate one.
   */
  VAULT_MASTER_KEY: string;
  /**
   * Stripe secret key (sk_live_… / sk_test_…), for `POST /billing/checkout`.
   * See `src/stripe.ts` for why this Worker calls Stripe's REST API directly
   * over `fetch` rather than depending on the `stripe` npm package.
   */
  STRIPE_SECRET_KEY?: string;
  /** Stripe webhook signing secret (whsec_…), for `POST /billing/webhook`. */
  STRIPE_WEBHOOK_SECRET?: string;
  /**
   * Optional doorbell secret sent to the Node compose service as an
   * `x-compose-auth` header on every `POST /compose` call the scheduled
   * digest makes (`src/digest.ts`). It stops strangers from invoking the
   * compose service's HTTP endpoint; leaking it grants NO data access —
   * every read the compose service performs is authorised by the
   * short-lived, per-user, digest-scoped session token, never by this
   * value. A doorbell, not a key. See `hosted/README.md`, "Digest
   * orchestration and token scopes".
   */
  DIGEST_COMPOSE_SECRET?: string;

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
  /**
   * The current key version of `VAULT_MASTER_KEY`, as a string integer.
   * Defaults to `"1"`. Bump this (and rotate the secret) per the rotation
   * procedure in `hosted/README.md`; `rotateMasterKey` uses it to find every
   * data key still wrapped under the previous version.
   */
  VAULT_MASTER_KEY_VERSION?: string;
  /** Stripe recurring Price id (price_…) for the £34/mo Solo tier. Env placeholder until Rob's
   * Stripe account is wired up at deploy — see `hosted/README.md` "H6: digest and billing". */
  STRIPE_PRICE_ID_SOLO?: string;
  /** Stripe recurring Price id (price_…) for the £99/mo Pro tier. Same placeholder status as
   * `STRIPE_PRICE_ID_SOLO`. */
  STRIPE_PRICE_ID_PRO?: string;
  /** Success-redirect URL for the billing Checkout session. */
  BILLING_SUCCESS_URL?: string;
  /** Cancel-redirect URL for the billing Checkout session. */
  BILLING_CANCEL_URL?: string;
  /**
   * Base URL of the Node digest-compose service (`src/hosted-digest/`, root
   * workspace) the scheduled digest handler calls (`src/digest.ts`). While
   * unset, the cron trigger no-ops with a single log line — a Worker deploy
   * ahead of the compose service must not error-spam or half-run.
   */
  DIGEST_SERVICE_URL?: string;
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

/**
 * Build this deploy's `MasterKeyProvider` from the configured secret and
 * version. The one call site every vault route uses — swapping in a
 * KMS-backed provider later means changing this one function, not the vault
 * or the routes that call it.
 */
export function vaultMasterKeyProvider(env: Env): MasterKeyProvider {
  const keyVersion = env.VAULT_MASTER_KEY_VERSION ? Number(env.VAULT_MASTER_KEY_VERSION) : 1;
  return workerSecretMasterKey(env.VAULT_MASTER_KEY, keyVersion);
}
