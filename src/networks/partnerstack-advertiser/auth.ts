/**
 * PartnerStack Vendor API auth + credential validation.
 *
 * The Vendor API uses an HTTP Basic key pair: a public key (username) and a
 * secret key (password), both generated from the vendor's PartnerStack
 * settings. A single key pair scopes exactly one vendor account, which is why
 * this adapter declares `credential_scope: 'single-brand'`.
 *
 * Reference: `src/networks/impact/auth.ts` (HTTP Basic, two user-supplied
 * values, no derivedValues). Both values appear together on the same settings
 * screen, so neither bootstraps the other.
 *
 * `verifyAuth()` hits `GET /v2/partnerships?limit=1` — the cheapest
 * authenticated call that returns 200 for a valid key pair even on a vendor
 * with no partnerships yet.
 */

import { partnerstackAdvRequest, SLUG } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('partnerstack-advertiser.auth');

export interface VerifyAuthOk {
  ok: true;
  identity?: string;
}

export interface VerifyAuthFail {
  ok: false;
  reason: string;
  envelope?: NetworkErrorEnvelope;
}

export function requirePublicKey(operation: string): string {
  return requireCredential('PARTNERSTACK_PUBLIC_KEY', {
    network: SLUG,
    operation,
    hint:
      'Find your Vendor API keys in the PartnerStack dashboard → Settings → API keys. ' +
      'PARTNERSTACK_PUBLIC_KEY is the Basic-auth username.',
  });
}

export function requireSecretKey(operation: string): string {
  return requireCredential('PARTNERSTACK_SECRET_KEY', {
    network: SLUG,
    operation,
    hint:
      'Find your Vendor API keys in the PartnerStack dashboard → Settings → API keys. ' +
      'PARTNERSTACK_SECRET_KEY is the Basic-auth password.',
  });
}

export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let publicKey: string;
  let secretKey: string;
  try {
    publicKey = requirePublicKey('verifyAuth');
    secretKey = requireSecretKey('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    await partnerstackAdvRequest<unknown>({
      operation: 'verifyAuth',
      path: '/partnerships',
      publicKey,
      secretKey,
      query: { limit: 1 },
      resilience: DEFAULT_RESILIENCE,
    });
    log.debug('partnerstack-advertiser verifyAuth succeeded');
    return { ok: true, identity: 'partnerstack-advertiser/keys-verified' };
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
 * - `PARTNERSTACK_PUBLIC_KEY`: format check only (non-empty). We cannot make a
 *   live call without the secret, and the wizard may prompt in either order.
 * - `PARTNERSTACK_SECRET_KEY`: writes the candidate into `process.env`, runs
 *   `verifyAuth()` (which needs both fields), restores the previous value.
 *   Defers to a format-only pass when the public key is not yet set.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'PARTNERSTACK_PUBLIC_KEY') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'PartnerStack public key is required.',
        hint: 'Settings → API keys in the PartnerStack vendor dashboard.',
      };
    }
    return { ok: true };
  }

  if (field === 'PARTNERSTACK_SECRET_KEY') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'PartnerStack secret key is required.',
        hint: 'Settings → API keys in the PartnerStack vendor dashboard. This is the Basic-auth password.',
      };
    }
    const publicKey = process.env['PARTNERSTACK_PUBLIC_KEY'];
    if (!publicKey) {
      return {
        ok: true,
        message: 'Secret key format accepted; live validation deferred until the public key is set.',
      };
    }
    const previous = process.env['PARTNERSTACK_SECRET_KEY'];
    process.env['PARTNERSTACK_SECRET_KEY'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'keys verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the key pair at the PartnerStack dashboard → Settings → API keys. The keys may be ' +
          'revoked, or paired incorrectly.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['PARTNERSTACK_SECRET_KEY'];
      } else {
        process.env['PARTNERSTACK_SECRET_KEY'] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for PartnerStack vendor.`,
    hint: 'PartnerStack (vendor side) expects PARTNERSTACK_PUBLIC_KEY and PARTNERSTACK_SECRET_KEY.',
  };
}
