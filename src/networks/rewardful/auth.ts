/**
 * Rewardful auth + credential validation.
 *
 * Rewardful uses a single API Secret, sent as the HTTP Basic username with an
 * empty password. One secret scopes one Rewardful account (one merchant /
 * Stripe account), which is why this adapter is `single-brand`.
 *
 * No `derivedValues` flow: the secret carries no separate identifier to look
 * up. `verifyAuth()` hits `GET /v1/campaigns?limit=1` — the cheapest
 * authenticated call that returns 200 for a valid secret even with no
 * campaigns. Reference: `src/networks/impact/auth.ts` (HTTP Basic).
 */

import { rewardfulRequest, SLUG } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('rewardful.auth');

export interface VerifyAuthOk {
  ok: true;
  identity?: string;
}

export interface VerifyAuthFail {
  ok: false;
  reason: string;
  envelope?: NetworkErrorEnvelope;
}

export function requireApiSecret(operation: string): string {
  return requireCredential('REWARDFUL_API_SECRET', {
    network: SLUG,
    operation,
    hint:
      'Find your API Secret on the Rewardful Company Settings page, then set ' +
      'REWARDFUL_API_SECRET (or run `affiliate-networks-mcp setup rewardful`).',
  });
}

export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let apiSecret: string;
  try {
    apiSecret = requireApiSecret('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    await rewardfulRequest<unknown>({
      operation: 'verifyAuth',
      path: '/campaigns',
      apiSecret,
      query: { limit: 1 },
      resilience: DEFAULT_RESILIENCE,
    });
    log.debug('rewardful verifyAuth succeeded');
    return { ok: true, identity: 'rewardful/secret-verified' };
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
  if (field === 'REWARDFUL_API_SECRET') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Rewardful API Secret is required.',
        hint: 'Find it on the Rewardful Company Settings page.',
      };
    }
    const previous = process.env['REWARDFUL_API_SECRET'];
    process.env['REWARDFUL_API_SECRET'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'secret verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the API Secret on the Rewardful Company Settings page. It may be regenerated, ' +
          'or copied with leading/trailing whitespace.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['REWARDFUL_API_SECRET'];
      } else {
        process.env['REWARDFUL_API_SECRET'] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Rewardful.`,
    hint: 'Rewardful expects REWARDFUL_API_SECRET.',
  };
}
