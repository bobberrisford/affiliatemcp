/**
 * Adtraction auth + credential validation.
 *
 * Adtraction uses a single API access token. The account holder generates it
 * inside their Adtraction account; affiliate-mcp reads it from
 * `ADTRACTION_API_TOKEN`. The token is supplied as a `token` QUERY parameter on
 * every request (see client.ts) rather than an Authorization header — which is
 * why `auth_model` is `custom`, not `bearer`.
 *   Source: https://help.adtraction.com/en/articles/1563159-get-started-with-the-adtraction-api
 *
 * --- verifyAuth ----------------------------------------------------------------
 *
 * Adtraction does not document a cheap `/me`-style identity endpoint. We verify
 * the token by issuing an authenticated programmes listing with a minimal body:
 * a 401/403 proves the token is invalid; any 2xx proves it is valid. The token
 * itself is the identity string we surface (truncated — the wizard echoes it
 * back so the user can confirm the right token was stored).
 *
 * verifyAuth never throws — it is called by error handlers.
 */

import { listApprovedProgrammesRaw } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('adtraction.auth');

const SLUG = 'adtraction';

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
 * Return the configured Adtraction API token, throwing a `config_error`
 * envelope when it is missing or blank.
 */
export function requireApiToken(operation: string): string {
  return requireCredential('ADTRACTION_API_TOKEN', {
    network: SLUG,
    operation,
    hint:
      'Set ADTRACTION_API_TOKEN in ~/.affiliate-mcp/.env. ' +
      'Generate the token in your Adtraction account (Account / API settings).',
  });
}

/** Mask all but the first/last 4 characters of a token for display. */
function maskToken(token: string): string {
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

/**
 * Verify Adtraction credentials by issuing an authenticated programmes request.
 *
 * Never throws — returns { ok: false } on any failure so callers (including
 * error handlers) do not loop.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let token: string;
  try {
    token = requireApiToken('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    // A cheap authenticated probe. A valid token returns a (possibly empty)
    // programmes list; an invalid token returns 401/403 which surfaces as an
    // auth_error envelope below.
    await listApprovedProgrammesRaw(token, 'verifyAuth');
    const identity = `adtraction/token:${maskToken(token)}`;
    log.debug({ identity }, 'adtraction verifyAuth succeeded');
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
      hint: 'Check ADTRACTION_API_TOKEN matches the token shown in your Adtraction account.',
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * ADTRACTION_API_TOKEN: performs a live authenticated probe with the entered
 * value. Returns ok:false with the upstream error if the probe fails.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'ADTRACTION_API_TOKEN') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'API token must not be empty.',
        hint: 'Generate the token inside your Adtraction account and paste it here.',
      };
    }
    // Temporarily inject the entered token so the live probe uses it.
    const prev = process.env['ADTRACTION_API_TOKEN'];
    process.env['ADTRACTION_API_TOKEN'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return {
          ok: true,
          message: result.identity ?? 'Token verified against the Adtraction API.',
        };
      }
      return {
        ok: false,
        message: result.reason,
        hint: 'Check the token is copied exactly, without leading or trailing spaces.',
      };
    } finally {
      if (prev === undefined) {
        delete process.env['ADTRACTION_API_TOKEN'];
      } else {
        process.env['ADTRACTION_API_TOKEN'] = prev;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Adtraction.`,
    hint: 'Adtraction expects ADTRACTION_API_TOKEN.',
  };
}
