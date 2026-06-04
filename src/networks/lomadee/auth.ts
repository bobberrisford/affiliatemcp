/**
 * Lomadee auth + credential validation.
 *
 * Lomadee uses a `custom` auth model with two distinct credential families:
 *
 *  1. App-token + sourceId — used by the offers and deeplink APIs. Both are
 *     carried in the request URL. The app-token is self-serve from the affiliate
 *     panel ("Credenciais de API" → "Gerar Token"); the sourceId identifies the
 *     publisher channel the link/offer is attributed to.
 *       Source: https://developer.socialsoul.com.vc/lab/tutoriais/afiliados/pra-que-serve-o-app-token-e-como-criar.html
 *
 *  2. A report token — used ONLY by the sales-report API ("Consulte suas
 *     vendas"). It is minted from the publisher's account e-mail and password
 *     via the createToken endpoint, then passed alongside the publisherId:
 *       GET /api/lomadee/createToken/?user={email}&password={password}
 *       GET /api/lomadee/reportTransaction?publisherId={publisherId}&token={token}
 *       Source: https://developer.socialsoul.com.vc/afiliados/relatorios/recursos/consulte-suas-vendas/
 *
 * --- Report-token cache --------------------------------------------------------
 *
 * This is the ONLY module-level mutable state allowed in this adapter folder.
 * The report token is reused across calls; createToken does not document an
 * explicit lifetime, so we cache for a conservative 10 minutes and re-mint on
 * expiry. `forceRefresh` is used by the credential validator so freshly-entered
 * credentials are tested against the live endpoint.
 *
 * --- verifyAuth ----------------------------------------------------------------
 *
 * verifyAuth proves the app-token + sourceId work by minting a deeplink for a
 * known URL (the cheapest identity-revealing call available; offers requires a
 * keyword and the report API needs the separate report credentials). A non-2xx
 * or an error status code returns { ok: false } — verifyAuth never throws,
 * because it is called by error handlers.
 */

import { lomadeeJsonRequest } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('lomadee.auth');

const SLUG = 'lomadee';

/** A neutral URL used to prove the app-token + sourceId can mint a deeplink. */
const VERIFY_PROBE_URL = 'https://www.lomadee.com/';

// ---------------------------------------------------------------------------
// Report-token cache — the only module-level mutable state in this folder.
// ---------------------------------------------------------------------------

interface ReportTokenCache {
  token: string;
  expiresAt: number; // ms since epoch
}

let reportTokenCache: ReportTokenCache | null = null;

/** Conservative lifetime for a minted report token (10 minutes). */
const REPORT_TOKEN_TTL_MS = 10 * 60 * 1000;

interface CreateTokenResponse {
  status?: number | string;
  token?: string;
  message?: string;
}

/**
 * Return a valid report token, minting a fresh one from the createToken endpoint
 * if the cache is empty or expired. The token is derived from the publisher's
 * account e-mail (LOMADEE_REPORT_USER) and password (LOMADEE_REPORT_PASSWORD).
 *
 * `forceRefresh: true` bypasses the cache — used during credential validation.
 */
export async function getReportToken(opts?: { forceRefresh?: boolean }): Promise<string> {
  if (!opts?.forceRefresh && reportTokenCache && reportTokenCache.expiresAt > Date.now()) {
    return reportTokenCache.token;
  }

  const user = requireCredential('LOMADEE_REPORT_USER', {
    network: SLUG,
    operation: 'getReportToken',
    hint: 'Set LOMADEE_REPORT_USER to your Lomadee/SocialSoul account e-mail in ~/.affiliate-mcp/.env.',
  });
  const password = requireCredential('LOMADEE_REPORT_PASSWORD', {
    network: SLUG,
    operation: 'getReportToken',
    hint: 'Set LOMADEE_REPORT_PASSWORD to your Lomadee/SocialSoul account password in ~/.affiliate-mcp/.env.',
  });

  const res = await lomadeeJsonRequest<CreateTokenResponse>({
    operation: 'getReportToken',
    path: '/api/lomadee/createToken/',
    query: { user, password },
    resilience: DEFAULT_RESILIENCE,
  });

  if (!res.token) {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'auth_error',
        network: SLUG,
        operation: 'getReportToken',
        networkErrorBody: JSON.stringify(res),
        message: 'Lomadee createToken returned no token field.',
        hint: 'Check LOMADEE_REPORT_USER and LOMADEE_REPORT_PASSWORD are the credentials you use to sign in to Lomadee.',
      }),
    );
  }

  reportTokenCache = { token: res.token, expiresAt: Date.now() + REPORT_TOKEN_TTL_MS };
  log.debug({ expiresAt: new Date(reportTokenCache.expiresAt).toISOString() }, 'report token cache updated');
  return reportTokenCache.token;
}

