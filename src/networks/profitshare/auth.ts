/**
 * Profitshare auth + credential validation.
 *
 * Profitshare uses an HMAC-signed credential pair rather than a bearer token:
 *   - PROFITSHARE_API_USER — the public identifier, sent as `X-PS-Client`.
 *   - PROFITSHARE_API_KEY  — the secret, used to compute the per-request
 *     `X-PS-Auth` HMAC-SHA1 signature. Never transmitted.
 *
 * Both are issued from the Profitshare affiliate dashboard (Account → API).
 * There is no refresh flow: the pair is static and long-lived. If the key is
 * compromised the affiliate regenerates it from the same screen. The signing
 * itself lives in `client.ts`; this file only reads credentials and runs the
 * cheap auth-check call.
 *
 * Why no `derivedValues` pattern (unlike Awin): the API user already scopes the
 * credential pair to a single affiliate account, so there is no second
 * identifier to auto-discover. Both fields are entered directly.
 *
 * Keep `verifyAuth` cheap and never throw from it — the wizard and error
 * handlers call it, and a throw would loop.
 */

import { profitshareRequest, PROFITSHARE_SLUG } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';
import type { ProfitshareCredentials } from './client.js';

const log = createLogger('profitshare.auth');

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
 * Read both credentials. Throws a `config_error` `NetworkError` (via
 * `requireCredential`) when either is missing — adapter ops call this at the
 * start of every operation.
 */
export function requireCredentials(operation: string): ProfitshareCredentials {
  const apiUser = requireCredential('PROFITSHARE_API_USER', {
    network: PROFITSHARE_SLUG,
    operation,
    hint:
      'Find your API user and key in the Profitshare affiliate dashboard under ' +
      'Account → API.',
  });
  const apiKey = requireCredential('PROFITSHARE_API_KEY', {
    network: PROFITSHARE_SLUG,
    operation,
    hint:
      'Find your API user and key in the Profitshare affiliate dashboard under ' +
      'Account → API.',
  });
  return { apiUser, apiKey };
}

/**
 * Verify the Profitshare credential pair by listing advertisers.
 *
 * Why this endpoint: `affiliate-advertisers` is the cheapest authenticated
 * affiliate call and returns 200 with a `result` array on a valid signature.
 * A bad signature returns an `error` body (Profitshare reports `InvalidSignature`),
 * which the client surfaces verbatim. We do not page or filter — we only care
 * that the signed request authenticates.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let credentials: ProfitshareCredentials;
  try {
    credentials = requireCredentials('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    await profitshareRequest<unknown>({
      operation: 'verifyAuth',
      resource: 'affiliate-advertisers',
      credentials,
      resilience: DEFAULT_RESILIENCE,
    });

    const identity = `profitshare/${credentials.apiUser}`;
    log.debug({ identity }, 'profitshare verifyAuth succeeded');
    return { ok: true, identity };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: PROFITSHARE_SLUG,
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * PROFITSHARE_API_KEY needs the API user to sign a probe, so we only run the
 * live check on the KEY field (which is entered second). The API user alone
 * cannot be verified — a signature needs both halves — so we format-check it.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'PROFITSHARE_API_USER') {
    if (value.trim() === '') {
      return {
        ok: false,
        message: 'Profitshare API user must not be empty.',
        hint: 'Copy the API user from the Profitshare dashboard → Account → API.',
      };
    }
    return { ok: true };
  }

  if (field === 'PROFITSHARE_API_KEY') {
    const previous = process.env['PROFITSHARE_API_KEY'];
    process.env['PROFITSHARE_API_KEY'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'credentials verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check both the API user and API key in the Profitshare dashboard → Account → API. ' +
          'A wrong key produces an InvalidSignature error.',
      };
    } finally {
      // Restore the previous value so a failed validation does not poison
      // subsequent operations in the same process (test isolation).
      if (previous === undefined) {
        delete process.env['PROFITSHARE_API_KEY'];
      } else {
        process.env['PROFITSHARE_API_KEY'] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Profitshare.`,
    hint:
      'Profitshare expects PROFITSHARE_API_USER and PROFITSHARE_API_KEY, both required.',
  };
}
