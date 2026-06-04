/**
 * Indoleads auth + credential validation.
 *
 * Indoleads uses a single self-issued API token (no OAuth2 token exchange).
 * The publisher generates the token at Account → API Settings and supplies it
 * as INDOLEADS_API_TOKEN. The token may be sent either as an
 * `Authorization: Bearer {token}` header or as a `?token={token}` GET
 * parameter; this adapter uses the Authorization header (see client.ts).
 *
 * --- verifyAuth ----------------------------------------------------------------
 *
 * Indoleads does not document a dedicated /me-style identity endpoint accessible
 * to publisher tokens. The cheapest identity-revealing call is a one-row offers
 * request (GET /api/offers?limit=1): a 2xx proves the token is valid; a 401/403
 * proves it is not. verifyAuth never throws — it is called by error handlers.
 *
 * Source: https://indoleads.atlassian.net/wiki/spaces/PUB/pages/53476781/API
 */

import { indoleadsRequest } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('indoleads.auth');

const SLUG = 'indoleads';

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
 * Verify Indoleads credentials by making a cheap one-row offers call.
 *
 * A successful response proves the token is valid. The token itself carries no
 * human-readable account name in the documented responses, so the identity
 * string is a redacted token fingerprint (last 4 characters) — enough for the
 * setup wizard's confirmation message without leaking the secret.
 *
 * Never throws — returns { ok: false } on any failure so callers (including
 * error handlers) do not loop.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let token: string;
  try {
    token = requireCredential('INDOLEADS_API_TOKEN', {
      network: SLUG,
      operation: 'verifyAuth',
      hint: 'Generate a token at https://app.indoleads.com → Account → API Settings, then set INDOLEADS_API_TOKEN.',
    });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    await indoleadsRequest<unknown>({
      operation: 'verifyAuth',
      path: '/offers',
      token,
      query: { limit: 1 },
      resilience: DEFAULT_RESILIENCE,
    });

    const fingerprint = token.length >= 4 ? token.slice(-4) : token;
    const identity = `indoleads/token:…${fingerprint}`;
    log.debug({ identity }, 'indoleads verifyAuth succeeded');
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
      hint: 'Check INDOLEADS_API_TOKEN matches the value at Account → API Settings.',
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
 * INDOLEADS_API_TOKEN: performs a full live one-row offers call with the
 * supplied value. Returns ok:false with the upstream error if the call fails.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'INDOLEADS_API_TOKEN') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'API token must not be empty.',
        hint: 'Copy the token from https://app.indoleads.com → Account → API Settings.',
      };
    }
    // Temporarily inject the credential so we can exercise the live call.
    const prev = process.env['INDOLEADS_API_TOKEN'];
    process.env['INDOLEADS_API_TOKEN'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return {
          ok: true,
          message: result.identity ?? 'Token verified against the Indoleads API.',
        };
      }
      return {
        ok: false,
        message: result.reason,
        hint: 'Check the token is copied without leading or trailing spaces and is still active in Account → API Settings.',
      };
    } finally {
      if (prev === undefined) {
        delete process.env['INDOLEADS_API_TOKEN'];
      } else {
        process.env['INDOLEADS_API_TOKEN'] = prev;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Indoleads.`,
    hint: 'Indoleads expects INDOLEADS_API_TOKEN.',
  };
}
