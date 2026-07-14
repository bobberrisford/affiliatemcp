/**
 * Email validation and the two one-way derivations `src/index.ts` needs:
 *
 * 1. `hashLinkToken` — the single-use sign-in link token is generated with
 *    real entropy and handed to the user via the emailed URL; only its
 *    SHA-256 hash is ever written to KV (`pending-link:<hash>`), the same
 *    "store the verifier, not the secret" shape as a password-reset token.
 *    A KV read of that record alone cannot be replayed into a valid link.
 *
 * 2. `emailLookupKey` — the KV key used to find an existing user by email is
 *    an HMAC-SHA256 of the normalised address, not the address itself, so a
 *    KV dump does not hand out the user list in plain email addresses.
 *    HMAC-SHA256 needs a secret key; rather than provision a dedicated pepper
 *    secret for this one lookup, this derives one from the existing
 *    `SESSION_SIGNING_KEY` secret via a domain-separated SHA-256 (documented
 *    trade-off in `hosted/README.md`): it keeps this slice to the two
 *    secrets the workstream brief names, at the cost of coupling the email
 *    pepper's lifetime to the session-signing key's. Rotating
 *    `SESSION_SIGNING_KEY` silently changes every user's lookup hash, so a
 *    rotation runbook must re-derive and rewrite the `email-hash:` entries
 *    (or accept returning users being issued a second account) — call this
 *    out before the first rotation, not after.
 *
 * Neither function ever logs its input.
 */

import type { Env } from './env.js';

// Deliberately permissive-but-sane, matching the waitlist Worker's check: a
// shape backstop, not a full RFC 5322 grammar validator.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL_LENGTH = 254; // RFC 5321 §4.5.3.1.3 total-length limit.

export function isValidEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_EMAIL_LENGTH && EMAIL_RE.test(value);
}

/** Trim and lower-case, so `Person@Example.com` and `person@example.com` collide. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return bytesToHex(new Uint8Array(digest));
}

/** A fresh single-use sign-in link token: 32 bytes of CSPRNG entropy, base64url. */
export function generateLinkToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** SHA-256 hex of the raw link token — the only form ever written to KV. */
export async function hashLinkToken(rawToken: string): Promise<string> {
  return sha256Hex(rawToken);
}

const EMAIL_PEPPER_LABEL = 'affiliate-mcp-hosted:email-lookup-pepper:v1';

/**
 * Derive the HMAC key used for `emailLookupKey`, from `SESSION_SIGNING_KEY`
 * plus a fixed domain-separation label (so the raw signing-key bytes are
 * never reused directly as HMAC key material for a different algorithm).
 */
async function deriveEmailHashKey(env: Env): Promise<CryptoKey> {
  const material = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${EMAIL_PEPPER_LABEL}:${env.SESSION_SIGNING_KEY}`),
  );
  return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/** The `email-hash:<hex>` KV key for a given address. Never the raw address. */
export async function emailLookupKey(email: string, env: Env): Promise<string> {
  const key = await deriveEmailHashKey(env);
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(normaliseEmail(email)),
  );
  return `email-hash:${bytesToHex(new Uint8Array(sig))}`;
}

const IP_RATE_LIMIT_LABEL = 'affiliate-mcp-hosted:rl-ip:v1';

/**
 * A one-way hash of the caller's IP for the request-link rate-limit counter
 * key. Domain-separated SHA-256 (not HMAC): unlike the email lookup, this key
 * only needs to be non-reversible-at-a-glance in a KV listing and is TTL'd
 * away within the hour, so a keyed pepper buys little here. The raw IP is
 * never stored and never logged.
 */
export async function ipRateLimitHash(ip: string): Promise<string> {
  return sha256Hex(`${IP_RATE_LIMIT_LABEL}:${ip}`);
}
