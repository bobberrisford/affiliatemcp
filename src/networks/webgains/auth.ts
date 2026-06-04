/**
 * Webgains auth + credential validation.
 *
 * Webgains' Smart Platform API uses an OAuth2 "Personal Access Token". Unlike
 * Skimlinks (client-credentials exchange) the publisher generates a long-lived
 * Personal Access Token self-serve inside the Smart Publisher Platform and the
 * adapter passes it directly as a bearer token. There is therefore NO token
 * exchange step and no module-level token cache: the credential the user
 * supplies IS the bearer token.
 *   Source: https://docs.webgains.dev/docs/platform-api-1/yhwhwxlbhc1zv-authentication-with-personal-access-tokens
 *
 * Credentials:
 *   - WEBGAINS_API_KEY      — the Personal Access Token (bearer secret).
 *   - WEBGAINS_PUBLISHER_ID — the numeric publisher account ID. Required because
 *       reporting/programme endpoints are scoped to a publisher account.
 *       BLOCKED(verify): whether the publisher ID is passed in the path, a query
 *       param, or is implied by the token could not be confirmed (doc host
 *       returned HTTP 403). The adapter passes it explicitly so a half-configured
 *       environment fails loudly rather than silently scoping to the wrong account.
 *   - WEBGAINS_CAMPAIGN_ID  — the publisher campaign (a.k.a. Site) ID, used only
 *       for generateTrackingLink (the `wgcampaignid` deeplink parameter).
 *
 * --- verifyAuth ----------------------------------------------------------------
 *
 * verifyAuth makes a cheap, identity-revealing call (Get Publisher) and returns
 * the publisher account as the identity. Any failure returns { ok: false } —
 * it never throws, because verifyAuth is called by error handlers.
 */

import { webgainsRequest } from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('webgains.auth');

const SLUG = 'webgains';

// ---------------------------------------------------------------------------
// Credential accessors
// ---------------------------------------------------------------------------

export function requireApiKey(operation: string): string {
  return requireCredential('WEBGAINS_API_KEY', {
    network: SLUG,
    operation,
    hint:
      'Set WEBGAINS_API_KEY in ~/.affiliate-mcp/.env. Generate a Personal Access ' +
      'Token in the Webgains Smart Publisher Platform under your account/developer settings.',
  });
}

export function requirePublisherId(operation: string): string {
  return requireCredential('WEBGAINS_PUBLISHER_ID', {
    network: SLUG,
    operation,
    hint:
      'Set WEBGAINS_PUBLISHER_ID in ~/.affiliate-mcp/.env. This is your numeric ' +
      'Webgains publisher account ID, shown in the Smart Publisher Platform.',
  });
}

// ---------------------------------------------------------------------------
// VerifyAuth
// ---------------------------------------------------------------------------

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
 * Raw shape of the Get Publisher response. Deliberately permissive — only the
 * identity-bearing fields are read; everything else is ignored.
 * BLOCKED(verify): exact field names (`id` vs `publisherId`, `name` vs
 * `accountName`) could not be confirmed against the doc host. The adapter reads
 * several plausible names defensively.
 */
interface WebgainsPublisherRaw {
  id?: string | number;
  publisherId?: string | number;
  name?: string;
  accountName?: string;
  publisher?: WebgainsPublisherRaw;
}

/**
 * Verify Webgains credentials by calling the Get Publisher endpoint.
 *
 * A successful 2xx proves the Personal Access Token is valid; a 401/403 proves
 * it is not. Never throws — returns { ok: false } on any failure so callers
 * (including error handlers) do not loop.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let token: string;
  let publisherId: string;
  try {
    token = requireApiKey('verifyAuth');
    publisherId = requirePublisherId('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    // BLOCKED(verify): the Get Publisher path is taken as
    // `/publishers/{publisherId}` pending live confirmation.
    const raw = await webgainsRequest<WebgainsPublisherRaw>({
      operation: 'verifyAuth',
      path: `/publishers/${publisherId}`,
      token,
      resilience: DEFAULT_RESILIENCE,
    });

    const inner = raw.publisher ?? raw;
    const name = inner.name ?? inner.accountName;
    const idValue = inner.publisherId ?? inner.id ?? publisherId;
    const identity = name
      ? `webgains/publisher:${idValue} (${name})`
      : `webgains/publisher:${idValue}`;

    log.debug({ identity }, 'webgains verifyAuth succeeded');
    return { ok: true, identity };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'auth_error',
      network: SLUG,
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
      hint: 'Check WEBGAINS_API_KEY and WEBGAINS_PUBLISHER_ID in your config.',
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

// ---------------------------------------------------------------------------
// Credential validation
// ---------------------------------------------------------------------------

/**
 * Validate a single credential field at wizard-entry time.
 *
 * WEBGAINS_API_KEY: format check (non-empty), then a live Get Publisher call to
 *   prove the token works. The live check uses whatever WEBGAINS_PUBLISHER_ID is
 *   currently in the environment.
 * WEBGAINS_PUBLISHER_ID: format check (positive integer) — no API call.
 * WEBGAINS_CAMPAIGN_ID: format check (positive integer) — no API call.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'WEBGAINS_API_KEY') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'API key (Personal Access Token) must not be empty.',
        hint: 'Generate a Personal Access Token in the Webgains Smart Publisher Platform.',
      };
    }
    // Live check: inject the candidate token and call Get Publisher.
    const prev = process.env['WEBGAINS_API_KEY'];
    process.env['WEBGAINS_API_KEY'] = value;
    try {
      if (!getCredential('WEBGAINS_PUBLISHER_ID')) {
        return {
          ok: true,
          message:
            'API key format OK; will validate against the API once the Publisher ID is set.',
        };
      }
      const result = await verifyAuth();
      if (result.ok) {
        return {
          ok: true,
          message: result.identity ?? 'API key verified against the Webgains API.',
        };
      }
      return {
        ok: false,
        message: result.reason,
        hint: 'Check WEBGAINS_API_KEY and WEBGAINS_PUBLISHER_ID. The token must be a valid, non-revoked Personal Access Token.',
      };
    } finally {
      if (prev === undefined) {
        delete process.env['WEBGAINS_API_KEY'];
      } else {
        process.env['WEBGAINS_API_KEY'] = prev;
      }
    }
  }

  if (field === 'WEBGAINS_PUBLISHER_ID') {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      return {
        ok: false,
        message: 'Webgains Publisher ID must be a positive integer.',
        hint: 'Find your numeric publisher account ID in the Webgains Smart Publisher Platform.',
      };
    }
    return { ok: true };
  }

  if (field === 'WEBGAINS_CAMPAIGN_ID') {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      return {
        ok: false,
        message: 'Webgains Campaign ID must be a positive integer.',
        hint:
          'Your Campaign (Site) ID is the number used as wgcampaignid in tracking links. ' +
          'Find it in the Smart Publisher Platform under your site/campaign settings.',
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Webgains.`,
    hint: 'Webgains expects WEBGAINS_API_KEY, WEBGAINS_PUBLISHER_ID, and WEBGAINS_CAMPAIGN_ID.',
  };
}
