/**
 * CJ Affiliate advertiser auth.
 *
 * The same Personal Access Token (PAT) the publisher CJ adapter uses also
 * powers the advertiser surface — CJ permission is enforced at query time on
 * the server, scoped to whichever CIDs (Company IDs) the underlying user has
 * been granted. Practical implication: a single PAT can address multiple
 * brands (`forAdvertisers: ["1234567","7654321"]`), which is why this adapter
 * declares `credentialScope: 'multi-brand'`.
 *
 * Setup flow:
 *   1. User pastes `CJ_ADVERTISER_API_TOKEN` (or chooses to reuse `CJ_API_TOKEN`
 *      from the publisher adapter — wizard surfaces the existing value).
 *   2. `verifyAuth()` runs a minimal GraphQL probe — a 1-row
 *      `commissionDetails` request against a placeholder CID. CJ accepts the
 *      query with an empty result set when the PAT is valid; a 401 surfaces
 *      as an auth_error envelope. Cheap, server-side validated, no CID needed.
 *   3. Brand discovery is best-effort (`listBrands` on the adapter); see
 *      `adapter.ts` for the caveats — CJ does not publish a clean "list every
 *      CID this PAT can see" endpoint, so the wizard may have to fall back to
 *      manual `brands.json` entries.
 *
 * Cardinal: never call cj.com directly from this module. All GraphQL goes via
 * `cjAdvGraphQL` in `./client.ts` so the read-only guard always runs.
 */

import { cjAdvGraphQL, CJ_ADVERTISER_GRAPHQL } from './client.js';
import { VERIFY_AUTH_QUERY } from './queries.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('cj-advertiser.auth');

export const SLUG = 'cj-advertiser';

/**
 * Build the Authorization header value for a CJ PAT. Centralised so the client
 * never has to know how CJ formats credentials.
 */
export function bearerAuthHeader(token: string): string {
  return `Bearer ${token}`;
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
 * Verify a PAT by running the cheapest possible authenticated GraphQL probe.
 *
 * We query `commissionDetails` for a placeholder CID with a 1-row cap.
 * Behaviour:
 *   - Valid PAT, no access to the placeholder CID → CJ returns 200 with empty
 *     `payments` / `records` arrays. That's success: the PAT authenticated.
 *   - Invalid PAT → CJ returns 401, which the client surfaces verbatim as an
 *     auth_error envelope. The resilience layer classifies and bubbles.
 *   - GraphQL-level error (schema drift, etc.) → returned in the `errors`
 *     array; the client throws and we surface the upstream message.
 *
 * TODO(verify): some CJ tenants surface a `viewer` / `me` / `currentUser`
 * query on the commissions endpoint that returns the company memberships the
 * PAT can see. If found, `listBrands` should use it; until then this probe
 * is intentionally CID-agnostic so brand-discovery is a separate concern.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let token: string;
  try {
    token = requireCredential('CJ_ADVERTISER_API_TOKEN', {
      network: SLUG,
      operation: 'verifyAuth',
      hint:
        'Generate a Personal Access Token in the CJ dashboard → Account → Personal Access Tokens. ' +
        'The same PAT works for both the publisher and the advertiser surfaces — if you already ' +
        'have CJ_API_TOKEN configured for the publisher adapter, you can reuse that value here.',
    });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    // The probe: a 1-row commissionDetails query against a placeholder CID
    // ("0" — guaranteed not to match any real advertiser). A valid PAT
    // returns 200 with empty records. We don't read the data; reaching here
    // means auth was accepted.
    await cjAdvGraphQL<{ commissionDetails?: { records?: unknown[] } }>({
      operation: 'verifyAuth',
      endpoint: CJ_ADVERTISER_GRAPHQL,
      query: VERIFY_AUTH_QUERY,
      variables: { forAdvertisers: ['0'], maxRows: 1 },
      token,
      resilience: DEFAULT_RESILIENCE,
    });
    log.debug('cj-advertiser verifyAuth succeeded');
    return { ok: true, identity: 'cj-advertiser/pat-verified' };
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
 * Validate one credential field at wizard-entry time.
 *
 * Only `CJ_ADVERTISER_API_TOKEN` is settable. We write the candidate into
 * `process.env`, run `verifyAuth()`, restore the previous value. The probe is
 * cheap so the user gets immediate feedback.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'CJ_ADVERTISER_API_TOKEN') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'CJ advertiser Personal Access Token is required.',
        hint:
          'Generate the PAT at the CJ dashboard → Account → Personal Access Tokens. ' +
          'The same PAT works for the publisher adapter too.',
      };
    }
    const previous = process.env['CJ_ADVERTISER_API_TOKEN'];
    process.env['CJ_ADVERTISER_API_TOKEN'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return {
          ok: true,
          message: 'PAT verified against CJ commissionDetails probe.',
        };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the token at the CJ dashboard → Account → Personal Access Tokens. ' +
          'The token may be revoked, expired, or copied with leading/trailing whitespace.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['CJ_ADVERTISER_API_TOKEN'];
      } else {
        process.env['CJ_ADVERTISER_API_TOKEN'] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for CJ advertiser.`,
    hint: 'CJ advertiser expects CJ_ADVERTISER_API_TOKEN.',
  };
}
