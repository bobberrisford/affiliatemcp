/**
 * Optimise Media (OMG Network API) HTTP client — the ONLY path adapter methods
 * use for network I/O.
 *
 * The OMG Network API authenticates with a non-standard `apikey` request header
 * (not `Authorization: Bearer`). The key is minted by creating a Service
 * Account in the Insights Dashboard. All credential reading and header
 * construction is centralised here so the adapter stays readable and the
 * resilience layer applies uniformly to every outgoing call.
 *
 * Reference: src/networks/everflow/client.ts (custom API-key header) and
 * src/networks/awin/client.ts (full rationale for the one-client rule).
 *
 * Hard rules for future contributors:
 *   1. Do NOT call `fetch` from `adapter.ts` or anywhere else in this folder.
 *   2. Do NOT add a second client that skips `withResilience`.
 *   3. On a non-2xx response, throw `HttpStatusError` so the resilience layer
 *      can apply its retry policy uniformly (never retry 4xx except 429).
 *   4. Preserve the raw response body verbatim on failure so principle 4.1
 *      (verbatim `networkErrorBody`) holds.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('optimise-media.client');

const SLUG = 'optimise-media';

/**
 * The OMG Network API root.
 *
 * The published API is described against OpenAPI 3.0 and served from the
 * Optimise `api.` host. Centralised here so a test harness or a future
 * `OPTIMISE_MEDIA_BASE_URL` override can swap it without touching adapter code.
 */
export const OPTIMISE_MEDIA_BASE_URL = 'https://api.optimisemedia.com';

export interface OptimiseMediaRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to `OPTIMISE_MEDIA_BASE_URL`. */
  path: string;
  /** API key. Passed in from auth helpers so credential reads happen once per op. */
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
 * Issue a single OMG Network API request under the resilience policy.
 *
 * Auth: the OMG Network API uses the custom `apikey` header (not Bearer). We
 * request `application/json` explicitly because the documented surface can
 * serve XML for some resources; forcing JSON keeps the transformer simple.
 */
export async function optimiseMediaRequest<T>(input: OptimiseMediaRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };

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

      log.debug({ url, method: init.method, operation: input.operation }, 'optimise-media request');

      const res = await fetch(url, init);

      // Read the body once. We need it both for success (decode JSON) and for
      // failure (surface the raw text on the envelope). Optimise error bodies
      // are typically JSON-shaped but may be plain text or XML on gateway
      // errors — preserving the raw text means the user sees the real content.
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Optimise Media ${input.operation} ${init.method ?? 'GET'} ${input.path} → HTTP ${res.status}`,
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
            network: SLUG,
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Optimise Media ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Build the OMG Network API auth headers.
 *
 * The API uses the custom `apikey` header rather than the
 * `Authorization: Bearer ...` convention. `Accept: application/json` is set
 * unconditionally to force JSON over the (also documented) XML representation.
 */
function buildHeaders(apiKey: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    apikey: apiKey,
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
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, OPTIMISE_MEDIA_BASE_URL);
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
