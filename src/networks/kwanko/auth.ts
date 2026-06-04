/**
 * Kwanko auth + credential validation.
 *
 * Kwanko uses a single API token. The publisher generates it in the Kwanko
 * platform (main menu → Features and API), copies it, and it is sent as
 * `Authorization: Bearer {token}` on every API call. There is no OAuth token
 * exchange and no separate secret — the token is the only credential.
 *
 * Source: https://developers.kwanko.com/ ;
 *         https://helpdesk-publisher.kwanko.com/ (statistics API access).
 *
 * The token is self-issued in the dashboard (no contact with Kwanko required),
 * so the network is self-serve. It may optionally be IP-restricted in platform
 * settings; an IP mismatch surfaces as an auth failure from the live endpoint.
 *
 * --- verifyAuth ----------------------------------------------------------------
 *
 * verifyAuth makes the cheapest identity-revealing call available — a campaigns
 * list with a single-item page. A 401/403 returns { ok: false } and never
 * throws, because verifyAuth is called by error handlers.
 */

import { kwankoRequest } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('kwanko.auth');

const SLUG = 'kwanko';

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
 * Return the configured Kwanko API token, or throw a `config_error` envelope
 * via `requireCredential` when it is missing.
 */
export function requireToken(operation: string): string {
  return requireCredential('KWANKO_API_TOKEN', {
    network: SLUG,
    operation,
    hint:
      'Set KWANKO_API_TOKEN in ~/.affiliate-mcp/.env. Generate it in the Kwanko ' +
      'platform: main menu → Features and API → generate / copy your API token.',
  });
}

/**
 * Verify Kwanko credentials by making a minimal authenticated call.
 *
 * Why the campaigns endpoint with a one-item page: it is the smallest
 * authenticated read the publisher API exposes and confirms the token is valid
 * without pulling a large payload. A 401/403 proves the token is wrong or
 * IP-restricted from this host.
 *
 * Never throws — returns { ok: false } on any failure so callers (including
 * error handlers) do not loop.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let token: string;
  try {
    token = requireToken('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    // BLOCKED(verify): path + pagination params taken from the public API
    // summary; confirm against a live response.
    await kwankoRequest<unknown>({
      operation: 'verifyAuth',
      path: '/publisher/campaigns',
      token,
      query: { per_page: 1, page: 1 },
      resilience: DEFAULT_RESILIENCE,
    });

    // Kwanko does not expose a /me-style endpoint via the documented publisher
    // API, so we identify by a token fingerprint (never the full secret).
    const identity = `kwanko/token:${fingerprint(token)}`;
    log.debug({ identity }, 'kwanko verifyAuth succeeded');
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
      hint: 'Check KWANKO_API_TOKEN. The token may be revoked, mistyped, or IP-restricted from this host.',
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/** A short, non-reversible fingerprint of the token for identity display. */
function fingerprint(token: string): string {
  if (token.length <= 4) return '****';
  return `${token.slice(0, 2)}…${token.slice(-2)}`;
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * `KWANKO_API_TOKEN`: writes the candidate into `process.env`, runs
 * `verifyAuth()` against the live endpoint, then restores the previous value.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'KWANKO_API_TOKEN') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'API token must not be empty.',
        hint: 'Generate it in the Kwanko platform → Features and API.',
      };
    }
    const previous = process.env['KWANKO_API_TOKEN'];
    process.env['KWANKO_API_TOKEN'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return {
          ok: true,
          message: result.identity ?? 'Token verified against the Kwanko API.',
        };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the token in the Kwanko platform → Features and API. The token may be ' +
          'revoked, copied with leading/trailing whitespace, or IP-restricted from this host.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['KWANKO_API_TOKEN'];
      } else {
        process.env['KWANKO_API_TOKEN'] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Kwanko.`,
    hint: 'Kwanko expects KWANKO_API_TOKEN.',
  };
}
