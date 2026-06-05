/**
 * Daisycon advertiser auth + credential validation.
 *
 * Daisycon's advertiser surface uses the SAME OAuth2 flow as the publisher
 * surface (`src/networks/daisycon/auth.ts`): the account holder self-creates
 * OAuth credentials (Client ID + Client Secret) in the Daisycon console, then
 * completes a one-time authorization_code + PKCE consent to obtain a refresh
 * token. This adapter exchanges that refresh token for short-lived access
 * tokens via:
 *
 *   POST https://login.daisycon.com/oauth/access-token
 *   Content-Type: application/x-www-form-urlencoded
 *   Body: grant_type=refresh_token&client_id=...&client_secret=...&refresh_token=...
 *
 *   Source: https://github.com/DaisyconBV/oauth-examples (cli-client.php)
 *           https://github.com/aiwha-dev/DaisyconApi (RestClient.php — same
 *             token endpoint + Bearer header against services.daisycon.com)
 *
 * The advertiser side is addressed by an advertiser id in the path
 * (`/advertisers/{advertiserId}/...`); the credential is multi-brand because a
 * single OAuth credential can address every advertiser account the user is
 * connected to. The advertiser ids are NOT carried in env — they are
 * discovered via `listBrands()` (GET /advertisers) and threaded back in as
 * `ctx.networkBrandId`. This mirrors the Awin / Impact advertiser adapters.
 *
 * --- Token cache ---------------------------------------------------------------
 *
 * This is the ONLY module-level mutable state allowed in this adapter folder.
 * The cache is INDEPENDENT of the publisher Daisycon adapter's cache so the two
 * adapters never share tokens or env vars. `forceRefresh` is used by the
 * credential validator so freshly-entered credentials are tested live even when
 * a cached token exists.
 *
 * --- verifyAuth ----------------------------------------------------------------
 *
 * verifyAuth obtains an access token (proving the credentials work). A failure
 * returns { ok: false } — it never throws, because verifyAuth is called by
 * error handlers.
 */

import { fetchAccessToken } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('daisycon-advertiser.auth');

export const SLUG = 'daisycon-advertiser';

// ---------------------------------------------------------------------------
// Token cache — the only module-level mutable state in this adapter folder.
// ---------------------------------------------------------------------------

interface TokenCache {
  accessToken: string;
  expiresAt: number; // ms since epoch
}

let tokenCache: TokenCache | null = null;

/**
 * Return a valid access token, refreshing from the Daisycon OAuth endpoint if
 * the cache is empty or expired.
 *
 * `forceRefresh: true` bypasses the cache — used during credential validation
 * when the user has just entered new credentials and we want to test them live.
 */
export async function getAccessToken(opts?: { forceRefresh?: boolean }): Promise<string> {
  if (!opts?.forceRefresh && tokenCache && tokenCache.expiresAt > Date.now()) {
    return tokenCache.accessToken;
  }

  const clientId = requireCredential('DAISYCON_ADVERTISER_CLIENT_ID', {
    network: SLUG,
    operation: 'getAccessToken',
    hint: 'Create OAuth credentials in the Daisycon console under Settings → API / OAuth.',
  });
  const clientSecret = requireCredential('DAISYCON_ADVERTISER_CLIENT_SECRET', {
    network: SLUG,
    operation: 'getAccessToken',
    hint: 'Create OAuth credentials in the Daisycon console under Settings → API / OAuth.',
  });
  const refreshToken = requireCredential('DAISYCON_ADVERTISER_REFRESH_TOKEN', {
    network: SLUG,
    operation: 'getAccessToken',
    hint: 'Obtain a refresh token via the one-time Daisycon OAuth authorisation step (see docs/networks/daisycon-advertiser.md).',
  });

  const result = await fetchAccessToken(clientId, clientSecret, refreshToken, DEFAULT_RESILIENCE);
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
 * Verify Daisycon advertiser credentials by successfully obtaining an OAuth2
 * access token.
 *
 * Why token exchange specifically: it is the cheapest call that conclusively
 * proves the credentials work. A successful refresh_token exchange proves the
 * client_id + client_secret + refresh_token are valid; a 401 proves they are not.
 *
 * Never throws — returns { ok: false } on any failure so callers (including
 * error handlers) do not loop.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let clientId: string;
  try {
    clientId = requireCredential('DAISYCON_ADVERTISER_CLIENT_ID', {
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

    const identity = `daisycon-advertiser/client:${clientId}`;
    log.debug({ identity }, 'daisycon-advertiser verifyAuth succeeded');
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
      hint: 'Check DAISYCON_ADVERTISER_CLIENT_ID, DAISYCON_ADVERTISER_CLIENT_SECRET and DAISYCON_ADVERTISER_REFRESH_TOKEN in your config.',
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
 * DAISYCON_ADVERTISER_CLIENT_ID: format check only (non-empty) — validating it
 * alone requires the secret and refresh token, so we defer the live check.
 *
 * DAISYCON_ADVERTISER_CLIENT_SECRET / DAISYCON_ADVERTISER_REFRESH_TOKEN:
 * perform a full live token exchange with whatever credentials are currently
 * set in the environment.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'DAISYCON_ADVERTISER_CLIENT_ID') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Client ID must not be empty.',
        hint: 'Copy the Client ID from the OAuth credentials you created in the Daisycon console.',
      };
    }
    return {
      ok: true,
      message:
        'Client ID format OK; will validate against the API after the secret and refresh token are entered.',
    };
  }

  if (
    field === 'DAISYCON_ADVERTISER_CLIENT_SECRET' ||
    field === 'DAISYCON_ADVERTISER_REFRESH_TOKEN'
  ) {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: `${
          field === 'DAISYCON_ADVERTISER_CLIENT_SECRET' ? 'Client Secret' : 'Refresh Token'
        } must not be empty.`,
        hint: 'Copy the value without leading or trailing spaces.',
      };
    }
    // Temporarily inject this credential so we can exercise the live exchange.
    const prev = process.env[field];
    process.env[field] = value;
    try {
      _resetTokenCache(); // ensure we don't hit the cache with stale data
      const result = await verifyAuth();
      if (result.ok) {
        return {
          ok: true,
          message: result.identity ?? 'Credentials verified against Daisycon OAuth endpoint.',
        };
      }
      return {
        ok: false,
        message: result.reason,
        hint: 'Check DAISYCON_ADVERTISER_CLIENT_ID, DAISYCON_ADVERTISER_CLIENT_SECRET and DAISYCON_ADVERTISER_REFRESH_TOKEN all match the values from the Daisycon console.',
      };
    } finally {
      if (prev === undefined) {
        delete process.env[field];
      } else {
        process.env[field] = prev;
      }
      _resetTokenCache();
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Daisycon advertiser.`,
    hint: 'Daisycon advertiser expects DAISYCON_ADVERTISER_CLIENT_ID, DAISYCON_ADVERTISER_CLIENT_SECRET, and DAISYCON_ADVERTISER_REFRESH_TOKEN.',
  };
}
