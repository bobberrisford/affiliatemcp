/**
 * Yieldkit auth + credential validation.
 *
 * Yieldkit authenticates with a long-lived API key + API secret pair. The
 * publisher generates both from the dashboard under Account → API access
 * (https://public.yieldkit.com/). Neither rotates automatically, so we treat
 * them as static secrets loaded from `YIELDKIT_API_KEY` and
 * `YIELDKIT_API_SECRET`. If Yieldkit moves to rotating credentials, this is the
 * only file that needs to change.
 *
 * Auth is passed as query parameters (`api_key`, `api_secret`), handled by
 * `client.ts`. We do not build auth headers here.
 *
 * --- verifyAuth ----------------------------------------------------------------
 *
 * `verifyAuth()` makes the cheapest authenticated call available — a one-row
 * Advertiser API request. A valid key/secret pair returns 200; an invalid pair
 * returns a 4xx with a JSON error body, so the envelope is actionable.
 *
 * Yieldkit does not expose an identity-revealing field we can derive a second
 * credential from: the key/secret pair is already scoped to the publisher
 * account. There is therefore no `derivedValues` flow (unlike Awin, which
 * derives AWIN_PUBLISHER_ID from the token).
 */

import { yieldkitRequest } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('yieldkit.auth');

export const YIELDKIT_SLUG = 'yieldkit';

/** The advertiser/offer listing endpoint. Doubles as the cheapest auth probe. */
export const ADVERTISER_PATH = '/v2/advertiser';

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
 * Read the API key, surfacing a missing value as a structured failure rather
 * than throwing (verifyAuth is called by error handlers; throwing here loops).
 */
export function requireApiKey(operation: string): string {
  return requireCredential('YIELDKIT_API_KEY', {
    network: YIELDKIT_SLUG,
    operation,
    hint: 'Find your API key in the Yieldkit dashboard → Account → API access.',
  });
}

export function requireApiSecret(operation: string): string {
  return requireCredential('YIELDKIT_API_SECRET', {
    network: YIELDKIT_SLUG,
    operation,
    hint: 'Find your API secret in the Yieldkit dashboard → Account → API access.',
  });
}

/**
 * Verify the Yieldkit key/secret pair by listing a single advertiser/offer.
 *
 * Why this endpoint: the Advertiser API is the smallest authenticated call in
 * the publisher surface and confirms both credentials at once. A bad pair
 * rejects cleanly with a 4xx JSON body.
 *
 * On success we return a generic identity string — Yieldkit does not return a
 * publisher id we can surface here, and the credentials are already scoped to
 * the account.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let apiKey: string;
  let apiSecret: string;
  try {
    apiKey = requireApiKey('verifyAuth');
    apiSecret = requireApiSecret('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    await yieldkitRequest<unknown>({
      operation: 'verifyAuth',
      path: ADVERTISER_PATH,
      apiKey,
      apiSecret,
      // Minimal probe — one row. We only care about the HTTP status.
      query: { limit: 1 },
      resilience: DEFAULT_RESILIENCE,
    });

    log.debug('yieldkit verifyAuth succeeded');
    return { ok: true, identity: 'yieldkit (authenticated)' };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: YIELDKIT_SLUG,
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * YIELDKIT_API_KEY:
 *   Cannot be validated in isolation — Yieldkit requires both the key and the
 *   secret on every call. We defer the live check to the secret step. This
 *   mirrors the OAuth2 client-id pattern in Rakuten's setup (the id needs the
 *   secret before it can be verified).
 *
 * YIELDKIT_API_SECRET:
 *   Writes the candidate secret into process.env, runs verifyAuth() (which
 *   reads the already-entered key from env), then restores the previous value.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'YIELDKIT_API_KEY') {
    if (value.trim() === '') {
      return {
        ok: false,
        message: 'Yieldkit API key must not be empty.',
        hint: 'Copy it from the Yieldkit dashboard → Account → API access.',
      };
    }
    // The key alone cannot be verified without the secret. The secret step
    // performs the live check against both credentials.
    return { ok: true, message: 'Key accepted; will verify once the API secret is entered.' };
  }

  if (field === 'YIELDKIT_API_SECRET') {
    const previous = process.env['YIELDKIT_API_SECRET'];
    process.env['YIELDKIT_API_SECRET'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'credentials verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check both the API key and secret in the Yieldkit dashboard → Account → API access. ' +
          'They may be revoked or copied with leading/trailing whitespace.',
      };
    } finally {
      // Restore the previous value so a failed validation doesn't poison
      // subsequent operations in the same process (test isolation).
      if (previous === undefined) {
        delete process.env['YIELDKIT_API_SECRET'];
      } else {
        process.env['YIELDKIT_API_SECRET'] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Yieldkit.`,
    hint: 'Yieldkit expects YIELDKIT_API_KEY and YIELDKIT_API_SECRET (both required).',
  };
}
