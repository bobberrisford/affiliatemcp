/**
 * Tapfiliate auth + credential validation.
 *
 * Tapfiliate uses a single API key, sent on every request in the `X-Api-Key`
 * header. One key scopes one Tapfiliate (merchant) account, which is why this
 * adapter is `single-brand`.
 *
 * No `derivedValues` flow: the key carries no separate identifier to look up.
 * `verifyAuth()` hits `GET /1.6/programs/?page=1` — the cheapest authenticated
 * call that returns 200 for a valid key even with no programmes. Reference:
 * `src/networks/rewardful/auth.ts`.
 */

import { tapfiliateRequest, SLUG } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('tapfiliate.auth');

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
  return requireCredential('TAPFILIATE_API_KEY', {
    network: SLUG,
    operation,
    hint:
      'Find your API key on the Tapfiliate Settings → API page, then set ' +
      'TAPFILIATE_API_KEY (or run `affiliate-networks-mcp setup tapfiliate`).',
  });
}

export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let apiKey: string;
  try {
    apiKey = requireApiKey('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    await tapfiliateRequest<unknown>({
      operation: 'verifyAuth',
      path: '/programs/',
      apiKey,
      query: { page: 1 },
      resilience: DEFAULT_RESILIENCE,
    });
    log.debug('tapfiliate verifyAuth succeeded');
    return { ok: true, identity: 'tapfiliate/key-verified' };
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
  if (field === 'TAPFILIATE_API_KEY') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Tapfiliate API key is required.',
        hint: 'Find it on the Tapfiliate Settings → API page.',
      };
    }
    const previous = process.env['TAPFILIATE_API_KEY'];
    process.env['TAPFILIATE_API_KEY'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'key verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the API key on the Tapfiliate Settings → API page. It may be regenerated, ' +
          'or copied with leading/trailing whitespace.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['TAPFILIATE_API_KEY'];
      } else {
        process.env['TAPFILIATE_API_KEY'] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Tapfiliate.`,
    hint: 'Tapfiliate expects TAPFILIATE_API_KEY.',
  };
}
