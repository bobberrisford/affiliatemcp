/**
 * Amazon Creators API auth + credential validation.
 *
 * The Creators API (successor to PA-API 5.0) authenticates with OAuth 2.0
 * client-credentials, NOT the old PA-API AWS SigV4. The user generates a
 * "Credential ID" / "Credential Secret" pair in Associates Central → Creators
 * API; the partner tag and marketplace come from their Associates account.
 *
 * --- The cheapest identity-revealing call ------------------------------------
 *
 * The Creators API is a product-catalog API: it exposes getItems / searchItems
 * and has no `/me`, `/accounts`, or reporting endpoint. The cheapest way to
 * prove the credentials work WITHOUT needing a real ASIN is the OAuth2 token
 * exchange itself: a successful client-credentials grant proves the Credential
 * ID + Secret are valid. We use that as `verifyAuth`. The "identity" we can
 * surface is the configured partner tag and marketplace — the token endpoint
 * does not return an account name.
 *
 * This adapter has NOT been validated against a live Creators API account; the
 * token endpoint, scope and headers are reconstructed from public sources (see
 * docs/networks/amazon-creators.md). Keep `verifyAuth` cheap and never throw
 * from it — it is called by error handlers and throwing here loops.
 */

import {
  getAccessToken,
  type AmazonCreatorsCredentials,
  AMAZON_CREATORS_SLUG,
  DEFAULT_MARKETPLACE,
} from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('amazon-creators.auth');

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
 * Read the four credentials. The partner tag and marketplace are required for
 * every catalog call and for tracking-link construction; the OAuth pair is
 * required for any authenticated call. `marketplace` falls back to the US
 * default rather than failing setup, so a user who only set the three core
 * fields still works.
 */
export function readCredentials(operation: string): AmazonCreatorsCredentials {
  const clientId = requireCredential('AMAZON_CREATORS_CLIENT_ID', {
    network: AMAZON_CREATORS_SLUG,
    operation,
    hint: 'Create a credential in Associates Central → Creators API → Applications → Create App.',
  });
  const clientSecret = requireCredential('AMAZON_CREATORS_CLIENT_SECRET', {
    network: AMAZON_CREATORS_SLUG,
    operation,
    hint: 'Copy the Credential Secret shown once when you add a new credential in Associates Central.',
  });
  const partnerTag = requireCredential('AMAZON_PARTNER_TAG', {
    network: AMAZON_CREATORS_SLUG,
    operation,
    hint: 'Your Associates store/tracking ID, e.g. "yoursite-20". Find it in Associates Central.',
  });
  const marketplace = getCredential('AMAZON_MARKETPLACE') ?? DEFAULT_MARKETPLACE;
  return { clientId, clientSecret, partnerTag, marketplace };
}

/**
 * Verify the credentials by performing the OAuth2 client-credentials token
 * exchange. A successful grant proves the credential pair is valid. We force a
 * refresh so a stale cached token does not mask a revoked credential.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let creds: AmazonCreatorsCredentials;
  try {
    creds = readCredentials('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    await getAccessToken({
      operation: 'verifyAuth',
      credentials: creds,
      resilience: DEFAULT_RESILIENCE,
      forceRefresh: true,
    });
    log.debug({ partnerTag: creds.partnerTag, marketplace: creds.marketplace }, 'amazon-creators verifyAuth succeeded');
    return {
      ok: true,
      identity: `amazon-creators/${creds.partnerTag} (${creds.marketplace})`,
    };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: AMAZON_CREATORS_SLUG,
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * - AMAZON_CREATORS_CLIENT_SECRET: deferred — the secret cannot be checked
 *   without the client id, and the wizard may edit it in isolation. Format
 *   check only (non-empty).
 * - AMAZON_CREATORS_CLIENT_ID: live-validated by attempting the token exchange
 *   IF a secret is already present in the environment; otherwise deferred with
 *   an informational message (mirrors Rakuten's "validate after secret" flow).
 * - AMAZON_PARTNER_TAG: format check. Associates tags look like `name-NN`.
 * - AMAZON_MARKETPLACE: format check against the `www.amazon.<tld>` shape.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'AMAZON_CREATORS_CLIENT_ID') {
    const secret = getCredential('AMAZON_CREATORS_CLIENT_SECRET');
    if (!secret) {
      return {
        ok: true,
        message: 'Will validate after the Credential Secret is entered.',
      };
    }
    const previous = process.env['AMAZON_CREATORS_CLIENT_ID'];
    process.env['AMAZON_CREATORS_CLIENT_ID'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'credentials verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint: 'Check the Credential ID and Secret in Associates Central → Creators API. They may be revoked or copied with stray whitespace.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['AMAZON_CREATORS_CLIENT_ID'];
      } else {
        process.env['AMAZON_CREATORS_CLIENT_ID'] = previous;
      }
    }
  }

  if (field === 'AMAZON_CREATORS_CLIENT_SECRET') {
    if (value.trim() === '') {
      return { ok: false, message: 'The Credential Secret must not be empty.' };
    }
    return { ok: true, message: 'Stored; validated together with the Credential ID.' };
  }

  if (field === 'AMAZON_PARTNER_TAG') {
    // Associates tags are typically `slug-NN`; we accept any non-empty,
    // hyphen-containing token rather than over-constraining a format Amazon
    // varies by marketplace.
    if (value.trim() === '') {
      return { ok: false, message: 'The partner tag must not be empty.' };
    }
    if (!/-\d{2,3}$/.test(value.trim())) {
      return {
        ok: true,
        message: 'Stored. Most Associates tags end in a country suffix such as "-20"; double-check yours in Associates Central.',
      };
    }
    return { ok: true };
  }

  if (field === 'AMAZON_MARKETPLACE') {
    if (value.trim() === '') {
      return { ok: false, message: 'The marketplace must not be empty.' };
    }
    if (!/^www\.amazon\.[a-z.]+$/.test(value.trim())) {
      return {
        ok: false,
        message: 'The marketplace should look like "www.amazon.com" or "www.amazon.co.uk".',
        hint: 'Use the storefront domain for your Associates marketplace.',
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Amazon Creators.`,
    hint: 'Amazon Creators expects AMAZON_CREATORS_CLIENT_ID, AMAZON_CREATORS_CLIENT_SECRET, AMAZON_PARTNER_TAG and AMAZON_MARKETPLACE.',
  };
}
