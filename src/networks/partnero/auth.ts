/**
 * Partnero auth + credential validation.
 *
 * Partnero uses a single API token sent as a Bearer token. The token is
 * generated per programme (Programs › Integration › API) and is shown once, so
 * one token scopes one programme — which is why this adapter is `single-brand`.
 *
 * No `derivedValues` flow: the token carries no separate identifier to look up.
 * `verifyAuth()` hits `GET /v1/partners?limit=1` — the cheapest authenticated
 * call that returns 200 for a valid token even with no partners. Reference:
 * `src/networks/rewardful/auth.ts` and `src/networks/awin/auth.ts`.
 */

import { partneroRequest, SLUG } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('partnero.auth');

export interface VerifyAuthOk {
  ok: true;
  identity?: string;
}

export interface VerifyAuthFail {
  ok: false;
  reason: string;
  envelope?: NetworkErrorEnvelope;
}

export function requireApiKey(operation: string): string {
  return requireCredential('PARTNERO_API_KEY', {
    network: SLUG,
    operation,
    hint:
      'Generate an API token in Partnero under Programs › Integration › API, then set ' +
      'PARTNERO_API_KEY (or run `affiliate-networks-mcp setup partnero`).',
  });
}

export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let token: string;
  try {
    token = requireApiKey('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    await partneroRequest<unknown>({
      operation: 'verifyAuth',
      path: '/partners',
      token,
      query: { limit: 1 },
      resilience: DEFAULT_RESILIENCE,
    });
    log.debug('partnero verifyAuth succeeded');
    return { ok: true, identity: 'partnero/token-verified' };
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

export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'PARTNERO_API_KEY') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Partnero API token is required.',
        hint: 'Generate one under Programs › Integration › API in your Partnero dashboard.',
      };
    }
    const previous = process.env['PARTNERO_API_KEY'];
    process.env['PARTNERO_API_KEY'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'token verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the API token under Programs › Integration › API. The token is shown once, ' +
          'may have been regenerated, or copied with leading/trailing whitespace.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['PARTNERO_API_KEY'];
      } else {
        process.env['PARTNERO_API_KEY'] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Partnero.`,
    hint: 'Partnero expects PARTNERO_API_KEY.',
  };
}
