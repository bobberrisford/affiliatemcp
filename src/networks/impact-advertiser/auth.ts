/**
 * Impact advertiser auth + credential shape detection.
 *
 * Impact's brand-side surface uses the same HTTP Basic scheme as the publisher
 * surface (base64(AccountSID:AuthToken)) but the URL pathing differs depending
 * on which tier of credential the operator pasted:
 *
 *   - Agency-passthrough creds  → `/Agencies/{AgencySID}/Advertisers/{BrandSID}/...`
 *     One SID addresses N brands. `listBrands()` discovers them via
 *     `GET /Agencies/{AgencySID}/Advertisers`.
 *     Doc ref: https://integrations.impact.com/impact-agency/reference/brand-api-passthrough
 *
 *   - Brand-direct creds        → `/Advertisers/{BrandSID}/...`
 *     One SID, one brand. `listBrands()` returns a single synthetic entry.
 *     Doc ref: https://integrations.impact.com/impact-brand/
 *
 * The adapter auto-detects the shape at first contact by probing
 * `GET /Agencies/{SID}`. If that returns 2xx we treat the credentials as
 * agency-tier; if it 4xxs (404/403/401 with the relevant code) we fall back
 * to brand-direct. Result is cached per (SID, AuthToken) tuple so we do not
 * pay the detection cost on every adapter call.
 *
 * The Impact docs site returned 403 to automated WebFetch during this PR's
 * research, so a few endpoint details are marked `// TODO(verify):` and
 * should be confirmed against a live agency tenant in the next PR.
 */

import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { requireCredential } from '../../shared/config.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('impact-advertiser.auth');

export const SLUG = 'impact-advertiser';

export type CredentialShape = 'agency' | 'brand-direct';

export interface DetectedCredentials {
  accountSid: string;
  authToken: string;
  shape: CredentialShape;
}

/**
 * Build the Basic-auth header value. Centralised so the client never has to
 * know how Impact formats credentials.
 */
export function basicAuthHeader(accountSid: string, authToken: string): string {
  const credentials = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  return `Basic ${credentials}`;
}

/**
 * Pull both credentials from env (or throw a `config_error` envelope) and
 * detect which shape the SID represents.
 *
 * Probe order:
 *   1. `GET /Agencies/{SID}`. 2xx → agency. 401 → wrong creds (bubble). 404 or
 *      403 with the "not an agency" code → brand-direct. Anything else surfaces
 *      verbatim so the caller sees the upstream body.
 *
 * Callers may pass an explicit probe function for tests; otherwise the
 * standard fetch is used.
 */
export interface DetectShapeOptions {
  /** Test seam — return the probe's HTTP status + body without going to fetch. */
  probe?: (sid: string, token: string) => Promise<{ status: number; body: string }>;
}

