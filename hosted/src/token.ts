/**
 * Hosted session token — Ed25519-signed, following the same wire format as
 * the entitlement-issuer Worker's `amcpe_…` token (`issuer/src/token.ts`), but
 * with a distinct product tag so a hosted session can never be mistaken for
 * (or accepted as) a desktop-premium entitlement.
 *
 *   payload      = { sub, product: "hosted-session", iss: <unix>, exp: <unix>, v: 1 }
 *   payloadBytes = UTF-8 of JSON.stringify(payload)   (key order is the wire format)
 *   sigBytes     = raw Ed25519 signature (64 bytes) over payloadBytes
 *   token        = "amcps_" + base64url(payloadBytes) + "." + base64url(sigBytes)
 *
 * Key handling differs from issuer on purpose: issuer's signer (the Worker)
 * and its verifier (the desktop app) are different processes, so issuer keeps
 * the private key as a Worker secret and embeds the derived public key inside
 * the app. Here the SAME Worker signs and verifies every token, so there is no
 * offline-distribution problem to solve — the public key is derived from the
 * private key at call time (Ed25519 JWK export includes the public "x"
 * component alongside the private "d" component; dropping "d" and
 * re-importing gives a verify-only key) rather than stored or distributed
 * separately. This keeps the Worker down to one signing secret.
 *
 * Uses WebCrypto Ed25519 only — no third-party crypto dependency.
 */

export const SESSION_TOKEN_PREFIX = 'amcps_';
export const SESSION_PRODUCT = 'hosted-session';

/**
 * Token scopes (H6). A token with no `scope` claim is a FULL session — the
 * 30-day token the sign-in flow issues, accepted everywhere. `scope:
 * "digest"` marks the short-lived token the Worker's own scheduled digest
 * handler mints for the compose service (`src/digest.ts`): it is accepted
 * ONLY by the read routes the digest actually needs (vault list and reveal,
 * still serving only its own userId) and rejected by every other
 * session-gated surface (`requireFullSession`, `src/routes/guard.ts`).
 * Absence-means-full keeps every previously issued token exactly as valid
 * as it was, with no re-issue or migration.
 */
export type SessionScope = 'full' | 'digest';

/** The canonical hosted-session payload. Do not reorder these keys. `scope`
 * is appended last and OMITTED entirely for full-scope tokens, so the wire
 * bytes of a full-scope token are byte-identical to pre-H6 tokens. */
export interface SessionPayload {
  sub: string; // userId
  product: typeof SESSION_PRODUCT;
  iss: number; // issued-at, unix seconds
  exp: number; // expiry, unix seconds
  v: 1;
  scope?: 'digest'; // absent = full scope
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

/** Generate a userId: `hosted_usr_<128-bit hex>`. Opaque, no PII embedded. */
export function generateUserId(): string {
  const uuid = crypto.randomUUID().replace(/-/g, '');
  return `hosted_usr_${uuid}`;
}

/** Build the canonical payload in the EXACT key order the verifier expects.
 * `scope` is only materialised for digest tokens — a full-scope payload
 * carries no `scope` key at all (see the `SessionPayload` doc comment). */
export function buildSessionPayload(args: {
  sub: string;
  iss: number;
  exp: number;
  scope?: 'digest';
}): SessionPayload {
  return {
    sub: args.sub,
    product: SESSION_PRODUCT,
    iss: args.iss,
    exp: args.exp,
    v: 1,
    ...(args.scope === 'digest' ? { scope: 'digest' as const } : {}),
  };
}

async function importPrivateKey(privateKeyPkcs8DerB64: string): Promise<CryptoKey> {
  const der = base64ToBytes(privateKeyPkcs8DerB64);
  // extractable: true — required so derivePublicKey() can export its JWK below.
  return crypto.subtle.importKey('pkcs8', der.buffer as ArrayBuffer, { name: 'Ed25519' }, true, ['sign']);
}

/**
 * Derive the verify-only public key from the private key, by exporting its
 * JWK form (which carries the public "x" alongside the private "d" for OKP
 * keys per RFC 8037) and re-importing with "d" dropped.
 */
async function derivePublicKey(privateKey: CryptoKey): Promise<CryptoKey> {
  const jwk = await crypto.subtle.exportKey('jwk', privateKey);
  const publicJwk: JsonWebKey = { kty: jwk.kty, crv: jwk.crv, x: jwk.x };
  return crypto.subtle.importKey('jwk', publicJwk, { name: 'Ed25519' }, false, ['verify']);
}

/** Sign a payload, returning the full `amcps_…` token. Pure: no I/O. */
export async function signSession(
  payload: SessionPayload,
  privateKeyPkcs8DerB64: string,
): Promise<string> {
  const payloadBytes = new TextEncoder().encode(JSON.stringify(payload));
  const key = await importPrivateKey(privateKeyPkcs8DerB64);
  const sig = await crypto.subtle.sign({ name: 'Ed25519' }, key, payloadBytes);
  return `${SESSION_TOKEN_PREFIX}${base64urlEncode(payloadBytes)}.${base64urlEncode(new Uint8Array(sig))}`;
}

/**
 * Verify a token against the private key (the public half is derived from
 * it; see `derivePublicKey`). Returns the payload when the prefix, signature,
 * product, and shape are valid; otherwise null. Does NOT check `exp` — expiry
 * is the caller's policy (`/auth/session/verify` enforces it).
 */
export async function verifySession(
  token: string,
  privateKeyPkcs8DerB64: string,
): Promise<SessionPayload | null> {
  if (!token.startsWith(SESSION_TOKEN_PREFIX)) return null;
  const body = token.slice(SESSION_TOKEN_PREFIX.length);
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
  const privateKey = await importPrivateKey(privateKeyPkcs8DerB64);
  const publicKey = await derivePublicKey(privateKey);
  const ok = await crypto.subtle.verify(
    { name: 'Ed25519' },
    publicKey,
    sigBytes.buffer as ArrayBuffer,
    payloadBytes.buffer as ArrayBuffer,
  );
  if (!ok) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as SessionPayload;
  } catch {
    return null;
  }
  if (
    payload.product !== SESSION_PRODUCT ||
    payload.v !== 1 ||
    typeof payload.sub !== 'string' ||
    typeof payload.exp !== 'number'
  ) {
    return null;
  }
  // Closed scope vocabulary: absent means full; the only recognised value is
  // "digest". Any other value is a malformed token, not a scope to guess at.
  if (payload.scope !== undefined && payload.scope !== 'digest') {
    return null;
  }
  return payload;
}

/** The effective scope of a verified payload: absent claim = full session. */
export function sessionScope(payload: SessionPayload): SessionScope {
  return payload.scope === 'digest' ? 'digest' : 'full';
}

/**
 * `verifySession` plus the expiry check every real caller needs — the exact
 * pair `POST /auth/session/verify` (`src/index.ts`) and every H3 vault route
 * (`src/routes/*`) perform before trusting a bearer token. Centralised so
 * "valid session" means the same thing everywhere it is checked.
 */
export async function resolveValidSession(
  token: string,
  privateKeyPkcs8DerB64: string,
): Promise<SessionPayload | null> {
  const payload = await verifySession(token, privateKeyPkcs8DerB64);
  if (!payload) return null;
  if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
  return payload;
}
