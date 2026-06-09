/**
 * Offer18 auth + credential validation.
 *
 * Offer18 is a tenant network engine. Affiliate-side API calls (`/api/af/...`)
 * authenticate with THREE query parameters carried on every request, plus the
 * per-tenant instance host:
 *
 *   OFFER18_BASE_URL   → the instance API host (a CREDENTIAL, not a constant).
 *                        See client.ts requireBaseUrl. There is no default —
 *                        each Offer18-powered network runs on its own host.
 *   OFFER18_API_KEY    → the affiliate API `key` query parameter.
 *   OFFER18_SECRET_KEY → the affiliate account id `aid` query parameter.
 *                        Offer18's own naming for the affiliate API uses
 *                        `key` (API key) + `aid` (affiliate id) + `mid`. The
 *                        "Secret key" shown under Account » Security pairs with
 *                        the API key as the affiliate's secret/account
 *                        identifier; we carry it as `aid`. Confirm against your
 *                        instance — see known_limitations.
 *   OFFER18_MID        → the network/advertiser `mid` query parameter.
 *
 * Credentials come from the affiliate dashboard under Account » Security
 * (click "view" to reveal the Secret key). The API key and MID are shown in the
 * same area / the affiliate's API access panel.
 *
 * --- Auth check -------------------------------------------------------------
 *
 * `verifyAuth()` calls `GET {base}/api/af/offers?key=..&aid=..&mid=..&page=1`,
 * the cheapest authenticated affiliate endpoint. Valid credentials return 200
 * with an offers payload; invalid credentials return a non-2xx with a body that
 * we surface verbatim.
 *
 * There is no refresh flow — the key/secret are long-lived. If compromised, the
 * affiliate regenerates them under Account » Security.
 */

import { offer18Request, requireBaseUrl, SLUG } from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('offer18.auth');

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
 * Resolve the three affiliate auth query parameters from env.
 *
 * Throws a NetworkError (config_error envelope) via requireCredential if any
 * are missing. The MID is numeric on Offer18; the key/aid are opaque strings.
 */
export function requireAuthParams(operation: string): {
  key: string;
  aid: string;
  mid: string;
} {
  const key = requireCredential('OFFER18_API_KEY', {
    network: SLUG,
    operation,
    hint:
      'Find your affiliate API key under Account » Security in your Offer18 dashboard, ' +
      'then set OFFER18_API_KEY in ~/.affiliate-mcp/.env.',
  });
  const aid = requireCredential('OFFER18_SECRET_KEY', {
    network: SLUG,
    operation,
    hint:
      'Find your Secret key under Account » Security (click "view"), then set ' +
      'OFFER18_SECRET_KEY in ~/.affiliate-mcp/.env.',
  });
  const mid = requireCredential('OFFER18_MID', {
    network: SLUG,
    operation,
    hint:
      'Your network/advertiser MID is shown alongside the API credentials under ' +
      'Account » Security. Set OFFER18_MID in ~/.affiliate-mcp/.env.',
  });
  return { key, aid, mid };
}

/**
 * Verify Offer18 credentials by calling `GET /api/af/offers`.
 *
 * Why this endpoint: it is the simplest authenticated affiliate endpoint with a
 * predictable 200 / non-2xx response pattern, and `page=1` keeps the payload
 * small. On success we report the affiliate id + MID as the identity string.
 *
 * Never throws — verifyAuth is itself called by error handlers, so it returns a
 * structured failure instead of looping.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let baseUrl: string;
  let auth: { key: string; aid: string; mid: string };
  try {
    baseUrl = requireBaseUrl('verifyAuth');
    auth = requireAuthParams('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    await offer18Request<unknown>({
      operation: 'verifyAuth',
      baseUrl,
      path: '/api/af/offers',
      query: { key: auth.key, aid: auth.aid, mid: auth.mid, page: 1 },
      resilience: DEFAULT_RESILIENCE,
    });

    const identity = `offer18/affiliate/${auth.aid}@mid:${auth.mid}`;
    log.debug({ identity }, 'offer18 verifyAuth succeeded');
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
 * OFFER18_BASE_URL : format check — must parse as an http(s) URL.
 * OFFER18_MID      : format check — must be a positive integer.
 * OFFER18_API_KEY /
 * OFFER18_SECRET_KEY: a live check needs ALL of base URL + key + secret + mid,
 *                     so when the others are already present we run verifyAuth;
 *                     otherwise we accept a non-empty value and defer the live
 *                     check to the first authenticated call.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'OFFER18_BASE_URL') {
    try {
      const u = new URL(value);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return {
          ok: false,
          message: 'Base URL must use http or https.',
          hint: 'Example: https://api.offer18.com',
        };
      }
      return { ok: true };
    } catch {
      return {
        ok: false,
        message: 'Base URL is not a valid URL.',
        hint: 'Example: https://api.offer18.com',
      };
    }
  }

  if (field === 'OFFER18_MID') {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      return {
        ok: false,
        message: 'Offer18 MID must be a positive integer.',
        hint: 'Your MID is shown alongside the API credentials under Account » Security.',
      };
    }
    return { ok: true };
  }

  if (field === 'OFFER18_API_KEY' || field === 'OFFER18_SECRET_KEY') {
    if (!value || value.trim() === '') {
      return { ok: false, message: `${field} must not be empty.` };
    }
    // A live check only works if the rest of the credential set is present.
    const haveOthers =
      getCredential('OFFER18_BASE_URL') &&
      getCredential('OFFER18_MID') &&
      (field === 'OFFER18_API_KEY'
        ? getCredential('OFFER18_SECRET_KEY')
        : getCredential('OFFER18_API_KEY'));

    if (!haveOthers) {
      return {
        ok: true,
        message: 'Stored. Full verification runs once base URL, key, secret and MID are all set.',
      };
    }

    const previous = process.env[field];
    process.env[field] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'Credentials verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Confirm the affiliate API key, Secret key and MID under Account » Security on your ' +
          'Offer18 instance, and that OFFER18_BASE_URL points at the correct host.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env[field];
      } else {
        process.env[field] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Offer18.`,
    hint:
      'Offer18 expects OFFER18_BASE_URL, OFFER18_API_KEY, OFFER18_SECRET_KEY and OFFER18_MID.',
  };
}
