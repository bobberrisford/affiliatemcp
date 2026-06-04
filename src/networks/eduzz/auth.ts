/**
 * Eduzz auth + credential validation.
 *
 * Eduzz uses a token-exchange scheme on the legacy api2 host. The publisher
 * (affiliate / producer) supplies three values found in their Eduzz account:
 *
 *   - EDUZZ_EMAIL       — the account email
 *   - EDUZZ_PUBLIC_KEY  — the account PublicKey
 *   - EDUZZ_API_KEY     — the account APIKey
 *
 * These are exchanged for a short-lived JWT via:
 *
 *   POST https://api2.eduzz.com/credential/generate_token
 *   Content-Type: application/x-www-form-urlencoded
 *   Body: email=...&publickey=...&apikey=...
 *
 * The JWT (returned in `profile.token`) is valid for ~15 minutes and is sent as
 * the `token` header on every subsequent request. The token is cached in memory
 * and refreshed automatically when it expires.
 *
 * --- Token cache ---------------------------------------------------------------
 *
 * This is the ONLY module-level mutable state allowed in this adapter folder.
 * The cache avoids a round-trip to the token endpoint on every API call. The
 * `forceRefresh` option is used by the credential validator so freshly-entered
 * credentials are tested against the live endpoint even if a cached token exists.
 *
 * --- verifyAuth ----------------------------------------------------------------
 *
 * verifyAuth obtains a token (proving the credentials work) and returns the
 * configured email as the identity. A failed exchange returns { ok: false } —
 * never throws, because verifyAuth is called by error handlers.
 */

import { fetchToken } from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('eduzz.auth');

const SLUG = 'eduzz';

const SETUP_HINT =
  'Find your PublicKey and APIKey in the Eduzz panel under Ferramentas → API ' +
  '(or My Eduzz → Integrations → API). EDUZZ_EMAIL is your account login email.';

// ---------------------------------------------------------------------------
// Token cache — the only module-level mutable state in this adapter folder.
// ---------------------------------------------------------------------------

interface TokenCache {
  token: string;
  expiresAt: number; // ms since epoch
}

let tokenCache: TokenCache | null = null;

/**
 * Return a valid JWT token, refreshing from the Eduzz token endpoint if the
 * cache is empty or already expired.
 *
 * `forceRefresh: true` bypasses the cache — used during credential validation
 * when the user has just entered new credentials and we want to test them live.
 */
export async function getToken(opts?: { forceRefresh?: boolean }): Promise<string> {
  if (!opts?.forceRefresh && tokenCache && tokenCache.expiresAt > Date.now()) {
    return tokenCache.token;
  }

  const email = requireCredential('EDUZZ_EMAIL', {
    network: SLUG,
    operation: 'getToken',
    hint: SETUP_HINT,
  });
  const publicKey = requireCredential('EDUZZ_PUBLIC_KEY', {
    network: SLUG,
    operation: 'getToken',
    hint: SETUP_HINT,
  });
  const apiKey = requireCredential('EDUZZ_API_KEY', {
    network: SLUG,
    operation: 'getToken',
    hint: SETUP_HINT,
  });

  const result = await fetchToken(email, publicKey, apiKey, DEFAULT_RESILIENCE);
  tokenCache = { token: result.token, expiresAt: result.expiresAt };

  log.debug({ expiresAt: new Date(result.expiresAt).toISOString() }, 'token cache updated');
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
 * Verify Eduzz credentials by successfully obtaining a JWT token.
 *
 * Why token exchange specifically: a successful exchange proves the
 * email + PublicKey + APIKey triple is valid; a 401/403 proves it is not. The
 * legacy api2 host does not expose a cheap, publisher-tier identity endpoint
 * that adds information beyond the token exchange itself, so the exchange IS the
 * authentication check.
 *
 * The configured email is returned as the identity string — this is what the
 * user sees in the setup wizard's confirmation message.
 *
 * Never throws — returns { ok: false } on any failure so callers (including
 * error handlers) do not loop.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let email: string;
  try {
    email = requireCredential('EDUZZ_EMAIL', {
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

    const identity = `eduzz/account:${email}`;
    log.debug({ identity }, 'eduzz verifyAuth succeeded');
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
      hint: 'Check EDUZZ_EMAIL, EDUZZ_PUBLIC_KEY and EDUZZ_API_KEY in your config.',
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
 * EDUZZ_EMAIL: format check only (looks like an email). Validating it alone
 * requires the keys, so we defer the live check to the EDUZZ_API_KEY step.
 *
 * EDUZZ_PUBLIC_KEY: format check only (non-empty). Live check deferred to the
 * API key step (the token endpoint needs all three values at once).
 *
 * EDUZZ_API_KEY: performs a full live token exchange with whatever EDUZZ_EMAIL
 * and EDUZZ_PUBLIC_KEY are currently set in the environment (or the value passed
 * alongside). Returns ok:false with the upstream error if the exchange fails.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'EDUZZ_EMAIL') {
    if (!value || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())) {
      return {
        ok: false,
        message: 'EDUZZ_EMAIL must be a valid email address.',
        hint: 'Use the email you log in to Eduzz with.',
      };
    }
    return {
      ok: true,
      message: 'Email format OK; will validate against the API after the API key is entered.',
    };
  }

  if (field === 'EDUZZ_PUBLIC_KEY') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'EDUZZ_PUBLIC_KEY must not be empty.',
        hint: 'Copy the PublicKey from the Eduzz panel under Ferramentas → API.',
      };
    }
    return {
      ok: true,
      message: 'PublicKey format OK; will validate against the API after the API key is entered.',
    };
  }

  if (field === 'EDUZZ_API_KEY') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'EDUZZ_API_KEY must not be empty.',
        hint: 'Copy the APIKey from the Eduzz panel under Ferramentas → API.',
      };
    }
    // Temporarily inject the API key so we can exercise the live exchange.
    const prevApiKey = process.env['EDUZZ_API_KEY'];
    process.env['EDUZZ_API_KEY'] = value;
    try {
      _resetTokenCache(); // ensure we don't hit the cache with stale data
      const result = await verifyAuth();
      if (result.ok) {
        return {
          ok: true,
          message: result.identity ?? 'Credentials verified against the Eduzz token endpoint.',
        };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check EDUZZ_EMAIL, EDUZZ_PUBLIC_KEY and EDUZZ_API_KEY. ' +
          'All three must match the values in the Eduzz panel (Ferramentas → API).',
      };
    } finally {
      if (prevApiKey === undefined) {
        delete process.env['EDUZZ_API_KEY'];
      } else {
        process.env['EDUZZ_API_KEY'] = prevApiKey;
      }
      _resetTokenCache();
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Eduzz.`,
    hint: 'Eduzz expects EDUZZ_EMAIL, EDUZZ_PUBLIC_KEY and EDUZZ_API_KEY.',
  };
}

// Silence unused-import lint warning when noUnusedLocals is on.
void getCredential;
