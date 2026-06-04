/**
 * Monetizze auth + credential validation.
 *
 * Monetizze uses a single API access key (a "chave de acesso") created in the
 * Monetizze panel under Menu > Ferramentas > API. The key is presented in the
 * `x_consumer_key` header on a token exchange:
 *
 *   POST https://api.monetizze.com.br/2.1/token
 *   x_consumer_key: <API access key>
 *   → { token: "..." }
 *
 * The returned token is sent in the `token` header on subsequent data calls.
 * The token is cached in memory and refreshed automatically.
 *
 * Source: https://help.monetizze.com.br/books/integracoes/page/api-monetizze
 *         https://github.com/Monetizze/ExemploPOSTCallback/issues/18
 *         https://github.com/skaisser/monetizze
 *
 * --- Token cache ---------------------------------------------------------------
 *
 * This is the ONLY module-level mutable state allowed in this adapter folder.
 * The cache avoids a round-trip to the token endpoint on every API call. The
 * `forceRefresh` option is used by the credential validator so a freshly-entered
 * key is tested against the live endpoint even if a cached token exists.
 *
 * --- verifyAuth ----------------------------------------------------------------
 *
 * verifyAuth exchanges the access key for a token (proving the key works) and
 * returns a short identity string. A 401/403 from the token endpoint returns
 * { ok: false } — never throws, because verifyAuth is called by error handlers.
 *
 * BLOCKED(verify): the token-response field name and any token lifetime are not
 * confirmed against the live interactive docs (the apidoc page is JS-rendered
 * and refused automated fetches). The client reads the token field defensively;
 * the cache uses a conservative fixed TTL.
 */

import { fetchToken } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('monetizze.auth');

const SLUG = 'monetizze';

// Conservative cache lifetime. The token lifetime is not documented publicly;
// 10 minutes keeps round-trips low while bounding staleness. BLOCKED(verify).
const TOKEN_TTL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Token cache — the only module-level mutable state in this adapter folder.
// ---------------------------------------------------------------------------

interface TokenCache {
  token: string;
  expiresAt: number; // ms since epoch
}

let tokenCache: TokenCache | null = null;

/**
 * Return a valid account token, refreshing from the Monetizze token endpoint if
 * the cache is empty or expired.
 *
 * `forceRefresh: true` bypasses the cache — used during credential validation
 * when the user has just entered a new key and we want to test it live.
 */
export async function getToken(opts?: { forceRefresh?: boolean }): Promise<string> {
  if (!opts?.forceRefresh && tokenCache && tokenCache.expiresAt > Date.now()) {
    return tokenCache.token;
  }

  const apiKey = requireCredential('MONETIZZE_API_KEY', {
    network: SLUG,
    operation: 'getToken',
    hint: 'Create your API access key in the Monetizze panel: Menu > Ferramentas > API. Set it as MONETIZZE_API_KEY.',
  });

  const result = await fetchToken(apiKey, DEFAULT_RESILIENCE);
  tokenCache = { token: result.token, expiresAt: Date.now() + TOKEN_TTL_MS };

  log.debug('token cache updated');
  return tokenCache.token;
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
 * Verify Monetizze credentials by successfully exchanging the access key for a
 * token.
 *
 * Why token exchange specifically: Monetizze's token endpoint is the cheapest
 * identity-revealing call available with an access key. A successful exchange
 * proves the key is valid; a 401/403 proves it is not.
 *
 * Never throws — returns { ok: false } on any failure so callers (including
 * error handlers) do not loop.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  try {
    requireCredential('MONETIZZE_API_KEY', {
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
    // Force-refresh so this always exercises the live token endpoint.
    await getToken({ forceRefresh: true });
    const identity = 'monetizze/account (API key verified)';
    log.debug({ identity }, 'monetizze verifyAuth succeeded');
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
      hint: 'Check MONETIZZE_API_KEY (created via Menu > Ferramentas > API in the Monetizze panel).',
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
 * MONETIZZE_API_KEY: performs a full live token exchange. Returns ok:false with
 * the upstream error if the exchange fails.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'MONETIZZE_API_KEY') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'API access key must not be empty.',
        hint: 'Create it in the Monetizze panel: Menu > Ferramentas > API.',
      };
    }
    // Temporarily inject the key so we can exercise the live exchange.
    const prev = process.env['MONETIZZE_API_KEY'];
    process.env['MONETIZZE_API_KEY'] = value;
    try {
      _resetTokenCache(); // ensure we don't hit the cache with stale data
      const result = await verifyAuth();
      if (result.ok) {
        return {
          ok: true,
          message: result.identity ?? 'API key verified against the Monetizze token endpoint.',
        };
      }
      return {
        ok: false,
        message: result.reason,
        hint: 'Check the key was copied without leading or trailing spaces. Recreate it via Menu > Ferramentas > API if needed.',
      };
    } finally {
      if (prev === undefined) {
        delete process.env['MONETIZZE_API_KEY'];
      } else {
        process.env['MONETIZZE_API_KEY'] = prev;
      }
      _resetTokenCache();
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Monetizze.`,
    hint: 'Monetizze expects MONETIZZE_API_KEY.',
  };
}
