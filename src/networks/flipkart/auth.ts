/**
 * Flipkart Affiliate auth + credential validation.
 *
 * Flipkart authenticates every call with two custom headers rather than a
 * standard `Authorization` header:
 *   Fk-Affiliate-Id:    the affiliate tracking ID (FLIPKART_AFFILIATE_ID)
 *   Fk-Affiliate-Token: the self-generated API token (FLIPKART_AFFILIATE_TOKEN)
 *
 * The token is self-issued: a registered affiliate logs in at
 * affiliate.flipkart.com → API → API Token and clicks "Generate API Token".
 * Only one token exists per account; generating a new one disables the old.
 * The token is long-lived and does not auto-rotate, so there is no refresh
 * flow — we treat both credentials as static secrets read from env.
 *
 * --- Auth check -------------------------------------------------------------
 *
 * `verifyAuth()` calls the Product Feed Listing endpoint
 * `GET /affiliate/api/{trackingId}.json`. This is the cheapest authenticated
 * call in the Flipkart surface: it confirms both that the token is valid AND
 * that it is paired with the supplied tracking ID (the tracking ID is a path
 * segment, so a mismatched pair fails fast). A valid pair returns 200 with the
 * category listing; an invalid pair returns a 401/403 with a body we surface
 * verbatim.
 *
 * We cannot derive the tracking ID from the response (it is an input, not an
 * output), so there is no `derivedValues` flow here — both credentials are
 * prompted explicitly by the wizard.
 *
 * Reference: src/networks/awin/auth.ts and src/networks/everflow/auth.ts.
 * Never throw a bare Error from this file; every failure path returns a
 * structured result carrying an envelope.
 */

import { flipkartRequest } from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('flipkart.auth');

export const FLIPKART_SLUG = 'flipkart';

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
 * Read the affiliate tracking ID. Surfaces as a `config_error` envelope when
 * missing — every credential read goes through `requireCredential`.
 */
export function requireAffiliateId(operation: string): string {
  return requireCredential('FLIPKART_AFFILIATE_ID', {
    network: FLIPKART_SLUG,
    operation,
    hint:
      'Set FLIPKART_AFFILIATE_ID to your affiliate tracking ID, shown at ' +
      'affiliate.flipkart.com -> API -> API Token (the "Affiliate Tracking ID" field).',
  });
}

/**
 * Read the API token. Surfaces as a `config_error` envelope when missing.
 */
export function requireToken(operation: string): string {
  return requireCredential('FLIPKART_AFFILIATE_TOKEN', {
    network: FLIPKART_SLUG,
    operation,
    hint:
      'Generate a token at affiliate.flipkart.com -> API -> API Token -> ' +
      '"Generate API Token". Only one token is active per account.',
  });
}

/**
 * Verify the Flipkart credentials by calling the Product Feed Listing endpoint
 * `GET /affiliate/api/{trackingId}.json`.
 *
 * Why this endpoint:
 *   - It is the smallest authenticated call that confirms BOTH credentials:
 *     the token (header) and the tracking ID (path segment) must match.
 *   - A bad token or mismatched pair returns a clean 401/403, so the error
 *     envelope is actionable rather than a generic 5xx.
 *
 * The identity we report is the tracking ID — Flipkart credentials are scoped
 * to exactly one affiliate account, so there is nothing further to derive.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let affiliateId: string;
  let token: string;
  try {
    affiliateId = requireAffiliateId('verifyAuth');
    token = requireToken('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    await flipkartRequest<unknown>({
      operation: 'verifyAuth',
      path: `/affiliate/api/${encodeURIComponent(affiliateId)}.json`,
      affiliateId,
      token,
      resilience: DEFAULT_RESILIENCE,
    });

    const identity = `flipkart/${affiliateId}`;
    log.debug({ identity }, 'flipkart verifyAuth succeeded');
    return { ok: true, identity };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: FLIPKART_SLUG,
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * FLIPKART_AFFILIATE_TOKEN:
 *   Requires the tracking ID to be present (the verify call pairs the two), so
 *   we write the candidate token into process.env, call verifyAuth(), then
 *   restore the previous value. If the tracking ID is not yet set we cannot
 *   verify in isolation, so we accept the value and defer to the combined
 *   check after the ID has been entered.
 *
 * FLIPKART_AFFILIATE_ID:
 *   Format check only (non-empty, no whitespace). The tracking ID is an opaque
 *   string assigned by Flipkart, not a numeric ID, so we do not pattern-match
 *   it beyond rejecting empty / whitespace values.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'FLIPKART_AFFILIATE_TOKEN') {
    if (!getCredential('FLIPKART_AFFILIATE_ID')) {
      return {
        ok: true,
        message: 'will validate once the affiliate tracking ID is entered',
      };
    }
    const previous = process.env['FLIPKART_AFFILIATE_TOKEN'];
    process.env['FLIPKART_AFFILIATE_TOKEN'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'token verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the token at affiliate.flipkart.com -> API -> API Token. The token may be ' +
          'regenerated (which disables the previous one), or copied with leading/trailing whitespace.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['FLIPKART_AFFILIATE_TOKEN'];
      } else {
        process.env['FLIPKART_AFFILIATE_TOKEN'] = previous;
      }
    }
  }

  if (field === 'FLIPKART_AFFILIATE_ID') {
    if (value.trim() === '' || /\s/.test(value)) {
      return {
        ok: false,
        message: 'Flipkart affiliate tracking ID must be non-empty and contain no whitespace.',
        hint: 'Copy the "Affiliate Tracking ID" shown at affiliate.flipkart.com -> API -> API Token.',
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Flipkart.`,
    hint: 'Flipkart expects FLIPKART_AFFILIATE_ID and FLIPKART_AFFILIATE_TOKEN.',
  };
}
