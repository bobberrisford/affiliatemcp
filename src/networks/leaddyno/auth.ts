/**
 * LeadDyno auth + credential validation.
 *
 * LeadDyno uses a single private API key, sent as the `key` query parameter on
 * every request (auth_model: custom — not a bearer or basic header). One key
 * scopes one LeadDyno account (one merchant), which is why this adapter is
 * `single-brand`.
 *
 * No `derivedValues` flow: the key carries no separate identifier to look up.
 * `verifyAuth()` hits `GET /v1/affiliates?page=1` — a cheap authenticated call
 * that returns 200 for a valid key even with no affiliates. Reference:
 * `src/networks/rewardful/auth.ts`.
 */

import { leaddynoRequest, SLUG } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('leaddyno.auth');

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
  return requireCredential('LEADDYNO_API_KEY', {
    network: SLUG,
    operation,
    hint:
      'Find your private API key in LeadDyno under Account → Profile, then set ' +
      'LEADDYNO_API_KEY (or run `affiliate-networks-mcp setup leaddyno`).',
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
    await leaddynoRequest<unknown>({
      operation: 'verifyAuth',
      path: '/affiliates',
      apiKey,
      query: { page: 1 },
      resilience: DEFAULT_RESILIENCE,
    });
    log.debug('leaddyno verifyAuth succeeded');
    return { ok: true, identity: 'leaddyno/key-verified' };
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
  if (field === 'LEADDYNO_API_KEY') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'LeadDyno private API key is required.',
        hint: 'Find it in LeadDyno under Account → Profile.',
      };
    }
    const previous = process.env['LEADDYNO_API_KEY'];
    process.env['LEADDYNO_API_KEY'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'key verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the private API key under Account → Profile. It may be regenerated, ' +
          'or copied with leading/trailing whitespace.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['LEADDYNO_API_KEY'];
      } else {
        process.env['LEADDYNO_API_KEY'] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for LeadDyno.`,
    hint: 'LeadDyno expects LEADDYNO_API_KEY.',
  };
}
