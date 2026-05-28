/**
 * Tradedoubler advertiser auth helpers.
 *
 * Auth model: token-in-query-string ("custom" in network.json terms).
 *
 * Tradedoubler issues one token per system (e.g. "REPORTS" for the reports
 * surface, "PRODUCTS" for the products surface). The token is obtained at:
 *   Account → Manage tokens  (UI label: "Settings" → "Management" → "Manage tokens")
 *
 * The token is passed as `token=<value>` in every request URL. There is no
 * Bearer header scheme for the legacy reports/management API surface.
 *
 * Organisation ID:
 *   Tradedoubler's advertiser reporting API requires the operator's
 *   ORGANISATION_ID (also called `organizationId` in API docs) to scope
 *   report queries to the correct advertiser account. Find it in the
 *   Tradedoubler UI at: Account → Organisation Settings → Organisation ID.
 *
 * Credential env vars:
 *   TRADEDOUBLER_ADV_TOKEN           — the 40-character hex API token
 *   TRADEDOUBLER_ADV_ORGANIZATION_ID — the numeric organisation ID
 *
 * Verification probe:
 *   GET https://reports.tradedoubler.com/pan/aReport3Key.action
 *       ?reportName=aAffiliateMyProgramsReport&token={TOKEN}&format=XML&columns=programId
 *   This is the lightest call that requires a valid token AND organisation
 *   context to return meaningful rows. A 200 with XML content = ok.
 *   A 200 with text/html = rejected token (Tradedoubler returns the login
 *   page instead of XML when credentials fail).
 *
 * References (verified from public docs and community implementations):
 *   https://dev.tradedoubler.com/
 *   https://github.com/jongotlin/TradedoublerReportsWrapper
 *   https://github.com/wp-plugins/affiliate-power (apis/tradedoubler.php)
 */

import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { requireCredential } from '../../shared/config.js';
import type { CredentialValidationResult } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('tradedoubler-advertiser.auth');

export const SLUG = 'tradedoubler-advertiser';

export const REPORTS_BASE = 'https://reports.tradedoubler.com';

export interface TradedoublerAdvCredentials {
  token: string;
  organizationId: string;
}

/** Read both credentials from env, or throw a config_error envelope. */
export function getCredentials(operation: string): TradedoublerAdvCredentials {
  const token = requireCredential('TRADEDOUBLER_ADV_TOKEN', {
    network: SLUG,
    operation,
    hint:
      'Obtain your Tradedoubler API token at: Account → Manage tokens. ' +
      'Choose the "REPORTS" system token (a 40-character hex string). ' +
      'Set TRADEDOUBLER_ADV_TOKEN in ~/.affiliate-mcp/.env.',
  });
  const organizationId = requireCredential('TRADEDOUBLER_ADV_ORGANIZATION_ID', {
    network: SLUG,
    operation,
    hint:
      'Find your Organisation ID in the Tradedoubler UI at: ' +
      'Account → Organisation Settings. It is a numeric identifier. ' +
      'Set TRADEDOUBLER_ADV_ORGANIZATION_ID in ~/.affiliate-mcp/.env.',
  });
  return { token, organizationId };
}

/**
 * Verify auth by probing the lightest reports endpoint.
 *
 * Tradedoubler returns HTTP 200 regardless of auth status — a rejected token
 * causes the response content-type to be text/html (the login page) rather
 * than application/xml. We check the response body for XML markers.
 */
export async function verifyAuth(): Promise<
  { ok: true; identity?: string } | { ok: false; reason: string }
