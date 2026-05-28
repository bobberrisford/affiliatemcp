/**
 * Partnerize (Advertiser) — auth helpers.
 *
 * The Partnerize Brand API uses HTTP Basic Authentication:
 *   Authorization: Basic base64(application_key:user_api_key)
 *
 *   application_key  — identifies the network (found in Partnerize dashboard
 *                       → Settings → API Credentials → Application Key).
 *   user_api_key     — identifies the user making the request (found in the
 *                       same page → User API Key).
 *
 * Both credentials are brand-scoped — one set addresses the brands (campaigns)
 * visible to that user's Partnerize account. `listBrands()` calls the campaigns
 * endpoint to enumerate them.
 *
 * The cheapest identity-revealing endpoint is:
 *   GET https://api.partnerize.com/v3/brand/campaigns?limit=1
 * which returns the list of campaigns this credential can access. A 200 response
 * confirms auth; a 401/403 surfaces the verbatim body.
 *
 * Reference: Impact advertiser auth.ts (also Basic auth; same structural pattern).
 *
 * TODO(verify): exact response field names and 401 body shape from a live account.
 */

import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { requireCredential } from '../../shared/config.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('partnerize-advertiser.auth');

export const SLUG = 'partnerize-advertiser';

export const BASE_URL = 'https://api.partnerize.com';

/**
 * Construct the Basic-auth header value for Partnerize.
 * `application_key` is the username; `user_api_key` is the password.
 */
export function basicAuthHeader(applicationKey: string, userApiKey: string): string {
  const encoded = Buffer.from(`${applicationKey}:${userApiKey}`).toString('base64');
  return `Basic ${encoded}`;
}

/**
 * Load both credentials from the environment (throw `config_error` if absent).
 */
export function loadCredentials(operation: string): {
  applicationKey: string;
  userApiKey: string;
} {
  const applicationKey = requireCredential('PARTNERIZE_APPLICATION_KEY', {
    network: SLUG,
    operation,
    hint:
      'Find your Application Key in the Partnerize dashboard under Settings → API Credentials → ' +
      'Application Key. Run `affiliate-networks-mcp setup partnerize-advertiser` to configure.',
  });
  const userApiKey = requireCredential('PARTNERIZE_USER_API_KEY', {
    network: SLUG,
    operation,
    hint:
      'Find your User API Key in the Partnerize dashboard under Settings → API Credentials → ' +
      'User API Key. Run `affiliate-networks-mcp setup partnerize-advertiser` to configure.',
  });
  return { applicationKey, userApiKey };
}

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
 * Verify auth by probing the brand campaigns endpoint with a limit of 1.
 * Returns a structured result; never throws (auth is called by error handlers).
 *
 * TODO(verify): response body field names from a live account; some Partnerize
 * tenants may surface a user-name or account-name for a friendlier identity.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let applicationKey: string;
  let userApiKey: string;
  try {
    const creds = loadCredentials('verifyAuth');
    applicationKey = creds.applicationKey;
    userApiKey = creds.userApiKey;
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'config_error',
      network: SLUG,
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }

  try {
    const url = `${BASE_URL}/v3/brand/campaigns?limit=1`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: basicAuthHeader(applicationKey, userApiKey),
        Accept: 'application/json',
      },
    });
    const body = await res.text();

    if (res.status === 401 || res.status === 403) {
      const envelope = buildErrorEnvelope({
        type: 'auth_error',
        network: SLUG,
        operation: 'verifyAuth',
        httpStatus: res.status,
        networkErrorBody: body,
        message: `Partnerize rejected the Application Key / User API Key (HTTP ${res.status}).`,
        hint:
          'Double-check both keys at Partnerize dashboard → Settings → API Credentials. ' +
          'The User API Key must belong to a user with access to brand campaigns.',
      });
      return { ok: false, reason: envelope.message, envelope };
    }

    if (!res.ok) {
      const envelope = buildErrorEnvelope({
        type: 'network_api_error',
        network: SLUG,
        operation: 'verifyAuth',
        httpStatus: res.status,
        networkErrorBody: body,
        message: `Partnerize campaigns probe returned HTTP ${res.status}.`,
      });
      return { ok: false, reason: envelope.message, envelope };
    }

    const identity = `partnerize-advertiser/${redact(applicationKey)}`;
    log.debug({ identity }, 'Partnerize advertiser auth verified');
    return { ok: true, identity };
  } catch (err) {
    const envelope = buildErrorEnvelope({
      type: 'network_unavailable',
      network: SLUG,
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate one credential field at wizard-entry time.
 *
 * `PARTNERIZE_APPLICATION_KEY` — format-validate only (alphanumeric string).
 * `PARTNERIZE_USER_API_KEY`    — live-probe if application_key is already set;
 *                                otherwise accept format and defer.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'PARTNERIZE_APPLICATION_KEY') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Partnerize Application Key is required.',
        hint: 'Find it at Partnerize dashboard → Settings → API Credentials → Application Key.',
      };
    }
    // Application keys are alphanumeric strings; minimum 6 characters.
    // TODO(verify): exact format/length from a live Partnerize account.
    if (!/^[A-Za-z0-9_-]{6,}$/.test(value.trim())) {
      return {
        ok: false,
        message: 'Partnerize Application Key looks malformed (expected an alphanumeric string).',
        hint: 'Copy the key exactly without leading/trailing whitespace.',
      };
    }
    return { ok: true };
  }

  if (field === 'PARTNERIZE_USER_API_KEY') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Partnerize User API Key is required.',
        hint: 'Find it at Partnerize dashboard → Settings → API Credentials → User API Key.',
      };
    }

    const appKey = process.env['PARTNERIZE_APPLICATION_KEY'];
    if (!appKey) {
      return {
        ok: true,
        message:
          'User API Key format accepted; live validation deferred until Application Key is set.',
      };
    }

    // Temporarily set the value to probe the live API.
    const previous = process.env['PARTNERIZE_USER_API_KEY'];
    process.env['PARTNERIZE_USER_API_KEY'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: 'Partnerize credentials verified successfully.' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Confirm both the Application Key and User API Key are correct at ' +
          'Partnerize dashboard → Settings → API Credentials.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['PARTNERIZE_USER_API_KEY'];
      } else {
        process.env['PARTNERIZE_USER_API_KEY'] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Partnerize advertiser.`,
    hint: 'Partnerize advertiser expects PARTNERIZE_APPLICATION_KEY and PARTNERIZE_USER_API_KEY.',
  };
}

function redact(key: string): string {
  if (key.length <= 6) return '****';
  return `${key.slice(0, 4)}…${key.slice(-2)}`;
}
