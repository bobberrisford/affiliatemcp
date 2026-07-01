/**
 * affiliate-mcp — desktop entitlement client (paid tier only).
 *
 * Verifies the £20/mo premium subscription. This is the ONLY subsystem that
 * ever calls our own issuer, and it ONLY does so for a user who has an account
 * key (i.e. has started a subscription). A free-tier user has no account key,
 * so `entitlementStatus()` is a pure local read and the app makes ZERO outbound
 * calls — the free tier's no-phone-home posture is intact.
 *
 * NB: the fetches here are the desktop app's control-plane calls to our issuer,
 * NOT affiliate-network adapter calls. They deliberately do not go through the
 * adapter `withResilience`/`client.ts` path (that layer is for affiliate APIs
 * and never runs in this desktop code path). Kept isolated here on purpose.
 *
 * Enforcement model: the issuer mints a SHORT-LIVED signed token while the
 * subscription is active. The app is entitled while it holds a validly-signed,
 * unexpired token. On launch it refreshes online; if offline, the cached token
 * keeps premium unlocked until it expires (its lifetime is the offline grace).
 * A cancelled subscription stops minting tokens, so the app locks once the last
 * token expires. Expiry is what makes cancellation enforceable.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { resolveConfigPaths } from '../cli/wizard/paths.js';

const ENTITLEMENT_PREFIX = 'amcpe_';
const ENTITLEMENT_PRODUCT = 'desktop-premium';

/**
 * Ed25519 PUBLIC key (SPKI DER, base64) that entitlement tokens are verified
 * against. This is a DEV key. Before first public release, regenerate the
 * production keypair (issuer `npm run gen-keypair`), set the PRIVATE half as the
 * issuer secret `LICENCE_SIGNING_KEY`, and swap this constant for the PUBLIC
 * half. Rotating after ship invalidates every issued entitlement.
 */
export const ENTITLEMENT_PUBLIC_KEY_SPKI_B64 =
  'MCowBQYDK2VwAyEAlMzj1LfEHTkHYFzDzKz/MlAFaVsIF5OkvY5WHQqwizc=';

/** Default issuer origin; overridable via AFFILIATE_MCP_ISSUER_URL. */
const DEFAULT_ISSUER_URL = 'https://affiliate-mcp-issuer.robertberrisford.workers.dev';

function issuerUrl(): string {
  const override = process.env['AFFILIATE_MCP_ISSUER_URL'];
  return override && override.trim() !== '' ? override.replace(/\/+$/, '') : DEFAULT_ISSUER_URL;
}

// ---------------------------------------------------------------------------
// Token verification (mirror of issuer/src/token.ts — keep identical)
// ---------------------------------------------------------------------------

export interface EntitlementPayload {
  akey: string;
  product: typeof ENTITLEMENT_PRODUCT;
  iss: number;
  exp: number;
  v: 1;
}

function base64ToBytes(b64: string): Uint8Array {
  const normalised = b64.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalised);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Verify a token's signature and shape against the embedded (or supplied)
 * public key. Returns the payload or null. Does NOT check expiry — the caller
 * applies the time policy.
 */
export async function verifyEntitlementToken(
  token: string,
  publicKeySpkiDerB64: string = ENTITLEMENT_PUBLIC_KEY_SPKI_B64,
): Promise<EntitlementPayload | null> {
  if (!token.startsWith(ENTITLEMENT_PREFIX)) return null;
  const body = token.slice(ENTITLEMENT_PREFIX.length);
  const dot = body.indexOf('.');
  if (dot < 0) return null;
  let payloadBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    payloadBytes = base64ToBytes(body.slice(0, dot));
    sigBytes = base64ToBytes(body.slice(dot + 1));
  } catch {
    return null;
  }
  const key = await crypto.subtle.importKey(
    'spki',
    base64ToBytes(publicKeySpkiDerB64).buffer as ArrayBuffer,
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  const ok = await crypto.subtle.verify(
    { name: 'Ed25519' },
    key,
    sigBytes.buffer as ArrayBuffer,
    payloadBytes.buffer as ArrayBuffer,
  );
  if (!ok) return null;
  let payload: EntitlementPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as EntitlementPayload;
  } catch {
    return null;
  }
  if (payload.product !== ENTITLEMENT_PRODUCT || payload.v !== 1 || typeof payload.exp !== 'number') {
    return null;
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Local store
// ---------------------------------------------------------------------------

interface StoredEntitlement {
  accountKey?: string;
  token?: string;
  exp?: number;
  lastRefreshed?: string;
}

function storePath(): string {
  return path.join(resolveConfigPaths().dir, 'entitlement.json');
}

function readStored(): StoredEntitlement {
  const p = storePath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as StoredEntitlement;
  } catch {
    return {};
  }
}

