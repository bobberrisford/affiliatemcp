/**
 * Tradedoubler auth + credential validation.
 *
 * Tradedoubler's modern publisher API (connect.tradedoubler.com) uses OAuth2
 * bearer tokens. The token is generated in the Tradedoubler dashboard under
 * Account → Manage tokens. Unlike the older api.tradedoubler.com surface (which
 * has per-product tokens passed via `?token=` query params), the connect API
 * uses a single bearer token in the `Authorization` header.
 *
 * Required credentials:
 *   - TRADEDOUBLER_API_TOKEN  — the OAuth2 bearer token
 *   - TRADEDOUBLER_ORGANIZATION_ID — the publisher's numeric organisation ID
 *
 * Auth check endpoint:
 *   GET /usermanagement/users/me
 *   → Returns current user details; 401 on a bad token.
 *
 * Why we also accept /publisher/account:
 *   Either endpoint can confirm auth. `/usermanagement/users/me` is smaller
 *   and faster; we prefer it for latency reasons during interactive setup.
 */

import { tradedoublerRequest } from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';
import { TD_SLUG } from './endpoints/shared.js';

const log = createLogger('tradedoubler.auth');

/**
 * Minimal shape of the /usermanagement/users/me response.
 *
 * Tradedoubler does not fully document this endpoint's field set. The fixture
 * file (tests/fixtures/tradedoubler/me.json) uses `organisationId` (British
 * English spelling) — this matches the pattern used throughout the connect API
 * (e.g. the Apiary blueprint consistently uses British English).
 *
 * BLOCKED: Exact spelling of the organisation ID field (`organisationId` vs
 * `organizationId`) cannot be confirmed without a live account response.
 * Both spellings are accepted defensively.
 */
interface TdUserMe {
  id?: number | string;
  email?: string;
  firstName?: string;
  lastName?: string;
  organisationId?: number | string; // expected (British English, matching Apiary style)
  organizationId?: number | string; // BLOCKED: alternate — kept as defensive fallback
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
 * Verify the Tradedoubler bearer token by calling GET /usermanagement/users/me.
 *
 * On success, returns the user's email (or id) as the `identity` string.
 * On auth failure (401), returns `ok: false` with the verbatim reason.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let token: string;
  try {
    token = requireCredential('TRADEDOUBLER_API_TOKEN', {
      network: TD_SLUG,
      operation: 'verifyAuth',
      hint:
        'Generate an API token in the Tradedoubler dashboard → Account → Manage tokens. ' +
        'Set TRADEDOUBLER_API_TOKEN in ~/.affiliate-mcp/.env.',
    });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    const user = await tradedoublerRequest<TdUserMe>({
      operation: 'verifyAuth',
      path: '/usermanagement/users/me',
      token,
      resilience: DEFAULT_RESILIENCE,
    });

    const id =
      user.id ??
      user.organisationId ?? // expected spelling (British English, see TdUserMe)
      user.organizationId; // fallback for American English variant
    const name =
      [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || '';
    const identity = name ? `tradedoubler/${id} (${name})` : `tradedoubler/${id ?? 'unknown'}`;

    log.debug({ id, name }, 'tradedoubler verifyAuth succeeded');

    return { ok: true, identity };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: TD_SLUG,
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * TRADEDOUBLER_API_TOKEN: performs a live /usermanagement/users/me call.
 * TRADEDOUBLER_ORGANIZATION_ID: format check only (positive integer).
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'TRADEDOUBLER_API_TOKEN') {
    const previous = process.env['TRADEDOUBLER_API_TOKEN'];
    process.env['TRADEDOUBLER_API_TOKEN'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return {
          ok: true,
          message: result.identity ?? 'token verified',
        };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the token in the Tradedoubler dashboard → Account → Manage tokens. ' +
          'The token may have been revoked, or copied with leading/trailing whitespace.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['TRADEDOUBLER_API_TOKEN'];
      } else {
        process.env['TRADEDOUBLER_API_TOKEN'] = previous;
      }
    }
  }

  if (field === 'TRADEDOUBLER_ORGANIZATION_ID') {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      return {
        ok: false,
        message: 'Tradedoubler organisation ID must be a positive integer.',
        hint:
          'Find your organisation ID in the Tradedoubler dashboard URL after login, or ' +
          'in Account → Organisation settings.',
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Tradedoubler.`,
    hint:
      'Tradedoubler expects TRADEDOUBLER_API_TOKEN (required) and ' +
      'TRADEDOUBLER_ORGANIZATION_ID (required, numeric).',
  };
}

/**
 * Read the current credential values without requiring them (used in setup
 * to offer a "skip" when the token has already been validated).
 */
export function getOrgId(): string | undefined {
  return getCredential('TRADEDOUBLER_ORGANIZATION_ID');
}
