/**
 * NetRefer ASR auth — OAuth 2.0 token fetch + in-memory token cache.
 *
 * --- The credential shape ----------------------------------------------------
 *
 * NetRefer's ASR (Affiliate Standard Reporting) API authenticates through a
 * Microsoft Entra (Azure AD) token endpoint rather than a NetRefer-hosted one.
 * The documented grant is the OAuth 2.0 resource-owner *password* grant: the
 * affiliate is issued a client id, client secret, username, and password at
 * onboarding, and exchanges all four for a JWT. The JWT is then sent as
 * `Authorization: Bearer <jwt>` on every ASR data call.
 *
 *   token endpoint  https://login.microsoftonline.com/<tenant>/oauth2/v2.0/token
 *   grant_type      password
 *   client_id       NETREFER_CLIENT_ID      (issued at onboarding)
 *   client_secret   NETREFER_CLIENT_SECRET  (issued at onboarding)
 *   username        NETREFER_USERNAME       (issued at onboarding)
 *   password        NETREFER_PASSWORD       (issued at onboarding)
 *   scope           api://<resource>/Reports.Read  (defaulted; overridable)
 *
 * Why password grant rather than client-credentials: the public ASR quick
 * start documents the password grant with a username/password pair on top of
 * the client id/secret. The Rakuten adapter models client-credentials; we
 * deviate here to match what NetRefer documents. The cache mechanics are
 * otherwise identical to Rakuten's (see `src/networks/rakuten/auth.ts`).
 *
 * --- Why the cache pattern ---------------------------------------------------
 *
 * Entra access tokens last ~1 hour (`expires_in` on the token response).
 * Calling the token endpoint on every ASR call would add a second HTTP
 * round-trip to a Microsoft host on every operation and burn the token
 * endpoint's own rate limit. The cache is a single module-scope object
 * `{ token, expiresAt }`; concurrent refreshes are deduplicated through
 * `inFlightRefresh` so two parallel callers do not both round-trip the token
 * endpoint. This is the ONLY mutable module-level state in the adapter.
 *
 * --- Refresh policy ----------------------------------------------------------
 *
 *   1. Proactive: when the cached token has < the proactive margin remaining,
 *      refresh before the next call uses it.
 *   2. Reactive: a 401 from a data call clears the cache and forces one
 *      refresh + one retry (handled in `client.ts`).
 *
 * Docs: https://developer.netrefer.com/Affiliate-api/ASR (the portal gates the
 * full reference behind onboarding; see docs/networks/netrefer.md).
 */

