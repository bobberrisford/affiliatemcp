/**
 * Effiliation auth + credential validation.
 *
 * Effiliation uses a single long-lived API key, supplied as the `key`
 * query-string parameter on every request. The publisher generates it from the
 * dashboard (My account → Personal data → Credentials, also surfaced under
 * Tools → API). There is no refresh flow: the key is a static secret loaded
 * from `EFFILIATION_API_KEY`. If Effiliation moves to rotating keys, this is
 * the only file that needs to change.
 *
 * --- Auth check -------------------------------------------------------------
 *
 * `verifyAuth()` calls `GET /apiv2/programs.json`, which is the cheapest
 * authenticated publisher endpoint and confirms the key works. A valid key
 * returns 200 with the programme list; an invalid key returns a non-2xx that
 * surfaces verbatim on the envelope.
 *
 * --- No derivedValues -------------------------------------------------------
 *
 * Unlike Awin (which derives AWIN_PUBLISHER_ID from /accounts), the Effiliation
 * key is already scoped to one publisher account. There is no second identifier
 * to derive, so we expose no `derivedValues` — the single key is the whole
 * credential set.
 *
 * Future contributors: keep `verifyAuth` cheap. The wizard calls it during
 * interactive setup; latency here is user-visible.
 */

import { effiliationRequest } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('effiliation.auth');

export const EFFILIATION_SLUG = 'effiliation';

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
 * Verify the Effiliation API key by calling `GET /apiv2/programs.json`.
 *
 * Why this endpoint:
 *   - It is the smallest authenticated publisher call and confirms the key has
 *     publisher scope.
 *   - A bad key produces a clean non-2xx whose body travels verbatim on the
 *     envelope, so the failure is actionable.
 *
 * The Effiliation key carries no embedded account identifier, so the identity
 * string is a generic authenticated marker. Never throw from here: verifyAuth
 * is called by error handlers and throwing would loop.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let apiKey: string;
  try {
    apiKey = requireCredential('EFFILIATION_API_KEY', {
      network: EFFILIATION_SLUG,
      operation: 'verifyAuth',
      hint:
        'Find your Effiliation API key in the dashboard under My account → Personal data → ' +
        'Credentials (also under Tools → API).',
    });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    await effiliationRequest<unknown>({
      operation: 'verifyAuth',
      path: '/apiv2/programs.json',
      apiKey,
      resilience: DEFAULT_RESILIENCE,
    });

    log.debug('effiliation verifyAuth succeeded');
    return { ok: true, identity: 'effiliation (authenticated)' };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: EFFILIATION_SLUG,
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * EFFILIATION_API_KEY:
 *   Writes the candidate key into process.env, calls verifyAuth(), then
 *   restores the previous value (test isolation). Returns ok on success.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'EFFILIATION_API_KEY') {
    const previous = process.env['EFFILIATION_API_KEY'];
    process.env['EFFILIATION_API_KEY'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'API key verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the key in the Effiliation dashboard under My account → Personal data → ' +
          'Credentials. It may be revoked or copied with leading/trailing whitespace.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['EFFILIATION_API_KEY'];
      } else {
        process.env['EFFILIATION_API_KEY'] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Effiliation.`,
    hint: 'Effiliation expects EFFILIATION_API_KEY (required).',
  };
}
