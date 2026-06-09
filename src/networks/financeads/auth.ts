/**
 * financeAds auth + credential validation.
 *
 * financeAds uses a static API key plus the publisher's numeric user ID. Both
 * are issued from the financeAds platform (and, for some accounts, only after
 * the publisher requests access to the "Leads & Sales API" from financeAds
 * support). There is no OAuth flow and no token rotation — the key is a
 * long-lived secret. That means:
 *   - No refresh logic is required; we treat the key as static.
 *   - Both credentials are read from env via `requireCredential`:
 *       FINANCEADS_API_KEY  — the API key.
 *       FINANCEADS_USER_ID  — the numeric publisher / user ID.
 *   - Unlike Awin (which derives its publisher ID from the auth response),
 *     the financeAds user ID is shown to the publisher in the dashboard
 *     ("top right of the page") and is required for the auth call itself, so
 *     there is no `derivedValues` flow — the user supplies both fields.
 *
 * --- UNVERIFIED SHAPE WARNING -----------------------------------------------
 *
 * The cheapest identity-revealing endpoint could not be confirmed against a
 * live account; the documentation is dashboard-gated. `verifyAuth` probes the
 * statistics endpoint with a one-day window as the smallest authenticated
 * call. A future contributor with live access should confirm the endpoint and
 * the 200/401 behaviour.
 *
 * --- Error handling ---------------------------------------------------------
 *
 * Every failure path returns a structured result carrying an envelope. We never
 * throw a bare Error from this file: `verifyAuth` is called by error handlers,
 * and throwing here would loop.
 */

import { financeadsRequest } from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('financeads.auth');

const NETWORK = 'financeads';

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
 * Read the two financeAds credentials, throwing a config_error envelope when
 * either is missing. Used by the adapter operations as a single entry point so
 * credential reads happen once per call.
 */
export function requireCredentials(operation: string): { apiKey: string; userId: string } {
  const apiKey = requireCredential('FINANCEADS_API_KEY', {
    network: NETWORK,
    operation,
    hint:
      'Find your API key in the financeAds platform. If it is not shown, contact ' +
      'financeAds support and request access to the Leads & Sales API.',
  });
  const userId = requireCredential('FINANCEADS_USER_ID', {
    network: NETWORK,
    operation,
    hint:
      'Your numeric financeAds user (publisher) ID is shown at the top right of ' +
      'the platform once you are signed in.',
  });
  return { apiKey, userId };
}

/**
 * Verify the financeAds credentials with the cheapest authenticated call.
 *
 * UNVERIFIED: the statistics endpoint path (`/api/statistic`) and parameter
 * shape are not confirmed against a live account. We send a one-day window to
 * keep the payload tiny. A valid key/user pair is expected to return 200; an
 * invalid pair is expected to return 401/403.
 *
 * The financeAds user ID is supplied by the user (not derivable from the
 * response), so on success the identity is built from that ID directly.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let creds: { apiKey: string; userId: string };
  try {
    creds = requireCredentials('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  // A narrow date window keeps the probe cheap. financeAds reporting is keyed
  // on EUR amounts; the window value is only used to bound the response size.
  const today = new Date().toISOString().slice(0, 10);

  try {
    await financeadsRequest<unknown>({
      operation: 'verifyAuth',
      // TODO(verify): confirm the statistics endpoint path against a live account.
      path: '/api/statistic',
      apiKey: creds.apiKey,
      userId: creds.userId,
      query: { date_start: today, date_end: today },
      resilience: DEFAULT_RESILIENCE,
    });

    const identity = `financeads/user/${creds.userId}`;
    log.debug({ identity }, 'financeads verifyAuth succeeded');
    return { ok: true, identity };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: NETWORK,
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * FINANCEADS_API_KEY:
 *   Cannot be validated in isolation — the auth call also needs the user ID.
 *   We write the candidate key into env, run verifyAuth() (which reads the
 *   already-entered user ID), then restore the previous value. If the user ID
 *   is not yet set, we defer with a friendly message rather than failing.
 *
 * FINANCEADS_USER_ID:
 *   Format check only (positive integer). A live check would need the API key,
 *   which may not be entered yet.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'FINANCEADS_API_KEY') {
    if (!getCredential('FINANCEADS_USER_ID')) {
      // The auth call needs both credentials; defer until the user ID exists.
      return {
        ok: true,
        message: 'API key recorded; will validate once the user ID is entered.',
      };
    }
    const previous = process.env['FINANCEADS_API_KEY'];
    process.env['FINANCEADS_API_KEY'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'API key verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the API key in the financeAds platform. If reporting access is not ' +
          'enabled, contact financeAds support to request the Leads & Sales API.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['FINANCEADS_API_KEY'];
      } else {
        process.env['FINANCEADS_API_KEY'] = previous;
      }
    }
  }

  if (field === 'FINANCEADS_USER_ID') {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      return {
        ok: false,
        message: 'financeAds user ID must be a positive integer.',
        hint: 'Your user ID is shown at the top right of the financeAds platform after sign-in.',
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for financeAds.`,
    hint:
      'financeAds expects FINANCEADS_API_KEY (required) and FINANCEADS_USER_ID (required).',
  };
}
