/**
 * Adrecord HTTP client — the ONLY path Adrecord adapter methods use for network I/O.
 *
 * Adrecord (a Nordic / Swedish network) authenticates with a private API key
 * delivered via a custom `APIKEY` request header. The key is generated from the
 * affiliate account; it can also be passed as a GET/POST variable, but a header
 * keeps the secret out of URLs and logs, so that is what we use.
 *
 * Hard rules (mirrored from Awin client.ts — read that file for the full
 * rationale):
 *   1. Do NOT call `fetch` from `adapter.ts` or anywhere else in this folder.
 *   2. Do NOT add a second client that skips `withResilience`.
 *   3. On a non-2xx response, throw `HttpStatusError` so the resilience layer
 *      can apply its retry policy uniformly. Adrecord throttles at 30 requests
 *      per 30 seconds and returns an error once the limit is hit; that surfaces
 *      as the upstream status (typically 429) which the resilience layer
 *      retries with backoff.
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

const log = createLogger('adrecord.client');

/**
 * The Adrecord affiliate API root. All output is JSON. Centralised so a test
 * harness can override it without touching adapter code. Hard-coded for v0.1.
 */
export const ADRECORD_BASE_URL = 'https://api.v2.adrecord.com';

export interface AdrecordRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to `ADRECORD_BASE_URL`. */
  path: string;
  /** Private API key. Passed in so credential reads happen once per op in the adapter. */
  apiKey: string;
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
 * Issue a single Adrecord API request under the resilience policy.
 *
 * Auth: Adrecord uses a custom `APIKEY: <key>` header (not Bearer). The key is
 * passed in from the adapter so credential reads happen once per operation in
 * the adapter, not deep inside the HTTP layer.
 */
export async function adrecordRequest<T>(input: AdrecordRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'adrecord', operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input.path, input.query);
      const init: RequestInit = {
        method: input.method ?? 'GET',
        headers: buildHeaders(input.apiKey, input.body !== undefined),
      };
      if (input.body !== undefined) {
        init.body = JSON.stringify(input.body);
      }
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ url, method: init.method, operation: input.operation }, 'adrecord request');

      const res = await fetch(url, init);

      // Read the body once. We need it both for success (decode JSON) and for
      // failure (surface the raw text on the envelope). Adrecord error bodies
      // are JSON-shaped but may be plain text on CDN / throttle responses —
      // preserving the raw text means the user sees the actual content.
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Adrecord ${input.operation} ${init.method ?? 'GET'} ${input.path} → HTTP ${res.status}`,
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
            network: 'adrecord',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Adrecord ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Build the Adrecord auth headers.
 *
 * Adrecord uses a custom header `APIKEY` rather than `Authorization: Bearer`.
 * `Accept: application/json` is set unconditionally because every Adrecord
 * endpoint returns JSON.
 */
function buildHeaders(apiKey: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    APIKEY: apiKey,
    Accept: 'application/json',
  };
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

/**
 * Compose the full URL with query string, using `URL` + `URLSearchParams` so
 * date values and other query parameters are encoded correctly.
 */
function buildUrl(pathname: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, ADRECORD_BASE_URL);
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