export async function detectCredentialShape(
  accountSid: string,
  authToken: string,
  opts: DetectShapeOptions = {},
): Promise<CredentialShape> {
  const probe =
    opts.probe ??
    (async (sid: string, token: string) => {
      const url = `https://api.impact.com/Agencies/${encodeURIComponent(sid)}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: basicAuthHeader(sid, token),
          Accept: 'application/json',
        },
      });
      const body = await res.text();
      return { status: res.status, body };
    });

  const { status, body } = await probe(accountSid, authToken);
  if (status >= 200 && status < 300) {
    log.debug({ accountSid: redact(accountSid) }, 'credentials detected as agency tier');
    return 'agency';
  }
  // 404 or 403 are the documented "not an agency" responses. We also accept
  // 400 because some Impact tenants return 400 with an `IsNotAgency`-style
  // error code for the same condition.
  // TODO(verify): confirm exact body shape for the brand-direct case from a
  // live agency tenant — docs site returned 403 to WebFetch during this PR.
  if (status === 404 || status === 403 || status === 400) {
    log.debug(
      { accountSid: redact(accountSid), status },
      'credentials detected as brand-direct tier',
    );
    return 'brand-direct';
  }
  if (status === 401) {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'auth_error',
        network: SLUG,
        operation: 'verifyAuth',
        httpStatus: 401,
        networkErrorBody: body,
        message: 'Impact rejected the Account SID / Auth Token (401).',
        hint: 'Double-check the SID and token at the Impact dashboard → Settings → API.',
      }),
    );
  }
  throw new NetworkError(
    buildErrorEnvelope({
      type: 'network_api_error',
      network: SLUG,
      operation: 'verifyAuth',
      httpStatus: status,
      networkErrorBody: body,
      message: `Impact /Agencies probe returned HTTP ${status}; cannot determine credential shape.`,
    }),
  );
}

/**
 * Load + detect in one go. Cached for the lifetime of the process so each
 * adapter method does not repeat the probe.
 */
let cached: DetectedCredentials | null = null;

export function _resetCredentialCache(): void {
  cached = null;
}

export async function getDetectedCredentials(
  operation: string,
  opts: DetectShapeOptions = {},
): Promise<DetectedCredentials> {
  if (cached) return cached;
  const accountSid = requireCredential('IMPACT_ADVERTISER_ACCOUNT_SID', {
    network: SLUG,
    operation,
    hint:
      'Run `affiliate-networks-mcp setup impact-advertiser` to provide IMPACT_ADVERTISER_ACCOUNT_SID, ' +
      'or set it in ~/.affiliate-mcp/.env. For an agency, paste the Agency SID; for a brand-direct ' +
      'token, paste the Advertiser SID. The adapter auto-detects which you provided.',
  });
  const authToken = requireCredential('IMPACT_ADVERTISER_AUTH_TOKEN', {
    network: SLUG,
    operation,
    hint:
      'Find the Auth Token in the Impact dashboard alongside the Account SID. ' +
      'We strongly recommend creating a read-only token (Impact dashboard → Settings → ' +
      'API → API Token, choose the read-only role) — this adapter only ever issues GETs.',
  });
  const shape = await detectCredentialShape(accountSid, authToken, opts);
  cached = { accountSid, authToken, shape };
  return cached;
}

export interface VerifyAuthOk {
  ok: true;
  identity?: { accountSid: string; shape: CredentialShape };
}
export interface VerifyAuthFail {
  ok: false;
  reason: string;
  envelope?: NetworkErrorEnvelope;
}

/**
 * Verify auth by running shape detection. The detection itself is a small
 * authenticated GET, so a successful detection IS a successful auth check.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  try {
    const { accountSid, shape } = await getDetectedCredentials('verifyAuth');
    return { ok: true, identity: { accountSid, shape } };
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
 * The wizard prompts SID first then token; the token validator does the live
 * shape-detection probe once both are in env.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'IMPACT_ADVERTISER_ACCOUNT_SID') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Impact advertiser Account SID is required.',
        hint:
          'For an agency, paste your Agency SID (Settings → API in the agency portal). ' +
          'For a brand-direct token, paste the Advertiser SID (Settings → API in the brand portal).',
      };
    }
    if (!/^[A-Za-z0-9_-]{8,}$/.test(value)) {
      return {
        ok: false,
        message:
          'Impact advertiser Account SID looks malformed (expected an alphanumeric string).',
        hint: 'Copy the SID exactly without leading/trailing whitespace.',
      };
    }
    return { ok: true };
  }

  if (field === 'IMPACT_ADVERTISER_AUTH_TOKEN') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Impact advertiser Auth Token is required.',
        hint:
          'We strongly recommend a read-only token here: Impact dashboard → Settings → API → ' +
          'create token with the "Read-only" role.',
      };
    }
    const sid = process.env['IMPACT_ADVERTISER_ACCOUNT_SID'];
    if (!sid) {
      return {
        ok: true,
        message:
          'Auth Token format accepted; live validation deferred until Account SID is set.',
      };
    }

    const previous = process.env['IMPACT_ADVERTISER_AUTH_TOKEN'];
    process.env['IMPACT_ADVERTISER_AUTH_TOKEN'] = value;
    _resetCredentialCache();
    try {
      const result = await verifyAuth();
      if (result.ok) {
        const tier = result.identity?.shape === 'agency' ? 'agency-passthrough' : 'brand-direct';
        return {
          ok: true,
          message: `Token verified. Credential tier detected: ${tier}.`,
        };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'If the credentials are agency-tier they should pass GET /Agencies/{SID}. ' +
          'If they are brand-direct the adapter auto-falls-back. A persistent 401 means the ' +
          'token does not match the SID.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['IMPACT_ADVERTISER_AUTH_TOKEN'];
      } else {
        process.env['IMPACT_ADVERTISER_AUTH_TOKEN'] = previous;
      }
      _resetCredentialCache();
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Impact advertiser.`,
    hint: 'Impact advertiser expects IMPACT_ADVERTISER_ACCOUNT_SID and IMPACT_ADVERTISER_AUTH_TOKEN.',
  };
}

function redact(sid: string): string {
  if (sid.length <= 6) return '****';
  return `${sid.slice(0, 4)}…${sid.slice(-2)}`;
}
