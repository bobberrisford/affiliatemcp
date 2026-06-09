/**
 * Digistore24 auth + credential validation.
 *
 * Digistore24 uses a long-lived API key delivered via the custom
 * `X-DS-API-KEY` header. The key is created by the account owner under
 * dev.digistore24.com → "Create API key" (Settings → API keys in the main
 * dashboard). There is no refresh flow — the key is a static secret loaded
 * from `DIGISTORE24_API_KEY`. If a key is compromised, the owner revokes it
 * and issues a new one.
 *
 * --- Auth check -------------------------------------------------------------
 *
 * `verifyAuth()` calls the `getUserInfo` function, the cheapest authenticated
 * call that also reveals the account identity (the Digistore24 ID / nickname).
 * A valid key returns `result: "success"` with a small `data` object; an
 * invalid key returns an `error` envelope which the client raises as a
 * `NetworkError`.
 *
 * We do NOT derive a second credential from this response: a Digistore24 API
 * key is already scoped to one account, and the publisher's own ID is the only
 * identifier subsequent operations need — and that is what `getUserInfo`
 * returns for display. There is no `derivedValues` flow here (unlike Awin's
 * publisher-ID derivation).
 *
 * Future contributors: keep `verifyAuth` cheap. The wizard calls it during
 * interactive setup; latency here is user-visible. `getUserInfo` is tiny.
 */

import { digistore24Request } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('digistore24.auth');

/**
 * The minimal shape we read off the `getUserInfo` `data` payload. Read
 * defensively — Digistore24 may rename or add fields. We accept the common
 * identity keys and fall back gracefully.
 */
interface Digistore24UserInfo {
  id?: string | number;
  user_id?: string | number;
  nickname?: string;
  name?: string;
  first_name?: string;
  last_name?: string;
  email?: string;
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
 * Verify the Digistore24 API key by calling `getUserInfo`.
 *
 * Why this function specifically:
 *   - It is the cheapest authenticated call and returns the account identity,
 *     so the same call powers validation AND the human-readable identity.
 *   - A bad key produces a clean error envelope (surfaced verbatim by the
 *     client), so the failure is actionable.
 *
 * Never throws — `verifyAuth` is called by error handlers, so a throw here
 * would loop. All failure paths return a `VerifyAuthFail`.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let apiKey: string;
  try {
    apiKey = requireCredential('DIGISTORE24_API_KEY', {
      network: 'digistore24',
      operation: 'verifyAuth',
      hint: 'Create an API key at dev.digistore24.com → "Create API key" (or Settings → API keys in the Digistore24 dashboard).',
    });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    const info = await digistore24Request<Digistore24UserInfo>({
      operation: 'verifyAuth',
      function: 'getUserInfo',
      apiKey,
      resilience: DEFAULT_RESILIENCE,
    });

    const identity = identityFor(info);
    log.debug({ identity }, 'digistore24 verifyAuth succeeded');
    return { ok: true, identity };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: 'digistore24',
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Build a human-readable identity string from the getUserInfo payload.
 * Prefers the Digistore24 ID/nickname; falls back to a name or email.
 */
function identityFor(info: Digistore24UserInfo | undefined): string {
  if (!info) return 'digistore24 (authenticated)';
  const id = info.id ?? info.user_id;
  const fullName = [info.first_name, info.last_name].filter(Boolean).join(' ').trim();
  const label = info.nickname ?? info.name ?? (fullName || info.email) ?? '';
  if (id !== undefined && label) return `digistore24/${id} (${label})`;
  if (id !== undefined) return `digistore24/${id}`;
  if (label) return `digistore24 (${label})`;
  return 'digistore24 (authenticated)';
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * `DIGISTORE24_API_KEY`:
 *   Writes the candidate key into `process.env`, runs `verifyAuth()`, restores
 *   the previous value. Returns `ok` on success with the discovered identity in
 *   `message`. This is the only field, so there is no format-only branch.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'DIGISTORE24_API_KEY') {
    const previous = process.env['DIGISTORE24_API_KEY'];
    process.env['DIGISTORE24_API_KEY'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'API key verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the key at dev.digistore24.com → "Create API key". The key may be revoked, ' +
          'scoped without read access, or copied with leading/trailing whitespace.',
      };
    } finally {
      // Restore the previous value so a failed validation does not poison
      // subsequent operations in the same process (test isolation).
      if (previous === undefined) {
        delete process.env['DIGISTORE24_API_KEY'];
      } else {
        process.env['DIGISTORE24_API_KEY'] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Digistore24.`,
    hint: 'Digistore24 expects DIGISTORE24_API_KEY (required).',
  };
}