function writeStored(next: StoredEntitlement): void {
  const { dir } = resolveConfigPaths();
  mkdirSync(dir, { recursive: true });
  writeFileSync(storePath(), JSON.stringify(next, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export type EntitlementState = 'none' | 'active' | 'expired' | 'inactive';

export interface EntitlementStatus {
  /** The single flag the app gates premium features on. */
  entitled: boolean;
  state: EntitlementState;
  /** Token expiry (unix seconds), when a token is cached. */
  exp?: number;
  /** Present once the user has started a subscription. */
  hasAccount: boolean;
}

/**
 * The current entitlement, computed from the LOCAL cache only — no network.
 * `none` when there is no account key at all (free tier: no calls, ever).
 * `active` when a validly-signed, unexpired token is cached. `expired` when the
 * cached token has lapsed (offline too long, or subscription ended). `inactive`
 * when there is an account key but no usable token.
 */
export async function entitlementStatus(now: number = Math.floor(Date.now() / 1000)): Promise<EntitlementStatus> {
  const stored = readStored();
  if (!stored.accountKey) return { entitled: false, state: 'none', hasAccount: false };
  if (!stored.token) return { entitled: false, state: 'inactive', hasAccount: true };
  const payload = await verifyEntitlementToken(stored.token);
  if (!payload) return { entitled: false, state: 'inactive', hasAccount: true };
  if (now < payload.exp) return { entitled: true, state: 'active', exp: payload.exp, hasAccount: true };
  return { entitled: false, state: 'expired', exp: payload.exp, hasAccount: true };
}

// ---------------------------------------------------------------------------
// Online operations (only reached for a user with an account key)
// ---------------------------------------------------------------------------

/**
 * Start a subscription: ask the issuer for a Checkout URL, persist the returned
 * account key so we can poll entitlement after payment, and return the URL for
 * the app to open in the system browser.
 */
export async function startCheckout(): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${issuerUrl()}/checkout`, { method: 'POST' });
    if (!res.ok) return { ok: false, error: `Checkout failed (HTTP ${res.status}).` };
    const body = (await res.json()) as { url?: string; accountKey?: string };
    if (!body.url || !body.accountKey) return { ok: false, error: 'Checkout returned an unexpected response.' };
    const stored = readStored();
    writeStored({ ...stored, accountKey: body.accountKey });
    return { ok: true, url: body.url };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Refresh entitlement from the issuer. Only calls out when an account key is
 * present. On success, caches the fresh token. On `active:false`, clears the
 * token (keeps the account key). On a network error, KEEPS the cached token so
 * a transient outage doesn't lock a paying user out — returns the still-valid
 * cached status. Returns the resulting local status.
 */
export async function refreshEntitlement(): Promise<EntitlementStatus> {
  const stored = readStored();
  if (!stored.accountKey) return { entitled: false, state: 'none', hasAccount: false };
  try {
    const res = await fetch(`${issuerUrl()}/entitlement`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountKey: stored.accountKey }),
    });
    const body = (await res.json()) as { active?: boolean; token?: string; exp?: number };
    if (body.active && body.token) {
      writeStored({ ...stored, token: body.token, exp: body.exp, lastRefreshed: new Date().toISOString() });
    } else {
      writeStored({ accountKey: stored.accountKey });
    }
  } catch {
    // Offline: keep the cached token; fall through to the cached status.
  }
  return entitlementStatus();
}

/** Ask the issuer for a billing-portal URL (manage/cancel). */
export async function openPortal(): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const stored = readStored();
  if (!stored.accountKey) return { ok: false, error: 'No subscription on this machine.' };
  try {
    const res = await fetch(`${issuerUrl()}/portal`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accountKey: stored.accountKey }),
    });
    if (!res.ok) return { ok: false, error: `Could not open the billing portal (HTTP ${res.status}).` };
    const body = (await res.json()) as { url?: string };
    if (!body.url) return { ok: false, error: 'Billing portal returned an unexpected response.' };
    return { ok: true, url: body.url };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Forget the subscription on this machine (local only; does not cancel). */
export function signOutEntitlement(): { ok: true } {
  writeStored({});
  return { ok: true };
}
