/**
 * FlexOffers auth + credential validation.
 *
 * FlexOffers uses a single account API Key for all Web Service API calls. The
 * publisher finds it in the dashboard under Tools → Web Services → API Keys
 * (the "API Key" column).
 * Source: https://supportbeta.flexoffers.com/knowledge/how-to-access-api-data-with-the-flexoffers-web-services-tool
 *         https://supportpro.flexoffers.com/flexoffers-api-authentication/
 *
 * The key is sent in the `apiKey` request header (see client.ts). There is no
 * OAuth token exchange and no token cache — the key is long-lived and used
 * directly on every call.
 *
 * --- verifyAuth ----------------------------------------------------------------
 *
 * FlexOffers does not expose a dedicated "whoami" / "ping" endpoint accessible
 * with a standard publisher key. We probe authentication by issuing a minimal
 * /allsales request for today only: a valid key returns HTTP 200 (even with an
 * empty sales array), an invalid key returns 401/403. verifyAuth never throws —
 * it is called by error handlers.
 */

import { flexoffersRequest } from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('flexoffers.auth');

const SLUG = 'flexoffers';

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
 * Return the configured FlexOffers API key, throwing a `config_error` envelope
 * when it is missing or blank.
 */
export function requireApiKey(operation: string): string {
  return requireCredential('FLEXOFFERS_API_KEY', {
    network: SLUG,
    operation,
    hint:
      'Set FLEXOFFERS_API_KEY in ~/.affiliate-mcp/.env. Find it in your FlexOffers ' +
      'account under Tools → Web Services → API Keys (the "API Key" column).',
  });
}

/**
 * Verify the FlexOffers API key by issuing a minimal authenticated request.
 *
 * We call GET /allsales for today's date only — the cheapest authenticated call
 * that yields a clear 200/401 signal. Even with no sales today, a valid key
 * returns HTTP 200. There is no identity endpoint in the public API, so the
 * returned identity is a generic string (the API key is never surfaced).
 *
 * Never throws — returns { ok: false } on any failure so callers (including
 * error handlers) do not loop.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let apiKey: string;
  try {
    apiKey = requireApiKey('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  // Today's date as the probe window. FlexOffers' /allsales requires a date
  // range; today is the safest choice as it avoids stressing historical windows.
  const today = new Date().toISOString().slice(0, 10);

  try {
    // We intentionally ignore the response body here — we only care that the
    // request authenticates. A non-2xx propagates through the resilience layer.
    await flexoffersRequest<unknown>({
      operation: 'verifyAuth',
      path: '/allsales',
      apiKey,
      query: { reportType: 'details', startDate: today, endDate: today },
      resilience: DEFAULT_RESILIENCE,
    });

    log.debug('flexoffers verifyAuth succeeded');

    // FlexOffers identifies the account by a numeric Account ID, supplied as an
    // optional credential for the user's reference. Surfaced in the identity
    // string when present; the API key itself is never echoed.
    const accountId = getCredential('FLEXOFFERS_ACCOUNT_ID');
    const identity = accountId ? `flexoffers/account:${accountId}` : 'flexoffers (account active)';

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
      hint: 'Check FLEXOFFERS_API_KEY in your config (Tools → Web Services → API Keys).',
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * FLEXOFFERS_API_KEY: live-validates by calling verifyAuth with the entered key.
 * FLEXOFFERS_ACCOUNT_ID: format check (positive integer) — optional, no API call.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'FLEXOFFERS_API_KEY') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'FlexOffers API key must not be blank.',
        hint: 'Copy the API Key from your FlexOffers account: Tools → Web Services → API Keys.',
      };
    }
    const previous = process.env['FLEXOFFERS_API_KEY'];
    process.env['FLEXOFFERS_API_KEY'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return {
          ok: true,
          message: result.identity ?? 'API key verified against the FlexOffers API.',
        };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the API Key at your FlexOffers account → Tools → Web Services → API Keys. ' +
          'Copy the full value without leading or trailing spaces.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['FLEXOFFERS_API_KEY'];
      } else {
        process.env['FLEXOFFERS_API_KEY'] = previous;
      }
    }
  }

  if (field === 'FLEXOFFERS_ACCOUNT_ID') {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      return {
        ok: false,
        message: 'FlexOffers Account ID must be a positive integer.',
        hint:
          'Find your Account ID in your FlexOffers account under Tools → Web Services → API Keys ' +
          '(shown alongside the Domain ID and API Key).',
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for FlexOffers.`,
    hint: 'FlexOffers expects FLEXOFFERS_API_KEY (required) and FLEXOFFERS_ACCOUNT_ID (optional).',
  };
}
