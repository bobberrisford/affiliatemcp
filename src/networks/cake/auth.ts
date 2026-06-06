/**
 * CAKE auth + credential validation.
 *
 * CAKE authenticates with an Affiliate API Key passed as the `api_key` query
 * parameter, scoped to a single affiliate account. The affiliate also supplies
 * their numeric `affiliate_id`. Both are obtained from the affiliate portal:
 * log in, then click "Reporting API" in the top-right — the panel shows the
 * Affiliate ID and the API Key.
 *
 * CAKE is a per-instance platform: each network runs on its own host. The host
 * itself is a credential (`CAKE_BASE_URL`); without it we cannot address any
 * endpoint. There is no shared/global CAKE API host.
 *
 * There is no token-refresh flow: the API key is static. If it is compromised,
 * the affiliate regenerates it from the same Reporting API panel.
 *
 * --- Auth check -------------------------------------------------------------
 *
 * `verifyAuth()` calls the affiliate OfferFeed endpoint
 * `GET /affiliates/api/4/offers.asmx/OfferFeed?api_key=...&affiliate_id=...`,
 * the cheapest authenticated affiliate endpoint. A valid key returns 200 XML;
 * an invalid key returns a non-2xx (or an XML body with success=false).
 *
 * Never throw from verifyAuth — it is invoked by error handlers. Failures are
 * returned as `{ ok: false, reason, envelope }`.
 */

import { cakeRequest, requireBaseUrl } from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('cake.auth');

const SLUG = 'cake';

export interface VerifyAuthOk {
  ok: true;
  identity?: string;
}

export interface VerifyAuthFail {
  ok: false;
  reason: string;
  envelope?: NetworkErrorEnvelope;
}

/** Affiliate OfferFeed endpoint — the cheapest authenticated affiliate call. */
export const OFFERFEED_PATH = '/affiliates/api/4/offers.asmx/OfferFeed';

export function requireApiKey(operation: string): string {
  return requireCredential('CAKE_API_KEY', {
    network: SLUG,
    operation,
    hint:
      'Find your Affiliate API Key in the CAKE affiliate portal: log in, then ' +
      'click "Reporting API" (top-right). Set it as CAKE_API_KEY.',
  });
}

export function requireAffiliateId(operation: string): string {
  return requireCredential('CAKE_AFFILIATE_ID', {
    network: SLUG,
    operation,
    hint:
      'Your numeric Affiliate ID is shown alongside the API Key in the CAKE ' +
      'affiliate portal Reporting API panel. Set it as CAKE_AFFILIATE_ID.',
  });
}

/**
 * Verify the CAKE credentials by calling the affiliate OfferFeed endpoint.
 *
 * Why this endpoint: it is a documented affiliate-scoped report that requires
 * only `api_key` + `affiliate_id`, so it doubles as the cheapest auth probe.
 *
 * The identity string combines the instance host with the affiliate id, since
 * a CAKE affiliate account is only meaningful relative to its instance.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let apiKey: string;
  let affiliateId: string;
  let baseUrl: string;
  try {
    baseUrl = requireBaseUrl('verifyAuth');
    apiKey = requireApiKey('verifyAuth');
    affiliateId = requireAffiliateId('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    await cakeRequest({
      operation: 'verifyAuth',
      path: OFFERFEED_PATH,
      apiKey,
      query: { affiliate_id: affiliateId, start_at_row: 1, row_limit: 1 },
      resilience: DEFAULT_RESILIENCE,
    });

    let host = baseUrl;
    try {
      host = new URL(baseUrl).host;
    } catch {
      /* keep the raw value */
    }
    const identity = `cake/${host}/affiliate/${affiliateId}`;
    log.debug({ identity }, 'cake verifyAuth succeeded');
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
 * CAKE_BASE_URL:
 *   Format check only — must parse as an http(s) URL. We cannot probe it on its
 *   own because the API also needs the key and affiliate id.
 *
 * CAKE_API_KEY:
 *   When the base URL and affiliate id are already configured, writes the
 *   candidate key into process.env and runs verifyAuth(), restoring the prior
 *   value afterwards. Otherwise a presence check only (the API call needs the
 *   other two credentials, which may not be entered yet).
 *
 * CAKE_AFFILIATE_ID:
 *   Format check only — must be a positive integer.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'CAKE_BASE_URL') {
    try {
      const u = new URL(value);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return {
          ok: false,
          message: 'CAKE_BASE_URL must use http or https.',
          hint: 'Example: https://your-network.cakemarketing.com',
        };
      }
      return { ok: true };
    } catch {
      return {
        ok: false,
        message: 'CAKE_BASE_URL is not a valid URL.',
        hint: 'Use the full host including scheme, e.g. https://your-network.cakemarketing.com.',
      };
    }
  }

  if (field === 'CAKE_AFFILIATE_ID') {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      return {
        ok: false,
        message: 'CAKE affiliate ID must be a positive integer.',
        hint: 'It is shown next to the API Key in the affiliate portal Reporting API panel.',
      };
    }
    return { ok: true };
  }

  if (field === 'CAKE_API_KEY') {
    const haveContext =
      getCredential('CAKE_BASE_URL') !== undefined &&
      getCredential('CAKE_AFFILIATE_ID') !== undefined;
    if (!haveContext) {
      // Can't probe without the host + affiliate id. Presence check only.
      if (value.trim() === '') {
        return { ok: false, message: 'CAKE_API_KEY must not be empty.' };
      }
      return {
        ok: true,
        message: 'API key recorded; will be verified once CAKE_BASE_URL and CAKE_AFFILIATE_ID are set.',
      };
    }

    const previous = process.env['CAKE_API_KEY'];
    process.env['CAKE_API_KEY'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'API key verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the API key in the CAKE affiliate portal Reporting API panel, and confirm ' +
          'CAKE_BASE_URL points at the correct instance host.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['CAKE_API_KEY'];
      } else {
        process.env['CAKE_API_KEY'] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for CAKE.`,
    hint: 'CAKE expects CAKE_BASE_URL, CAKE_API_KEY, and CAKE_AFFILIATE_ID.',
  };
}
