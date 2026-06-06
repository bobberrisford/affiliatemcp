/**
 * ShopMy HTTP client — the ONLY path ShopMy adapter methods use for network I/O.
 *
 * ShopMy's Brand Partner API authenticates with a long-lived partner token. The
 * public documentation (https://docs.shopmy.us/reference/getting-started-with-your-api)
 * describes the partner token as a static secret supplied per brand; the exact
 * request header is not stated verbatim in the publicly indexable pages, so we
 * default to a custom `x-api-key` header here. This is the assumption flagged in
 * `network.json` `known_limitations` and must be confirmed against a live brand
 * partner account before the adapter is promoted past `experimental`. If ShopMy
 * turns out to expect `Authorization: Bearer <token>`, this is the single file
 * that changes.
 *
 * Hard rules (mirrored from Awin/Everflow client.ts — read those for the full
 * rationale):
 *   1. Do NOT call `fetch` from `adapter.ts` or anywhere else in this folder.
 *   2. Do NOT add a second client that skips `withResilience`.
 *   3. On a non-2xx response, throw `HttpStatusError` so the resilience layer
 *      applies its retry policy uniformly.
 *   4. Preserve the raw response body verbatim on failure.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('shopmy.client');

/**
 * ShopMy API base URL. The Brand Partner endpoints live under `/v1/Partners/`
 * (e.g. `/v1/Partners/OrderReport`). Centralised so a test harness or sandbox
 * environment can override it without touching adapter code.
 */
export const SHOPMY_BASE_URL = 'https://api.shopmy.us';

/** The custom header name ShopMy's partner token is sent under. */
export const SHOPMY_AUTH_HEADER = 'x-api-key';

export interface ShopmyRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to `SHOPMY_BASE_URL`. */
  path: string;
  /** Partner token. Passed in so callers fetch from `requireCredential` once. */
  token: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Query string parameters. Values with `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Body for POST/PUT requests; serialised as JSON. */
  body?: unknown;
  /** Resilience knobs for this specific call. Required so each op picks its own profile. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single ShopMy API request under the resilience policy.
 *
 * Why the response is typed as `T` with no runtime validation: ShopMy's order
 * report payload is weakly documented in the public reference, so we read keys
 * defensively in the adapter's transformers and preserve the verbatim payload
 * under `rawNetworkData` rather than rejecting unexpected shapes here.
 */
export async function shopmyRequest<T>(input: ShopmyRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'shopmy', operation: input.operation };

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

      log.debug({ url, method: init.method, operation: input.operation }, 'shopmy request');

      const res = await fetch(url, init);

      // Read the body once. We need it both for success (decode JSON) and for
      // failure (surface the raw text on the envelope).
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `ShopMy ${input.operation} ${init.method ?? 'GET'} ${input.path} → HTTP ${res.status}`,
        );
      }

      if (rawBody.trim() === '') {
        return {} as T;
      }

      try {
        return JSON.parse(rawBody) as T;
      } catch (err) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: 'shopmy',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `ShopMy ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Build the ShopMy auth headers.
 *
 * ShopMy's partner token is sent under the custom `x-api-key` header (see the
 * file-level note on why this is an assumption). `Accept` is always
 * `application/json`.
 */
function buildHeaders(token: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    [SHOPMY_AUTH_HEADER]: token,
    Accept: 'application/json',
  };
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

/**
 * Compose the full URL with query string, using `URL` + `URLSearchParams`.
 */
function buildUrl(pathname: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, SHOPMY_BASE_URL);
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
