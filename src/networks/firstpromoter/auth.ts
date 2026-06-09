/**
 * FirstPromoter auth + credential validation.
 *
 * FirstPromoter v2 uses two credentials, both required on every request:
 *   - FIRSTPROMOTER_API_KEY     → `Authorization: Bearer <key>`
 *   - FIRSTPROMOTER_ACCOUNT_ID  → `ACCOUNT-ID: <id>`
 * One key + account id pair scopes one FirstPromoter account (one merchant),
 * which is why this adapter is `single-brand`.
 *
 * No `derivedValues` flow: the account id is not derivable from the key, the
 * user copies both from the dashboard. `verifyAuth()` hits
 * `GET /api/v2/company/promoters?per_page=1` — the cheapest authenticated call
 * that returns 200 for a valid pair even with no promoters. Reference:
 * `src/networks/rewardful/auth.ts`.
 */

import { firstPromoterRequest, SLUG } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { CredentialValidationResult, NetworkErrorEnvelope } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('firstpromoter.auth');

export const API_KEY_ENV = 'FIRSTPROMOTER_API_KEY';
export const ACCOUNT_ID_ENV = 'FIRSTPROMOTER_ACCOUNT_ID';

export interface VerifyAuthOk {
  ok: true;
  identity?: string;
}

export interface VerifyAuthFail {
  ok: false;
  reason: string;
  envelope?: NetworkErrorEnvelope;
}

export function requireApiKey(operation: string): string {
  return requireCredential(API_KEY_ENV, {
    network: SLUG,
    operation,
    hint:
      'Find your API key in the FirstPromoter dashboard under Settings › Integrations › ' +
      'Manage API Keys, then set FIRSTPROMOTER_API_KEY (or run ' +
      '`affiliate-networks-mcp setup firstpromoter`).',
  });
}

export function requireAccountId(operation: string): string {
  return requireCredential(ACCOUNT_ID_ENV, {
    network: SLUG,
    operation,
    hint:
      'Your numeric account id is shown alongside the API key in FirstPromoter under ' +
      'Settings › Integrations › Manage API Keys. Set FIRSTPROMOTER_ACCOUNT_ID.',
  });
}

export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let apiKey: string;
  let accountId: string;
  try {
    apiKey = requireApiKey('verifyAuth');
    accountId = requireAccountId('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    await firstPromoterRequest<unknown>({
      operation: 'verifyAuth',
      path: '/promoters',
      apiKey,
      accountId,
      query: { per_page: 1 },
      resilience: DEFAULT_RESILIENCE,
    });
    log.debug('firstpromoter verifyAuth succeeded');
    return { ok: true, identity: `firstpromoter/account-${accountId}` };
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

export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === API_KEY_ENV) {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'FirstPromoter API key is required.',
        hint: 'Find it under Settings › Integrations › Manage API Keys.',
      };
    }
    // The key cannot be verified without the account id; if the account id is
    // not yet set, accept the format and re-validate once both are present.
    if (!process.env[ACCOUNT_ID_ENV] || process.env[ACCOUNT_ID_ENV]?.trim() === '') {
      return {
        ok: true,
        message: 'API key recorded; it is verified once the account id is entered.',
      };
    }
    return runVerify(API_KEY_ENV, value);
  }

  if (field === ACCOUNT_ID_ENV) {
    if (!value || value.trim() === '') {
      return {
        ok: false,
        message: 'FirstPromoter account id is required.',
        hint: 'It is shown alongside the API key under Settings › Integrations › Manage API Keys.',
      };
    }
    return runVerify(ACCOUNT_ID_ENV, value);
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for FirstPromoter.`,
    hint: 'FirstPromoter expects FIRSTPROMOTER_API_KEY and FIRSTPROMOTER_ACCOUNT_ID.',
  };
}

/**
 * Temporarily set `field` to `value` in the environment, run `verifyAuth`, then
 * restore the previous value. Lets the wizard live-check a credential as it is
 * entered without persisting it first.
 */
async function runVerify(field: string, value: string): Promise<CredentialValidationResult> {
  const previous = process.env[field];
  process.env[field] = value;
  try {
    const result = await verifyAuth();
    if (result.ok) {
      return { ok: true, message: result.identity ?? 'credentials verified' };
    }
    return {
      ok: false,
      message: result.reason,
      hint:
        'Check the API key and account id under Settings › Integrations › Manage API Keys. ' +
        'A key may be regenerated, or copied with leading/trailing whitespace.',
    };
  } finally {
    if (previous === undefined) {
      delete process.env[field];
    } else {
      process.env[field] = previous;
    }
  }
}
