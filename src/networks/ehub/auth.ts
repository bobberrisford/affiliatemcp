/**
 * eHUB auth + credential validation.
 *
 * Patterned on `src/networks/awin/auth.ts`.
 *
 * eHUB authenticates with a single long-lived API key passed as an `apiKey`
 * query parameter (see `client.ts`). That means:
 *   - No refresh flow is required for v0.1 — the key is a static secret loaded
 *     from `EHUB_API_KEY`. If eHUB moves to rotating keys, this is the only
 *     file that needs to change.
 *   - The cheapest authenticated, identity-revealing call is the campaigns
 *     listing (`GET /campaigns`). We use a 1-row probe for `verifyAuth`.
 *
 * eHUB also needs a publisher identifier (`EHUB_PUBLISHER_ID`, the `a_aid`
 * value shown in the user profile and embedded in tracking links). Unlike
 * Awin, eHUB does not return the publisher id from a cheap auth call we can
 * rely on across tenants, so we do NOT auto-derive it; it is a prompted field.
 * That id is needed only by `generateTrackingLink` (the `a_aid` URL parameter).
 *
 * Future contributors: keep `verifyAuth` cheap. The wizard calls it during
 * interactive setup; latency here is user-visible.
 *
 * Docs: https://ehub.docs.apiary.io/ and https://ehubv3.docs.apiary.io/
 */

import { ehubRequest } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('ehub.auth');

export const EHUB_SLUG = 'ehub';

/**
 * Minimal shape we read off eHUB's `GET /campaigns` probe. eHUB wraps list
 * responses in an envelope keyed by the resource name (e.g. `{ campaigns: [] }`)
 * with a `code` field; we read defensively and never over-specify.
 */
interface EhubCampaignsEnvelope {
  code?: number;
  campaigns?: Array<{ id?: number | string; name?: string }>;
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
 * Verify the eHUB API key by hitting `GET /campaigns?perPage=1`.
 *
 * Why this endpoint specifically:
 *   - It is small (one campaign) and authenticated, so it doubles as the
 *     cheapest credential check.
 *   - It rejects a bad key with a clean non-2xx, so the error envelope is
 *     actionable.
 *
 * On success we surface a generic identity string. eHUB does not return a
 * stable publisher identity on this call, so we do not attempt to derive one.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let apiKey: string;
  try {
    apiKey = requireCredential('EHUB_API_KEY', {
      network: EHUB_SLUG,
      operation: 'verifyAuth',
      hint: 'Generate an API key in the eHUB dashboard under your profile / API settings.',
    });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    const response = await ehubRequest<EhubCampaignsEnvelope>({
      operation: 'verifyAuth',
      path: '/campaigns',
      apiKey,
      query: { perPage: 1 },
      resilience: DEFAULT_RESILIENCE,
    });

    const count = Array.isArray(response.campaigns) ? response.campaigns.length : 0;
    log.debug({ count }, 'ehub verifyAuth succeeded');

    return {
      ok: true,
      identity: 'ehub (API key verified)',
    };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: EHUB_SLUG,
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * Behaviour:
 *   - `EHUB_API_KEY`: writes the candidate into `process.env`, runs
 *     `verifyAuth()`, restores the previous value. Returns `ok` on success.
 *   - `EHUB_PUBLISHER_ID`: format check only (non-empty token). eHUB publisher
 *     ids (the `a_aid` value) are short alphanumeric strings, not necessarily
 *     numeric, so we do not enforce a digits-only shape. We do not verify it by
 *     API call because that requires the key and the user may edit this field
 *     in isolation.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'EHUB_API_KEY') {
    const previous = process.env['EHUB_API_KEY'];
    process.env['EHUB_API_KEY'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'API key verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the API key in the eHUB dashboard under your profile / API settings. The key may be ' +
          'revoked, mistyped, or copied with leading/trailing whitespace.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['EHUB_API_KEY'];
      } else {
        process.env['EHUB_API_KEY'] = previous;
      }
    }
  }

  if (field === 'EHUB_PUBLISHER_ID') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'eHUB publisher ID must not be empty.',
        hint: 'This is the a_aid value shown in your eHUB profile and embedded in your tracking links.',
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for eHUB.`,
    hint: 'eHUB expects EHUB_API_KEY (required) and EHUB_PUBLISHER_ID (required for tracking links).',
  };
}
