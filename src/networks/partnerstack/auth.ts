/**
 * PartnerStack Partner API auth + credential validation.
 *
 * PartnerStack's Partner API uses a single long-lived API key the partner
 * generates from their settings, sent as `Authorization: Bearer {key}`. That
 * means no refresh flow (treat it like Awin's static bearer token) and a single
 * credential: `PARTNERSTACK_API_KEY`.
 *
 * No `derivedValues` flow applies: the partner key carries no separate
 * identifier we must look up before other calls (unlike Awin's publisher ID).
 *
 * `verifyAuth()` hits `GET /api/v2/partnerships?limit=1` — the cheapest
 * authenticated call that reliably returns 200 for a valid key even when the
 * partner has no partnerships yet. Reference: `src/networks/awin/auth.ts`.
 */

import { partnerstackRequest, SLUG } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('partnerstack.auth');

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
  return requireCredential('PARTNERSTACK_API_KEY', {
    network: SLUG,
    operation,
    hint:
      'Generate a Partner API key in the PartnerStack dashboard → your user menu → Settings → ' +
      'API keys, then set PARTNERSTACK_API_KEY (or run `affiliate-networks-mcp setup partnerstack`).',
  });
}

/**
 * Verify the API key by hitting `GET /partnerships?limit=1`.
 *
 * On a 401 the resilience layer surfaces an `auth_error` envelope verbatim; we
 * convert that to a `VerifyAuthFail` rather than throwing, because verifyAuth
 * is itself called by the wizard and error handlers (throwing here loops).
 */
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
    await partnerstackRequest<unknown>({
      operation: 'verifyAuth',
      path: '/partnerships',
      apiKey,
      query: { limit: 1 },
      resilience: DEFAULT_RESILIENCE,
    });
    log.debug('partnerstack verifyAuth succeeded');
    return { ok: true, identity: 'partnerstack/key-verified' };
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
 * Validate a single credential field at wizard-entry time. Only
 * `PARTNERSTACK_API_KEY` is settable: we write the candidate into
 * `process.env`, run `verifyAuth()`, then restore the previous value.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'PARTNERSTACK_API_KEY') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'PartnerStack API key is required.',
        hint: 'Find it in the PartnerStack dashboard → Settings → API keys.',
      };
    }
    const previous = process.env['PARTNERSTACK_API_KEY'];
    process.env['PARTNERSTACK_API_KEY'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'key verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the key at the PartnerStack dashboard → Settings → API keys. It may be revoked, ' +
          'or copied with leading/trailing whitespace.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['PARTNERSTACK_API_KEY'];
      } else {
        process.env['PARTNERSTACK_API_KEY'] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for PartnerStack.`,
    hint: 'PartnerStack (partner side) expects PARTNERSTACK_API_KEY.',
  };
}
