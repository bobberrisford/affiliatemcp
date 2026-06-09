/**
 * Adcell auth + credential validation.
 *
 * Adcell (a DACH performance network; standalone here, distinct from the mrge
 * adapter) authenticates the publisher API with two values:
 *   - an API key / password generated from "My ADCELL → Settings → API-Password"
 *     (this is NOT the normal login password), and
 *   - the publisher (affiliate) account ID.
 *
 * Both are long-lived; there is no refresh flow, so we treat them as static
 * secrets loaded from `ADCELL_API_TOKEN` and `ADCELL_AFFILIATE_ID`.
 *
 * IMPORTANT (unverified): Adcell's API reference is dashboard-gated. The
 * auth-check endpoint and header scheme below are reconstructed from public
 * third-party integrations and have NOT been confirmed against a live account.
 * If a live account differs, this file and `client.ts` are the only two places
 * that need to change.
 *
 * We do NOT auto-derive the affiliate ID: the user reads it from the dashboard
 * and enters it in setup. Unlike Awin (token → publisher id), Adcell's
 * verify-auth response shape is not documented publicly, so deriving it would
 * be a guess.
 */

import { adcellRequest } from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('adcell.auth');

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
 * Verify the Adcell credentials with a cheap, list-style call.
 *
 * Endpoint (UNVERIFIED): `GET /v2/publisher/programs?limit=1`. This is the
 * cheapest authenticated publisher call we expect Adcell to expose — a tiny
 * programmes page. A valid key should return 200; an invalid one should return
 * 401/403 with a body we surface verbatim.
 *
 * We never throw from verifyAuth — it is called by error handlers and the
 * wizard, both of which expect a structured result.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let apiKey: string;
  try {
    apiKey = requireCredential('ADCELL_API_TOKEN', {
      network: 'adcell',
      operation: 'verifyAuth',
      hint: 'Create an API password under My ADCELL → Settings → API-Password (not your login password).',
    });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  const affiliateId = getCredential('ADCELL_AFFILIATE_ID');

  try {
    // Minimal probe — one programme record. We only care about the HTTP status.
    await adcellRequest<unknown>({
      operation: 'verifyAuth',
      path: '/v2/publisher/programs',
      apiKey,
      affiliateId,
      query: { limit: 1 },
      resilience: DEFAULT_RESILIENCE,
    });

    const identity = affiliateId ? `adcell/publisher/${affiliateId}` : 'adcell (authenticated)';
    log.debug({ identity }, 'adcell verifyAuth succeeded');
    return { ok: true, identity };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: 'adcell',
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * ADCELL_API_TOKEN:
 *   Writes the candidate key into process.env, calls verifyAuth(), then
 *   restores the previous value. Returns ok on success.
 *
 * ADCELL_AFFILIATE_ID:
 *   Format check only — must be a positive integer. We cannot confirm it via
 *   API without also having the key, and the user may edit it in isolation.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'ADCELL_API_TOKEN') {
    const previous = process.env['ADCELL_API_TOKEN'];
    process.env['ADCELL_API_TOKEN'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'API key verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the API password under My ADCELL → Settings → API-Password. It may be revoked, ' +
          'or you may have entered your normal login password by mistake.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['ADCELL_API_TOKEN'];
      } else {
        process.env['ADCELL_API_TOKEN'] = previous;
      }
    }
  }

  if (field === 'ADCELL_AFFILIATE_ID') {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      return {
        ok: false,
        message: 'Adcell publisher (affiliate) ID must be a positive integer.',
        hint: 'Your publisher ID is shown in the My ADCELL dashboard and in most dashboard URLs after login.',
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Adcell.`,
    hint: 'Adcell expects ADCELL_API_TOKEN (required) and ADCELL_AFFILIATE_ID (required for account scoping).',
  };
}
