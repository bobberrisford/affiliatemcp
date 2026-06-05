/**
 * Adtraction advertiser auth + credential validation.
 *
 * Adtraction's advertiser (brand-side) surface uses the SAME single API access
 * token scheme as the publisher surface: the account holder generates a token
 * inside their Adtraction ADVERTISER account and affiliate-mcp reads it from
 * `ADTRACTION_ADVERTISER_API_TOKEN`. The token is supplied as a `token` QUERY
 * parameter on every request (see client.ts), not an Authorization header —
 * which is why `auth_model` is `custom`, not `bearer`.
 *   Source: https://help.adtraction.com/en/articles/1563159-get-started-with-the-adtraction-api
 *           ("find or generate your unique API access token that you can find
 *            right inside your Affiliate or Advertiser account")
 *   Advertiser endpoints are documented at the Apiary "#reference/advertiser"
 *   section. BLOCKED(verify): both docs sites
 *   (https://adtractionv3.docs.apiary.io/, https://apidocs.adtraction.net/v2/)
 *   returned HTTP 403 to automated fetch during this PR's research, so the exact
 *   advertiser paths and field names were corroborated via public search
 *   snippets and the v2 partner-endpoint pattern, not read directly.
 *
 * --- verifyAuth ----------------------------------------------------------------
 *
 * Adtraction does not document a cheap `/me`-style identity endpoint. We verify
 * the token by issuing an authenticated advertiser programmes listing with a
 * minimal body: a 401/403 proves the token is invalid; any 2xx proves it is
 * valid. The token itself is the identity string we surface (truncated).
 *
 * verifyAuth never throws — it is called by error handlers.
 */

import { listAdvertiserProgrammesRaw } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('adtraction-advertiser.auth');

export const SLUG = 'adtraction-advertiser';

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
 * Return the configured Adtraction advertiser API token, throwing a
 * `config_error` envelope when it is missing or blank.
 */
export function requireApiToken(operation: string): string {
  return requireCredential('ADTRACTION_ADVERTISER_API_TOKEN', {
    network: SLUG,
    operation,
    hint:
      'Set ADTRACTION_ADVERTISER_API_TOKEN in ~/.affiliate-mcp/.env. ' +
      'Generate the token inside your Adtraction advertiser account (Account / API settings).',
  });
}

/** Mask all but the first/last 4 characters of a token for display. */
function maskToken(token: string): string {
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

/**
 * Verify Adtraction advertiser credentials by issuing an authenticated
 * programmes request.
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
    await listAdvertiserProgrammesRaw(token, 'verifyAuth');
    const identity = `adtraction-advertiser/token:${maskToken(token)}`;
    log.debug({ identity }, 'adtraction-advertiser verifyAuth succeeded');
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
      hint: 'Check ADTRACTION_ADVERTISER_API_TOKEN matches the token shown in your Adtraction advertiser account.',
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * ADTRACTION_ADVERTISER_API_TOKEN: performs a live authenticated probe with the
 * entered value. Returns ok:false with the upstream error if the probe fails.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'ADTRACTION_ADVERTISER_API_TOKEN') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'API token must not be empty.',
        hint: 'Generate the token inside your Adtraction advertiser account and paste it here.',
      };
    }
    // Temporarily inject the entered token so the live probe uses it.
    const prev = process.env['ADTRACTION_ADVERTISER_API_TOKEN'];
    process.env['ADTRACTION_ADVERTISER_API_TOKEN'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return {
          ok: true,
          message: result.identity ?? 'Token verified against the Adtraction advertiser API.',
        };
      }
      return {
        ok: false,
        message: result.reason,
        hint: 'Check the token is copied exactly, without leading or trailing spaces.',
      };
    } finally {
      if (prev === undefined) {
        delete process.env['ADTRACTION_ADVERTISER_API_TOKEN'];
      } else {
        process.env['ADTRACTION_ADVERTISER_API_TOKEN'] = prev;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Adtraction advertiser.`,
    hint: 'Adtraction advertiser expects ADTRACTION_ADVERTISER_API_TOKEN.',
  };
}
