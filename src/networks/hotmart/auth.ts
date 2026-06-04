/**
 * Hotmart auth + credential validation.
 *
 * Hotmart uses 2-legged OAuth2 (client-credentials grant). The user self-issues
 * a Client ID and Client Secret in the Hotmart dashboard under
 * Tools → Developer Tools (the same page also shows a precomputed "Basic" token,
 * which is just base64(client_id:client_secret)). These are exchanged for a
 * bearer access token via:
 *
 *   POST https://api-sec-vlc.hotmart.com/security/oauth/token
 *     Authorization: Basic {base64(client_id:client_secret)}
 *     ?grant_type=client_credentials&client_id=...&client_secret=...
 *
 * The token is cached in memory and refreshed automatically when it expires.
 * Hotmart documents a 24-hour token lifetime.
 *
 * --- Token cache ---------------------------------------------------------------
 *
 * This is the ONLY module-level mutable state allowed in this adapter folder.
 * The cache avoids a round-trip to the auth server on every API call. The
 * `forceRefresh` option is used by the credential validator so a freshly-entered
 * secret is tested against the live endpoint even if a cached token exists.
 *
 * --- HOTMART_BASIC_TOKEN -------------------------------------------------------
 *
 * The Basic token is OPTIONAL. It is exactly base64(client_id:client_secret),
 * which the adapter computes itself from the id and secret. We accept it as an
 * explicit override only so a user who copies the precomputed value from the
 * Developer Tools page (rather than the raw id/secret) can still authenticate.
 * It carries no information the id+secret do not.
 *
 * --- verifyAuth ----------------------------------------------------------------
 *
 * verifyAuth obtains an access token (proving the credentials work) and returns
 * the client ID as the identity. A 401 from the token endpoint returns
 * { ok: false } — never throws, because verifyAuth is called by error handlers.
 */

import { fetchAccessToken } from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('hotmart.auth');

const SLUG = 'hotmart';

// ---------------------------------------------------------------------------
// Token cache — the only module-level mutable state in this adapter folder.
// ---------------------------------------------------------------------------

interface TokenCache {
  accessToken: string;
  expiresAt: number; // ms since epoch
}

let tokenCache: TokenCache | null = null;

/**
 * Return a valid access token, refreshing from the Hotmart auth endpoint if the
 * cache is empty or within 60 seconds of expiry.
 *
 * `forceRefresh: true` bypasses the cache — used during credential validation
 * when the user has just entered new credentials and we want to test them live.
 */
export async function getAccessToken(opts?: { forceRefresh?: boolean }): Promise<string> {
  if (!opts?.forceRefresh && tokenCache && tokenCache.expiresAt > Date.now()) {
    return tokenCache.accessToken;
  }

  const clientId = requireCredential('HOTMART_CLIENT_ID', {
    network: SLUG,
    operation: 'getAccessToken',
    hint: 'Log in to Hotmart → Tools → Developer Tools and copy the Client ID.',
  });
  const clientSecret = requireCredential('HOTMART_CLIENT_SECRET', {
    network: SLUG,
    operation: 'getAccessToken',
    hint: 'Log in to Hotmart → Tools → Developer Tools and copy the Client Secret.',
  });
  // Optional: the precomputed Basic token. When absent the client derives it
  // from id+secret, so this is never required.
  const basicToken = getCredential('HOTMART_BASIC_TOKEN');

  const result = await fetchAccessToken(
    clientId,
    clientSecret,
    DEFAULT_RESILIENCE,
    basicToken ?? undefined,
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

/**
 * Verify Hotmart credentials by successfully obtaining an OAuth2 access token.
 *
 * Why token exchange specifically: Hotmart's 2-legged OAuth has no cheap
 * /me endpoint that returns account identity without already knowing an id; the
 * act of exchanging credentials for a token IS the authentication check. A
 * successful exchange proves the client_id + client_secret are valid; a 401
 * proves they are not.
 *
 * Never throws — returns { ok: false } on any failure so callers (including
 * error handlers) do not loop.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let clientId: string;
  try {
    clientId = requireCredential('HOTMART_CLIENT_ID', {
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

    const identity = `hotmart/client:${clientId}`;
    log.debug({ identity }, 'hotmart verifyAuth succeeded');
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
      hint: 'Check HOTMART_CLIENT_ID and HOTMART_CLIENT_SECRET in your config.',
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
 * HOTMART_CLIENT_ID: format check only (non-empty string) — validating it alone
 * requires the secret, so we defer the live check to the secret step.
 *
 * HOTMART_CLIENT_SECRET: performs a full live token exchange with whatever
 * HOTMART_CLIENT_ID is currently set in the environment. Returns ok:false with
 * the upstream error if the exchange fails.
 *
 * HOTMART_BASIC_TOKEN: optional. Format check only (non-empty base64-ish). It is
 * never required because the adapter derives it from the id and secret.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'HOTMART_CLIENT_ID') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Client ID must not be empty.',
        hint: 'Copy the Client ID from Hotmart → Tools → Developer Tools.',
      };
    }
    return {
      ok: true,
      message: 'Client ID format OK; will validate against the API after the secret is entered.',
    };
  }

  if (field === 'HOTMART_CLIENT_SECRET') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Client Secret must not be empty.',
        hint: 'Copy the Client Secret from Hotmart → Tools → Developer Tools.',
      };
    }
    // Temporarily inject the secret so we can exercise the live exchange.
    const prevSecret = process.env['HOTMART_CLIENT_SECRET'];
    process.env['HOTMART_CLIENT_SECRET'] = value;
    try {
      _resetTokenCache(); // ensure we don't hit the cache with stale data
      const result = await verifyAuth();
      if (result.ok) {
        return {
          ok: true,
          message: result.identity ?? 'Credentials verified against Hotmart OAuth endpoint.',
        };
      }
      return {
        ok: false,
        message: result.reason,
        hint: 'Check HOTMART_CLIENT_ID and HOTMART_CLIENT_SECRET. Both must match the values in Hotmart → Tools → Developer Tools.',
      };
    } finally {
      if (prevSecret === undefined) {
        delete process.env['HOTMART_CLIENT_SECRET'];
      } else {
        process.env['HOTMART_CLIENT_SECRET'] = prevSecret;
      }
      _resetTokenCache();
    }
  }

  if (field === 'HOTMART_BASIC_TOKEN') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Basic token must not be empty if provided.',
        hint:
          'The Basic token is OPTIONAL — it is base64(client_id:client_secret), which the ' +
          'adapter computes itself. Only set it if you prefer to paste the precomputed value ' +
          'shown on the Developer Tools page.',
      };
    }
    return {
      ok: true,
      message: 'Basic token format OK (optional; the adapter can derive it from id and secret).',
    };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Hotmart.`,
    hint: 'Hotmart expects HOTMART_CLIENT_ID, HOTMART_CLIENT_SECRET, and optionally HOTMART_BASIC_TOKEN.',
  };
}
