/**
 * mrge auth + credential validation.
 *
 * mrge (the rebranded Yieldkit/Metapic platform) uses a three-credential
 * authentication scheme: api_key, api_secret, and site_id. These are found
 * in the publisher dashboard under Account → API access (for api_key and
 * api_secret) and Account → Your Sites (for site_id).
 *
 * Auth model: "custom" — credentials are passed as query parameters, not in
 * an Authorization header. This is the Yieldkit legacy pattern confirmed
 * by public API documentation and third-party integration guides.
 *
 * BLOCKED(verify): If publisher-api.mrge.com accepts a Bearer token in the
 *   Authorization header, migrate auth_model to "bearer" and adjust buildAuthParams.
 *   Cannot verify without live credentials; publisher-api.mrge.com returns
 *   HTTP 403 to all automated fetches as of 2026-05-28.
 *
 * verifyAuth: uses GET /v2/advertiser/terms?api_key=…&api_secret=…&site_id=…
 * with limit=1. This is the cheapest grounded endpoint that confirms all three
 * credentials are valid simultaneously. A 401/403 means credentials are invalid;
 * a 200 with an empty results set means the credentials are valid but the site
 * has no active programmes — which is still auth success.
 *
 * BLOCKED(verify): confirm the exact endpoint URL and response shape for the
 *   mrge publisher-api.mrge.com surface vs the legacy api.yieldkit.com surface.
 *   Requires live credentials; both surfaces return 403 to automated fetches.
 */

import { mrgeRequest, MRGE_BASE_URL } from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('mrge.auth');

/**
 * Minimal shape of a Yieldkit advertiser/terms response item.
 * Used only to confirm the API returns a parseable response — we don't use
 * the data itself in verifyAuth.
 * BLOCKED(verify): confirm the exact response shape from api.yieldkit.com/v2/advertiser/terms.
 *   The envelope (array vs. wrapped object) requires live API access.
 */
interface MrgeAdvertiserTermsResponse {
  advertiser?: Array<{
    id?: number | string;
    name?: string;
  }>;
  // The Yieldkit API may return results in a top-level array directly.
  // BLOCKED(verify): confirm the envelope shape with live credentials.
  results?: unknown[];
  count?: number;
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
 * Verify mrge credentials by making a cheap call to the advertiser terms
 * endpoint. Returns identity on success or a structured failure — never throws.
 *
 * Why this endpoint: it requires all three credentials (api_key, api_secret,
 * site_id) and returns a clean 401/403 on bad credentials. A 200 response
 * (even with empty results) confirms auth is working.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let apiKey: string;
  let apiSecret: string;
  let siteId: string;

