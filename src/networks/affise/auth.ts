/**
 * Affise auth + credential validation.
 *
 * Affise uses an affiliate-panel API key delivered via the custom `API-Key`
 * header. The affiliate finds their key under Settings › Security in their
 * Affise partner panel. The key is long-lived; there is no refresh flow.
 *
 * Affise is multi-tenant: every network runs its own Affise instance, so the
 * key alone is not enough — it is only meaningful against that network's own
 * API host. That host is the network's tracking domain
 * (Settings › Tracking domains), supplied via `AFFISE_BASE_URL`. Both
 * credentials are validated together: a key is only verifiable against the base
 * URL it belongs to.
 *
 * --- Auth check -------------------------------------------------------------
 *
 * `verifyAuth()` calls `GET /3.0/partner/offers?page=1&limit=1`, the cheapest
 * authenticated affiliate endpoint. A valid (base, key) pair returns 200; an
 * invalid key returns a 4xx with a JSON error body.
 */

import { affiseRequest, resolveBaseUrl } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('affise.auth');

const SLUG = 'affise';

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
 * Verify the Affise credentials by calling `GET /3.0/partner/offers`.
 *
 * Why this endpoint:
 *   - It is the simplest authenticated affiliate endpoint with a predictable
 *     200 / 4xx response pattern.
 *   - With `limit=1` the payload is tiny so the call is fast.
 *   - It exercises BOTH credentials: the base URL (host reachability) and the
 *     API key (authorisation) must be correct together.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let apiKey: string;
  let baseUrl: string;
  try {
    baseUrl = resolveBaseUrl('verifyAuth');
    apiKey = requireCredential('AFFISE_API_KEY', {
      network: SLUG,
      operation: 'verifyAuth',
      hint:
        'Find your affiliate API key in your Affise partner panel under ' +
        'Settings → Security, then set AFFISE_API_KEY in ~/.affiliate-mcp/.env.',
    });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    await affiseRequest<unknown>({
      operation: 'verifyAuth',
      path: '/3.0/partner/offers',
      apiKey,
      baseUrl,
      query: { page: 1, limit: 1 },
      resilience: DEFAULT_RESILIENCE,
    });

    // The Affise host is the only stable identity we can derive without a
    // dedicated profile endpoint; the key is scoped to a single partner account
    // by the network.
    const identity = `affise (${new URL(baseUrl).host})`;
    log.debug({ identity }, 'affise verifyAuth succeeded');
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
 * AFFISE_BASE_URL:
 *   Format check only — must be a valid http(s) URL. We do not call the network
 *   here because the API key may not yet be entered.
 *
 * AFFISE_API_KEY:
 *   Writes the candidate key into process.env, calls verifyAuth() (which also
 *   reads AFFISE_BASE_URL), then restores the previous value.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'AFFISE_BASE_URL') {
    try {
      const u = new URL(value);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return {
          ok: false,
          message: 'The tracking-domain base URL must use http or https.',
          hint: 'Example: https://api-yournetwork.affise.com',
        };
      }
      return { ok: true, message: `Base URL looks valid (${u.origin}).` };
    } catch {
      return {
        ok: false,
        message: `"${value}" is not a valid URL.`,
        hint:
          'Paste your network\'s tracking domain from Settings → Tracking domains, ' +
          'including the scheme, e.g. https://api-yournetwork.affise.com.',
      };
    }
  }

  if (field === 'AFFISE_API_KEY') {
    const previous = process.env['AFFISE_API_KEY'];
    process.env['AFFISE_API_KEY'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'API key verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Confirm AFFISE_BASE_URL points at your network\'s tracking domain and that the ' +
          'API key from Settings → Security is current and not revoked.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['AFFISE_API_KEY'];
      } else {
        process.env['AFFISE_API_KEY'] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Affise.`,
    hint: 'Affise expects AFFISE_BASE_URL and AFFISE_API_KEY.',
  };
}