import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { HttpStatusError, withResilience, DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import { createLogger } from '../../shared/logging.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';

const log = createLogger('netrefer.auth');

const SLUG = 'netrefer';

/**
 * The documented ASR token endpoint (Microsoft Entra / Azure AD). The tenant
 * id is the one NetRefer publishes for ASR onboarding. It is treated as a
 * fixed default — the per-operator variability lives on the DATA host
 * (`NETREFER_BASE_URL`), not the token host. A user whose operator uses a
 * different tenant can override via `NETREFER_TOKEN_URL`.
 */
const DEFAULT_TOKEN_URL =
  'https://login.microsoftonline.com/0e0b50ac-5253-4347-b528-251b2f17cfc6/oauth2/v2.0/token';

/**
 * The documented ASR scope. NetRefer publishes `Reports.Read` against an
 * `api://<resource>` audience for the affiliate ASR surface. Overridable via
 * `NETREFER_SCOPE` because the resource id can differ per onboarding.
 */
const DEFAULT_SCOPE = 'api://56a563d7-9aad-4773-b966-01ec2d1ec5ac/Reports.Read';

function tokenUrl(): string {
  const override = process.env['NETREFER_TOKEN_URL'];
  if (override && override.trim() !== '') return override;
  return DEFAULT_TOKEN_URL;
}

function scope(): string {
  const override = process.env['NETREFER_SCOPE'];
  if (override && override.trim() !== '') return override;
  return DEFAULT_SCOPE;
}

interface TokenCacheEntry {
  token: string;
  /** Epoch ms; the time at which we treat the token as expired. */
  expiresAt: number;
}

/** Module-scope cache. The single piece of mutable state in the adapter. */
let cache: TokenCacheEntry | null = null;

/** In-flight refresh deduplication (see Rakuten auth for the full rationale). */
let inFlightRefresh: Promise<string> | null = null;

/** Refresh proactively when this many ms remain on the lifetime. */
const PROACTIVE_REFRESH_MARGIN_MS = 5 * 60 * 1000; // 5 minutes

/** Test-only: clear the cache so an isolated test does not leak token state. */
export function _resetTokenCache(): void {
  cache = null;
  inFlightRefresh = null;
}

/**
 * Return a usable access token, refreshing if necessary. Throws a NetworkError
 * (auth_error envelope) on failure. `forceRefresh` is set by the client after
 * a 401; that path is logged at debug level so it is observable.
 */
export async function getAccessToken(opts: { forceRefresh?: boolean } = {}): Promise<string> {
  const now = Date.now();
  if (!opts.forceRefresh && cache && cache.expiresAt - now > PROACTIVE_REFRESH_MARGIN_MS) {
    return cache.token;
  }
  return refreshToken({ reason: opts.forceRefresh ? 'forced (401)' : 'expired or missing' });
}

/** Force a token refresh. Deduplicates concurrent callers via `inFlightRefresh`. */
export async function refreshToken(opts: { reason: string }): Promise<string> {
  if (inFlightRefresh) return inFlightRefresh;

  inFlightRefresh = (async () => {
    log.debug({ reason: opts.reason, tokenUrl: tokenUrl() }, 'netrefer token refresh');
    try {
      const clientId = requireCredential('NETREFER_CLIENT_ID', {
        network: SLUG,
        operation: 'auth.refreshToken',
        hint: 'Set NETREFER_CLIENT_ID in ~/.affiliate-mcp/.env or run `affiliate-networks-mcp setup netrefer`.',
      });
      const clientSecret = requireCredential('NETREFER_CLIENT_SECRET', {
        network: SLUG,
        operation: 'auth.refreshToken',
        hint: 'Set NETREFER_CLIENT_SECRET in ~/.affiliate-mcp/.env or run `affiliate-networks-mcp setup netrefer`.',
      });
      const username = requireCredential('NETREFER_USERNAME', {
        network: SLUG,
        operation: 'auth.refreshToken',
        hint: 'Set NETREFER_USERNAME (issued by NetRefer at ASR onboarding).',
      });
      const password = requireCredential('NETREFER_PASSWORD', {
        network: SLUG,
        operation: 'auth.refreshToken',
        hint: 'Set NETREFER_PASSWORD (issued by NetRefer at ASR onboarding).',
      });

      const exchanged = await exchangeForToken(clientId, clientSecret, username, password);
      cache = exchanged;
      log.debug(
        { expiresAt: new Date(exchanged.expiresAt).toISOString() },
        'netrefer token cached',
      );
      return exchanged.token;
    } finally {
      inFlightRefresh = null;
    }
  })();

  return inFlightRefresh;
}

/**
 * Round-trip the Entra token endpoint and parse its response.
 *
 * The exchange goes through `withResilience` so a transient 5xx on the token
 * host is retried under the same policy as a data endpoint.
 *
 * The body is form-urlencoded per OAuth 2.0; the resource-owner password grant
 * carries `grant_type=password` plus the client id/secret, the username and
 * password, and the documented `scope`.
 */
async function exchangeForToken(
  clientId: string,
  clientSecret: string,
  username: string,
  password: string,
): Promise<TokenCacheEntry> {
  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: clientId,
    client_secret: clientSecret,
    username,
    password,
    scope: scope(),
  }).toString();

  return withResilience(
    { network: SLUG, operation: 'auth.tokenExchange' },
    async () => {
      const res = await fetch(tokenUrl(), {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      });
      const raw = await res.text();
      if (!res.ok) {
        throw new HttpStatusError(res.status, raw, `NetRefer token exchange → HTTP ${res.status}`);
      }
      let parsed: { access_token?: string; expires_in?: number; token_type?: string };
      try {
        parsed = JSON.parse(raw);
      } catch (err) {
        // Preserve the verbatim body on the envelope (principle 4.1).
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'auth_error',
            network: SLUG,
            operation: 'auth.tokenExchange',
            httpStatus: res.status,
            networkErrorBody: raw,
            message: `NetRefer token endpoint returned non-JSON body (parse error: ${(err as Error).message})`,
            hint: 'Confirm NETREFER_TOKEN_URL points at the Entra token endpoint NetRefer issued for ASR.',
          }),
        );
      }
      if (!parsed.access_token) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'auth_error',
            network: SLUG,
            operation: 'auth.tokenExchange',
            httpStatus: res.status,
            networkErrorBody: raw,
            message: 'NetRefer token endpoint returned HTTP 200 but no access_token field.',
            hint: 'Re-check NETREFER_CLIENT_ID / NETREFER_CLIENT_SECRET / NETREFER_USERNAME / NETREFER_PASSWORD and NETREFER_SCOPE.',
          }),
        );
      }
      const lifetimeMs = (parsed.expires_in ?? 3600) * 1000;
      return { token: parsed.access_token, expiresAt: Date.now() + lifetimeMs };
    },
    DEFAULT_RESILIENCE,
  );
}

