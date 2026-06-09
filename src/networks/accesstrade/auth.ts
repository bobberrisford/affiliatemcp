/**
 * AccessTrade auth + credential validation.
 *
 * AccessTrade authenticates publisher API requests with a custom header,
 * `Authorization: Token <access_key>`. The access key is a long-lived secret
 * the publisher copies from their profile page in the AccessTrade dashboard
 * (confirmed: support.accesstrade.global/api/how-do-i-authenticate-publisher-api-requests.html,
 * 2026-06-05). There is no refresh flow — the key is static until the publisher
 * regenerates it.
 *
 * Many AccessTrade publisher endpoints are scoped to a site (`{siteId}` path
 * segment): campaigns and the product feed both require it. We therefore prompt
 * for `ACCESSTRADE_SITE_ID` in addition to the access key. The conversion report
 * (`/v1/publishers/me/reports/conversion`) is account-scoped and does not need
 * the site id.
 *
 * --- Auth check -------------------------------------------------------------
 *
 * `verifyAuth()` calls the affiliated-campaigns endpoint with `limit=1` for the
 * configured site, which is the cheapest authenticated publisher call that
 * exercises both the access key and the site id. A valid key returns 200; an
 * invalid key returns a 401 with a JSON error body.
 *
 * We cannot derive the site id from the access key (the key is account-scoped,
 * not site-scoped), so there is no `derivedValues` flow — the site id is
 * prompted directly.
 *
 * Future contributors: keep `verifyAuth` cheap. The wizard calls it during
 * interactive setup; latency here is user-visible.
 */

import { accessTradeRequest } from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('accesstrade.auth');

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
 * Verify the AccessTrade access key by listing one affiliated campaign for the
 * configured site.
 *
 * Why this endpoint:
 *   - It is a small authenticated publisher call (`limit=1`), so it is fast.
 *   - It exercises both the access key and the site id, catching a mistyped
 *     site id at setup time rather than at first reporting call.
 *   - A bad key returns a clean 401 with a JSON body, so the error envelope is
 *     actionable.
 *
 * The site id is required by this endpoint. If it is missing we surface a
 * config_error so the wizard can re-prompt.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let accessKey: string;
  let siteId: string;
  try {
    accessKey = requireCredential('ACCESSTRADE_ACCESS_KEY', {
      network: 'accesstrade',
      operation: 'verifyAuth',
      hint:
        'Copy your access key from the AccessTrade publisher dashboard → your profile page → API access key.',
    });
    siteId = requireCredential('ACCESSTRADE_SITE_ID', {
      network: 'accesstrade',
      operation: 'verifyAuth',
      hint:
        'Set ACCESSTRADE_SITE_ID to one of your registered site (website) IDs, visible under Websites in the dashboard.',
    });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    await accessTradeRequest<unknown>({
      operation: 'verifyAuth',
      path: `/v1/publishers/me/sites/${encodeURIComponent(siteId)}/campaigns/affiliated`,
      accessKey,
      query: { limit: 1, page: 1 },
      resilience: DEFAULT_RESILIENCE,
    });

    const identity = `accesstrade/site/${siteId}`;
    log.debug({ identity }, 'accesstrade verifyAuth succeeded');
    return { ok: true, identity };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: 'accesstrade',
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * ACCESSTRADE_ACCESS_KEY:
 *   Writes the candidate key into process.env, calls verifyAuth(), then
 *   restores the previous value. Requires ACCESSTRADE_SITE_ID to already be
 *   present (verifyAuth exercises a site-scoped endpoint); if it is not, we
 *   report a hint rather than a confusing network failure.
 *
 * ACCESSTRADE_SITE_ID:
 *   Format check only — a non-empty token. AccessTrade site ids are opaque
 *   strings, so we do not impose a numeric format; we cannot verify it via the
 *   API without the access key, which may not be present when this field is
 *   edited in isolation.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'ACCESSTRADE_ACCESS_KEY') {
    if (!getCredential('ACCESSTRADE_SITE_ID')) {
      return {
        ok: false,
        message: 'Enter ACCESSTRADE_SITE_ID before validating the access key.',
        hint: 'The access key is validated against a site-scoped endpoint, so the site id must be set first.',
      };
    }
    const previous = process.env['ACCESSTRADE_ACCESS_KEY'];
    process.env['ACCESSTRADE_ACCESS_KEY'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'access key verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the access key on your AccessTrade profile page. The key may be revoked, regenerated, or copied with leading/trailing whitespace.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['ACCESSTRADE_ACCESS_KEY'];
      } else {
        process.env['ACCESSTRADE_ACCESS_KEY'] = previous;
      }
    }
  }

  if (field === 'ACCESSTRADE_SITE_ID') {
    if (value.trim() === '') {
      return {
        ok: false,
        message: 'AccessTrade site ID must not be empty.',
        hint: 'Use one of your registered website (site) IDs, visible under Websites in the dashboard.',
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for AccessTrade.`,
    hint: 'AccessTrade expects ACCESSTRADE_ACCESS_KEY (required) and ACCESSTRADE_SITE_ID (required).',
  };
}
