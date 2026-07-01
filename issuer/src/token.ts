/**
 * Entitlement token — the SIGNING half of the CANONICAL ENTITLEMENT TOKEN v1.
 *
 * This is NOT the old one-off licence (that was permanent and offline forever).
 * A subscription can lapse, so the entitlement token is deliberately
 * SHORT-LIVED: the app verifies the signature offline within a grace window and
 * must re-fetch a fresh token from `/entitlement` before it expires. Expiry is
 * what makes cancellation enforceable.
 *
 * MUST match the app-side verifier byte-for-byte:
 *
 *   payload      = { akey, product: "desktop-premium", iss: <unix>, exp: <unix>, v: 1 }
 *   payloadBytes = UTF-8 of JSON.stringify(payload)   (key order is the wire format)
 *   sigBytes     = raw Ed25519 signature (64 bytes) over payloadBytes
 *   token        = "amcpe_" + base64url(payloadBytes) + "." + base64url(sigBytes)
 *
 * Uses WebCrypto Ed25519, built into both the Cloudflare Workers runtime and
 * Node 20+, so the same code runs in the Worker, in tests, and (the verify
 * half) in the desktop app. No third-party crypto dependency.
 */

export const ENTITLEMENT_TOKEN_PREFIX = 'amcpe_';
export const ENTITLEMENT_PRODUCT = 'desktop-premium';

/** The canonical v1 entitlement payload. Do not reorder these keys. */
export interface EntitlementPayload {
  akey: string;
  product: typeof ENTITLEMENT_PRODUCT;
  iss: number; // issued-at, unix seconds
  exp: number; // expiry, unix seconds
  v: 1;
}

/** base64url (RFC 4648 §5), no padding. Works in Workers and Node. */
export function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i] as number);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode a base64-or-base64url string to bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  const normalised = b64.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalised);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Generate an account key: `amcp_acc_<128-bit hex>`. Opaque bearer id. */
export function generateAccountKey(): string {
  const uuid = crypto.randomUUID().replace(/-/g, '');
  return `amcp_acc_${uuid}`;
}

/** Build the canonical payload in the EXACT key order the verifier expects. */
export function buildEntitlement(args: { akey: string; iss: number; exp: number }): EntitlementPayload {
  return {
    akey: args.akey,
    product: ENTITLEMENT_PRODUCT,
    iss: args.iss,
    exp: args.exp,
    v: 1,
  };
}

async function importPrivateKey(privateKeyPkcs8DerB64: string): Promise<CryptoKey> {
  const der = base64ToBytes(privateKeyPkcs8DerB64);
  return crypto.subtle.importKey('pkcs8', der.buffer as ArrayBuffer, { name: 'Ed25519' }, false, [
    'sign',
  ]);
}

async function importPublicKey(publicKeySpkiDerB64: string): Promise<CryptoKey> {
  const der = base64ToBytes(publicKeySpkiDerB64);
  return crypto.subtle.importKey('spki', der.buffer as ArrayBuffer, { name: 'Ed25519' }, false, [
    'verify',
  ]);
}

/** Sign a payload, returning the full `amcpe_…` token. Pure: no I/O. */
export async function signEntitlement(
  payload: EntitlementPayload,
  privateKeyPkcs8DerB64: string,
): Promise<string> {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const key = await importPrivateKey(privateKeyPkcs8DerB64);
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, key, payloadBytes);
  return `${ENTITLEMENT_TOKEN_PREFIX}${base64urlEncode(payloadBytes)}.${base64urlEncode(new Uint8Array(sig))}`;
}

/**
 * Verify a token against the public key. Returns the payload when the prefix,
 * signature, product, and shape are valid; otherwise null. Does NOT check
 * `exp` — expiry/grace is the caller's policy (the app enforces the 7-day
 * grace). Shared with the app-side verifier; keep the logic identical.
 */
export async function verifyEntitlement(
  token: string,
  publicKeySpkiDerB64: string,
): Promise<EntitlementPayload | null> {
  if (!token.startsWith(ENTITLEMENT_TOKEN_PREFIX)) return null;
  const body = token.slice(ENTITLEMENT_TOKEN_PREFIX.length);
  const dot = body.indexOf('.');
  if (dot < 0) return null;
  const payloadB64 = body.slice(0, dot);
  const sigB64 = body.slice(dot + 1);
  let payloadBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    payloadBytes = base64ToBytes(payloadB64);
    sigBytes = base64ToBytes(sigB64);
  } catch {
    return null;
  }
  const key = await importPublicKey(publicKeySpkiDerB64);
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
