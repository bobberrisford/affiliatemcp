/**
 * Sovrn Commerce auth + credential validation.
 *
 * Sovrn Commerce uses two credentials:
 *
 *   SOVRN_SECRET_KEY  — the "Secret key" from the Settings page of the Sovrn
 *     Commerce dashboard (Settings → Key icon → Generate Secret Key). This is
 *     used in the Authorization header for all reporting API calls. The header
 *     value is "secret {SECRET_KEY}".
 *
 *   SOVRN_API_KEY  — the per-site "API key" from the same Settings page. This
 *     is used when constructing tracking links (redirect.viglink.com?key=...).
 *     It is NOT used in the reporting API Authorization header.
 *
 * Why two keys: Sovrn maintains the VigLink convention of one credential for
 * link monetisation (API key, embeddable in JS/URLs) and a separate, more
 * powerful credential for reporting (Secret key, kept server-side). The site
 * API key is per-site; the Secret key covers all sites in the account.
 *
 * verifyAuth strategy: call GET /v1/reports/merchants with today's clickDate.
 * If it returns 200 (even an empty body), auth is valid. A 401 means the
 * Secret key is wrong; 403 means it may be absent or ungenerated. There is
 * no dedicated "whoami" or "ping" endpoint in the public Sovrn Commerce API.
 *
 * /reports/merchants is preferred over /reports/transactions for auth probes
 * because it has a 10-second rate limit (vs 60 seconds for transactions),
 * making repeated auth checks faster.
 * Source: support.viglink.com/hc/en-us/articles/360008095914 (2026-05-28).
 *
 * Sources:
 *   https://knowledge.sovrn.com/how-to-implement-sovrn-commerce-apis
 *   https://support.viglink.com/hc/en-us/articles/360007678554
 *   https://developer.sovrn.com/
 */

import { sovrnRequest } from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('sovrn-commerce.auth');

const SLUG = 'sovrn-commerce';

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
 * Verify the Sovrn Commerce Secret key by issuing a minimal authenticated
 * request to the reporting API.
 *
 * We call GET /v1/reports/merchants with today's date — this is the cheapest
 * authenticated call that provides a clear 200/401 signal. Even if the
 * publisher has no data for today, a valid key returns 200 (empty payload).
 *
 * The /reports/merchants endpoint requires only a clickDate query parameter.
 * No additional mandatory parameters (e.g. siteUuid) are required.
 * Source: developer.sovrn.com/reference/get_reports-merchants (2026-05-28).
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let secretKey: string;
  try {
    secretKey = requireCredential('SOVRN_SECRET_KEY', {
      network: SLUG,
      operation: 'verifyAuth',
      hint:
        'Generate a Secret key at the Sovrn Commerce dashboard: Settings → click the Key icon ' +
        'on your site → Generate Secret Key.',
    });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  // Use today's date for the auth probe. Sovrn's transactions endpoint requires
  // at least one date parameter in YYYY-MM-DD format; today is the safest choice
  // as it avoids querying historical windows that might trigger additional access
  // checks on restricted accounts.
  const today = new Date().toISOString().slice(0, 10);

  try {
    // We intentionally ignore the response body here — we only care about the
    // HTTP status code. A 200 means the key is valid; anything else propagates
    // as an error through the resilience layer.
    await sovrnRequest<unknown>({
      operation: 'verifyAuth',
      path: '/v1/reports/merchants',
      secretKey,
      query: { clickDate: today },
      resilience: DEFAULT_RESILIENCE,
    });

    log.debug('sovrn-commerce verifyAuth succeeded');

    // There is no identity endpoint in the public Sovrn Commerce API. We
    // return a generic identity string with the site API key (if set) so the
    // user has a visible confirmation. The Secret key is never surfaced.
    const apiKey = getCredential('SOVRN_API_KEY');
    const identity = apiKey ? `sovrn-commerce (site key: ${apiKey})` : 'sovrn-commerce';

    return { ok: true, identity };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: SLUG,
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * SOVRN_SECRET_KEY: live-validates by calling verifyAuth.
 * SOVRN_API_KEY: format check only — the site API key is a short alphanumeric
 *   string used for tracking links. There is no dedicated validation endpoint
 *   for it in the public API.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'SOVRN_SECRET_KEY') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Sovrn Commerce Secret key must not be blank.',
        hint:
          'Generate a Secret key at the Sovrn Commerce dashboard: Settings → Key icon → Generate Secret Key.',
      };
    }
    const previous = process.env['SOVRN_SECRET_KEY'];
    process.env['SOVRN_SECRET_KEY'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return {
          ok: true,
          message: result.identity ?? 'Secret key verified',
        };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the Secret key at the Sovrn Commerce dashboard → Settings → Key icon. ' +
          'Ensure you have clicked "Generate Secret Key" and copied the full value.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['SOVRN_SECRET_KEY'];
      } else {
        process.env['SOVRN_SECRET_KEY'] = previous;
      }
    }
  }

  if (field === 'SOVRN_API_KEY') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Sovrn Commerce site API key must not be blank.',
        hint:
          'Find your site API key at the Sovrn Commerce dashboard: Settings → Key icon next to your site.',
      };
    }
    // The site API key format is not strictly documented. We accept any non-blank
    // string; a malformed key will fail at tracking-link time when redirect.viglink.com
    // rejects the request.
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Sovrn Commerce.`,
    hint:
      'Sovrn Commerce expects SOVRN_SECRET_KEY (for reporting APIs) and SOVRN_API_KEY ' +
      '(for generating tracking links). Both are found in the Settings page of your Sovrn Commerce account.',
  };
}
