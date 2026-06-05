/**
 * Kwanko advertiser auth + credential validation.
 *
 * The Kwanko advertiser API uses the same single-token Bearer scheme as the
 * publisher surface: the advertiser generates an API token in the Kwanko
 * platform (main menu -> Features and API), copies it, and it is sent as
 * `Authorization: Bearer {token}` on every call. There is no OAuth exchange
 * and no separate secret — the token is the only credential.
 *
 * Source: https://developers.kwanko.com/ ;
 *         https://helpdesk-advertiser.kwanko.com/ (advertiser API access);
 *         corroborated by the dltHub Kwanko source config (base_url
 *         https://api.kwanko.com, bearer auth, resources conversions +
 *         statistics).
 *
 * The token is self-issued in the dashboard (no contact with Kwanko required),
 * so the network is self-serve. It may optionally be IP-restricted in platform
 * settings; an IP mismatch surfaces as an auth failure from the live endpoint.
 *
 * The Kwanko developer reference and advertiser help desk both return HTTP 403
 * to automated fetch, so a few endpoint details below are marked
 * `BLOCKED(verify)` and should be confirmed against a live advertiser account.
 *
 * --- verifyAuth ----------------------------------------------------------------
 *
 * verifyAuth makes the cheapest authenticated call available — the advertiser
 * statistics endpoint with a one-day window and a single-row page. A 401/403
 * returns { ok: false } and never throws, because verifyAuth is called by
 * error handlers.
 */

import { kwankoAdvRequest } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('kwanko-advertiser.auth');

export const SLUG = 'kwanko-advertiser';

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
 * Return the configured Kwanko advertiser API token, or throw a `config_error`
 * envelope via `requireCredential` when it is missing.
 */
export function requireToken(operation: string): string {
  return requireCredential('KWANKO_ADVERTISER_API_TOKEN', {
    network: SLUG,
    operation,
    hint:
      'Set KWANKO_ADVERTISER_API_TOKEN in ~/.affiliate-mcp/.env. Generate it in the Kwanko ' +
      'platform: main menu -> Features and API -> generate / copy your API token. A read-only ' +
      'token is recommended; this adapter only ever issues GET requests.',
  });
}

/**
 * Verify Kwanko advertiser credentials with a minimal authenticated call.
 *
 * Why the statistics endpoint with a one-day window and a one-row page: it is
 * the smallest authenticated read the advertiser API exposes and confirms the
 * token is valid without pulling a large payload. A 401/403 proves the token
 * is wrong or IP-restricted from this host.
 *
 * BLOCKED(verify): the path + pagination/date params are taken from public
 * summaries; confirm against a live response.
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

  const today = new Date().toISOString().slice(0, 10);

  try {
    await kwankoAdvRequest<unknown>({
      operation: 'verifyAuth',
      path: '/advertiser/statistics',
      token,
      query: { debut: today, fin: today, per_page: 1, page: 1 },
      resilience: DEFAULT_RESILIENCE,
    });

    // Kwanko does not expose a /me-style endpoint via the documented advertiser
    // API, so we identify by a token fingerprint (never the full secret).
    const identity = `kwanko-advertiser/token:${fingerprint(token)}`;
    log.debug({ identity }, 'kwanko-advertiser verifyAuth succeeded');
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
      hint: 'Check KWANKO_ADVERTISER_API_TOKEN. The token may be revoked, mistyped, or IP-restricted from this host.',
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
 * `KWANKO_ADVERTISER_API_TOKEN`: writes the candidate into `process.env`, runs
 * `verifyAuth()` against the live endpoint, then restores the previous value.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'KWANKO_ADVERTISER_API_TOKEN') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'API token must not be empty.',
        hint: 'Generate it in the Kwanko platform -> Features and API.',
      };
    }
    const previous = process.env['KWANKO_ADVERTISER_API_TOKEN'];
    process.env['KWANKO_ADVERTISER_API_TOKEN'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return {
          ok: true,
          message: result.identity ?? 'Token verified against the Kwanko advertiser API.',
        };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the token in the Kwanko platform -> Features and API. The token may be ' +
          'revoked, copied with leading/trailing whitespace, or IP-restricted from this host.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['KWANKO_ADVERTISER_API_TOKEN'];
      } else {
        process.env['KWANKO_ADVERTISER_API_TOKEN'] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Kwanko advertiser.`,
    hint: 'Kwanko advertiser expects KWANKO_ADVERTISER_API_TOKEN.',
  };
}
