/**
 * Addrevenue auth + credential validation.
 *
 * Addrevenue uses a long-lived OAuth2 "lifetime" token. The publisher generates
 * it by hand in the dashboard under Tools → API Tokens (Generate new token).
 * The token does not auto-rotate, so we treat it as a static bearer secret
 * loaded from `ADDREVENUE_API_TOKEN`:
 *   - No refresh flow is required for v0.1 (contrast Rakuten's client-
 *     credentials cache). If Addrevenue moves to rotating tokens, this is the
 *     only file that needs to change.
 *   - The auth-check endpoint is `GET /advertisers`, the cheapest authenticated
 *     publisher call. A valid token returns 200; an invalid one returns a 401
 *     with a JSON error body, so the resulting envelope is actionable.
 *
 * --- The channel ID ---------------------------------------------------------
 *
 * Addrevenue scopes a publisher's reporting and tracking to a "channel". The
 * numeric channel ID appears in tracking links (`addrevenue.io/t?c=<channelId>
 * &a=<advertiserId>`) and is supplied as the `channelId` query parameter on the
 * reporting endpoints. We cannot reliably derive it from the token at v0.1 (the
 * advertisers listing is not channel-scoped and the developer reference does
 * not document a `/me`-style identity call), so it is prompted as a separate
 * `ADDREVENUE_CHANNEL_ID` credential and format-validated only. If a future
 * verification against a live account shows the channel ID is discoverable, add
 * a `derivedValues` hook here in the Awin AWIN_PUBLISHER_ID style.
 */

import { addrevenueRequest } from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('addrevenue.auth');

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
 * Verify the Addrevenue token by calling `GET /advertisers`.
 *
 * Why this endpoint:
 *   - It is a small, authenticated publisher call with a predictable 200 / 401
 *     response pattern, so it doubles as the cheapest auth probe.
 *   - It does not require the channel ID, so verifyAuth works during setup even
 *     before `ADDREVENUE_CHANNEL_ID` is entered.
 *
 * We never throw from verifyAuth — it is called by error handlers and the setup
 * wizard, so a thrown error would loop. Failures are returned as VerifyAuthFail.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let token: string;
  try {
    token = requireCredential('ADDREVENUE_API_TOKEN', {
      network: 'addrevenue',
      operation: 'verifyAuth',
      hint: 'Generate a lifetime API token in the Addrevenue dashboard under Tools → API Tokens.',
    });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    await addrevenueRequest<unknown>({
      operation: 'verifyAuth',
      path: '/advertisers',
      token,
      resilience: DEFAULT_RESILIENCE,
    });

    const channelId = getCredential('ADDREVENUE_CHANNEL_ID');
    const identity = channelId
      ? `addrevenue/channel/${channelId}`
      : 'addrevenue (authenticated; no channel ID set)';

    log.debug({ identity }, 'addrevenue verifyAuth succeeded');
    return { ok: true, identity };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: 'addrevenue',
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * ADDREVENUE_API_TOKEN:
 *   Writes the candidate token into process.env, runs verifyAuth(), then
 *   restores the previous value (test isolation). Returns ok on success.
 *
 * ADDREVENUE_CHANNEL_ID:
 *   Format check only — must be a positive integer. We do not verify it via the
 *   API because doing so requires the token and the user may be editing this
 *   field in isolation.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'ADDREVENUE_API_TOKEN') {
    const previous = process.env['ADDREVENUE_API_TOKEN'];
    process.env['ADDREVENUE_API_TOKEN'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'token verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the token in the Addrevenue dashboard under Tools → API Tokens. The token may be ' +
          'revoked or copied with leading/trailing whitespace.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['ADDREVENUE_API_TOKEN'];
      } else {
        process.env['ADDREVENUE_API_TOKEN'] = previous;
      }
    }
  }

  if (field === 'ADDREVENUE_CHANNEL_ID') {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      return {
        ok: false,
        message: 'Addrevenue channel ID must be a positive integer.',
        hint: 'Your channel ID is shown in the Addrevenue dashboard and in your tracking links (the `c` parameter).',
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Addrevenue.`,
    hint:
      'Addrevenue expects ADDREVENUE_API_TOKEN (required) and ADDREVENUE_CHANNEL_ID (required for tracking links).',
  };
}
