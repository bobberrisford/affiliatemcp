/**
 * Skimlinks auth + credential validation.
 *
 * Skimlinks uses OAuth2 client-credentials grant. The publisher supplies a
 * Client ID and Client Secret (obtained from Skimlinks Hub → Toolbox → API →
 * API Authentication Credentials). These are exchanged for a short-lived bearer
 * access token via:
 *
 *   POST https://authentication.skimapis.com/access_token
 *   Content-Type: application/x-www-form-urlencoded
 *   Body: grant_type=client_credentials&client_id=...&client_secret=...
 *
 * The token is cached in memory and refreshed automatically when it expires.
 *
 * --- Token cache ---------------------------------------------------------------
 *
 * This is the ONLY module-level mutable state allowed in this adapter folder.
 * The cache avoids a round-trip to the auth server on every API call. The
 * `forceRefresh` option is used by the credential validator so a freshly-entered
 * secret is tested against the live endpoint even if a cached token exists.
 *
 * --- Credential derivation -----------------------------------------------------
 *
 * Skimlinks requires a Publisher ID for most Reporting API calls. Unlike Awin
 * (where the publisher ID can be auto-derived from the token), Skimlinks does not
 * expose a /me-style endpoint that returns the publisher ID from the token alone.
 * The publisher must supply SKIMLINKS_PUBLISHER_ID explicitly. It is available in
 * the Skimlinks Hub dashboard.
 *
 * --- verifyAuth ----------------------------------------------------------------
 *
 * verifyAuth obtains an access token (proving the credentials work) and returns
 * the publisher ID as the identity. A 401 from the token endpoint returns
 * { ok: false } — never throws, because verifyAuth is called by error handlers.
 */

import { fetchAccessToken } from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('skimlinks.auth');

const SLUG = 'skimlinks';

// ---------------------------------------------------------------------------
// Token cache — the only module-level mutable state in this adapter folder.
// ---------------------------------------------------------------------------

interface TokenCache {
  accessToken: string;
  expiresAt: number; // ms since epoch
}

let tokenCache: TokenCache | null = null;

/**
 * Return a valid access token, refreshing from the Skimlinks auth endpoint if
 * the cache is empty or within 60 seconds of expiry.
 *
 * `forceRefresh: true` bypasses the cache — used during credential validation
 * when the user has just entered new credentials and we want to test them live.
 */
export async function getAccessToken(opts?: { forceRefresh?: boolean }): Promise<string> {
  if (!opts?.forceRefresh && tokenCache && tokenCache.expiresAt > Date.now()) {
    return tokenCache.accessToken;
  }

  const clientId = requireCredential('SKIMLINKS_CLIENT_ID', {
    network: SLUG,
    operation: 'getAccessToken',
    hint: 'Log in at https://hub.skimlinks.com → Toolbox → API → API Authentication Credentials.',
  });
  const clientSecret = requireCredential('SKIMLINKS_CLIENT_SECRET', {
    network: SLUG,
    operation: 'getAccessToken',
    hint: 'Log in at https://hub.skimlinks.com → Toolbox → API → API Authentication Credentials.',
  });

  const result = await fetchAccessToken(clientId, clientSecret, DEFAULT_RESILIENCE);
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

/**
 * Verify Skimlinks credentials by successfully obtaining an OAuth2 access token.
 *
 * Why token exchange specifically: Skimlinks does not have a low-cost /me endpoint
 * accessible with publisher-tier credentials; the act of exchanging credentials
 * for a token IS the authentication check. A successful exchange proves the
 * client_id + client_secret are valid; a 401 proves they are not.
 *
 * The publisher ID is returned as the identity string — this is what the user
 * sees in the setup wizard's confirmation message.
 *
 * Never throws — returns { ok: false } on any failure so callers (including
 * error handlers) do not loop.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let clientId: string;
  try {
    clientId = requireCredential('SKIMLINKS_CLIENT_ID', {
      network: SLUG,
      operation: 'verifyAuth',
    });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    // Force-refresh so this always exercises the live auth endpoint.
    await getAccessToken({ forceRefresh: true });

    const publisherId = getCredential('SKIMLINKS_PUBLISHER_ID');
    const identity = publisherId
      ? `skimlinks/publisher:${publisherId} (client:${clientId})`
      : `skimlinks/client:${clientId} (publisher ID not yet set)`;

    log.debug({ identity }, 'skimlinks verifyAuth succeeded');
    return { ok: true, identity };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'auth_error',
      network: SLUG,
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
      hint: 'Check SKIMLINKS_CLIENT_ID and SKIMLINKS_CLIENT_SECRET in your config.',
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

// ---------------------------------------------------------------------------
// Credential validation
// ---------------------------------------------------------------------------

/**
 * Validate a single credential field at wizard-entry time.
 *
 * SKIMLINKS_CLIENT_ID: format check only (non-empty string) — validating it
 * alone requires the secret, so we defer the live check to the secret step.
 *
 * SKIMLINKS_CLIENT_SECRET: performs a full live token exchange with whatever
 * SKIMLINKS_CLIENT_ID is currently set in the environment (or the one passed
 * alongside). Returns ok:false with the upstream error if the exchange fails.
 *
 * SKIMLINKS_PUBLISHER_ID: format check (positive integer) — no API call needed.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'SKIMLINKS_CLIENT_ID') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Client ID must not be empty.',
        hint: 'Copy the Client ID from Skimlinks Hub → Toolbox → API → API Authentication Credentials.',
      };
    }
    return {
      ok: true,
      message: 'Client ID format OK; will validate against the API after the secret is entered.',
    };
  }

  if (field === 'SKIMLINKS_CLIENT_SECRET') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Client Secret must not be empty.',
        hint: 'Copy the Client Secret from Skimlinks Hub → Toolbox → API → API Authentication Credentials.',
      };
    }
    // Temporarily inject both credentials so we can exercise the live exchange.
    const prevSecret = process.env['SKIMLINKS_CLIENT_SECRET'];
    process.env['SKIMLINKS_CLIENT_SECRET'] = value;
    try {
      _resetTokenCache(); // ensure we don't hit the cache with stale data
      const result = await verifyAuth();
      if (result.ok) {
        return {
          ok: true,
          message: result.identity ?? 'Credentials verified against Skimlinks auth endpoint.',
        };
      }
      return {
        ok: false,
        message: result.reason,
        hint: 'Check SKIMLINKS_CLIENT_ID and SKIMLINKS_CLIENT_SECRET. Both must match the values in Skimlinks Hub → Toolbox → API.',
      };
    } finally {
      if (prevSecret === undefined) {
        delete process.env['SKIMLINKS_CLIENT_SECRET'];
      } else {
        process.env['SKIMLINKS_CLIENT_SECRET'] = prevSecret;
      }
      _resetTokenCache();
    }
  }

  if (field === 'SKIMLINKS_PUBLISHER_ID') {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      return {
        ok: false,
        message: 'Skimlinks Publisher ID must be a positive integer.',
        hint: 'Find your Publisher ID in the Skimlinks Hub dashboard URL or under Account settings.',
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Skimlinks.`,
    hint: 'Skimlinks expects SKIMLINKS_CLIENT_ID, SKIMLINKS_CLIENT_SECRET, and SKIMLINKS_PUBLISHER_ID.',
  };
}
