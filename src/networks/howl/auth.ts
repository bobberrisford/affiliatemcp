/**
 * Howl auth + credential validation.
 *
 * Howl (formerly Narrativ) authenticates with a static, long-lived API key the
 * publisher generates from the dashboard's Developer Options page. The key is
 * sent in a custom Authorization scheme `NRTV-API-KEY <key>` — see
 * `./client.ts` and https://docs.narrativ.com/auth.html.
 *
 * We treat the key as a static secret loaded from `HOWL_API_KEY`; there is no
 * refresh flow. If Howl moves to rotating keys this is the only file that needs
 * to change.
 *
 * --- The cheap auth-check endpoint ------------------------------------------
 *
 * `GET /api/v1/tokeninfo/` is the smallest authenticated call in the Howl
 * surface. It echoes the token's metadata (token id, owning user `uid`, enabled
 * flag, expiry timestamps) and rejects a bad key with a clean 401, so it makes
 * an honest, fast `verifyAuth` probe.
 *
 * --- Why we do NOT derive HOWL_PUBLISHER_ID ---------------------------------
 *
 * Unlike Awin (whose `/accounts` call yields the publisher id), Howl's
 * `tokeninfo` returns the owning USER id (`uid`), not the publisher id
 * (`pub_id`). The statistics and smart-link endpoints address the publisher by
 * `pub_id`, which is a distinct identifier. Howl does not expose a documented
 * "list my publishers" endpoint for a publisher key, so we cannot reliably
 * derive `pub_id` from the key. The user supplies it as a second credential.
 *
 * Future contributors: keep `verifyAuth` cheap. The wizard calls it during
 * interactive setup; latency here is user-visible.
 */

import { howlRequest } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('howl.auth');

/**
 * Minimal shape we read off Howl's `GET /api/v1/tokeninfo/` response. We do not
 * over-specify it — see `client.ts` for the rationale. Howl wraps the payload
 * under a top-level `data` key on most endpoints; we read both shapes.
 */
interface HowlTokenInfo {
  token_id?: string | number;
  uid?: string | number;
  description?: string;
  is_enabled_by_user?: boolean;
  datetime_expires?: string;
}

interface HowlTokenInfoEnvelope {
  data?: HowlTokenInfo;
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
 * Read the configured publisher id. Howl addresses the publisher by `pub_id`
 * on the statistics and smart-link endpoints; it is a required credential
 * because it cannot be derived from the API key (see file header).
 */
export function requirePublisherId(operation: string): string {
  return requireCredential('HOWL_PUBLISHER_ID', {
    network: 'howl',
    operation,
    hint: 'Set HOWL_PUBLISHER_ID to your numeric Howl publisher id (shown in the dashboard URL and on Developer Options).',
  });
}

/** Read the configured API key. */
export function requireApiKey(operation: string): string {
  return requireCredential('HOWL_API_KEY', {
    network: 'howl',
    operation,
    hint: 'Generate a key on the Howl dashboard → Developer Options, then set HOWL_API_KEY.',
  });
}

/**
 * Verify the Howl API key by hitting `GET /api/v1/tokeninfo/`.
 *
 * On success we return the owning user id as the identity. We never throw —
 * `verifyAuth` is called by error handlers and by the wizard, so a thrown error
 * here would loop or break setup. Missing-credential and upstream failures both
 * surface as a structured `VerifyAuthFail`.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let apiKey: string;
  try {
    apiKey = requireApiKey('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    const response = await howlRequest<HowlTokenInfo | HowlTokenInfoEnvelope>({
      operation: 'verifyAuth',
      path: '/api/v1/tokeninfo/',
      apiKey,
      resilience: DEFAULT_RESILIENCE,
    });

    const info =
      (response as HowlTokenInfoEnvelope).data ?? (response as HowlTokenInfo);
    const uid = info?.uid;

    log.debug({ uid }, 'howl verifyAuth succeeded');

    return {
      ok: true,
      identity: uid !== undefined ? `howl/user ${uid}` : 'howl (token verified)',
    };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: 'howl',
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 *   - `HOWL_API_KEY`: writes the candidate into `process.env`, runs
 *     `verifyAuth()`, restores the previous value.
 *   - `HOWL_PUBLISHER_ID`: format check (positive integer). We do not verify by
 *     API call because the user may be editing this field in isolation and the
 *     statistics endpoint needs a date window to return cleanly.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'HOWL_API_KEY') {
    const previous = process.env['HOWL_API_KEY'];
    process.env['HOWL_API_KEY'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'key verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint: 'Check the key on the Howl dashboard → Developer Options. It may be revoked, expired, or copied with surrounding whitespace.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['HOWL_API_KEY'];
      } else {
        process.env['HOWL_API_KEY'] = previous;
      }
    }
  }

  if (field === 'HOWL_PUBLISHER_ID') {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      return {
        ok: false,
        message: 'Howl publisher id must be a positive integer.',
        hint: 'Find your numeric publisher id in the Howl dashboard URL after signing in, or on the Developer Options page.',
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Howl.`,
    hint: 'Howl expects HOWL_API_KEY (required) and HOWL_PUBLISHER_ID (required).',
  };
}