// ---------------------------------------------------------------------------
// verifyAuth + validateCredential
// ---------------------------------------------------------------------------

export interface VerifyAuthOk {
  ok: true;
  identity?: string;
  derivedValues?: Record<string, string>;
}

export interface VerifyAuthFail {
  ok: false;
  reason: string;
  envelope?: NetworkErrorEnvelope;
}

/**
 * Verify auth by exchanging credentials for a token.
 *
 * The token exchange is the conclusive correctness probe: it proves all four
 * OAuth credentials and the scope resolve. We deliberately do NOT issue a data
 * call here — the ASR base host is per-operator and may not be reachable from
 * the wizard's network, and a successful token exchange is sufficient evidence
 * the credentials work. A 401/400 from the token endpoint surfaces verbatim.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  _resetTokenCache();
  try {
    await refreshToken({ reason: 'verifyAuth' });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'auth_error',
      network: SLUG,
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
      hint: 'Re-check the four NetRefer credentials. Trailing whitespace from a copy/paste is the most common cause.',
    });
    return { ok: false, reason: envelope.message, envelope };
  }

  const username = process.env['NETREFER_USERNAME'] ?? '';
  return {
    ok: true,
    identity: username ? `netrefer/${username}` : 'netrefer',
    derivedValues: {},
  };
}

/**
 * Validate a single credential at wizard-entry time.
 *
 * All five fields (base URL + four OAuth fields) need to be present together
 * for a useful check; the wizard prompts all of them then calls `verifyAuth()`.
 * Per-field format checks catch obvious typos before the network round-trip.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  switch (field) {
    case 'NETREFER_BASE_URL':
      return validateBaseUrl(value);
    case 'NETREFER_CLIENT_ID':
      if (!value || value.trim() === '') {
        return { ok: false, message: 'Client ID is required.' };
      }
      return { ok: true };
    case 'NETREFER_CLIENT_SECRET':
      if (!value || value.trim() === '') {
        return { ok: false, message: 'Client secret is required.' };
      }
      if (/\s/.test(value)) {
        return {
          ok: false,
          message: 'Client secret contains whitespace — typically a copy/paste error.',
          hint: 'Re-copy the value NetRefer issued; secrets do not contain spaces.',
        };
      }
      return { ok: true };
    case 'NETREFER_USERNAME':
      if (!value || value.trim() === '') {
        return { ok: false, message: 'Username is required.' };
      }
      return { ok: true };
    case 'NETREFER_PASSWORD':
      if (!value || value.trim() === '') {
        return { ok: false, message: 'Password is required.' };
      }
      return { ok: true };
    default:
      return {
        ok: false,
        message: `Unknown credential field "${field}" for NetRefer.`,
        hint: 'NetRefer expects NETREFER_BASE_URL, NETREFER_CLIENT_ID, NETREFER_CLIENT_SECRET, NETREFER_USERNAME, and NETREFER_PASSWORD.',
      };
  }
}

/**
 * Validate the per-operator base URL. It must be a syntactically valid
 * `http(s)` URL — the host varies per operator, so we cannot check it against
 * a fixed allow-list, only that it parses.
 */
export function validateBaseUrl(value: string): CredentialValidationResult {
  if (!value || value.trim() === '') {
    return {
      ok: false,
      message: 'NetRefer base URL is required.',
      hint: 'NetRefer issues a per-operator ASR host at onboarding, e.g. https://asr.operator.netrefer.com.',
    };
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return {
      ok: false,
      message: `"${value}" is not a valid URL.`,
      hint: 'Provide the full ASR base URL including the scheme, e.g. https://asr.example.netrefer.com.',
    };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return {
      ok: false,
      message: `NetRefer base URL must use http or https (got "${url.protocol}").`,
    };
  }
  return { ok: true };
}
