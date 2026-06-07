/**
 * Licence token signing — the SIGNING half of CANONICAL LICENCE TOKEN FORMAT v1.
 *
 * MUST match the verifier in the main repo (`src/shared/config.ts`,
 * `verifyLicenceToken`) byte-for-byte:
 *
 *   payload      = { lid, email, product: "desktop", issued: "YYYY-MM-DD", v: 1 }
 *   payloadBytes = UTF-8 of JSON.stringify(payload)
 *   sigBytes     = raw Ed25519 signature (64 bytes) over payloadBytes
 *   token        = "amcp_" + base64url(payloadBytes) + "." + base64url(sigBytes)
 *
 * Uses WebCrypto SubtleCrypto with the Ed25519 algorithm — built into the
 * Cloudflare Workers runtime AND Node 20+, so the same code path runs in the
 * Worker and in local tests/scripts. No third-party crypto dependency.
 */

/** Token prefix — the licence string always starts with this. */
export const LICENCE_TOKEN_PREFIX = 'amcp_';

/** The canonical v1 licence payload. */
export interface LicencePayload {
  lid: string;
  email: string;
  product: 'desktop';
  issued: string; // YYYY-MM-DD (UTC)
  v: 1;
}

/**
 * Encode bytes as base64url (RFC 4648 §5): `+`→`-`, `/`→`_`, no `=` padding.
 * Pure WebCrypto-friendly implementation (no Node Buffer dependency).
 */
export function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  // btoa is available in both the Workers runtime and Node 16+.
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Decode a base64-or-base64url string to bytes (ArrayBuffer-backed). */
function base64ToBytes(b64: string): Uint8Array {
  const normalised = b64.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalised);
  const buf = new ArrayBuffer(binary.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Generate a licence id: `"amcp_lid_" + <random hex>`.
 * Uses crypto.randomUUID() (without dashes) for 128 bits of entropy.
 */
export function generateLid(): string {
  const uuid = crypto.randomUUID().replace(/-/g, '');
  return `amcp_lid_${uuid}`;
}

/** Today's date in UTC as YYYY-MM-DD. */
export function todayIssued(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Build the canonical v1 payload in the EXACT key order the verifier expects.
 * JSON.stringify preserves insertion order, so this object literal IS the wire
 * format. Do not reorder these keys.
 */
export function buildPayload(args: { lid: string; email: string; issued: string }): LicencePayload {
  return {
    lid: args.lid,
    email: args.email,
    product: 'desktop',
    issued: args.issued,
    v: 1,
  };
}

/**
 * Import an Ed25519 PRIVATE key from PKCS8 DER (base64) into a CryptoKey.
 */
async function importPrivateKey(privateKeyPkcs8DerB64: string): Promise<CryptoKey> {
  const der = base64ToBytes(privateKeyPkcs8DerB64);
  return crypto.subtle.importKey('pkcs8', der.buffer as ArrayBuffer, { name: 'Ed25519' }, false, [
    'sign',
  ]);
}

/**
 * Sign a licence payload and return the full token string.
 *
 * Pure: takes the payload + key material, returns the token. No I/O, no KV,
 * no email. Callers (the Worker, the CLI script) supply the key.
 */
export async function signLicence(
  payload: LicencePayload,
  privateKeyPkcs8DerB64: string,
): Promise<string> {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const key = await importPrivateKey(privateKeyPkcs8DerB64);
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, key, payloadBytes);
  const sigBytes = new Uint8Array(sig);
  return `${LICENCE_TOKEN_PREFIX}${base64urlEncode(payloadBytes)}.${base64urlEncode(sigBytes)}`;
}
