/**
 * Post Affiliate Pro auth + credential validation.
 *
 * Two credentials are required, both per-tenant:
 *   POST_AFFILIATE_PRO_BASE_URL — the account API base URL, e.g.
 *     https://demo.postaffiliatepro.com/api/v3. The subdomain identifies the
 *     merchant account, so this is a credential, not a fixed constant.
 *   POST_AFFILIATE_PRO_API_KEY  — a Bearer API key created in the merchant
 *     panel under Configuration > Tools > Integration > API v3.
 *
 * One key + base URL scopes one Post Affiliate Pro account (one merchant),
 * which is why this adapter is `single-brand`.
 *
 * No `derivedValues` flow: the key carries no separate identifier to look up.
 * `verifyAuth()` hits `GET /affiliates?limit=1` — the cheapest authenticated
 * call that returns 200 for a valid key even with no affiliates. Reference:
 * `src/networks/rewardful/auth.ts` and `src/networks/everflow/auth.ts`.
 */

import { papRequest, requireBaseUrl, SLUG } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('post-affiliate-pro.auth');

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
  return requireCredential('POST_AFFILIATE_PRO_API_KEY', {
    network: SLUG,
    operation,
    hint:
      'Create an API key in the Post Affiliate Pro merchant panel under ' +
      'Configuration > Tools > Integration > API v3, then set ' +
      'POST_AFFILIATE_PRO_API_KEY (or run `affiliate-networks-mcp setup post-affiliate-pro`).',
  });
}

export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let apiKey: string;
  let baseUrl: string;
  try {
    baseUrl = requireBaseUrl('verifyAuth');
    apiKey = requireApiKey('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    await papRequest<unknown>({
      operation: 'verifyAuth',
      path: '/affiliates',
      baseUrl,
      apiKey,
      query: { limit: 1 },
      resilience: DEFAULT_RESILIENCE,
    });
    log.debug('post-affiliate-pro verifyAuth succeeded');
    return { ok: true, identity: 'post-affiliate-pro/key-verified' };
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
  if (field === 'POST_AFFILIATE_PRO_BASE_URL') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Post Affiliate Pro base URL is required.',
        hint: 'Use your account API base, e.g. https://demo.postaffiliatepro.com/api/v3.',
      };
    }
    try {
      // eslint-disable-next-line no-new
      new URL(value);
    } catch {
      return {
        ok: false,
        message: 'Post Affiliate Pro base URL is not a valid URL.',
        hint:
          'It must include the scheme and the /api/v3 path, e.g. ' +
          'https://demo.postaffiliatepro.com/api/v3.',
      };
    }
    return { ok: true };
  }

  if (field === 'POST_AFFILIATE_PRO_API_KEY') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Post Affiliate Pro API key is required.',
        hint:
          'Create one under Configuration > Tools > Integration > API v3 in the merchant panel.',
      };
    }
    const previous = process.env['POST_AFFILIATE_PRO_API_KEY'];
    process.env['POST_AFFILIATE_PRO_API_KEY'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'key verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the API key under Configuration > Tools > Integration > API v3, and confirm ' +
          'POST_AFFILIATE_PRO_BASE_URL points at the right account subdomain.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['POST_AFFILIATE_PRO_API_KEY'];
      } else {
        process.env['POST_AFFILIATE_PRO_API_KEY'] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Post Affiliate Pro.`,
    hint: 'Post Affiliate Pro expects POST_AFFILIATE_PRO_BASE_URL and POST_AFFILIATE_PRO_API_KEY.',
  };
}
