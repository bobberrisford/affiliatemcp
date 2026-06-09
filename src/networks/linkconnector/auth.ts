/**
 * LinkConnector auth + credential validation.
 *
 * LinkConnector authenticates with a single long-lived API key the publisher
 * generates in the dashboard (Tools > API > Create API Key). The key is passed
 * as the `Key` query parameter on every call (see `client.ts`). There is no
 * OAuth flow and no token rotation, so we treat the key as a static secret
 * loaded from `LINKCONNECTOR_API_KEY`. If LinkConnector ever introduces
 * rotation, this is the only file that needs to change.
 *
 * No `derivedValues` pattern here: LinkConnector does not expose a separate
 * account/publisher identifier that subsequent calls need — the API key alone
 * scopes every request to the publisher's account. Contrast with Awin, where
 * the token yields a publisher ID via `/accounts`.
 *
 * Why `verifyAuth` calls the Transaction report with a one-day window: there is
 * no dedicated "who am I" endpoint in the documented surface. The Transaction
 * report (`getReportTransaction`) is the cheapest authenticated call that
 * cleanly distinguishes a valid key (HTTP 200, possibly zero rows) from an
 * invalid one (non-2xx). Keep this cheap — the wizard calls it interactively.
 */

import { linkconnectorRequest } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('linkconnector.auth');

export const LINKCONNECTOR_SLUG = 'linkconnector';

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
 * Read the API key, throwing a `config_error` envelope when it is missing.
 */
export function requireApiKey(operation: string): string {
  return requireCredential('LINKCONNECTOR_API_KEY', {
    network: LINKCONNECTOR_SLUG,
    operation,
    hint: 'Generate an API key in the LinkConnector dashboard -> Tools -> API -> Create API Key.',
  });
}

/**
 * Format a Date as `YYYY-MM-DD` — LinkConnector's report date parameters are
 * day-granular. Centralised so the adapter and auth agree on the format.
 */
function dateOnly(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Verify the API key with a minimal Transaction report call.
 *
 * On success we return `ok: true` with a generic identity string — the API
 * does not return a human-readable account name, so we cannot surface one. On
 * any failure we return `ok: false` with the verbatim upstream reason; we never
 * throw, because `verifyAuth` is itself invoked by error handlers and throwing
 * here would loop.
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

  const now = new Date();
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  try {
    await linkconnectorRequest<unknown>({
      operation: 'verifyAuth',
      func: 'getReportTransaction',
      apiKey,
      query: {
        StartDate: dateOnly(yesterday),
        EndDate: dateOnly(now),
        RowStart: 0,
        RowsPerCall: 1,
      },
      resilience: DEFAULT_RESILIENCE,
    });

    log.debug('linkconnector verifyAuth succeeded');
    // LinkConnector exposes no account name on this surface; the key itself is
    // the identity. We avoid inventing one.
    return { ok: true, identity: 'linkconnector (API key verified)' };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: LINKCONNECTOR_SLUG,
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * `LINKCONNECTOR_API_KEY` is validated by writing the candidate into the
 * environment, running `verifyAuth()`, and restoring the previous value so a
 * failed validation does not poison subsequent operations in the same process.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'LINKCONNECTOR_API_KEY') {
    if (value.trim() === '') {
      return {
        ok: false,
        message: 'The LinkConnector API key must not be empty.',
        hint: 'Generate one at Tools -> API -> Create API Key in the LinkConnector dashboard.',
      };
    }

    const previous = process.env['LINKCONNECTOR_API_KEY'];
    process.env['LINKCONNECTOR_API_KEY'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'API key verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'Check the key at the LinkConnector dashboard -> Tools -> API. The key may be revoked or ' +
          'copied with leading/trailing whitespace.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['LINKCONNECTOR_API_KEY'];
      } else {
        process.env['LINKCONNECTOR_API_KEY'] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for LinkConnector.`,
    hint: 'LinkConnector expects LINKCONNECTOR_API_KEY.',
  };
}
