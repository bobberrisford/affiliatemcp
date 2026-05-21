/**
 * Impact auth + credential validation.
 *
 * Impact uses HTTP Basic with two user-supplied values:
 *   - `IMPACT_ACCOUNT_SID` — the publisher's Account SID, ALSO the URL path
 *     prefix (`/Mediapartners/{AccountSID}/...`).
 *   - `IMPACT_AUTH_TOKEN`  — the Basic-auth password.
 *
 * No `derivedValues` flow applies here: both values are surfaced together on
 * the same dashboard screen (Settings → API → "Account SID and Auth Token"),
 * so neither can bootstrap the other. The wizard simply prompts for both.
 *
 * Why `verifyAuth()` uses `GET /Campaigns?PageSize=1`:
 *   - It is the smallest authenticated call in the Mediapartners surface that
 *     reliably returns 200 for a valid token even on an account with zero
 *     joined campaigns (Impact returns `{ Campaigns: [], "@page": ... }`).
 *   - `PageSize=1` keeps the payload minimal so wizard latency is low.
 *   - It exercises the same auth + path-prefix code path every other op uses,
 *     so a successful verifyAuth is a strong predictor that listProgrammes /
 *     listTransactions will at least connect.
 */

import { impactRequest } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('impact.auth');

export interface VerifyAuthOk {
  ok: true;
  identity?: { accountSid: string };
  /**
   * Empty by design — Impact's two credentials are both user-supplied. The
   * field is present so the call shape matches Awin/CJ.
   */
  derivedValues: Record<string, never>;
}

export interface VerifyAuthFail {
  ok: false;
  reason: string;
  envelope?: NetworkErrorEnvelope;
}

/**
 * Verify the Impact credentials by hitting `GET /Mediapartners/{SID}/Campaigns?PageSize=1`.
 *
 * On success returns `{ ok: true, identity: { accountSid }, derivedValues: {} }`.
 * On failure surfaces the network error envelope so the wizard can render the
 * verbatim Impact response body inline.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let accountSid: string;
  let authToken: string;
  try {
    accountSid = requireCredential('IMPACT_ACCOUNT_SID', {
      network: 'impact',
      operation: 'verifyAuth',
      hint:
        'Find your Account SID in the Impact publisher dashboard → Settings → ' +
        'API → "Account SID and Auth Token".',
    });
    authToken = requireCredential('IMPACT_AUTH_TOKEN', {
      network: 'impact',
      operation: 'verifyAuth',
      hint:
        'Find your Auth Token in the Impact publisher dashboard → Settings → ' +
        'API → "Account SID and Auth Token". The token is the Basic-auth password.',
    });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    await impactRequest<unknown>({
      operation: 'verifyAuth',
      path: '/Campaigns',
      accountSid,
      authToken,
      query: { PageSize: 1 },
      resilience: DEFAULT_RESILIENCE,
    });

    log.debug({ accountSid: redactSid(accountSid) }, 'impact verifyAuth succeeded');

    return {
      ok: true,
      identity: { accountSid },
      derivedValues: {},
    };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: 'impact',
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * - `IMPACT_ACCOUNT_SID`: format check only (non-empty; Impact SIDs are
 *   typically alphanumeric strings 16+ chars long). We do not call the API
 *   from this branch because doing so requires the token, and the wizard may
 *   prompt for these fields in either order.
 * - `IMPACT_AUTH_TOKEN`: writes the candidate into `process.env`, runs
 *   `verifyAuth()` (which requires both fields), restores the previous
 *   values. Requires `IMPACT_ACCOUNT_SID` to already be set; if not, returns
 *   a format-only check with a hint pointing the user back at the SID step.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'IMPACT_ACCOUNT_SID') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Impact Account SID is required.',
        hint: 'Settings → API → "Account SID and Auth Token" in the Impact publisher dashboard.',
      };
    }
    if (!/^[A-Za-z0-9_-]{8,}$/.test(value)) {
      return {
        ok: false,
        message: 'Impact Account SID looks malformed (expected an alphanumeric string).',
        hint: 'Copy the SID directly from the dashboard; avoid leading/trailing whitespace.',
      };
    }
    return { ok: true };
  }

  if (field === 'IMPACT_AUTH_TOKEN') {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'Impact Auth Token is required.',
        hint: 'Settings → API → "Account SID and Auth Token". The token is the Basic-auth password.',
      };
    }
    const sid = process.env['IMPACT_ACCOUNT_SID'];
    if (!sid) {
      // Without a SID we cannot make a live call. Surface a format-pass
      // result with a hint so the wizard can re-validate after the SID is set.
      return {
        ok: true,
        message: 'Auth Token format accepted; live validation deferred until Account SID is set.',
      };
    }

    const previous = process.env['IMPACT_AUTH_TOKEN'];
    process.env['IMPACT_AUTH_TOKEN'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return {
          ok: true,
          message: `Token verified for Account SID ${redactSid(sid)}.`,
        };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the token at Impact dashboard → Settings → API. The token may be revoked, expired, ' +
          'or paired with a different Account SID.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['IMPACT_AUTH_TOKEN'];
      } else {
        process.env['IMPACT_AUTH_TOKEN'] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Impact.`,
    hint: 'Impact expects IMPACT_ACCOUNT_SID and IMPACT_AUTH_TOKEN (both required).',
  };
}

function redactSid(sid: string): string {
  if (sid.length <= 6) return '****';
  return `${sid.slice(0, 4)}…${sid.slice(-2)}`;
}
