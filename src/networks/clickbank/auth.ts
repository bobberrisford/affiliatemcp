/**
 * ClickBank auth + credential validation.
 *
 * ClickBank authenticates with TWO static keys sent together in one header:
 *
 *   Authorization: <DEVELOPER-KEY>:<CLERK-KEY>
 *
 *   - The DEVELOPER key is account-wide. It is created once in the master
 *     account under Settings → API Management.
 *   - The CLERK key is per-user (the "API clerk"). You create a user, grant it
 *     API permissions, and copy its clerk key.
 *
 * Both are long-lived secrets — there is no refresh flow. If a key is
 * compromised it must be revoked and regenerated from the same screen. That
 * means this is the only file that would need to change if ClickBank ever
 * moves to rotating credentials.
 *
 * --- Account nickname -------------------------------------------------------
 *
 * ClickBank scopes a publisher's activity to an account NICKNAME (the login
 * handle, e.g. `myacct`). The nickname is the affiliate identifier baked into
 * every HopLink (`?affiliate=<nickname>`). We hold it in CLICKBANK_NICKNAME so
 * `generateTrackingLink` can build deterministic HopLinks and `verifyAuth` can
 * report a human-readable identity. It is NOT used as a credential — the keys
 * authenticate; the nickname identifies.
 *
 * --- Auth check -------------------------------------------------------------
 *
 * `verifyAuth()` calls `GET /quickstats/count`, the cheapest authenticated
 * ClickBank endpoint (it returns aggregate sale/refund/chargeback counts, not
 * a row set). A valid key pair returns 200; an invalid pair returns 401.
 *
 * We cannot derive the keys or the nickname from the response — ClickBank does
 * not echo account identity on quickstats — so there is no `derivedValues`
 * flow here. The nickname is prompted directly in `setup.ts`.
 */

import { clickbankRequest } from './client.js';
import { requireCredential, getCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('clickbank.auth');

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
 * Read the developer + clerk key pair, throwing a `config_error` envelope when
 * either is missing. Returned as a tuple so callers fetch both once.
 */
export function requireKeys(operation: string): { developerKey: string; clerkKey: string } {
  const developerKey = requireCredential('CLICKBANK_DEV_KEY', {
    network: 'clickbank',
    operation,
    hint:
      'Create a developer key in your ClickBank master account under Settings → API Management, ' +
      'then set CLICKBANK_DEV_KEY in ~/.affiliate-mcp/.env.',
  });
  const clerkKey = requireCredential('CLICKBANK_CLERK_KEY', {
    network: 'clickbank',
    operation,
    hint:
      'Create an API user (clerk) under Settings → API Management and copy its clerk key, ' +
      'then set CLICKBANK_CLERK_KEY in ~/.affiliate-mcp/.env.',
  });
  return { developerKey, clerkKey };
}

/**
 * Verify the ClickBank key pair by calling `GET /quickstats/count`.
 *
 * Why this endpoint:
 *   - It is the cheapest authenticated ClickBank call — it returns aggregate
 *     counters, not a paginated row set, so the payload is tiny and fast.
 *   - It exercises the exact `Authorization: DEV:CLERK` header that every
 *     other operation depends on, so a pass here means the keys are good.
 *   - A bad key pair returns a clean 401, so the error envelope is actionable.
 *
 * On success we report the configured nickname (if any) as the identity. The
 * keys do not contain the nickname; it is held separately in
 * CLICKBANK_NICKNAME.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let keys: { developerKey: string; clerkKey: string };
  try {
    keys = requireKeys('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    await clickbankRequest<unknown>({
      operation: 'verifyAuth',
      path: '/quickstats/count',
      developerKey: keys.developerKey,
      clerkKey: keys.clerkKey,
      resilience: DEFAULT_RESILIENCE,
    });

    const nickname = getCredential('CLICKBANK_NICKNAME');
    const identity = nickname ? `clickbank/${nickname}` : 'clickbank (authenticated)';

    log.debug({ identity }, 'clickbank verifyAuth succeeded');
    return { ok: true, identity };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: 'clickbank',
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * Why the key fields validate together rather than in isolation: ClickBank's
 * auth header needs BOTH keys, so a single key cannot be checked against the
 * API on its own. We write the candidate into `process.env`, run `verifyAuth()`
 * (which needs the other key already entered), then restore the previous value.
 * When the second key is the one being validated, the live check passes; when
 * only the first has been entered, `verifyAuth` reports a clear missing-credential
 * message and the wizard re-checks after the second key.
 *
 * CLICKBANK_NICKNAME is format-validated only — ClickBank nicknames are short
 * lowercase alphanumeric handles; we do not have a cheap endpoint that confirms
 * a nickname belongs to the authenticated account.
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'CLICKBANK_DEV_KEY' || field === 'CLICKBANK_CLERK_KEY') {
    const previous = process.env[field];
    process.env[field] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'key pair verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint:
          'ClickBank needs BOTH the developer key and the clerk key. Confirm both under ' +
          'Settings → API Management. If you have only entered one so far, the wizard will ' +
          're-check once the second key is provided. Keys must be copied without surrounding whitespace.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env[field];
      } else {
        process.env[field] = previous;
      }
    }
  }

  if (field === 'CLICKBANK_NICKNAME') {
    // ClickBank account nicknames are short alphanumeric handles (the login
    // name). We allow lowercase letters and digits, 3–24 chars — the documented
    // shape. We do not API-verify it (no cheap nickname-confirming endpoint).
    if (!/^[a-z0-9]{3,24}$/.test(value)) {
      return {
        ok: false,
        message: 'ClickBank nickname must be 3–24 lowercase letters or digits.',
        hint: 'Your nickname is your ClickBank account login handle (e.g. "myacct").',
      };
    }
    return { ok: true };
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for ClickBank.`,
    hint:
      'ClickBank expects CLICKBANK_DEV_KEY (required), CLICKBANK_CLERK_KEY (required), ' +
      'and CLICKBANK_NICKNAME (required, for HopLinks and identity).',
  };
}
