/**
 * Everflow auth + credential validation.
 *
 * Everflow uses a custom API key delivered via the `X-Eflow-API-Key` header.
 * The key is a long-lived secret created by a network admin under the affiliate
 * account's "API" tab. Affiliates cannot self-issue keys; they must be generated
 * by the network operator and handed to the affiliate.
 *
 * Important: there is no refresh flow. The key is static and long-lived.
 * If a key is compromised, the network admin must revoke it and issue a new one.
 *
 * --- Auth check -------------------------------------------------------------
 *
 * `verifyAuth()` calls `GET /v1/affiliates/alloffers?page=1&page_size=1`, which
 * is the cheapest authenticated affiliate endpoint. A valid key returns 200;
 * an invalid key returns 401 with a JSON error body.
 *
 * We cannot derive an affiliate ID from this response — Everflow's affiliate
 * API keys are already scoped to a single affiliate account by the network
 * admin. The EVERFLOW_AFFILIATE_ID env var is prompted separately for use in
 * any operations that need to reference the affiliate account explicitly.
 */

import { everflowRequest } from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('everflow.auth');

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
 * Verify the Everflow API key by calling `GET /v1/affiliates/alloffers`.
 *
 * Why this endpoint:
 *   - It is the simplest authenticated affiliate endpoint with a predictable
 *     200 / 401 response pattern.
 *   - With page_size=1 the payload is tiny so the call is fast.
 *   - A 401 produces a JSON body with an actionable message from Everflow.
 *
 * On success we return the affiliate ID from env (if configured) as the
 * identity string. The key does not contain the affiliate ID itself — that
 * is held in EVERFLOW_AFFILIATE_ID.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let apiKey: string;
  try {
    apiKey = requireCredential('EVERFLOW_API_KEY', {
      network: 'everflow',
      operation: 'verifyAuth',
      hint:
        'Ask your Everflow network admin to generate an affiliate API key for your account ' +
        'under Manage Affiliate → API tab.',
    });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    // Minimal probe — page 1, 1 record. We only care about the HTTP status.
    await everflowRequest<unknown>({
      operation: 'verifyAuth',
      path: '/v1/affiliates/alloffers',
      apiKey,
      query: { page: 1, page_size: 1 },
      resilience: DEFAULT_RESILIENCE,
    });

    const affiliateId = getCredential('EVERFLOW_AFFILIATE_ID');
    const identity = affiliateId ? `everflow/affiliate/${affiliateId}` : 'everflow (authenticated)';

    log.debug({ identity }, 'everflow verifyAuth succeeded');
    return { ok: true, identity };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: 'everflow',
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * EVERFLOW_API_KEY:
 *   Writes the candidate key into process.env, calls verifyAuth(), then
 *   restores the previous value. Returns ok on success.
 *
 * EVERFLOW_AFFILIATE_ID:
 *   Format check only — must be a positive integer. We cannot verify it via
 *   API without a separate authenticated call that may be unavailable at
 *   entry time.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'EVERFLOW_API_KEY') {
    const previous = process.env['EVERFLOW_API_KEY'];
    process.env['EVERFLOW_API_KEY'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'API key verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the API key with your Everflow network admin. Keys are generated under ' +
          'Manage Affiliate → API tab and may be revoked or scoped incorrectly.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['EVERFLOW_API_KEY'];
      } else {
        process.env['EVERFLOW_API_KEY'] = previous;
      }
    }
  }

  if (field === 'EVERFLOW_AFFILIATE_ID') {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      return {
        ok: false,
        message: 'Everflow affiliate ID must be a positive integer.',
        hint: 'Your affiliate ID is visible in the Everflow dashboard URL after login.',
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Everflow.`,
    hint:
      'Everflow expects EVERFLOW_API_KEY (required) and EVERFLOW_AFFILIATE_ID (optional, for display).',
  };
}
