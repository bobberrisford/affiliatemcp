/**
 * AvantLink auth + credential validation.
 *
 * AvantLink authenticates by query parameter, not by HTTP header. Three values
 * scope and authenticate a call:
 *
 *   - `affiliate_id`  — the AvantLink-assigned affiliate (publisher) identifier.
 *   - `auth_key`      — a 32-character randomly generated API key from the
 *                       dashboard. This is the secret.
 *   - `website_id`    — the AvantLink-assigned website identifier under the
 *                       affiliate account. Reports and tracking links are
 *                       scoped per website, so this is required for most
 *                       modules.
 *
 * There is no token exchange and no refresh flow — the `auth_key` is a static,
 * long-lived secret. If it is compromised the affiliate regenerates it from
 * the dashboard. This file is the only place that needs to change if AvantLink
 * moves to a rotating scheme.
 *
 * We cannot derive any of these three values from an API response (unlike Awin,
 * which derives its publisher ID), because every authenticated module already
 * requires all three to run. There is therefore no `derivedValues` flow here;
 * the wizard prompts for each value directly.
 *
 * --- Auth check -------------------------------------------------------------
 *
 * `verifyAuth()` runs the `AssociationFeed` module, which lists the merchants
 * (programmes) the affiliate is associated with. It is the cheapest
 * authenticated affiliate module and confirms all three credentials at once: a
 * bad `auth_key` or `affiliate_id` fails, and a wrong `website_id` returns no
 * associations.
 *
 * Docs:
 *   - Where can I find my ID? https://support.avantlink.com/hc/en-us/articles/360004058972-Where-can-I-find-my-ID-
 *   - Affiliate API Technical Integration: https://support.avantlink.com/hc/en-us/articles/203644699-Affiliate-API-Technical-Integration
 */

import { avantlinkRequest } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('avantlink.auth');

export const AVANTLINK_SLUG = 'avantlink';

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
 * Read the affiliate ID credential, throwing a `config_error` envelope when it
 * is missing. Shared by the adapter operations and the auth check.
 */
export function requireAffiliateId(operation: string): string {
  return requireCredential('AVANTLINK_AFFILIATE_ID', {
    network: AVANTLINK_SLUG,
    operation,
    hint:
      'Your affiliate ID is shown in the AvantLink dashboard under Account → API, ' +
      'or set AVANTLINK_AFFILIATE_ID in ~/.affiliate-mcp/.env.',
  });
}

/** Read the API key (auth_key) credential, throwing a `config_error` envelope when missing. */
export function requireApiKey(operation: string): string {
  return requireCredential('AVANTLINK_API_KEY', {
    network: AVANTLINK_SLUG,
    operation,
    hint:
      'Generate or copy your 32-character API key (auth_key) in the AvantLink dashboard ' +
      'under Account → API, then set AVANTLINK_API_KEY in ~/.affiliate-mcp/.env.',
  });
}

/** Read the website ID credential, throwing a `config_error` envelope when missing. */
export function requireWebsiteId(operation: string): string {
  return requireCredential('AVANTLINK_WEBSITE_ID', {
    network: AVANTLINK_SLUG,
    operation,
    hint:
      'Your website ID is shown beside the registered site in the AvantLink dashboard ' +
      'under Account → Websites, or set AVANTLINK_WEBSITE_ID in ~/.affiliate-mcp/.env.',
  });
}

/**
 * Verify the AvantLink credentials by running the `AssociationFeed` module.
 *
 * Why this module: it is the smallest authenticated affiliate call, it exercises
 * all three credentials at once, and it returns the affiliate's merchant
 * associations (so a 200 with content confirms a working website scope). We do
 * not throw — verifyAuth is called by error handlers and the wizard.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let affiliateId: string;
  let authKey: string;
  let websiteId: string;
  try {
    affiliateId = requireAffiliateId('verifyAuth');
    authKey = requireApiKey('verifyAuth');
    websiteId = requireWebsiteId('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    await avantlinkRequest<unknown>({
      operation: 'verifyAuth',
      module: 'AssociationFeed',
      query: {
        affiliate_id: affiliateId,
        auth_key: authKey,
        website_id: websiteId,
      },
      resilience: DEFAULT_RESILIENCE,
    });

    const identity = `avantlink/affiliate/${affiliateId} (website ${websiteId})`;
    log.debug({ identity }, 'avantlink verifyAuth succeeded');
    return { ok: true, identity };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: AVANTLINK_SLUG,
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 *   - `AVANTLINK_API_KEY`: writes the candidate into process.env, runs
 *     `verifyAuth()`, then restores the previous value. This needs the
 *     affiliate ID and website ID to already be present; if they are not, the
 *     verify call surfaces a config_error which we relay.
 *   - `AVANTLINK_AFFILIATE_ID` / `AVANTLINK_WEBSITE_ID`: format check only
 *     (positive integer). We do not verify them in isolation because a
 *     meaningful check needs the API key as well.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'AVANTLINK_API_KEY') {
    const previous = process.env['AVANTLINK_API_KEY'];
    process.env['AVANTLINK_API_KEY'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'API key verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the API key in the AvantLink dashboard under Account → API. It must be the ' +
          '32-character auth_key, and AVANTLINK_AFFILIATE_ID and AVANTLINK_WEBSITE_ID must also be set.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['AVANTLINK_API_KEY'];
      } else {
        process.env['AVANTLINK_API_KEY'] = previous;
      }
    }
  }

  if (field === 'AVANTLINK_AFFILIATE_ID' || field === 'AVANTLINK_WEBSITE_ID') {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      const label = field === 'AVANTLINK_AFFILIATE_ID' ? 'affiliate ID' : 'website ID';
      return {
        ok: false,
        message: `AvantLink ${label} must be a positive integer.`,
        hint: 'Both IDs are shown in the AvantLink dashboard under Account → API and Account → Websites.',
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for AvantLink.`,
    hint:
      'AvantLink expects AVANTLINK_AFFILIATE_ID, AVANTLINK_API_KEY, and AVANTLINK_WEBSITE_ID.',
  };
}
