/**
 * OAuth 2.1 authorization-code + PKCE primitives for the hosted connector
 * (decision `docs/decisions/2026-07-15-hosted-connector-oauth.md`, slice 1).
 *
 * This module is the storage-and-crypto layer under `src/routes/oauth.ts`.
 * It holds NO route logic and, like `src/token.ts` and `src/identity.ts`,
 * uses WebCrypto and KV only — no third-party dependency — so it stays on the
 * Workers runtime the same way the rest of this Worker does.
 *
 * Why this exists: the connect flow used to hand the user a 30-day,
 * full-account `amcps_` bearer to paste into their MCP client's settings
 * (`renderSessionPage`, `src/index.ts`). The accepted decision replaces that
 * with the MCP authorization framework's OAuth flow: the MCP client performs
 * an authorization-code exchange with PKCE, stores the tokens itself, and the
 * user pastes nothing. This slice adds the authorization server (`/authorize`,
 * `/token`, `/register`, and metadata) to this Worker; the transport-side
 * acceptance of the resulting access tokens is a later slice (see the
 * "Slices" note in `hosted/README.md`).
 *
 * Token model, stated once here because it is the load-bearing design choice:
 *
 * - **Access token = a short-lived, FULL-scope hosted session token**
 *   (`amcps_…`, `src/token.ts`), TTL `OAUTH_ACCESS_TOKEN_TTL_SECONDS`. It is
 *   the exact same wire format the sign-in flow already mints, so the existing
 *   `POST /auth/session/verify` (and therefore the transport that already
 *   calls it, `src/hosted-transport/session-auth.ts`) verifies it with no
 *   change — that is what keeps bearer acceptance working during the staged
 *   migration. It is only ever full-scope: OAuth never mints a digest-scoped
 *   token (those stay internal to the scheduled digest, `src/digest.ts`), so
 *   the full-vs-digest distinction the decision requires be preserved is
 *   preserved by construction here.
 * - **Refresh token = an opaque, server-side, single-use-then-rotated
 *   credential** (`amcpr_…`), NOT a signed session token, stored only as its
 *   SHA-256 hash in KV. Deliberately a different shape from the access token
 *   so it can never be presented to the transport as a bearer and accepted:
 *   the transport verifies `amcps_` session tokens, and a refresh token is
 *   not one. Rotated on every use (old hash deleted, new one written) so a
 *   leaked-then-used refresh token is detectable as a reuse of a now-unknown
 *   token.
 *
 * All OAuth records live in the `HOSTED_USERS` namespace alongside the
 * existing `pending-link:` sign-in tokens: they are account/auth artefacts,
 * never affiliate credentials or affiliate data, so the "no affiliate data in
 * HOSTED_USERS" invariant (`src/env.ts`, `hosted/README.md`) is unchanged.
 * Key shapes, all documented in `hosted/README.md` "OAuth (slice 1)":
 *   oauth:client:<clientId>   -> ClientRecord        (registered client; no TTL)
 *   oauth:req:<reqId>         -> PendingAuthRequest   (TTL'd, single-use)
 *   oauth:code:<sha256Hex>    -> AuthCodeRecord       (TTL'd, single-use)
 *   oauth:refresh:<sha256Hex> -> RefreshRecord        (TTL'd, rotated on use)
 */

import { base64urlEncode } from './token.js';

// ── TTLs and constants ─────────────────────────────────────────────────────

/** Access-token lifetime: one hour. Short by design — the point of the OAuth
 * swap is to replace the 30-day full-account bearer with a token the client
 * silently refreshes, so a leak is bounded to this window rather than a
 * month. */
export const OAUTH_ACCESS_TOKEN_TTL_SECONDS = 60 * 60;

/** Refresh-token lifetime: 30 days, matching the old bearer's ceiling but as a
 * revocable, rotating credential the user never handles rather than one they
 * paste by hand. */
export const OAUTH_REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

/** How long a pending authorization request survives between `/authorize` and
 * the user completing sign-in + consent. Matches the 15-minute magic-link
 * window it is threaded through (`LINK_TOKEN_TTL_SECONDS`, `src/index.ts`). */
export const OAUTH_REQUEST_TTL_SECONDS = 15 * 60;

/** Authorization-code lifetime: 5 minutes. The client redeems it at `/token`
 * immediately after the redirect; this bounds a code intercepted in transit
 * (already defended by PKCE) to a short window regardless. RFC 6749 §4.1.2
 * recommends a maximum of 10 minutes; 5 is comfortably inside that. */
export const OAUTH_CODE_TTL_SECONDS = 5 * 60;

export const REFRESH_TOKEN_PREFIX = 'amcpr_';

/**
 * The single scope this authorization server grants. MCP clients typically
 * request no granular scope; the access token is always a full hosted
 * session (see the file header). A fixed identifier is carried through the
 * flow for protocol completeness and echoed in the token response.
 */
