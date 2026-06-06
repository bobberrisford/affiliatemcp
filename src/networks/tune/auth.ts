/**
 * TUNE (HasOffers) auth + credential validation.
 *
 * TUNE's Affiliate API authenticates with two values delivered as query
 * parameters on every call: an `api_key` (the affiliate API key from the
 * publisher dashboard) and a `NetworkId`. The key is long-lived; there is no
 * refresh flow.
 *
 * TUNE is multi-tenant: every network runs its own HasOffers instance, so the
 * key alone is not enough — it is only meaningful against that network's own
 * host. That host is built from the NetworkId
 * (`https://{network_id}.api.hasoffers.com`), supplied via `TUNE_NETWORK_ID`.
 * Both credentials are validated together: a key is only verifiable against the
 * NetworkId it belongs to.
 *
 * --- Auth check -------------------------------------------------------------
 *
 * `verifyAuth()` calls `Affiliate_Offer::findAll` with `limit=1`, the cheapest
 * authenticated affiliate call. A valid (NetworkId, key) pair returns HTTP 200
 * with an envelope `status > 0`; an invalid key returns an error envelope. We
 * never throw from `verifyAuth` — it is called by error handlers, and throwing
 * here would loop.
 */

import { tuneRequest, resolveBaseUrl } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('tune.auth');

const SLUG = 'tune';

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
 * Read the affiliate API key, surfacing a missing value as a config_error.
 */
export function requireApiKey(operation: string): string {
  return requireCredential('TUNE_API_KEY', {
    network: SLUG,
    operation,
    hint:
      'Find your affiliate API key in your TUNE/HasOffers publisher dashboard ' +
      '(API tab / API access), then set TUNE_API_KEY in ~/.affiliate-mcp/.env.',
  });
}

/**
 * Read the NetworkId, surfacing a missing value as a config_error.
 */
export function requireNetworkId(operation: string): string {
  return requireCredential('TUNE_NETWORK_ID', {
    network: SLUG,
    operation,
    hint:
      'Set TUNE_NETWORK_ID to your network identifier (shown alongside your API key ' +
      'in the publisher dashboard). The API host is built from it.',
  });
}

/**
 * Verify the TUNE credentials by calling `Affiliate_Offer::findAll` with limit 1.
 *
 * Why this call:
 *   - It is the simplest authenticated affiliate call with a predictable
 *     success / failure envelope.
 *   - With `limit=1` the payload is tiny so the call is fast.
 *   - It exercises BOTH credentials: the NetworkId (host + routing param) and
 *     the API key (authorisation) must be correct together.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let apiKey: string;
  let baseUrl: string;
  let networkId: string;
  try {
    baseUrl = resolveBaseUrl('verifyAuth');
    networkId = requireNetworkId('verifyAuth');
    apiKey = requireApiKey('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    await tuneRequest<unknown>({
      operation: 'verifyAuth',
      target: 'Affiliate_Offer',
      apiMethod: 'findAll',
      apiKey,
      baseUrl,
      networkId,
      query: { limit: 1, page: 1 },
      resilience: DEFAULT_RESILIENCE,
    });

    // The NetworkId is the only stable identity we can derive without a
    // dedicated profile endpoint; the key is scoped to a single affiliate
    // account by the network.
    const identity = `tune (${networkId})`;
    log.debug({ identity }, 'tune verifyAuth succeeded');
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
 * TUNE_NETWORK_ID:
 *   Format check only — must be a non-empty DNS-safe label. We do not call the
 *   network here because the API key may not yet be entered.
 *
 * TUNE_API_KEY:
 *   Writes the candidate key into process.env, calls verifyAuth() (which also
 *   reads TUNE_NETWORK_ID), then restores the previous value.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'TUNE_NETWORK_ID') {
    if (!/^[A-Za-z0-9-]+$/.test(value.trim())) {
      return {
        ok: false,
        message: 'The NetworkId must contain only letters, digits, and hyphens.',
        hint: 'Use the bare NetworkId from the publisher dashboard, e.g. "atollsnet".',
      };
    }
    return {
      ok: true,
      message: `Network host will be https://${value.trim()}.api.hasoffers.com.`,
    };
  }

  if (field === 'TUNE_API_KEY') {
    const previous = process.env['TUNE_API_KEY'];
    process.env['TUNE_API_KEY'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'API key verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Confirm TUNE_NETWORK_ID matches your network and that the affiliate API key ' +
          'from the publisher dashboard is current and not revoked.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['TUNE_API_KEY'];
      } else {
        process.env['TUNE_API_KEY'] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for TUNE.`,
    hint: 'TUNE expects TUNE_NETWORK_ID and TUNE_API_KEY.',
  };
}
