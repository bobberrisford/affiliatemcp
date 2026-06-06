/**
 * Refersion auth + credential validation.
 *
 * Refersion uses a key pair: a public API key and a secret key, sent as the
 * `Refersion-Public-Key` / `Refersion-Secret-Key` headers on every request. One
 * key pair scopes one Refersion merchant account, which is why this adapter is
 * `single-brand`.
 *
 * No `derivedValues` flow: neither key carries a separate identifier to look up.
 * `verifyAuth()` hits `POST /v2/affiliate/list` with a tiny page — the cheapest
 * authenticated call that returns 200 for a valid key pair even with no
 * affiliates. Reference: `src/networks/rewardful/auth.ts`.
 */

import { refersionRequest, SLUG, type RefersionCredentials } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('refersion.auth');

export interface VerifyAuthOk {
  ok: true;
  identity?: string;
}

export interface VerifyAuthFail {
  ok: false;
  reason: string;
  envelope?: NetworkErrorEnvelope;
}

export function requireCredentials(operation: string): RefersionCredentials {
  const apiKey = requireCredential('REFERSION_API_KEY', {
    network: SLUG,
    operation,
    hint:
      'Find your API keys in Refersion under Account > Settings, then set ' +
      'REFERSION_API_KEY (the public key) and REFERSION_SECRET_KEY ' +
      '(or run `affiliate-networks-mcp setup refersion`).',
  });
  const secretKey = requireCredential('REFERSION_SECRET_KEY', {
    network: SLUG,
    operation,
    hint:
      'Find your API keys in Refersion under Account > Settings, then set ' +
      'REFERSION_SECRET_KEY (the secret key) and REFERSION_API_KEY ' +
      '(or run `affiliate-networks-mcp setup refersion`).',
  });
  return { apiKey, secretKey };
}

export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let credentials: RefersionCredentials;
  try {
    credentials = requireCredentials('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    await refersionRequest<unknown>({
      operation: 'verifyAuth',
      path: '/affiliate/list',
      credentials,
      method: 'POST',
      body: { page: 1, per_page: 1 },
      resilience: DEFAULT_RESILIENCE,
    });
    log.debug('refersion verifyAuth succeeded');
    return { ok: true, identity: 'refersion/keys-verified' };
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
  if (field === 'REFERSION_API_KEY' || field === 'REFERSION_SECRET_KEY') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: `Refersion ${field === 'REFERSION_API_KEY' ? 'public key' : 'secret key'} is required.`,
        hint: 'Find both keys in Refersion under Account > Settings.',
      };
    }

    // Both keys are needed to make an authenticated call. Defer the live check
    // until the partner field is also present so we validate the pair, not one
    // half of it (see Rakuten's deferred-validation pattern for the rationale).
    const partner =
      field === 'REFERSION_API_KEY'
        ? process.env['REFERSION_SECRET_KEY']
        : process.env['REFERSION_API_KEY'];
    if (!partner || partner.trim() === '') {
      return {
        ok: true,
        message: 'Format looks valid; the key pair is verified once both keys are set.',
      };
    }

    const previous = process.env[field];
    process.env[field] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'keys verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check both API keys in Refersion under Account > Settings. They may be regenerated, ' +
          'or copied with leading/trailing whitespace.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env[field];
      } else {
        process.env[field] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Refersion.`,
    hint: 'Refersion expects REFERSION_API_KEY and REFERSION_SECRET_KEY.',
  };
}
