/**
 * Tolt auth + credential validation.
 *
 * Tolt uses a single API key sent as a Bearer token. One key scopes one Tolt
 * organisation (one merchant's affiliate programme), which is why this adapter
 * is `single-brand`.
 *
 * No `derivedValues` flow: the key carries no separate identifier to look up.
 * `verifyAuth()` hits `GET /v1/partners?limit=1` — the cheapest authenticated
 * call that returns 200 for a valid key even with no partners. Reference:
 * `src/networks/rewardful/auth.ts`.
 */

import { toltRequest, SLUG } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('tolt.auth');

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
  return requireCredential('TOLT_API_KEY', {
    network: SLUG,
    operation,
    hint:
      'Find your API key in Tolt under Settings → Integrations, then set ' +
      'TOLT_API_KEY (or run `affiliate-networks-mcp setup tolt`).',
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
    await toltRequest<unknown>({
      operation: 'verifyAuth',
      path: '/partners',
      token,
      query: { limit: 1 },
      resilience: DEFAULT_RESILIENCE,
    });
    log.debug('tolt verifyAuth succeeded');
    return { ok: true, identity: 'tolt/key-verified' };
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
  if (field === 'TOLT_API_KEY') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Tolt API key is required.',
        hint: 'Find it in Tolt under Settings → Integrations.',
      };
    }
    const previous = process.env['TOLT_API_KEY'];
    process.env['TOLT_API_KEY'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'key verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the API key in Tolt under Settings → Integrations. It may be regenerated, ' +
          'or copied with leading/trailing whitespace.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['TOLT_API_KEY'];
      } else {
        process.env['TOLT_API_KEY'] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Tolt.`,
    hint: 'Tolt expects TOLT_API_KEY.',
  };
}
