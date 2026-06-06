/**
 * ShareASale auth + credential validation.
 *
 * ShareASale signs every request with an HMAC-SHA256 digest rather than a
 * bearer token (see `client.ts`). The credential triple is:
 *   - SHAREASALE_AFFILIATE_ID — the public affiliate (publisher) account id,
 *     sent as the `affiliateId` query param.
 *   - SHAREASALE_API_TOKEN    — the public API token, sent as `token` and mixed
 *     into the signature string.
 *   - SHAREASALE_API_SECRET   — the secret key, used as the SHA-256 signature
 *     material; never transmitted.
 *
 * All three are issued from the ShareASale account dashboard (API Manager,
 * account.shareasale.com/a-apimanager.cfm). There is no refresh flow: the
 * triple is static and long-lived. If the secret is compromised the affiliate
 * regenerates it from the same screen. The signing itself lives in `client.ts`;
 * this file only reads credentials and runs the cheap auth-check call.
 *
 * Why no `derivedValues` pattern (unlike Awin): the affiliate id is part of the
 * credential triple, so there is no second identifier to auto-discover. All
 * fields are entered directly.
 *
 * Keep `verifyAuth` cheap and never throw from it — the wizard and error
 * handlers call it, and a throw would loop.
 */

import { shareasaleRequest, SHAREASALE_SLUG } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';
import type { ShareasaleCredentials } from './client.js';

const log = createLogger('shareasale.auth');

export interface VerifyAuthOk {
  ok: true;
  identity?: string;
}

export interface VerifyAuthFail {
  ok: false;
  reason: string;
  envelope?: NetworkErrorEnvelope;
}

const CREDENTIAL_HINT =
  'Find your affiliate id, API token and secret key in the ShareASale dashboard under ' +
  'API Manager (account.shareasale.com/a-apimanager.cfm).';

/**
 * Read all three credentials. Throws a `config_error` `NetworkError` (via
 * `requireCredential`) when any is missing — adapter ops call this at the start
 * of every operation.
 */
export function requireCredentials(operation: string): ShareasaleCredentials {
  const affiliateId = requireCredential('SHAREASALE_AFFILIATE_ID', {
    network: SHAREASALE_SLUG,
    operation,
    hint: CREDENTIAL_HINT,
  });
  const token = requireCredential('SHAREASALE_API_TOKEN', {
    network: SHAREASALE_SLUG,
    operation,
    hint: CREDENTIAL_HINT,
  });
  const secretKey = requireCredential('SHAREASALE_API_SECRET', {
    network: SHAREASALE_SLUG,
    operation,
    hint: CREDENTIAL_HINT,
  });
  return { affiliateId, token, secretKey };
}

/**
 * Verify the ShareASale credential triple by running the cheapest signed
 * report: `merchantStatus`. A valid signature returns 200 with the affiliate's
 * merchant relationships; a bad signature or token returns a non-2xx (or an
 * error body) which the client surfaces verbatim. We do not page or filter —
 * we only care that the signed request authenticates.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let credentials: ShareasaleCredentials;
  try {
    credentials = requireCredentials('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    await shareasaleRequest<unknown>({
      operation: 'verifyAuth',
      action: 'merchantStatus',
      credentials,
      resilience: DEFAULT_RESILIENCE,
    });

    const identity = `shareasale/${credentials.affiliateId}`;
    log.debug({ identity }, 'shareasale verifyAuth succeeded');
    return { ok: true, identity };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: SHAREASALE_SLUG,
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * The affiliate id and token are format-checked (a signature needs all three
 * halves, so neither can be verified alone). The secret is entered last and
 * runs a live signed probe, so the user learns immediately if any of the three
 * is wrong.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'SHAREASALE_AFFILIATE_ID') {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      return {
        ok: false,
        message: 'ShareASale affiliate id must be a positive integer.',
        hint: 'Your affiliate id is shown in the ShareASale dashboard header and on the API Manager screen.',
      };
    }
    return { ok: true };
  }

  if (field === 'SHAREASALE_API_TOKEN') {
    if (value.trim() === '') {
      return {
        ok: false,
        message: 'ShareASale API token must not be empty.',
        hint: 'Copy the API token from the ShareASale dashboard → API Manager.',
      };
    }
    return { ok: true };
  }

  if (field === 'SHAREASALE_API_SECRET') {
    const previous = process.env['SHAREASALE_API_SECRET'];
    process.env['SHAREASALE_API_SECRET'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'credentials verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the affiliate id, API token and secret key in the ShareASale dashboard → API Manager. ' +
          'A wrong secret produces a signature failure.',
      };
    } finally {
      // Restore the previous value so a failed validation does not poison
      // subsequent operations in the same process (test isolation).
      if (previous === undefined) {
        delete process.env['SHAREASALE_API_SECRET'];
      } else {
        process.env['SHAREASALE_API_SECRET'] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for ShareASale.`,
    hint:
      'ShareASale expects SHAREASALE_AFFILIATE_ID, SHAREASALE_API_TOKEN and SHAREASALE_API_SECRET, all required.',
  };
}