export const OAUTH_SCOPE = 'mcp';

// ── Record shapes (JSON in KV) ─────────────────────────────────────────────

/**
 * A registered OAuth client. Slice 1 serves PUBLIC clients only
 * (`token_endpoint_auth_method: "none"`, PKCE-authenticated), which is what
 * the desktop and web MCP clients this fronts are. There is no confidential
 * client and no `client_secret` anywhere in this design.
 */
export interface ClientRecord {
  clientId: string;
  redirectUris: string[];
  clientName?: string;
  createdAt: number;
}

export interface PendingAuthRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  scope: string;
  state?: string;
  /** RFC 8707 resource indicator, carried through when the client sends one. */
  resource?: string;
  expiresAt: number;
}

export interface AuthCodeRecord {
  clientId: string;
  userId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: 'S256';
  scope: string;
  resource?: string;
  expiresAt: number;
}

export interface RefreshRecord {
  userId: string;
  clientId: string;
  scope: string;
  resource?: string;
  expiresAt: number;
}

// ── KV key helpers ─────────────────────────────────────────────────────────

const clientKey = (clientId: string) => `oauth:client:${clientId}`;
const requestKey = (reqId: string) => `oauth:req:${reqId}`;
const codeKey = (codeHash: string) => `oauth:code:${codeHash}`;
const refreshKey = (tokenHash: string) => `oauth:refresh:${tokenHash}`;

// ── Random-token + hashing helpers ─────────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** 32 bytes of CSPRNG entropy, base64url — the raw form of codes, request ids,
 * client ids, and the body of a refresh token. */
export function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64urlEncode(bytes);
}

/** SHA-256 hex of an input — the only form of an authorization code or refresh
 * token ever written to KV, exactly as `hashLinkToken` does for sign-in
 * tokens (`src/identity.ts`): a KV read of the stored record cannot be
 * replayed into the live credential. */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return bytesToHex(new Uint8Array(digest));
}

/**
 * Verify a PKCE `code_verifier` against a stored S256 `code_challenge`
 * (RFC 7636 §4.6): the challenge is `base64url(SHA-256(verifier))`. Returns
 * true only on an exact match. S256 is the only method this server supports;
 * `plain` is deliberately unsupported (RFC 7636 §4.2 permits refusing it, and
 * the MCP framework mandates S256 for public clients).
 */
export async function verifyPkceS256(codeVerifier: string, codeChallenge: string): Promise<boolean> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
  const computed = base64urlEncode(new Uint8Array(digest));
  return timingSafeEqualStr(computed, codeChallenge);
}

/** A length-independent constant-time string comparison, so a challenge check
 * does not leak how much of the value matched via timing. */
function timingSafeEqualStr(a: string, b: string): boolean {
  const aBytes = new TextEncoder().encode(a);
  const bBytes = new TextEncoder().encode(b);
  // Fold the length difference into the accumulator rather than early-return,
  // so the comparison time does not depend on where the strings diverge.
  let diff = aBytes.length ^ bBytes.length;
  const max = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < max; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

/** A `code_verifier` must be 43–128 chars of the unreserved set (RFC 7636
 * §4.1). Validated so a malformed verifier is a clean `invalid_grant`, not a
 * confusing hash mismatch. */
export function isValidCodeVerifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9\-._~]{43,128}$/.test(value);
}

/** A `code_challenge` is the base64url of a 32-byte SHA-256, so 43 unreserved
 * chars. Validated at `/authorize` so a malformed challenge is rejected up
 * front rather than guaranteeing a later `/token` failure. */
export function isValidCodeChallenge(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9\-._~]{43,128}$/.test(value);
}

// ── Client registry (dynamic registration + static lookup) ─────────────────

/**
 * Register a public client (RFC 7591 dynamic client registration). The caller
 * has already validated `redirectUris`. Returns the stored record, including
 * the freshly minted `client_id`. No `client_secret`: these are public
 * clients authenticated by PKCE, not a secret.
 */
export async function registerClient(
  kv: KVNamespace,
  redirectUris: string[],
  clientName: string | undefined,
  now: number,
): Promise<ClientRecord> {
  const record: ClientRecord = {
    clientId: `oauth_client_${randomToken()}`,
    redirectUris,
    ...(clientName ? { clientName } : {}),
    createdAt: now,
  };
  await kv.put(clientKey(record.clientId), JSON.stringify(record));
  return record;
}