> {
  let token: string;
  let organizationId: string;
  try {
    ({ token, organizationId } = getCredentials('verifyAuth'));
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message };
    }
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }

  try {
    const url = buildTokenUrl(`${REPORTS_BASE}/pan/aReport3Key.action`, token, {
      reportName: 'aAffiliateMyProgramsReport',
      format: 'XML',
      columns: 'programId',
      organizationId,
    });

    const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/xml, text/xml' } });
    const body = await res.text();

    if (!res.ok) {
      return {
        ok: false,
        reason: `Tradedoubler verifyAuth returned HTTP ${res.status}: ${body.slice(0, 200)}`,
      };
    }

    // Tradedoubler returns 200 + HTML login page on bad credentials.
    if (isHtmlResponse(body)) {
      return {
        ok: false,
        reason:
          'Tradedoubler rejected the token (returned HTML login page instead of XML). ' +
          'Check TRADEDOUBLER_ADV_TOKEN is the REPORTS-system token.',
      };
    }

    log.debug({ organizationId }, 'tradedoubler-advertiser auth ok');
    return { ok: true, identity: `tradedoubler-advertiser/org/${organizationId}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `Tradedoubler verifyAuth network error: ${msg}` };
  }
}

/**
 * Per-field live validation called by the setup wizard.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'TRADEDOUBLER_ADV_TOKEN') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Tradedoubler API token is required.',
        hint:
          'Go to Account → Manage tokens in the Tradedoubler UI. ' +
          'Copy the token listed under the "REPORTS" system.',
      };
    }
    // Tradedoubler tokens are 40-character hex strings (SHA-1).
    if (!/^[0-9a-fA-F]{40}$/.test(value.trim())) {
      return {
        ok: false,
        message:
          'Tradedoubler API token looks malformed — expected a 40-character hex string.',
        hint:
          'The token should look like: a1b2c3d4e5f6... (40 hex characters). ' +
          'Copy it exactly from Account → Manage tokens.',
      };
    }
    return { ok: true };
  }

  if (field === 'TRADEDOUBLER_ADV_ORGANIZATION_ID') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Tradedoubler Organisation ID is required.',
        hint:
          'Find it at Account → Organisation Settings in the Tradedoubler dashboard. ' +
          'It is a numeric identifier.',
      };
    }
    if (!/^\d+$/.test(value.trim())) {
      return {
        ok: false,
        message: 'Tradedoubler Organisation ID must be a numeric value.',
        hint: 'The Organisation ID contains only digits (e.g. 123456).',
      };
    }
    // Attempt a live probe if the token is already in env.
    const existingToken = process.env['TRADEDOUBLER_ADV_TOKEN'];
    if (existingToken) {
      const prev = process.env['TRADEDOUBLER_ADV_ORGANIZATION_ID'];
      process.env['TRADEDOUBLER_ADV_ORGANIZATION_ID'] = value;
      try {
        const result = await verifyAuth();
        if (result.ok) {
          return {
            ok: true,
            message: `Organisation ID verified. Identity: ${result.identity ?? 'ok'}.`,
          };
        }
        return { ok: false, message: result.reason };
      } finally {
        if (prev === undefined) {
          delete process.env['TRADEDOUBLER_ADV_ORGANIZATION_ID'];
        } else {
          process.env['TRADEDOUBLER_ADV_ORGANIZATION_ID'] = prev;
        }
      }
    }
    return {
      ok: true,
      message: 'Organisation ID format accepted; live validation runs after the token is set.',
    };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Tradedoubler advertiser.`,
    hint:
      'Tradedoubler advertiser expects TRADEDOUBLER_ADV_TOKEN and ' +
      'TRADEDOUBLER_ADV_ORGANIZATION_ID.',
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a URL with the token injected as a query parameter, plus any extra
 * params. Tradedoubler's classic API uses token-in-query rather than headers.
 *
 * The `buildErrorEnvelope` import is kept for future use in error paths inside
 * this module's helpers.
 */
export function buildTokenUrl(
  base: string,
  token: string,
  params: Record<string, string | number | undefined> = {},
): string {
  const url = new URL(base);
  url.searchParams.set('token', token);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    url.searchParams.set(k, String(v));
  }
  return url.toString();
}

/**
 * True when the response body looks like an HTML page rather than XML.
 * Tradedoubler returns the login page (HTML) when the token is invalid.
 */
export function isHtmlResponse(body: string): boolean {
  const trimmed = body.trimStart().toLowerCase();
  return trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html');
}

// Silence lint — buildErrorEnvelope is used only in future error paths.
void buildErrorEnvelope;
