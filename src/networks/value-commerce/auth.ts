/**
 * ValueCommerce auth + credential validation.
 *
 * ValueCommerce issues a "report API authentication key" pair — a CLIENT_KEY and
 * a CLIENT_SECRET — from the management console. These are joined with a pipe and
 * Base64-encoded to form the signature for the token-acquisition request:
 *
 *   GET https://api.valuecommerce.com/auth/v1/affiliate/token/?grant_type=client_credentials
 *   Authorization: Bearer {Base64(CLIENT_KEY|CLIENT_SECRET)}
 *   → { access_token, token_type, expires_in }   (token valid 30 minutes)
 *
 * To self-issue the key pair: management console → ［ツール］>［レポートAPI］>
 * agree to the terms and click "API認証キーを発行する", then read CLIENT_KEY and
 * CLIENT_SECRET from ［設定］>［レポートAPI認証キーの取得］. Only the contract owner
 * or a sub-contract owner can issue the key.
 *   Source: https://help.valuecommerce.ne.jp/aff/tool/api/02/
 *
 * --- Token cache ---------------------------------------------------------------
 *
 * The bearer token is short-lived (30 minutes). It is cached in memory and
 * refreshed automatically on expiry. This is the ONLY module-level mutable state
 * allowed in this adapter folder. The `forceRefresh` option lets the credential
 * validator test a freshly-entered secret against the live endpoint even if a
 * cached token exists.
 *
 * --- verifyAuth ----------------------------------------------------------------
 *
 * verifyAuth obtains an access token (proving the credentials work) and returns
 * the CLIENT_KEY as the identity string. A 401 from the token endpoint returns
 * { ok: false } — it never throws, because verifyAuth is called by error handlers.
 */

import { fetchAccessToken } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('value-commerce.auth');

const SLUG = 'value-commerce';

const CONSOLE_HINT =
  'Issue your report API authentication key in the ValueCommerce console: ' +
  'Tools (ツール) → Report API (レポートAPI) → "API認証キーを発行する", then read ' +
  'CLIENT_KEY and CLIENT_SECRET from Settings (設定) → Report API auth key ' +
  '(レポートAPI認証キーの取得).';

// ---------------------------------------------------------------------------
// Token cache — the only module-level mutable state in this adapter folder.
// ---------------------------------------------------------------------------

interface TokenCache {
  accessToken: string;
  expiresAt: number; // ms since epoch
}

let tokenCache: TokenCache | null = null;

/**
 * Return a valid access token, refreshing from the ValueCommerce token endpoint
 * if the cache is empty or within 60 seconds of expiry.
 *
 * `forceRefresh: true` bypasses the cache — used during credential validation
 * when the user has just entered new credentials and we want to test them live.
 */
export async function getAccessToken(opts?: { forceRefresh?: boolean }): Promise<string> {
  if (!opts?.forceRefresh && tokenCache && tokenCache.expiresAt > Date.now()) {
    return tokenCache.accessToken;
  }

  const clientKey = requireCredential('VALUE_COMMERCE_CLIENT_KEY', {
    network: SLUG,
    operation: 'getAccessToken',
    hint: CONSOLE_HINT,
  });
  const clientSecret = requireCredential('VALUE_COMMERCE_CLIENT_SECRET', {
    network: SLUG,
    operation: 'getAccessToken',
    hint: CONSOLE_HINT,
  });

  const result = await fetchAccessToken(clientKey, clientSecret, DEFAULT_RESILIENCE);
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
 * Verify ValueCommerce credentials by successfully obtaining an access token.
 *
 * Why token acquisition specifically: it is the cheapest call that proves the
 * CLIENT_KEY + CLIENT_SECRET are valid. A successful exchange proves the key pair;
 * a 401 ("invalid_client" / "invalid_token") proves it is wrong.
 *
 * Never throws — returns { ok: false } on any failure so callers (including error
 * handlers) do not loop.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let clientKey: string;
  try {
    clientKey = requireCredential('VALUE_COMMERCE_CLIENT_KEY', {
      network: SLUG,
      operation: 'verifyAuth',
      hint: CONSOLE_HINT,
    });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    // Force-refresh so this always exercises the live token endpoint.
    await getAccessToken({ forceRefresh: true });
    const identity = `value-commerce/client:${clientKey}`;
    log.debug({ identity }, 'value-commerce verifyAuth succeeded');
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
      hint: CONSOLE_HINT,
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
 * VALUE_COMMERCE_CLIENT_KEY: format check only (non-empty string) — validating it
 * alone requires the secret, so the live check is deferred to the secret step.
 *
 * VALUE_COMMERCE_CLIENT_SECRET: performs a full live token acquisition with
 * whatever VALUE_COMMERCE_CLIENT_KEY is currently set in the environment. Returns
 * ok:false with the upstream error if acquisition fails.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'VALUE_COMMERCE_CLIENT_KEY') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'CLIENT_KEY must not be empty.',
        hint: CONSOLE_HINT,
      };
    }
    return {
      ok: true,
      message: 'CLIENT_KEY format OK; will validate against the API after the secret is entered.',
    };
  }

  if (field === 'VALUE_COMMERCE_CLIENT_SECRET') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'CLIENT_SECRET must not be empty.',
        hint: CONSOLE_HINT,
      };
    }
    // Temporarily inject the secret so we can exercise the live token request.
    const prevSecret = process.env['VALUE_COMMERCE_CLIENT_SECRET'];
    process.env['VALUE_COMMERCE_CLIENT_SECRET'] = value;
    try {
      _resetTokenCache(); // ensure we don't hit the cache with stale data
      const result = await verifyAuth();
      if (result.ok) {
        return {
          ok: true,
          message: result.identity ?? 'Credentials verified against the ValueCommerce token endpoint.',
        };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check VALUE_COMMERCE_CLIENT_KEY and VALUE_COMMERCE_CLIENT_SECRET. Both must match the ' +
          'values shown in Settings → Report API auth key (レポートAPI認証キーの取得).',
      };
    } finally {
      if (prevSecret === undefined) {
        delete process.env['VALUE_COMMERCE_CLIENT_SECRET'];
      } else {
        process.env['VALUE_COMMERCE_CLIENT_SECRET'] = prevSecret;
      }
      _resetTokenCache();
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for ValueCommerce.`,
    hint: 'ValueCommerce expects VALUE_COMMERCE_CLIENT_KEY and VALUE_COMMERCE_CLIENT_SECRET.',
  };
}
