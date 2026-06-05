/**
 * Webgains advertiser (brand-side) auth + credential validation.
 *
 * Webgains' Smart Platform API uses an OAuth2 "Personal Access Token" (PAT).
 * The advertiser generates a long-lived PAT self-serve inside the advertiser
 * dashboard (the same token mechanism the publisher side uses) and the adapter
 * passes it directly as a bearer token. There is NO token-exchange step and no
 * module-level token cache: the credential the user supplies IS the bearer
 * token.
 *   Source: https://docs.webgains.dev/docs/platform-api-1/yhwhwxlbhc1zv-authentication-with-personal-access-tokens
 *           https://knowledgehub.webgains.com/home/what-api-connections-do-webgains-offer-for-adverti
 *
 * Credentials:
 *   - WEBGAINS_ADVERTISER_API_KEY      — the Personal Access Token (bearer secret).
 *   - WEBGAINS_ADVERTISER_ACCOUNT_ID   — the numeric advertiser account ID. Used to
 *       scope reporting/programme endpoints to the advertiser's account.
 *       BLOCKED(verify): whether the account ID is passed in the path, a query
 *       param, or is implied by the token could not be confirmed (the doc host
 *       returns HTTP 403 to automated fetch). The adapter passes it explicitly so
 *       a half-configured environment fails loudly rather than silently scoping
 *       to the wrong account.
 *
 * --- verifyAuth ----------------------------------------------------------------
 *
 * verifyAuth makes a cheap, identity-revealing call (Get Programs for the
 * advertiser account) and returns the account as the identity. Any failure
 * returns { ok: false } — it never throws, because verifyAuth is called by
 * error handlers.
 */

import { webgainsAdvRequest } from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('webgains-advertiser.auth');

export const SLUG = 'webgains-advertiser';

// ---------------------------------------------------------------------------
// Credential accessors
// ---------------------------------------------------------------------------

export function requireApiKey(operation: string): string {
  return requireCredential('WEBGAINS_ADVERTISER_API_KEY', {
    network: SLUG,
    operation,
    hint:
      'Set WEBGAINS_ADVERTISER_API_KEY in ~/.affiliate-mcp/.env. Generate a Personal Access ' +
      'Token in the Webgains advertiser dashboard under your account / developer (API) settings. ' +
      'We recommend a read-only token where the dashboard offers one.',
  });
}

export function requireAccountId(operation: string): string {
  return requireCredential('WEBGAINS_ADVERTISER_ACCOUNT_ID', {
    network: SLUG,
    operation,
    hint:
      'Set WEBGAINS_ADVERTISER_ACCOUNT_ID in ~/.affiliate-mcp/.env. This is your numeric ' +
      'Webgains advertiser account ID, shown in the advertiser dashboard.',
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
 * Raw shape of the Get Programs response (used as the auth probe). Deliberately
 * permissive — only the existence of a 2xx matters for auth; the first
 * programme name, if present, is surfaced as a friendly identity label.
 * BLOCKED(verify): exact field names could not be confirmed against the doc
 * host (HTTP 403). Several plausible names are read defensively.
 */
interface WebgainsAdvProgramsProbe {
  programs?: Array<{ id?: string | number; name?: string; programName?: string }>;
  programmes?: Array<{ id?: string | number; name?: string; programName?: string }>;
  data?: Array<{ id?: string | number; name?: string; programName?: string }>;
  results?: Array<{ id?: string | number; name?: string; programName?: string }>;
}

/**
 * Verify Webgains advertiser credentials by calling the Get Programs endpoint
 * scoped to the advertiser account.
 *
 * A successful 2xx proves the Personal Access Token is valid; a 401/403 proves
 * it is not. Never throws — returns { ok: false } on any failure so callers
 * (including error handlers) do not loop.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let token: string;
  let accountId: string;
  try {
    token = requireApiKey('verifyAuth');
    accountId = requireAccountId('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    // BLOCKED(verify): the Get Programs path is taken as
    // `/advertisers/{accountId}/programs` pending live confirmation.
    const raw = await webgainsAdvRequest<WebgainsAdvProgramsProbe>({
      operation: 'verifyAuth',
      path: `/advertisers/${accountId}/programs`,
      token,
      query: { limit: 1 },
      resilience: DEFAULT_RESILIENCE,
    });

    const list = raw.programs ?? raw.programmes ?? raw.data ?? raw.results ?? [];
    const first = Array.isArray(list) ? list[0] : undefined;
    const programmeName = first?.name ?? first?.programName;
    const identity = programmeName
      ? `webgains-advertiser/account:${accountId} (e.g. ${programmeName})`
      : `webgains-advertiser/account:${accountId}`;

    log.debug({ identity }, 'webgains-advertiser verifyAuth succeeded');
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
      hint: 'Check WEBGAINS_ADVERTISER_API_KEY and WEBGAINS_ADVERTISER_ACCOUNT_ID in your config.',
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
 * WEBGAINS_ADVERTISER_API_KEY: format check (non-empty), then a live Get
 *   Programs call (once the Account ID is set) to prove the token works.
 * WEBGAINS_ADVERTISER_ACCOUNT_ID: format check (positive integer) — no API call.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'WEBGAINS_ADVERTISER_API_KEY') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'API key (Personal Access Token) must not be empty.',
        hint: 'Generate a Personal Access Token in the Webgains advertiser dashboard.',
      };
    }
    // Live check: inject the candidate token and call Get Programs.
    const prev = process.env['WEBGAINS_ADVERTISER_API_KEY'];
    process.env['WEBGAINS_ADVERTISER_API_KEY'] = value;
    try {
      if (!getCredential('WEBGAINS_ADVERTISER_ACCOUNT_ID')) {
        return {
          ok: true,
          message:
            'API key format OK; will validate against the API once the Account ID is set.',
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
        hint: 'Check WEBGAINS_ADVERTISER_API_KEY and WEBGAINS_ADVERTISER_ACCOUNT_ID. The token must be a valid, non-revoked Personal Access Token.',
      };
    } finally {
      if (prev === undefined) {
        delete process.env['WEBGAINS_ADVERTISER_API_KEY'];
      } else {
        process.env['WEBGAINS_ADVERTISER_API_KEY'] = prev;
      }
    }
  }

  if (field === 'WEBGAINS_ADVERTISER_ACCOUNT_ID') {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      return {
        ok: false,
        message: 'Webgains advertiser Account ID must be a positive integer.',
        hint: 'Find your numeric advertiser account ID in the Webgains advertiser dashboard.',
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Webgains advertiser.`,
    hint: 'Webgains advertiser expects WEBGAINS_ADVERTISER_API_KEY and WEBGAINS_ADVERTISER_ACCOUNT_ID.',
  };
}