/** Test-only: reset the report-token cache so fresh credentials are exercised. */
export function _resetReportTokenCache(): void {
  reportTokenCache = null;
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

interface CreateLinksResponse {
  status?: { code?: number | string; message?: string } | number | string;
  links?: Array<{ id?: string | number; link?: string; redirectLink?: string }>;
  requestStatus?: { code?: number | string };
}

/**
 * Verify Lomadee credentials by minting a deeplink with the configured
 * app-token + sourceId.
 *
 * Why createLinks specifically: it is the cheapest identity-revealing call that
 * exercises both the app-token and the sourceId. The offers API requires a
 * keyword and the report API uses entirely separate credentials, so neither is
 * a clean auth probe for the primary (app-token) credential pair.
 *
 * Never throws — returns { ok: false } on any failure so callers (including
 * error handlers) do not loop.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let appToken: string;
  let sourceId: string;
  try {
    appToken = requireCredential('LOMADEE_APP_TOKEN', { network: SLUG, operation: 'verifyAuth' });
    sourceId = requireCredential('LOMADEE_SOURCE_ID', { network: SLUG, operation: 'verifyAuth' });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    const res = await lomadeeJsonRequest<CreateLinksResponse>({
      operation: 'verifyAuth',
      path: `/service/createLinks/lomadee/${encodeURIComponent(appToken)}/`,
      query: { sourceId, link1: VERIFY_PROBE_URL },
      resilience: DEFAULT_RESILIENCE,
    });

    // Lomadee reports a per-request status code in the body even on HTTP 200.
    // A populated links array is the positive signal; otherwise treat as failure.
    const linked = Array.isArray(res.links) && res.links.length > 0 && !!res.links[0]?.link;
    if (!linked) {
      const envelope = buildErrorEnvelope({
        type: 'auth_error',
        network: SLUG,
        operation: 'verifyAuth',
        networkErrorBody: JSON.stringify(res),
        message: 'Lomadee createLinks returned no usable link; the app-token or sourceId may be invalid.',
        hint: 'Confirm LOMADEE_APP_TOKEN and LOMADEE_SOURCE_ID from the affiliate panel → Credenciais de API.',
      });
      return { ok: false, reason: envelope.message, envelope };
    }

    const identity = `lomadee/source:${sourceId} (app-token:${appToken.slice(0, 6)}…)`;
    log.debug({ identity }, 'lomadee verifyAuth succeeded');
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
      hint: 'Check LOMADEE_APP_TOKEN and LOMADEE_SOURCE_ID in your config.',
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
 * LOMADEE_APP_TOKEN: format check only (non-empty) — validating it live also
 * needs the sourceId, so the live check is deferred to the sourceId step.
 *
 * LOMADEE_SOURCE_ID: performs a live createLinks probe with the configured
 * app-token, surfacing the upstream failure if the pair is invalid.
 *
 * LOMADEE_PUBLISHER_ID: format check (positive integer) — no API call needed.
 *
 * LOMADEE_REPORT_USER / LOMADEE_REPORT_PASSWORD: non-empty format checks. The
 * report credentials are validated together via a live createToken probe when
 * the password is entered.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'LOMADEE_APP_TOKEN') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'App-token must not be empty.',
        hint: 'Copy the token from the Lomadee affiliate panel → Credenciais de API → Gerar Token.',
      };
    }
    return {
      ok: true,
      message: 'App-token format OK; will validate against the API after the source ID is entered.',
    };
  }

  if (field === 'LOMADEE_SOURCE_ID') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Source ID must not be empty.',
        hint: 'Find or generate your sourceId in the Lomadee affiliate panel.',
      };
    }
    const prevSource = process.env['LOMADEE_SOURCE_ID'];
    process.env['LOMADEE_SOURCE_ID'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return {
          ok: true,
          message: result.identity ?? 'Credentials verified against the Lomadee deeplink endpoint.',
        };
      }
      return {
        ok: false,
        message: result.reason,
        hint: 'Check LOMADEE_APP_TOKEN and LOMADEE_SOURCE_ID. Both come from the affiliate panel → Credenciais de API.',
      };
    } finally {
      if (prevSource === undefined) delete process.env['LOMADEE_SOURCE_ID'];
      else process.env['LOMADEE_SOURCE_ID'] = prevSource;
    }
  }

  if (field === 'LOMADEE_PUBLISHER_ID') {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      return {
        ok: false,
        message: 'Lomadee Publisher ID must be a positive integer.',
        hint: 'Find your Publisher ID in the Lomadee affiliate panel under your account details.',
      };
    }
    return { ok: true };
  }

  if (field === 'LOMADEE_REPORT_USER') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Report user (account e-mail) must not be empty.',
        hint: 'This is the e-mail you use to sign in to Lomadee/SocialSoul.',
      };
    }
    return {
      ok: true,
      message: 'Report user format OK; will validate together with the password.',
    };
  }

  if (field === 'LOMADEE_REPORT_PASSWORD') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Report password must not be empty.',
        hint: 'This is the password you use to sign in to Lomadee/SocialSoul.',
      };
    }
    const prevPassword = process.env['LOMADEE_REPORT_PASSWORD'];
    process.env['LOMADEE_REPORT_PASSWORD'] = value;
    try {
      _resetReportTokenCache();
      await getReportToken({ forceRefresh: true });
      return { ok: true, message: 'Report credentials verified against the Lomadee createToken endpoint.' };
    } catch (err) {
      const reason = err instanceof NetworkError ? err.envelope.message : err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        message: reason,
        hint: 'Check LOMADEE_REPORT_USER and LOMADEE_REPORT_PASSWORD match your Lomadee sign-in.',
      };
    } finally {
      if (prevPassword === undefined) delete process.env['LOMADEE_REPORT_PASSWORD'];
      else process.env['LOMADEE_REPORT_PASSWORD'] = prevPassword;
      _resetReportTokenCache();
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Lomadee.`,
    hint: 'Lomadee expects LOMADEE_APP_TOKEN, LOMADEE_SOURCE_ID, LOMADEE_PUBLISHER_ID, LOMADEE_REPORT_USER, and LOMADEE_REPORT_PASSWORD.',
  };
}
