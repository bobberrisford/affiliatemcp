/**
 * Admitad advertiser (brand-side) auth + credential validation.
 *
 * Same OAuth2 scheme as the publisher adapter, with advertiser-scoped scopes.
 * The brand owner self-registers an API application in their Admitad account
 * ("Show credentials") to obtain a Client ID (app id) and Client Secret (secret
 * key). These are exchanged for a short-lived bearer access token via:
 *
 *   POST https://api.admitad.com/token/
 *   Authorization: Basic base64(client_id:client_secret)
 *   Content-Type: application/x-www-form-urlencoded
 *   Body: grant_type=client_credentials&client_id=...&scope=<space-separated scopes>
 *
 * The token is cached in memory and refreshed automatically when it expires.
 *
 * --- Why client_credentials ----------------------------------------------------
 *
 * client_credentials is the simplest self-serve flow that yields a token for
 * reading the account holder's OWN advertiser statistics: no end-user redirect,
 * no separate user password. The advertiser registers their own application and
 * reads their own programme data, which is exactly the local-first model this
 * project uses. Source:
 * https://developers.admitad.com/knowledge-base/article/client-authorization_2
 *
 * --- Advertiser scopes ---------------------------------------------------------
 *
 * Admitad advertisers request advertiser-scoped scopes, confirmed against the
 * client-authorization article and the Advertiser API method index:
 *   - advertiser_statistics → /advertiser/{id}/statistics/actions/  (reporting)
 *   - advertiser_info       → /advertiser/{id}/info/                (campaigns/brands)
 *   - advertiser_websites   → /advertiser/{id}/websites/            (joined ad spaces)
 * Sources:
 *   https://developers.admitad.com/knowledge-base/article/client-authorization_2
 *   https://developers.admitad.com/knowledge-base/articles/advertiser-api-methods
 *   https://developers.admitad.com/en/doc/advertiser-api_en/methods/statistics/statistics-actions/
 *   https://developers.admitad.com/en/doc/advertiser-api_en/methods/advertiser_info/advertiser_info/
 *
 * The Admitad developer docs host returned 403 to automated WebFetch during this
 * PR's research, so endpoint shapes were corroborated via search snippets and the
 * public Python wrapper (admitad/admitad-python-api), exactly as the publisher
 * adapter did. A few response-field details carry `// BLOCKED(verify)` notes.
 *
 * --- Token cache ---------------------------------------------------------------
 *
 * This is the ONLY module-level mutable state allowed in this adapter folder.
 * `forceRefresh` is used by the credential validator so a freshly-entered secret
 * is tested against the live endpoint even if a cached token exists.
 */

import { fetchAdvAccessToken, admitadAdvRequest } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('admitad-advertiser.auth');

export const SLUG = 'admitad-advertiser';

/**
 * Advertiser scopes requested in a single client_credentials token exchange.
 * Requesting them together avoids one token per operation. If the API
 * application does not have a scope enabled, Admitad returns an auth error
 * which surfaces verbatim.
 */
export const ADMITAD_ADV_SCOPES = 'advertiser_statistics advertiser_info advertiser_websites';

// ---------------------------------------------------------------------------
// Token cache — the only module-level mutable state in this adapter folder.
// ---------------------------------------------------------------------------

interface TokenCache {
  accessToken: string;
  expiresAt: number; // ms since epoch
}

let tokenCache: TokenCache | null = null;

/**
 * Return a valid access token, refreshing from the Admitad token endpoint if
 * the cache is empty or expired.
 *
 * `forceRefresh: true` bypasses the cache — used during credential validation
 * when the user has just entered new credentials and we want to test them live.
 */
export async function getAccessToken(opts?: { forceRefresh?: boolean }): Promise<string> {
  if (!opts?.forceRefresh && tokenCache && tokenCache.expiresAt > Date.now()) {
    return tokenCache.accessToken;
  }

  const clientId = requireCredential('ADMITAD_ADVERTISER_CLIENT_ID', {
    network: SLUG,
    operation: 'getAccessToken',
    hint: 'Register an API application in your Admitad advertiser account and click "Show credentials" to copy the Client ID (app id).',
  });
  const clientSecret = requireCredential('ADMITAD_ADVERTISER_CLIENT_SECRET', {
    network: SLUG,
    operation: 'getAccessToken',
    hint: 'Register an API application in your Admitad advertiser account and click "Show credentials" to copy the Client Secret (secret key).',
  });

  const result = await fetchAdvAccessToken(
    clientId,
    clientSecret,
    ADMITAD_ADV_SCOPES,
    DEFAULT_RESILIENCE,
  );
  tokenCache = { accessToken: result.accessToken, expiresAt: result.expiresAt };

  log.debug({ expiresAt: new Date(result.expiresAt).toISOString() }, 'token cache updated');
  return tokenCache.accessToken;
}

/** Test-only: reset the token cache so fresh credentials are exercised. */
export function _resetTokenCache(): void {
  tokenCache = null;
}

// ---------------------------------------------------------------------------
// VerifyAuth
// ---------------------------------------------------------------------------

export interface VerifyAuthOk {
  ok: true;
  identity?: string;
}

export interface VerifyAuthFail {
  ok: false;
  reason: string;
  envelope?: NetworkErrorEnvelope;
}

