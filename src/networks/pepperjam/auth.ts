/**
 * Pepperjam (Ascend by Partnerize) auth + credential validation.
 *
 * Pepperjam authenticates with a single self-issued `apiKey` passed as a query
 * parameter on every request. The publisher generates the key from the Ascend
 * console (Resources → API Keys, at https://ascend.pepperjam.com/affiliate/api/);
 * it is long-lived and does not auto-rotate. That means:
 *   - No refresh flow is required for v0.1 — we treat the key as a static
 *     secret loaded from `PEPPERJAM_API_KEY`. If Ascend moves to rotating
 *     keys, this is the only file that needs to change.
 *   - The key is already scoped to a single publisher account, so there is no
 *     separate publisher-id credential to derive (unlike Awin). `verifyAuth`
 *     therefore makes a cheap call purely to confirm the key works.
 *
 * --- Auth check -------------------------------------------------------------
 *
 * `verifyAuth()` calls `GET /publisher/advertiser?page=1` (the cheapest
 * authenticated publisher endpoint — the list of advertisers/programmes the
 * publisher can work with). A valid key returns 200 with a `meta`/`data`
 * envelope; an invalid key returns a 401 with an error body.
 *
 * Keep `verifyAuth` cheap. The wizard calls it during interactive setup;
 * latency here is user-visible.
 */

import { pepperjamRequest, type PepperjamEnvelope } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('pepperjam.auth');

const SLUG = 'pepperjam';

export const PEPPERJAM_API_KEY_ENV = 'PEPPERJAM_API_KEY';

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
 * Read the configured API key or throw a config_error NetworkError.
 *
 * Shared by the adapter operations so the credential read happens once per
 * call, in one place, with one actionable hint.
 */
export function requireApiKey(operation: string): string {
  return requireCredential(PEPPERJAM_API_KEY_ENV, {
    network: SLUG,
    operation,
    hint:
      'Generate a key in the Ascend console: Resources → API Keys ' +
      '(https://ascend.pepperjam.com/affiliate/api/), then set PEPPERJAM_API_KEY.',
  });
}

/**
 * Verify the Pepperjam API key by calling `GET /publisher/advertiser`.
 *
 * Why this endpoint:
 *   - It is the smallest authenticated publisher endpoint and the one the rest
 *     of the adapter leans on for programme discovery.
 *   - A valid key returns 200 with the `meta`/`data` envelope; an invalid key
 *     returns a 401 with an actionable error body, so the envelope is useful.
 *
 * The key is already scoped to one publisher account, so there is nothing to
 * derive. On success we return a generic identity string — the API does not
 * echo the publisher's own account name on this endpoint.
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
    // Minimal probe — page 1. We only care that the key authenticates.
    const response = await pepperjamRequest<PepperjamEnvelope<unknown>>({
      operation: 'verifyAuth',
      resource: '/publisher/advertiser',
      apiKey,
      query: { page: 1 },
      resilience: DEFAULT_RESILIENCE,
    });

    const total = response.meta?.pagination?.total_results;
    const identity =
      typeof total === 'number'
        ? `pepperjam (authenticated; ${total} advertisers visible)`
        : 'pepperjam (authenticated)';

    log.debug({ identity }, 'pepperjam verifyAuth succeeded');
    return { ok: true, identity };
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
 * Validate a single credential field at wizard-entry time.
 *
 * PEPPERJAM_API_KEY:
 *   Writes the candidate key into process.env, calls verifyAuth(), then
 *   restores the previous value. Returns ok on success. Restoring the previous
 *   value keeps a failed validation from poisoning later operations in the same
 *   process (test isolation).
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === PEPPERJAM_API_KEY_ENV) {
    const previous = process.env[PEPPERJAM_API_KEY_ENV];
    process.env[PEPPERJAM_API_KEY_ENV] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'API key verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the key in the Ascend console: Resources → API Keys ' +
          '(https://ascend.pepperjam.com/affiliate/api/). The key may be revoked, ' +
          'or copied with leading/trailing whitespace.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env[PEPPERJAM_API_KEY_ENV];
      } else {
        process.env[PEPPERJAM_API_KEY_ENV] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Pepperjam.`,
    hint: 'Pepperjam expects PEPPERJAM_API_KEY (required).',
  };
}
