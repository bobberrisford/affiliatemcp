/**
 * Tradedoubler HTTP client — the ONLY path Tradedoubler adapter methods use for
 * network I/O.
 *
 * Tradedoubler's modern publisher API lives at https://connect.tradedoubler.com
 * and uses OAuth2 bearer tokens (passed in the `Authorization: Bearer {token}`
 * header). This is distinct from the older per-product token scheme used by
 * api.tradedoubler.com (Products, Vouchers, Claims) where tokens are passed as
 * a `?token=` query parameter. We target the newer connect.tradedoubler.com
 * surface for all publisher operations.
 *
 * Cardinal rules (mirrored from awin/client.ts):
 *   1. Do NOT call `fetch` from `adapter.ts` or anywhere else in this folder.
 *   2. Do NOT add a second client that skips `withResilience`.
 *   3. On a non-2xx response, throw `HttpStatusError`.
 *   4. Preserve the raw response body verbatim on failure (PRD principle 4.1).
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('tradedoubler.client');

/**
 * The Tradedoubler publisher API base URL (modern connect API).
 * Hard-coded for v0.1; override via TRADEDOUBLER_BASE_URL env var if needed
 * in future.
 */
export const TD_BASE_URL = 'https://connect.tradedoubler.com';

export interface TdRequestInput {
  /** Canonical operation name — used as breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to `TD_BASE_URL`. */
  path: string;
  /** Bearer token. Passed in so callers can fetch from `requireCredential` once. */
  token: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Query string parameters. Values with `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Body for POST/PUT requests; serialised as JSON. */
  body?: unknown;
  /** Resilience config for this call. */
  resilience: ResilienceConfig;
  /** Optional AbortSignal for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single Tradedoubler API request under the resilience policy.
 *
 * Response typing follows the same pattern as awin/client.ts: no runtime
 * schema validation — adapters MUST handle missing/unexpected fields defensively
 * and preserve the original under `rawNetworkData`.
 */
export async function tradedoublerRequest<T>(input: TdRequestInput): Promise<T> {
  const ctx: WithResilienceContext = {
    network: 'tradedoubler',
    operation: input.operation,
  };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input.path, input.query);
      const init: RequestInit = {
        method: input.method ?? 'GET',
        headers: buildHeaders(input.token, input.body !== undefined),
      };
      if (input.body !== undefined) {
        init.body = JSON.stringify(input.body);
      }
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug(
        { url, method: init.method, operation: input.operation },
        'tradedoubler request',
      );

      const res = await fetch(url, init);

      // Read the body once — needed for both success (JSON decode) and failure
      // (verbatim surface on the envelope per PRD principle 4.1).
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Tradedoubler ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
        );
      }

      // Empty body — return empty object; adapters detect missing fields.
      if (rawBody.trim() === '') {
        return {} as T;
      }

      try {
        return JSON.parse(rawBody) as T;
      } catch (err) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: 'tradedoubler',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Tradedoubler ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Build Authorization and content headers for the connect.tradedoubler.com API.
 *
 * Tradedoubler's connect API uses OAuth2 bearer tokens in the Authorization
 * header. The older api.tradedoubler.com surface uses `?token=` query params —
 * that pattern is NOT used here.
 */
function buildHeaders(token: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

/**
 * Compose the full URL with query string.
 *
 * Uses `URL` + `URLSearchParams` to correctly encode all special characters
 * in Tradedoubler's date and filter parameters.
 */
function buildUrl(
  pathname: string,
  query?: Record<string, string | number | undefined>,
): string {
  const url = new URL(
    pathname.startsWith('/') ? pathname : `/${pathname}`,
    TD_BASE_URL,
  );
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

// Re-export so adapter code can throw HttpStatusError without importing from
// shared/resilience directly.
export { HttpStatusError };