interface AdmitadMeResponse {
  id?: string | number;
  username?: string;
  email?: string;
}

/**
 * Verify Admitad advertiser credentials by obtaining an OAuth2 access token and
 * reading /me/.
 *
 * A successful token exchange proves the client_id + client_secret are valid; a
 * 401 proves they are not. We then call /me/ for a friendly identity string. If
 * /me/ fails but the token exchange succeeded, we still report success with a
 * token-only identity — the advertiser-scoped operations validate the data-plane
 * scopes themselves.
 *
 * Never throws — returns { ok: false } on any failure so callers (including error
 * handlers) do not loop.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let clientId: string;
  try {
    clientId = requireCredential('ADMITAD_ADVERTISER_CLIENT_ID', {
      network: SLUG,
      operation: 'verifyAuth',
    });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  let token: string;
  try {
    // Force-refresh so this always exercises the live token endpoint.
    token = await getAccessToken({ forceRefresh: true });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'auth_error',
      network: SLUG,
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
      hint: 'Check ADMITAD_ADVERTISER_CLIENT_ID and ADMITAD_ADVERTISER_CLIENT_SECRET in your config.',
    });
    return { ok: false, reason: envelope.message, envelope };
  }

  // Read /me/ for a friendly identity. A failure here does not invalidate the
  // credentials (the token exchange already succeeded), so we fall back to a
  // token-only identity rather than reporting auth failure.
  try {
    const me = await admitadAdvRequest<AdmitadMeResponse>({
      operation: 'verifyAuth',
      path: '/me/',
      token,
      resilience: DEFAULT_RESILIENCE,
    });
    const who = me.username ?? me.email ?? (me.id !== undefined ? String(me.id) : undefined);
    const identity = who
      ? `admitad-advertiser/${who} (client:${clientId})`
      : `admitad-advertiser/client:${clientId}`;
    log.debug({ identity }, 'admitad advertiser verifyAuth succeeded');
    return { ok: true, identity };
  } catch (err) {
    log.debug(
      { err: err instanceof Error ? err.message : String(err) },
      'admitad advertiser /me/ probe failed; reporting token-only identity',
    );
    return {
      ok: true,
      identity: `admitad-advertiser/client:${clientId} (identity lookup unavailable)`,
    };
  }
}

// ---------------------------------------------------------------------------
// Credential validation
// ---------------------------------------------------------------------------

/**
 * Validate a single credential field at wizard-entry time.
 *
 * ADMITAD_ADVERTISER_CLIENT_ID: format check only (non-empty) — validating it
 * alone requires the secret, so we defer the live check to the secret step.
 *
 * ADMITAD_ADVERTISER_CLIENT_SECRET: performs a full live token exchange with
 * whatever ADMITAD_ADVERTISER_CLIENT_ID is currently set. Returns ok:false with
 * the upstream error if the exchange fails.
 *
 * ADMITAD_ADVERTISER_ID: format check (positive integer) — no API call needed.
 * This is the advertiser id Admitad uses in the /advertiser/{id}/... path.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'ADMITAD_ADVERTISER_CLIENT_ID') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Client ID must not be empty.',
        hint: 'Copy the Client ID (app id) from your Admitad API application — click "Show credentials".',
      };
    }
    return {
      ok: true,
      message: 'Client ID format OK; will validate against the API after the secret is entered.',
    };
  }

  if (field === 'ADMITAD_ADVERTISER_CLIENT_SECRET') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Client Secret must not be empty.',
        hint: 'Copy the Client Secret (secret key) from your Admitad API application — click "Show credentials".',
      };
    }
    // Temporarily inject the secret so we can exercise the live exchange.
    const prevSecret = process.env['ADMITAD_ADVERTISER_CLIENT_SECRET'];
    process.env['ADMITAD_ADVERTISER_CLIENT_SECRET'] = value;
    try {
      _resetTokenCache(); // ensure we don't hit the cache with stale data
      const result = await verifyAuth();
      if (result.ok) {
        return {
          ok: true,
          message: result.identity ?? 'Credentials verified against the Admitad token endpoint.',
        };
      }
      return {
        ok: false,
        message: result.reason,
        hint: 'Check ADMITAD_ADVERTISER_CLIENT_ID and ADMITAD_ADVERTISER_CLIENT_SECRET, and that the API application has the advertiser_statistics, advertiser_info and advertiser_websites scopes enabled.',
      };
    } finally {
      if (prevSecret === undefined) {
        delete process.env['ADMITAD_ADVERTISER_CLIENT_SECRET'];
      } else {
        process.env['ADMITAD_ADVERTISER_CLIENT_SECRET'] = prevSecret;
      }
      _resetTokenCache();
    }
  }

  if (field === 'ADMITAD_ADVERTISER_ID') {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      return {
        ok: false,
        message: 'Admitad advertiser id must be a positive integer.',
        hint: 'Find your advertiser id in your Admitad advertiser account (it appears in the /advertiser/{id}/ API paths). It scopes every reporting call.',
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Admitad advertiser.`,
    hint: 'Admitad advertiser expects ADMITAD_ADVERTISER_CLIENT_ID, ADMITAD_ADVERTISER_CLIENT_SECRET, and ADMITAD_ADVERTISER_ID.',
  };
}
