/**
 * ShopMy auth + credential validation.
 *
 * ShopMy's Brand Partner API uses a long-lived partner token issued per brand.
 * The token is created from the brand partner dashboard and handed to the
 * integration; it does not auto-rotate, so we treat it as a static secret read
 * from `SHOPMY_API_TOKEN`. There is no refresh flow.
 *
 * The token is already scoped to a single brand by ShopMy, so there is no
 * account ID to derive in the way Awin derives a publisher ID. An optional
 * `SHOPMY_BRAND_NAME` env var is used purely as a human-readable label in the
 * identity string; it is never sent to the API.
 *
 * --- Auth check -------------------------------------------------------------
 *
 * `verifyAuth()` issues a minimal `GET /v1/Partners/OrderReport` request (a
 * single-record page). This is the cheapest authenticated brand-partner
 * endpoint with a predictable 200 / 401 response. We only inspect the HTTP
 * status; an empty-but-200 body (a brand with no orders) still proves the token
 * is valid.
 *
 * Never throw from `verifyAuth` — it is called by error handlers and the wizard;
 * throwing here would loop. Always return a structured result.
 */

import { shopmyRequest } from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('shopmy.auth');

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
 * Verify the ShopMy partner token by hitting the order report endpoint with a
 * one-record page. A valid token returns 200 (possibly with an empty result
 * set); an invalid token returns 401.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let token: string;
  try {
    token = requireCredential('SHOPMY_API_TOKEN', {
      network: 'shopmy',
      operation: 'verifyAuth',
      hint:
        'Generate a brand partner API token from the ShopMy brand dashboard and set ' +
        'SHOPMY_API_TOKEN in ~/.affiliate-mcp/.env.',
    });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    // Minimal probe — one record. We only care about the HTTP status; ShopMy
    // returns orders by transaction date descending, so a page size of 1 is the
    // cheapest authenticated read.
    await shopmyRequest<unknown>({
      operation: 'verifyAuth',
      path: '/v1/Partners/OrderReport',
      token,
      query: { limit: 1 },
      resilience: DEFAULT_RESILIENCE,
    });

    const brand = getCredential('SHOPMY_BRAND_NAME');
    const identity = brand ? `shopmy/${brand}` : 'shopmy (authenticated)';

    log.debug({ identity }, 'shopmy verifyAuth succeeded');
    return { ok: true, identity };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: 'shopmy',
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * SHOPMY_API_TOKEN:
 *   Writes the candidate token into process.env, calls verifyAuth(), then
 *   restores the previous value. Returns ok on success.
 *
 * SHOPMY_BRAND_NAME:
 *   Optional display label. Any non-empty string is accepted; it is never sent
 *   to the API.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'SHOPMY_API_TOKEN') {
    const previous = process.env['SHOPMY_API_TOKEN'];
    process.env['SHOPMY_API_TOKEN'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'token verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the partner token in the ShopMy brand dashboard. The token may be revoked, ' +
          'scoped to a different brand, or copied with leading/trailing whitespace.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['SHOPMY_API_TOKEN'];
      } else {
        process.env['SHOPMY_API_TOKEN'] = previous;
      }
    }
  }

  if (field === 'SHOPMY_BRAND_NAME') {
    if (value.trim() === '') {
      return {
        ok: false,
        message: 'SHOPMY_BRAND_NAME must not be empty if provided.',
        hint: 'This is an optional display label for your brand; leave it unset to skip it.',
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for ShopMy.`,
    hint: 'ShopMy expects SHOPMY_API_TOKEN (required) and SHOPMY_BRAND_NAME (optional label).',
  };
}