export async function getClient(kv: KVNamespace, clientId: string): Promise<ClientRecord | null> {
  const raw = await kv.get(clientKey(clientId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ClientRecord;
  } catch {
    return null;
  }
}

/** A registered redirect URI must match one the client registered EXACTLY
 * (RFC 6749 §3.1.2.3). No prefix or subpath matching — an exact-string allow
 * list is the safe default against open-redirect abuse of the authorization
 * endpoint. */
export function isRegisteredRedirectUri(client: ClientRecord, redirectUri: string): boolean {
  return client.redirectUris.includes(redirectUri);
}

// ── Pending authorization request ──────────────────────────────────────────

export async function putPendingRequest(
  kv: KVNamespace,
  request: PendingAuthRequest,
): Promise<string> {
  const reqId = randomToken();
  await kv.put(requestKey(reqId), JSON.stringify(request), {
    expirationTtl: OAUTH_REQUEST_TTL_SECONDS,
  });
  return reqId;
}

export async function getPendingRequest(kv: KVNamespace, reqId: string): Promise<PendingAuthRequest | null> {
  const raw = await kv.get(requestKey(reqId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingAuthRequest;
  } catch {
    return null;
  }
}

export async function deletePendingRequest(kv: KVNamespace, reqId: string): Promise<void> {
  await kv.delete(requestKey(reqId));
}

// ── Authorization code ─────────────────────────────────────────────────────

/** Mint a single-use authorization code, storing only its hash. Returns the
 * raw code to place in the redirect. */
export async function issueAuthCode(kv: KVNamespace, record: AuthCodeRecord): Promise<string> {
  const code = randomToken();
  const hash = await sha256Hex(code);
  await kv.put(codeKey(hash), JSON.stringify(record), { expirationTtl: OAUTH_CODE_TTL_SECONDS });
  return code;
}

/**
 * Consume an authorization code: read it, then delete it BEFORE returning, so
 * a code is single-use even under a retry. Returns the record when the code
 * is known and unexpired, else null.
 */
export async function consumeAuthCode(kv: KVNamespace, code: string): Promise<AuthCodeRecord | null> {
  const hash = await sha256Hex(code);
  const raw = await kv.get(codeKey(hash));
  if (!raw) return null;
  await kv.delete(codeKey(hash));
  let record: AuthCodeRecord;
  try {
    record = JSON.parse(raw) as AuthCodeRecord;
  } catch {
    return null;
  }
  if (record.expiresAt <= Math.floor(Date.now() / 1000)) return null;
  return record;
}

// ── Refresh token ──────────────────────────────────────────────────────────

/** Mint an opaque refresh token, storing only its hash. Returns the raw token
 * for the token-endpoint response. */
export async function issueRefreshToken(kv: KVNamespace, record: RefreshRecord): Promise<string> {
  const token = `${REFRESH_TOKEN_PREFIX}${randomToken()}`;
  const hash = await sha256Hex(token);
  await kv.put(refreshKey(hash), JSON.stringify(record), {
    expirationTtl: OAUTH_REFRESH_TOKEN_TTL_SECONDS,
  });
  return token;
}

/**
 * Consume a refresh token for rotation: read it, delete it, and return the
 * record when known and unexpired. Deleting on read is what makes rotation
 * single-use — the caller immediately issues a fresh token. Returns null for
 * an unknown, malformed, or expired token.
 */
export async function consumeRefreshToken(kv: KVNamespace, token: string): Promise<RefreshRecord | null> {
  if (!token.startsWith(REFRESH_TOKEN_PREFIX)) return null;
  const hash = await sha256Hex(token);
  const raw = await kv.get(refreshKey(hash));
  if (!raw) return null;
  await kv.delete(refreshKey(hash));
  let record: RefreshRecord;
  try {
    record = JSON.parse(raw) as RefreshRecord;
  } catch {
    return null;
  }
  if (record.expiresAt <= Math.floor(Date.now() / 1000)) return null;
  return record;
}

// ── Redirect-URI safety ────────────────────────────────────────────────────

/**
 * A redirect URI acceptable to store and to redirect to. Absolute URL, and
 * either https or a loopback http URL (RFC 8252 §7.3 permits `http://127.0.0.1`
 * and `http://[::1]` and `http://localhost` for native apps). Everything else
 * — a non-loopback `http:` origin, a `javascript:`/`data:` scheme, a relative
 * reference — is refused, so the authorization endpoint can never be turned
 * into an open redirector or an XSS sink.
 */
export function isAcceptableRedirectUri(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol === 'http:') {
    const host = url.hostname;
    return host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === 'localhost';
  }
  return false;
}

// ── Authorization-server metadata (RFC 8414) ───────────────────────────────

/**
 * The `/.well-known/oauth-authorization-server` document. MCP clients read
 * this to discover the authorization, token, and registration endpoints. The
 * shape is RFC 8414; only the fields this server actually honours are
 * advertised (S256-only PKCE, `none` client auth, the two grant types this
 * slice implements).
 */
export function authorizationServerMetadata(issuer: string): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    registration_endpoint: `${issuer}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [OAUTH_SCOPE],
  };
}
