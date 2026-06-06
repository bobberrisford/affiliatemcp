/**
 * Howl HTTP client — the ONLY path Howl adapter methods use for network I/O.
 *
 * Howl (formerly Narrativ) authenticates with a custom Authorization scheme:
 * `Authorization: NRTV-API-KEY <key>` (verified against
 * https://docs.narrativ.com/auth.html). It is NOT a standard bearer token, so
 * the header is constructed here rather than via the generic `Bearer` prefix.
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

const log = createLogger('howl.client');

/**
 * The Howl API root. Centralised so a test harness or staging environment can
 * override it without touching adapter code. Hard-coded for v0.1.
 *
 * Verified against https://docs.narrativ.com/auth.html — every documented
 * endpoint lives under `/api/v1/`.
 */
export const HOWL_BASE_URL = 'https://api.narrativ.com';

export interface HowlRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to `HOWL_BASE_URL`. */
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
 * Issue a single Howl API request under the resilience policy.
 *
 * Why the response is typed as `T` with no runtime validation: Howl's REST
 * surface drifts and the adapter's transformers read keys defensively. Hard
 * schemas break first; the transformers preserve the original under
 * `rawNetworkData` so the user always sees what Howl actually sent.
 */
export async function howlRequest<T>(input: HowlRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'howl', operation: input.operation };

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

      log.debug({ url, method: init.method, operation: input.operation }, 'howl request');

      const res = await fetch(url, init);

      // Read the body once. We need it both for success (decode JSON) and for
      // failure (surface the raw text on the envelope). Howl error bodies are
      // typically JSON-shaped but may be plain text on CDN errors.
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Howl ${input.operation} ${init.method ?? 'GET'} ${input.path} → HTTP ${res.status}`,
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
            network: 'howl',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Howl ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Build the Howl auth headers.
 *
 * Howl uses a custom Authorization scheme `NRTV-API-KEY <key>` rather than the
 * HTTP `Bearer` convention (https://docs.narrativ.com/auth.html). The `Accept`
 * header is set to `application/json` because every Howl endpoint returns JSON.
 */
function buildHeaders(apiKey: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `NRTV-API-KEY ${apiKey}`,
    Accept: 'application/json',
  };
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

/**
 * Compose the full URL with query string, using `URL` + `URLSearchParams` so
 * ISO timestamps and other reserved characters are encoded correctly.
 */
function buildUrl(pathname: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, HOWL_BASE_URL);
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
