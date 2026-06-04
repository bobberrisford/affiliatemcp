/**
 * Admitad auth + credential validation.
 *
 * Admitad uses an OAuth2 client_credentials grant. The account holder
 * self-registers an API application in their personal account ("Show
 * credentials") to obtain a Client ID (app id) and Client Secret (secret key).
 * These are exchanged for a short-lived bearer access token via:
 *
 *   POST https://api.admitad.com/token/
 *   Authorization: Basic base64(client_id:client_secret)
 *   Content-Type: application/x-www-form-urlencoded
 *   Body: grant_type=client_credentials&client_id=...&scope=<space-separated scopes>
 *
 * The token is cached in memory and refreshed automatically when it expires.
 *
 * --- Why client_credentials (not password / authorization_code) ----------------
 *
 * Admitad supports client_credentials, password, and authorization_code grants.
 * client_credentials is the simplest self-serve flow that yields a token for
 * reading the account holder's OWN statistics: no end-user redirect, no separate
 * user password. The publisher registers their own application and reads their
 * own data, which is exactly the local-first, single-account model this project
 * uses. Source:
 * https://developers.admitad.com/knowledge-base/article/client-authorization_2
 *
 * --- Scopes --------------------------------------------------------------------
 *
 * Each endpoint requires a specific scope, requested together in one token call:
 *   - statistics         → /statistics/actions/, /statistics/dates/
 *   - advcampaigns       → /advcampaigns/ (listProgrammes / getProgramme)
 *   - deeplink_generator → /deeplink/.../ (generateTrackingLink)
 *   - private_data       → /me/ (identity for verifyAuth)
 * Sources: trezorg/admitad-python-api pyadmitad/items/{statistics,campaigns,me}.py
 *          https://developers.admitad.com/knowledge-base/article/deeplink-generator_1
 *
 * --- Token cache ---------------------------------------------------------------
 *
 * This is the ONLY module-level mutable state allowed in this adapter folder.
 * The cache avoids a round-trip to the token endpoint on every API call. The
 * `forceRefresh` option is used by the credential validator so a freshly-entered
 * secret is tested against the live endpoint even if a cached token exists.
 *
 * --- verifyAuth ----------------------------------------------------------------
 *
 * verifyAuth obtains an access token (proving the credentials work) and then
 * reads /me/ for an identity string. A 401 from the token endpoint returns
 * { ok: false } — never throws, because verifyAuth is called by error handlers.
 */

import { fetchAccessToken, admitadRequest } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('admitad.auth');

const SLUG = 'admitad';

/**
 * Scopes requested in a single client_credentials token exchange. Requesting
 * them together avoids one token per operation. If the API application does not
 * have a scope enabled, Admitad returns an auth error which surfaces verbatim.
 */
export const ADMITAD_SCOPES = 'statistics advcampaigns deeplink_generator private_data';

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

  const clientId = requireCredential('ADMITAD_CLIENT_ID', {
    network: SLUG,
    operation: 'getAccessToken',
    hint: 'Register an API application in your Admitad account and click "Show credentials" to copy the Client ID (app id).',
  });
  const clientSecret = requireCredential('ADMITAD_CLIENT_SECRET', {
    network: SLUG,
    operation: 'getAccessToken',
    hint: 'Register an API application in your Admitad account and click "Show credentials" to copy the Client Secret (secret key).',
  });

  const result = await fetchAccessToken(clientId, clientSecret, ADMITAD_SCOPES, DEFAULT_RESILIENCE);
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
  first_name?: string;
  last_name?: string;
}

/**
 * Verify Admitad credentials by obtaining an OAuth2 access token and reading /me/.
 *
 * A successful token exchange proves the client_id + client_secret are valid; a
 * 401 proves they are not. We then call /me/ (scope: private_data) for a friendly
 * identity string. If /me/ fails but the token exchange succeeded, we still report
 * success with a token-only identity — the data plane scopes are validated by the
 * actual operations.
 *
 * Never throws — returns { ok: false } on any failure so callers (including error
 * handlers) do not loop.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let clientId: string;
  try {
    clientId = requireCredential('ADMITAD_CLIENT_ID', {
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
      hint: 'Check ADMITAD_CLIENT_ID and ADMITAD_CLIENT_SECRET in your config.',
    });
    return { ok: false, reason: envelope.message, envelope };
  }

  // Read /me/ for a friendly identity. A failure here does not invalidate the
  // credentials (the token exchange already succeeded), so we fall back to a
  // token-only identity rather than reporting auth failure.
  try {
    const me = await admitadRequest<AdmitadMeResponse>({
      operation: 'verifyAuth',
      path: '/me/',
      token,
      resilience: DEFAULT_RESILIENCE,
    });
    const who = me.username ?? me.email ?? (me.id !== undefined ? String(me.id) : undefined);
    const identity = who
      ? `admitad/${who} (client:${clientId})`
      : `admitad/client:${clientId}`;
    log.debug({ identity }, 'admitad verifyAuth succeeded');
    return { ok: true, identity };
  } catch (err) {
    log.debug({ err: err instanceof Error ? err.message : String(err) }, 'admitad /me/ probe failed; reporting token-only identity');
    return { ok: true, identity: `admitad/client:${clientId} (identity lookup unavailable)` };
  }
}

// ---------------------------------------------------------------------------
// Credential validation
// ---------------------------------------------------------------------------

/**
 * Validate a single credential field at wizard-entry time.
 *
 * ADMITAD_CLIENT_ID: format check only (non-empty) — validating it alone requires
 * the secret, so we defer the live check to the secret step.
 *
 * ADMITAD_CLIENT_SECRET: performs a full live token exchange with whatever
 * ADMITAD_CLIENT_ID is currently set. Returns ok:false with the upstream error
 * if the exchange fails.
 *
 * ADMITAD_WEBSITE_ID: format check (positive integer) — no API call needed.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'ADMITAD_CLIENT_ID') {
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

  if (field === 'ADMITAD_CLIENT_SECRET') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Client Secret must not be empty.',
        hint: 'Copy the Client Secret (secret key) from your Admitad API application — click "Show credentials".',
      };
    }
    // Temporarily inject the secret so we can exercise the live exchange.
    const prevSecret = process.env['ADMITAD_CLIENT_SECRET'];
    process.env['ADMITAD_CLIENT_SECRET'] = value;
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
        hint: 'Check ADMITAD_CLIENT_ID and ADMITAD_CLIENT_SECRET, and that the API application has the statistics, advcampaigns, deeplink_generator and private_data scopes enabled.',
      };
    } finally {
      if (prevSecret === undefined) {
        delete process.env['ADMITAD_CLIENT_SECRET'];
      } else {
        process.env['ADMITAD_CLIENT_SECRET'] = prevSecret;
      }
      _resetTokenCache();
    }
  }

  if (field === 'ADMITAD_WEBSITE_ID') {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      return {
        ok: false,
        message: 'Admitad Website ID must be a positive integer.',
        hint: 'Find your ad space (website) ID in your Admitad account under your connected ad spaces. It is required for deeplink generation.',
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Admitad.`,
    hint: 'Admitad expects ADMITAD_CLIENT_ID, ADMITAD_CLIENT_SECRET, and ADMITAD_WEBSITE_ID.',
  };
}
