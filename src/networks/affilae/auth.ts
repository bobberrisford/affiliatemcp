/**
 * Affilae auth + credential validation.
 *
 * Affilae uses a long-lived bearer token generated from the dashboard
 * "API Tokens" menu (https://rest.affilae.com/reference). It does not
 * auto-rotate, so for v0.1 we treat it as a static secret loaded from
 * `AFFILAE_API_TOKEN`. If Affilae moves to rotating tokens, this is the only
 * file that needs to change.
 *
 * The cheapest identity-revealing call on the publisher side is
 * `GET /publisher/publishers.me`, which returns the authenticated publisher's
 * own account (publisher ID, profile IDs). We use it both for `verifyAuth`
 * and for live credential validation in the wizard.
 *
 * Never throw a bare Error from this file: `verifyAuth` is called by error
 * handlers and the wizard; both expect a structured result.
 */

import { affilaeRequest } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('affilae.auth');

/**
 * The minimal shape we read off Affilae's `GET /publisher/publishers.me`.
 *
 * Affilae's public field documentation is thin (the reference site gates
 * fetchers), so we read several plausible identity keys defensively rather
 * than over-specify. The verbatim payload is preserved upstream by callers
 * that surface it; here we only need a stable identity string.
 */
export interface AffilaePublisherMe {
  id?: string;
  _id?: string;
  publisherId?: string;
  name?: string;
  companyName?: string;
  email?: string;
  // Some envelopes wrap the account under `publisher` / `data`.
  publisher?: AffilaePublisherMe;
  data?: AffilaePublisherMe;
}

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
 * Verify the Affilae token by hitting `GET /publisher/publishers.me`.
 *
 * Why this endpoint specifically:
 *   - It is the smallest authenticated publisher call: it returns the
 *     authenticated publisher's own account, so there is no list to page.
 *   - It rejects with a 401/403 on a bad token, which the resilience layer
 *     classifies as an `auth_error` envelope — actionable for the user.
 *
 * On a 401/403 (or any upstream failure) we return `{ ok: false, reason }`
 * rather than throwing, because this function is itself called from error
 * handlers; throwing here would loop.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let token: string;
  try {
    token = requireCredential('AFFILAE_API_TOKEN', {
      network: 'affilae',
      operation: 'verifyAuth',
      hint: 'Generate a token in the Affilae dashboard → API Tokens menu.',
    });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    const response = await affilaeRequest<AffilaePublisherMe>({
      operation: 'verifyAuth',
      path: '/publisher/publishers.me',
      token,
      resilience: DEFAULT_RESILIENCE,
    });

    log.debug('affilae verifyAuth succeeded');
    return { ok: true, identity: identityFor(response) };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: 'affilae',
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Build a human-readable identity from a publishers.me payload, unwrapping the
 * common `publisher` / `data` envelopes if present. Defensive against the
 * exact field names because Affilae's response shape is not fully documented
 * publicly.
 */
export function identityFor(raw: AffilaePublisherMe | undefined): string {
  if (!raw) return 'affilae';
  const flat = raw.publisher ?? raw.data ?? raw;
  const id = flat.id ?? flat._id ?? flat.publisherId;
  const name = flat.name ?? flat.companyName ?? flat.email ?? '';
  if (id && name) return `affilae/${id} (${name})`;
  if (id) return `affilae/${id}`;
  if (name) return `affilae (${name})`;
  return 'affilae';
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * `AFFILAE_API_TOKEN` is the only field; validating it requires a live call.
 * We write the candidate into `process.env`, run `verifyAuth()`, then restore
 * the previous value so a failed validation does not poison subsequent
 * operations in the same process (test isolation).
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'AFFILAE_API_TOKEN') {
    const previous = process.env['AFFILAE_API_TOKEN'];
    process.env['AFFILAE_API_TOKEN'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'token verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the token in the Affilae dashboard → API Tokens menu. The token may be revoked, ' +
          'or copied with leading/trailing whitespace. Ensure it is a publisher token, not an advertiser token.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['AFFILAE_API_TOKEN'];
      } else {
        process.env['AFFILAE_API_TOKEN'] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Affilae.`,
    hint: 'Affilae expects a single credential: AFFILAE_API_TOKEN.',
  };
}
