/**
 * Adservice auth + credential validation.
 *
 * Adservice (publisher side, part of the merged Adtraction/Adservice group)
 * authenticates every API request with two values supplied as COOKIES:
 *   - UID         — the publisher/client ID
 *   - LoginToken  — a login token tied to the account session
 * Both are obtained via /Account.pl/loginToken.
 *   Source: https://publisher.adservice.com/doc/publisher/API/Statistics_pl.html
 *
 * BLOCKED(verify): the public documentation host returns HTTP 403 to automated
 * fetches, so the exact /Account.pl/loginToken request/response shape could not
 * be confirmed. This adapter treats UID and LoginToken as configured credentials
 * (ADSERVICE_UID, ADSERVICE_LOGIN_TOKEN) and sends them as cookies. We also accept
 * an optional ADSERVICE_AFFILIATE_ID purely as a human-readable identity label
 * (the third-party Strackr connector refers to an "Affiliate ID" found in the
 * account); it is not sent on requests.
 *
 * --- verifyAuth ----------------------------------------------------------------
 *
 * verifyAuth makes a cheap, identity-revealing call (a 1-row Statistics.pl read)
 * with the configured cookies. Success proves the UID + LoginToken are accepted;
 * a 401/403 proves they are not. Never throws — it is called by error handlers.
 */

import { adserviceRequest, STATISTICS_PATH, type AdserviceCredentials } from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('adservice.auth');

const SLUG = 'adservice';

const CREDENTIAL_HINT =
  'Set ADSERVICE_UID and ADSERVICE_LOGIN_TOKEN in ~/.affiliate-mcp/.env. ' +
  'Both are obtained from the Adservice publisher account via /Account.pl/loginToken ' +
  '(see https://publisher.adservice.com/doc/publisher/API/Statistics_pl.html).';

/**
 * Read UID + LoginToken from config and assemble the cookie credentials.
 * Throws a `config_error` NetworkError (via requireCredential) when either is missing.
 */
export function requireCredentials(operation: string): AdserviceCredentials {
  const uid = requireCredential('ADSERVICE_UID', {
    network: SLUG,
    operation,
    hint: CREDENTIAL_HINT,
  });
  const loginToken = requireCredential('ADSERVICE_LOGIN_TOKEN', {
    network: SLUG,
    operation,
    hint: CREDENTIAL_HINT,
  });
  return { uid, loginToken };
}

// ---------------------------------------------------------------------------
// VerifyAuth
// ---------------------------------------------------------------------------

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
 * Verify Adservice credentials with a minimal Statistics.pl read.
 *
 * Why Statistics.pl specifically: it is the documented self-serve reporting
 * endpoint and accepts the same UID + LoginToken cookies as every other call,
 * so a 200 proves the credentials are accepted. A 401/403 proves they are not.
 *
 * Never throws — returns { ok: false } on any failure so callers (including
 * error handlers) do not loop.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let credentials: AdserviceCredentials;
  try {
    credentials = requireCredentials('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    // Minimal read: a 1-row statistics call over a tiny window. We do not care
    // about the contents, only that the credentials are accepted.
    await adserviceRequest<unknown>({
      operation: 'verifyAuth',
      path: STATISTICS_PATH,
      credentials,
      query: { limit: 1, group_by: 'camp_title' },
      resilience: DEFAULT_RESILIENCE,
    });

    const affiliateId = getCredential('ADSERVICE_AFFILIATE_ID');
    const identity = affiliateId
      ? `adservice/affiliate:${affiliateId} (uid:${credentials.uid})`
      : `adservice/uid:${credentials.uid}`;

    log.debug({ identity }, 'adservice verifyAuth succeeded');
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
      hint: 'Check ADSERVICE_UID and ADSERVICE_LOGIN_TOKEN in your config.',
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

// ---------------------------------------------------------------------------
// Credential validation
// ---------------------------------------------------------------------------

/**
 * Validate a single credential field at wizard-entry time.
 *
 * ADSERVICE_UID: format check (non-empty) — validating it alone requires the
 *   LoginToken, so we defer the live check to the LoginToken step.
 * ADSERVICE_LOGIN_TOKEN: performs a full live Statistics.pl read with whatever
 *   ADSERVICE_UID is currently set, returning the upstream error on failure.
 * ADSERVICE_AFFILIATE_ID: optional identity label — format check only.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'ADSERVICE_UID') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'UID must not be empty.',
        hint: 'Your UID is the publisher/client ID obtained via /Account.pl/loginToken.',
      };
    }
    return {
      ok: true,
      message: 'UID format OK; will validate against the API after the LoginToken is entered.',
    };
  }

  if (field === 'ADSERVICE_LOGIN_TOKEN') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'LoginToken must not be empty.',
        hint: 'Your LoginToken is obtained via /Account.pl/loginToken in your Adservice account.',
      };
    }
    const prev = process.env['ADSERVICE_LOGIN_TOKEN'];
    process.env['ADSERVICE_LOGIN_TOKEN'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return {
          ok: true,
          message: result.identity ?? 'Credentials verified against the Adservice Statistics API.',
        };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check ADSERVICE_UID and ADSERVICE_LOGIN_TOKEN. Both come from /Account.pl/loginToken ' +
          'and must be copied without leading or trailing spaces.',
      };
    } finally {
      if (prev === undefined) {
        delete process.env['ADSERVICE_LOGIN_TOKEN'];
      } else {
        process.env['ADSERVICE_LOGIN_TOKEN'] = prev;
      }
    }
  }

  if (field === 'ADSERVICE_AFFILIATE_ID') {
    // Optional identity label; accept any non-empty value, accept blank as "not set".
    if (value && value.trim() !== '' && !/^[A-Za-z0-9_-]+$/.test(value.trim())) {
      return {
        ok: false,
        message: 'Affiliate ID should be an alphanumeric identifier.',
        hint: 'Find your Affiliate ID in the Account section of your Adservice publisher account.',
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Adservice.`,
    hint: 'Adservice expects ADSERVICE_UID, ADSERVICE_LOGIN_TOKEN, and optionally ADSERVICE_AFFILIATE_ID.',
  };
}
