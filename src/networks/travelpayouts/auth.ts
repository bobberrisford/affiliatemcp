/**
 * Travelpayouts auth + credential validation.
 *
 * Travelpayouts uses a single, long-lived personal API token (the partner
 * generates it from Profile -> API token; it does not auto-rotate). That means:
 *   - No refresh flow is required for v0.1 — we treat the token as a static
 *     secret loaded from `TRAVELPAYOUTS_ACCESS_TOKEN`. If Travelpayouts moves
 *     to rotating tokens, this is the only file that needs to change.
 *   - The token is sent as the custom `X-Access-Token` header (see client.ts),
 *     not as an HTTP Bearer token.
 *   - The auth-check endpoint is `GET /finance/v2/get_user_balance`, the
 *     cheapest authenticated call: it returns one small object (balances per
 *     currency) and rejects a bad token with a clean 4xx rather than a 5xx.
 *
 * Why there is no `derivedValues` here (unlike Awin, which derives a publisher
 * ID): the personal token is the only identifier Travelpayouts needs for the
 * finance endpoints. There is no separate account/publisher id to look up, so
 * the single-credential setup needs no derivation step.
 *
 * Future contributors: keep `verifyAuth` cheap. The wizard calls it during
 * interactive setup; latency here is user-visible. `get_user_balance` is small
 * and fast, so a 30s timeout is plenty.
 */

import { travelpayoutsRequest } from './client.js';
import { requireCredential } from '../../shared/config.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type {
  CredentialValidationResult,
  NetworkErrorEnvelope,
} from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('travelpayouts.auth');

export const TRAVELPAYOUTS_SLUG = 'travelpayouts';

/**
 * The minimal shape we read off `GET /finance/v2/get_user_balance`.
 *
 * The response is `{ "balance": { "usd": "1794.34", "eur": "1524.08",
 * "rub": "134661.93" } }` — balances are decimal strings in whole currency
 * units (not minor units). We do not over-specify the shape; transformers
 * tolerate missing keys defensively (see client.ts for the rationale).
 */
interface TravelpayoutsBalanceResponse {
  balance?: Record<string, string | number>;
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

/**
 * Read the configured access token via `requireCredential` so a missing value
 * surfaces as a `config_error` envelope rather than an empty header.
 */
export function requireAccessToken(operation: string): string {
  return requireCredential('TRAVELPAYOUTS_ACCESS_TOKEN', {
    network: TRAVELPAYOUTS_SLUG,
    operation,
    hint: 'Generate a token in the Travelpayouts dashboard -> Profile -> API token, then set TRAVELPAYOUTS_ACCESS_TOKEN.',
  });
}

/**
 * Verify the Travelpayouts token by hitting `GET /finance/v2/get_user_balance`.
 *
 * Why this endpoint specifically:
 *   - It is the smallest authenticated call in the publisher-side surface
 *     (returns one balances object).
 *   - It rejects an invalid token with a clean 4xx (not a generic 5xx), so the
 *     error envelope is actionable.
 *
 * On success we report the balances we observed as the identity string so the
 * wizard shows the user something recognisable. We never throw from here —
 * verifyAuth is called by error handlers and throwing would loop.
 */
export async function verifyAuth(): Promise<VerifyAuthOk | VerifyAuthFail> {
  let token: string;
  try {
    token = requireAccessToken('verifyAuth');
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    throw err;
  }

  try {
    const response = await travelpayoutsRequest<TravelpayoutsBalanceResponse>({
      operation: 'verifyAuth',
      path: '/finance/v2/get_user_balance',
      token,
      resilience: DEFAULT_RESILIENCE,
    });

    const balances = response.balance ?? {};
    const currencies = Object.keys(balances);
    log.debug({ currencies: currencies.length }, 'travelpayouts verifyAuth succeeded');

    const identity =
      currencies.length > 0
        ? `travelpayouts (balances: ${currencies.map((c) => c.toUpperCase()).join(', ')})`
        : 'travelpayouts (token valid; no balances reported)';

    return { ok: true, identity };
  } catch (err) {
    if (err instanceof NetworkError) {
      return { ok: false, reason: err.envelope.message, envelope: err.envelope };
    }
    const envelope = buildErrorEnvelope({
      type: 'network_api_error',
      network: TRAVELPAYOUTS_SLUG,
      operation: 'verifyAuth',
      message: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: envelope.message, envelope };
  }
}

/**
 * Validate a single credential field at wizard-entry time.
 *
 * `TRAVELPAYOUTS_ACCESS_TOKEN` is the only field. We write the candidate into
 * `process.env`, run `verifyAuth()`, and restore the previous value so a failed
 * validation does not poison subsequent operations in the same process (test
 * isolation).
 */
export async function validateCredential(
  field: string,
  value: string,
): Promise<CredentialValidationResult> {
  if (field === 'TRAVELPAYOUTS_ACCESS_TOKEN') {
    const previous = process.env['TRAVELPAYOUTS_ACCESS_TOKEN'];
    process.env['TRAVELPAYOUTS_ACCESS_TOKEN'] = value;
    try {
      const result = await verifyAuth();
      if (result.ok) {
        return { ok: true, message: result.identity ?? 'token verified' };
      }
      return {
        ok: false,
        message: result.reason,
        hint: 'Check the token at Travelpayouts -> Profile -> API token. The token may be revoked or copied with leading/trailing whitespace.',
      };
    } finally {
      if (previous === undefined) {
        delete process.env['TRAVELPAYOUTS_ACCESS_TOKEN'];
      } else {
        process.env['TRAVELPAYOUTS_ACCESS_TOKEN'] = previous;
      }
    }
  }

  return {
    ok: false,
    message: `Unknown credential field "${field}" for Travelpayouts.`,
    hint: 'Travelpayouts expects TRAVELPAYOUTS_ACCESS_TOKEN (required).',
  };
}
