/**
 * Scaleo auth + credential validation.
 *
 * Scaleo authenticates via an `api-key` query parameter (not an HTTP header).
 * The key is long-lived and scoped to a single user (here, an affiliate
 * account). API access must be switched on per user by the platform
 * administrator: profile edit page → API Access switcher → save; the key then
 * appears under Account → API.
 *
 * There is no token-refresh flow: the key is static. If compromised, the
 * administrator must rotate it.
 *
 * --- Two credentials, both required ----------------------------------------
 *
 *   SCALEO_BASE_URL  the network's per-tenant tracking URL (the API host).
 *                    Scaleo has no shared API host; every Scaleo-powered
 *                    network lives at its own domain.
 *   SCALEO_API_KEY   the affiliate API key.
 *
 * --- Auth check -------------------------------------------------------------
 *
 * `verifyAuth()` calls `GET /api/v2/affiliate/offers?page=1&perPage=1`, the
 * cheapest authenticated affiliate endpoint. A valid key returns 200; an
 * invalid key returns 401/403 with a JSON error body. The affiliate's own
 * identity is not derivable from this response — the key is already scoped to
 * one affiliate by the administrator — so the identity string is best-effort
 * (the configured base URL host).
 */

import { scaleoRequest, requireBaseUrl, requireApiKey } from './client.js';
import { NetworkError, buildErrorEnvelope } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('scaleo.auth');

const SLUG = 'scaleo';

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
 * Verify the Scaleo credentials by calling `GET /affiliate/offers`.
 *
 * Why this endpoint:
 *   - It is the simplest authenticated affiliate endpoint with a predictable
 *     200 / 401 response pattern.
 *   - With perPage=1 the payload is tiny so the call is fast.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let baseUrl: string;
  let apiKey: string;
  try {
    baseUrl = requireBaseUrl('verifyAuth');
    apiKey = requireApiKey('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    await scaleoRequest<unknown>({
      operation: 'verifyAuth',
      path: '/offers',
      baseUrl,
      apiKey,
      query: { page: 1, perPage: 1 },
      resilience: DEFAULT_RESILIENCE,
    });

    // The API key does not encode an affiliate ID; use the tenant host as a
    // human-readable identity hint.
    const host = (() => {
      try {
        return new URL(baseUrl).host;
      } catch {
        return baseUrl;
      }
    })();
    const identity = `scaleo (${host})`;
    log.debug({ identity }, 'scaleo verifyAuth succeeded');
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
 * SCALEO_BASE_URL:
 *   Format check only — must parse as an absolute http(s) URL. We cannot verify
 *   reachability without the API key, which may not be entered yet.
 *
 * SCALEO_API_KEY:
 *   Writes the candidate key into process.env, calls verifyAuth(), then
 *   restores the previous value. Requires SCALEO_BASE_URL to be set already.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'SCALEO_BASE_URL') {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return {
        ok: false,
        message: 'SCALEO_BASE_URL must be a valid URL.',
        hint: 'Provide the full tracking URL including scheme, e.g. https://yournetwork.scaletrk.com.',
      };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return {
        ok: false,
        message: 'SCALEO_BASE_URL must use http or https.',
        hint: 'Provide the full tracking URL including scheme, e.g. https://yournetwork.scaletrk.com.',
      };
    }
    return { ok: true };
  }

  if (field === 'SCALEO_API_KEY') {
    const previous = process.env['SCALEO_API_KEY'];
    process.env['SCALEO_API_KEY'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'API key verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Confirm SCALEO_BASE_URL is set to your tracking URL, then ask your Scaleo administrator ' +
          'to confirm API Access is enabled on your affiliate profile (profile edit → API Access switcher).',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['SCALEO_API_KEY'];
      } else {
        process.env['SCALEO_API_KEY'] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Scaleo.`,
    hint: 'Scaleo expects SCALEO_BASE_URL (your tracking URL) and SCALEO_API_KEY.',
  };
}
