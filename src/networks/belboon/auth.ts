/**
 * Belboon auth + credential validation.
 *
 * Belboon runs on the Ingenious Technologies platform. The publisher API is the
 * "export file" interface: authentication is not a header but two values baked
 * into the request URL —
 *
 *   - BELBOON_MAGIC_KEY  — a UUID found in the Belboon dashboard under
 *                          Settings → API (a.k.a. the "Magic Key"). It is the
 *                          first path segment of every export URL.
 *   - BELBOON_USER_ID    — the numeric partner/user id, baked into the export
 *                          file name (`<exportName>_<userId>.csv`).
 *
 * There is no refresh flow; both values are long-lived secrets the publisher
 * reads from the dashboard. If the Magic Key is compromised it is rotated from
 * the same screen.
 *
 * An optional BELBOON_EXPORT_HOST overrides the per-tenant export host (the
 * Ingenious platform serves some accounts from a non-default subdomain). It is
 * read directly by the client; it is not a secret.
 *
 * --- Auth check -------------------------------------------------------------
 *
 * `verifyAuth()` requests the advertiser/programme export with no date filters
 * (`adm-merchantexport`). It is the cheapest identity-revealing call: a valid
 * Magic Key + user id returns a 200 CSV body; a bad key returns a 4xx. We do
 * not parse the body for identity beyond confirming the request authenticated —
 * the export interface does not return an account-name field we can trust, so
 * the identity string is built from the configured user id.
 *
 * Never throw from verifyAuth: it is called by error handlers and the wizard.
 * Every failure path returns a structured `{ ok: false, reason, envelope }`.
 */

import { belboonRequest } from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('belboon.auth');

const SLUG = 'belboon';

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
 * Verify the Belboon credentials by requesting the advertiser/programme export.
 *
 * We choose `adm-merchantexport` because it requires no date range and is the
 * smallest authenticated export the publisher can always request. A bad Magic
 * Key or user id surfaces as a 4xx via the client's `HttpStatusError`.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let magicKey: string;
  let userId: string;
  try {
    magicKey = requireCredential('BELBOON_MAGIC_KEY', {
      network: SLUG,
      operation: 'verifyAuth',
      hint: 'Find the Magic Key in the Belboon dashboard under Settings → API.',
    });
    userId = requireCredential('BELBOON_USER_ID', {
      network: SLUG,
      operation: 'verifyAuth',
      hint: 'Your numeric Belboon partner/user id, shown in the dashboard under Account.',
    });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    await belboonRequest({
      operation: 'verifyAuth',
      exportName: 'adm-merchantexport',
      magicKey,
      userId,
      resilience: DEFAULT_RESILIENCE,
    });

    const identity = `belboon/partner/${userId}`;
    log.debug({ identity }, 'belboon verifyAuth succeeded');
    return { ok: true, identity };
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
 * Validate a single credential field at wizard-entry time.
 *
 *   BELBOON_MAGIC_KEY — format-checked (UUID-ish), then a live `verifyAuth()`
 *     IF a user id is already present in the environment (the export call needs
 *     both). When the user id is not yet entered, we accept the format and
 *     defer the live check.
 *   BELBOON_USER_ID — format check only (positive integer). A live check needs
 *     the Magic Key, which may not be entered yet.
 *   BELBOON_EXPORT_HOST — optional host override; light format check.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'BELBOON_MAGIC_KEY') {
    // The Magic Key is a UUID on the Ingenious platform. Accept the canonical
    // 8-4-4-4-12 hex form; do not hard-fail other lengths in case a tenant uses
    // a variant, but warn via the message.
    const looksUuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(
      value.trim(),
    );
    if (value.trim().length < 8) {
      return {
        ok: false,
        message: 'The Belboon Magic Key looks too short.',
        hint: 'Copy the full Magic Key from the Belboon dashboard under Settings → API.',
      };
    }

    const userId = getCredential('BELBOON_USER_ID');
    if (!userId) {
      return {
        ok: true,
        message: looksUuid
          ? 'Magic Key format accepted; will validate once the user id is set.'
          : 'Magic Key accepted (unusual format); will validate once the user id is set.',
      };
    }

    const previous = process.env['BELBOON_MAGIC_KEY'];
    process.env['BELBOON_MAGIC_KEY'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'credentials verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the Magic Key in the Belboon dashboard under Settings → API. It may have ' +
          'been rotated, or the user id may not match the account that owns the key.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['BELBOON_MAGIC_KEY'];
      } else {
        process.env['BELBOON_MAGIC_KEY'] = previous;
      }
    }
  }

  if (field === 'BELBOON_USER_ID') {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      return {
        ok: false,
        message: 'Belboon user/partner id must be a positive integer.',
        hint: 'Your numeric partner id is shown in the Belboon dashboard under Account.',
      };
    }
    return { ok: true };
  }

  if (field === 'BELBOON_EXPORT_HOST') {
    const v = value.trim();
    if (v === '') return { ok: true, message: 'No override; using the default Belboon export host.' };
    const candidate = /^https?:\/\//.test(v) ? v : `https://${v}`;
    try {
      // eslint-disable-next-line no-new
      new URL(candidate);
      return { ok: true };
    } catch {
      return {
        ok: false,
        message: `"${value}" is not a valid host or URL.`,
        hint: 'Enter the export host shown in your export download links, e.g. export.net.belboon.com.',
      };
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Belboon.`,
    hint:
      'Belboon expects BELBOON_MAGIC_KEY (required), BELBOON_USER_ID (required), ' +
      'and BELBOON_EXPORT_HOST (optional).',
  };
}
