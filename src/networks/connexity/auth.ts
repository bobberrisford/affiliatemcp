/**
 * Connexity auth + credential validation.
 *
 * Connexity authenticates publisher API calls with two static credentials read
 * from the publisher portal:
 *   - `CONNEXITY_PUBLISHER_ID` — the numeric publisher ID.
 *   - `CONNEXITY_API_KEY` — a long-lived API key (no auto-rotation, so no
 *     refresh flow is required for v0.1).
 *
 * Both are sent as QUERY parameters on every request (see `client.ts`); there
 * is no `Authorization` header and no OAuth handshake.
 *
 * --- verifyAuth strategy ----------------------------------------------------
 *
 * The cheapest identity-revealing call is a tightly-scoped Get Earnings Report:
 * a single-day window returns a small JSON object echoing `publisherId`, which
 * confirms both credentials are valid (a bad key or ID returns a 4xx). We do
 * NOT have a dedicated `/me` endpoint, so this report doubles as the auth
 * probe.
 *
 * Docs:
 *   - https://pubresources.connexity.com/hc/en-us/articles/24602346033053-Publisher-API-Reference
 *
 * Future contributors: keep `verifyAuth` cheap. The wizard calls it during
 * interactive setup; latency here is user-visible. The single-day earnings
 * window keeps the payload small.
 */

import { connexityRequest } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('connexity.auth');

/**
 * The minimal shape we read off Connexity's Get Earnings Report response. We do
 * not over-specify it — the adapter transformers read keys defensively.
 */
interface ConnexityEarningsEnvelope {
  publisherId?: number | string;
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

/** Format a Date as Connexity's `YYYY-MM-DD` date parameter. */
function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Verify the Connexity credentials by requesting a single-day earnings report.
 *
 * On success we echo back the publisher ID as the identity. A bad key or ID
 * surfaces as a 4xx from the reporting host and we return `ok: false` with the
 * verbatim reason — we never throw from here, because verifyAuth is itself
 * called by error handlers and throwing would loop.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let publisherId: string;
  let apiKey: string;
  try {
    publisherId = requireCredential('CONNEXITY_PUBLISHER_ID', {
      network: 'connexity',
      operation: 'verifyAuth',
      hint: 'Find your publisher ID in the Connexity publisher portal under Account → API Access.',
    });
    apiKey = requireCredential('CONNEXITY_API_KEY', {
      network: 'connexity',
      operation: 'verifyAuth',
      hint: 'Generate an API key in the Connexity publisher portal under Account → API Access.',
    });
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    const today = new Date();
    const response = await connexityRequest<ConnexityEarningsEnvelope>({
      operation: 'verifyAuth',
      path: '/api/reporting/earnings',
      publisherId,
      apiKey,
      query: { startDate: ymd(today), endDate: ymd(today) },
      resilience: DEFAULT_RESILIENCE,
    });

    const echoed = response?.publisherId !== undefined ? String(response.publisherId) : publisherId;
    log.debug({ publisherId: echoed }, 'connexity verifyAuth succeeded');

    return { ok: true, identity: `connexity/${echoed}` };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: 'connexity',
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * Behaviour:
 *   - `CONNEXITY_PUBLISHER_ID`: format check (positive integer). We do not call
 *     the API here because the API also needs the key, which may not be entered
 *     yet — the live check happens when the key is validated.
 *   - `CONNEXITY_API_KEY`: writes the candidate into `process.env`, runs
 *     `verifyAuth()` (which needs both fields), restores the previous value.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'CONNEXITY_PUBLISHER_ID') {
    if (!/^\d+$/.test(value) || Number(value) <= 0) {
      return {
        ok: false,
        message: 'Connexity publisher ID must be a positive integer.',
        hint: 'Find it in the publisher portal under Account → API Access.',
      };
    }
    return { ok: true };
  }

  if (field === 'CONNEXITY_API_KEY') {
    const previous = process.env['CONNEXITY_API_KEY'];
    process.env['CONNEXITY_API_KEY'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'API key verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the API key in the Connexity publisher portal under Account → API Access. ' +
          'Confirm the publisher ID is also correct; both are required for a valid call.',
      };
    } finally {
      // Restore the previous value so a failed validation does not poison
      // subsequent operations in the same process (test isolation).
      if (previous === undefined) {
        delete process.env['CONNEXITY_API_KEY'];
      } else {
        process.env['CONNEXITY_API_KEY'] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Connexity.`,
    hint: 'Connexity expects CONNEXITY_PUBLISHER_ID and CONNEXITY_API_KEY.',
  };
}
