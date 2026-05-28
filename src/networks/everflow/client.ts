/**
 * Everflow HTTP client — the ONLY path Everflow adapter methods use for network I/O.
 *
 * Everflow uses a custom API key header (`X-Eflow-API-Key`) rather than a
 * standard Bearer token. All credential reading and header construction is
 * centralised here so the adapter stays readable and the resilience layer
 * applies uniformly to every outgoing call.
 *
 * Hard rules (mirrored from Awin client.ts — read that file for the full
 * rationale):
 *   1. Do NOT call `fetch` from `adapter.ts` or anywhere else in this folder.
 *   2. Do NOT add a second client that skips `withResilience`.
 *   3. On a non-2xx response, throw `HttpStatusError` so the resilience layer
 *      can apply its retry policy uniformly.
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

const log = createLogger('everflow.client');

/**
 * Everflow REST API base URL.
 *
 * All affiliate-side endpoints live under /v1/affiliates/. Network-side
 * (admin) endpoints use /v1/networks/ but are not used by this adapter.
 */
export const EVERFLOW_BASE_URL = 'https://api.eflow.team';

export interface EverflowRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to `EVERFLOW_BASE_URL`. */
  path: string;
  /** API key. Passed in from auth helpers. */
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
 * Issue a single Everflow API request under the resilience policy.
 *
 * Auth: Everflow uses `X-Eflow-API-Key: <key>` (custom header, not Bearer).
 * The key is passed in from the adapter so credential reads happen once per
 * operation in the adapter, not deep inside the HTTP layer.
 */
export async function everflowRequest<T>(input: EverflowRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'everflow', operation: input.operation };

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

      log.debug({ url, method: init.method, operation: input.operation }, 'everflow request');

      const res = await fetch(url, init);

      // Read the body once. We need it both for success (decode JSON) and for
      // failure (surface the raw text on the envelope). Everflow error bodies
      // are typically JSON-shaped but may be plain text on CDN errors.
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Everflow ${input.operation} ${init.method ?? 'GET'} ${input.path} → HTTP ${res.status}`,
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
            network: 'everflow',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Everflow ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Build the Everflow auth headers.
 *
 * Everflow uses a custom header `X-Eflow-API-Key` rather than the HTTP
 * `Authorization: Bearer ...` convention. The `Accept` and `Content-Type`
 * headers are set to `application/json` unconditionally because every
 * Everflow endpoint returns JSON.
 */
function buildHeaders(apiKey: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Eflow-API-Key': apiKey,
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
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, EVERFLOW_BASE_URL);
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