  try {
    apiKey = requireCredential('MRGE_API_KEY', {
      network: 'mrge',
      operation: 'verifyAuth',
      hint: 'Find your API key in the mrge publisher dashboard under Account → API access.',
    });
    apiSecret = requireCredential('MRGE_API_SECRET', {
      network: 'mrge',
      operation: 'verifyAuth',
      hint: 'Find your API secret in the mrge publisher dashboard under Account → API access.',
    });
    siteId = requireCredential('MRGE_SITE_ID', {
      network: 'mrge',
      operation: 'verifyAuth',
      hint: 'Find your Site ID in the mrge publisher dashboard under Account → Your Sites.',
    });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    const response = await mrgeRequest<MrgeAdvertiserTermsResponse | unknown[]>({
      operation: 'verifyAuth',
      baseUrl: MRGE_BASE_URL,
      path: '/v2/advertiser/terms',
      apiKey,
      apiSecret,
      query: {
        site_id: siteId,
        limit: 1,
      },
      resilience: DEFAULT_RESILIENCE,
    });

    log.debug({ siteId }, 'mrge verifyAuth succeeded');

    // Derive a human-readable identity. The response shape is uncertain —
    // we just confirm auth worked and label by site_id.
    const identity = `mrge/site:${siteId}`;

    void response; // shape is uncertain; we only care that the call succeeded.

    return { ok: true, identity };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: 'mrge',
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Retrieve the three credentials required by every mrge API call.
 * Throws a NetworkError (config_error envelope) if any are missing.
 */
export function requireAuthParams(operation: string): {
  apiKey: string;
  apiSecret: string;
  siteId: string;
} {
  return {
    apiKey: requireCredential('MRGE_API_KEY', {
      network: 'mrge',
      operation,
      hint: 'Find your API key in the mrge publisher dashboard under Account → API access.',
    }),
    apiSecret: requireCredential('MRGE_API_SECRET', {
      network: 'mrge',
      operation,
      hint: 'Find your API secret in the mrge publisher dashboard under Account → API access.',
    }),
    siteId: requireCredential('MRGE_SITE_ID', {
      network: 'mrge',
      operation,
      hint: 'Find your Site ID in the mrge publisher dashboard under Account → Your Sites.',
    }),
  };
}

/**
 * Optional convenience: return the site_id without throwing if unset.
 */
export function getSiteId(): string | undefined {
  return getCredential('MRGE_SITE_ID');
}

/**
 * Per-field validation called by the setup wizard.
 *
 * MRGE_API_KEY / MRGE_API_SECRET: a live verifyAuth call confirms both
 * are valid together (they must be used as a pair). We only do a live check
 * when both are present.
 *
 * MRGE_SITE_ID: format-validate as a hexadecimal string. The Yieldkit
 * site_id is a 24- or 32-character hex string (confirmed from live API
 * call captures on any.run showing site_id=0fb9199cb9ce464f9c82523578c269b4
 * and docs example site_id=51e8ee76e4b0dc18d49a4337). Not a plain integer.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'MRGE_API_KEY') {
    // Yieldkit API keys are 32-character lowercase hex strings (MD5-like).
    // Example from live docs: c5c2398597a6adcd9b149ad745f207f4
    // Source: public.yieldkit.com documentation example.
    if (!value || value.trim().length < 8) {
      return {
        ok: false,
        message: 'API key appears too short to be valid (expected a 32-character hex string).',
        hint: 'Find your API key at https://home.yieldkit.com/account/api. It is a 32-character hex string.',
      };
    }
    // We cannot validate the key without also having the secret and site_id.
    // Return a format-only pass so the wizard can proceed.
    return { ok: true, message: 'API key format accepted; live validation will occur at the end of setup.' };
  }

  if (field === 'MRGE_API_SECRET') {
    // Yieldkit API secrets are 32-character lowercase hex strings (MD5-like).
    // Example from live docs: 74607007cdb6b0db4b3219c8adee3e09
    // Source: public.yieldkit.com documentation example.
    if (!value || value.trim().length < 8) {
      return {
        ok: false,
        message: 'API secret appears too short to be valid (expected a 32-character hex string).',
        hint: 'Find your API secret at https://home.yieldkit.com/account/api. It is a 32-character hex string.',
      };
    }
    return { ok: true, message: 'API secret format accepted; live validation will occur at the end of setup.' };
  }

  if (field === 'MRGE_SITE_ID') {
    // Yieldkit site IDs are hexadecimal strings (24 or 32 hex characters),
    // not plain integers. Examples from live API calls:
    //   24-char: 51e8ee76e4b0dc18d49a4337 (MongoDB ObjectId format)
    //   32-char: 0fb9199cb9ce464f9c82523578c269b4 (MD5 hash format)
    // Source: public.yieldkit.com docs example + malware sandbox captures of
    // real Yieldkit API calls (any.run reports, 2024).
    if (!/^[0-9a-f]{20,40}$/i.test(value)) {
      return {
        ok: false,
        message: 'mrge site ID must be a hexadecimal string (24 or 32 characters, e.g. 51e8ee76e4b0dc18d49a4337).',
        hint: 'Find your Site ID in the mrge publisher dashboard at https://home.yieldkit.com/account/sites. It looks like a 24- or 32-character hex string, not a plain number.',
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for mrge.`,
    hint: 'mrge expects MRGE_API_KEY, MRGE_API_SECRET, and MRGE_SITE_ID.',
  };
}
