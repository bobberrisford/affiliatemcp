/**
 * Affiliate Future auth + credential validation.
 *
 * Affiliate Future authenticates each publisher API call with two query
 * parameters: an API key (`key`) and an API password (`passcode`). Both are
 * obtained from the "Reporting APIs" page in the publisher account dashboard.
 * That means:
 *   - There is no token exchange and no refresh flow. The key and password are
 *     static, long-lived secrets loaded from `AFFILIATE_FUTURE_API_KEY` and
 *     `AFFILIATE_FUTURE_PASSWORD`.
 *   - The auth-check endpoint is the Merchant List
 *     (`GET /PublisherService.svc/GetAFMerchantList`), which is the cheapest
 *     authenticated call and confirms both credentials in one round-trip.
 *
 * There is no second identifier to derive (Affiliate Future scopes the key +
 * password to a single publisher account), so this adapter does not implement
 * the `derivedValues` pattern that Awin uses for AWIN_PUBLISHER_ID.
 *
 * Reference: src/networks/awin/auth.ts and src/networks/everflow/auth.ts.
 *
 * Future contributors: keep `verifyAuth` cheap. The wizard calls it during
 * interactive setup; latency here is user-visible.
 */

import { affiliateFutureRequest } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('affiliate-future.auth');

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
 * Read the API key and password from the environment.
 *
 * Both are required for every call. We surface a missing credential as a
 * `config_error` envelope (via `requireCredential`) so the user gets an
 * actionable hint rather than a confusing upstream rejection.
 */
export function requireCredentials(operation: string): { key: string; passcode: string } {
  const key = requireCredential('AFFILIATE_FUTURE_API_KEY', {
    network: 'affiliate-future',
    operation,
    hint: 'Find your API key on the Reporting APIs page in the Affiliate Future account dashboard.',
  });
  const passcode = requireCredential('AFFILIATE_FUTURE_PASSWORD', {
    network: 'affiliate-future',
    operation,
    hint: 'Find your API password on the Reporting APIs page in the Affiliate Future account dashboard.',
  });
  return { key, passcode };
}

/**
 * Verify the credentials by hitting the Merchant List endpoint.
 *
 * Why this endpoint specifically:
 *   - It is the cheapest authenticated publisher call and exercises both the
 *     key and the password in one round-trip.
 *   - A bad key or password fails the call, so the error envelope is
 *     actionable.
 *
 * We do not derive any further identifier — the credentials are already scoped
 * to a single publisher account. The identity string is a fixed label.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let key: string;
  let passcode: string;
  try {
    ({ key, passcode } = requireCredentials('verifyAuth'));
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    // `merchantsJoined=ALL` is the broadest, cheapest probe of the credentials.
    await affiliateFutureRequest<unknown>({
      operation: 'verifyAuth',
      path: '/PublisherService.svc/GetAFMerchantList',
      key,
      passcode,
      query: { merchantsJoined: 'ALL', newMerchants: 'NO' },
      resilience: DEFAULT_RESILIENCE,
    });

    log.debug('affiliate-future verifyAuth succeeded');
    return { ok: true, identity: 'affiliate-future (authenticated)' };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: 'affiliate-future',
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * Both credentials are needed together to make any call, so we only run the
 * live check on the password step (entered second) when the key is already
 * present in the environment. The key step is format-checked alone.
 *
 * AFFILIATE_FUTURE_API_KEY:
 *   Non-empty check only — the key cannot be verified without the password,
 *   which the wizard prompts for next.
 *
 * AFFILIATE_FUTURE_PASSWORD:
 *   Writes the candidate password into process.env, runs verifyAuth() (which
 *   reads both credentials), then restores the previous value.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'AFFILIATE_FUTURE_API_KEY') {
    if (value.trim() === '') {
      return {
        ok: false,
        message: 'Affiliate Future API key must not be empty.',
        hint: 'Copy the API key from the Reporting APIs page in the account dashboard.',
      };
    }
    // We cannot verify the key without the password (the wizard prompts for it
    // next). Accept the format and let the password step run the live check.
    return { ok: true, message: 'will validate after password' };
  }

  if (field === 'AFFILIATE_FUTURE_PASSWORD') {
    const previous = process.env['AFFILIATE_FUTURE_PASSWORD'];
    process.env['AFFILIATE_FUTURE_PASSWORD'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'credentials verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the API key and password on the Reporting APIs page in the Affiliate Future ' +
          'account dashboard. The values may be mistyped or copied with surrounding whitespace.',
      };
    } finally {
      // Restore the previous value so a failed validation doesn't poison
      // subsequent operations in the same process (test isolation).
      if (previous === undefined) {
        delete process.env['AFFILIATE_FUTURE_PASSWORD'];
      } else {
        process.env['AFFILIATE_FUTURE_PASSWORD'] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Affiliate Future.`,
    hint: 'Affiliate Future expects AFFILIATE_FUTURE_API_KEY and AFFILIATE_FUTURE_PASSWORD.',
  };
}
