/**
 * eHUB HTTP client — the ONLY path eHUB adapter methods use for network I/O.
 *
 * Patterned on `src/networks/awin/client.ts`. The rationale for keeping all
 * `fetch` in one file is identical: the resilience layer (timeout, retry,
 * circuit breaker — see `src/shared/resilience.ts`) must wrap every outbound
 * call exactly once, and the HTTP↔domain seam is the most-mutated line when a
 * network's API drifts.
 *
 * eHUB specifics (verified against the public docs, June 2026):
 *   - Base URL: https://api.ehub.cz/v3
 *   - Auth: an `apiKey` *query parameter* (not a header). The eHUB docs note a
 *     plan to also accept the key in a request header, but the query-parameter
 *     form is the documented one, so we use it. This is why `authModel` is
 *     `custom` rather than `bearer`.
 *   - JSON by default. We set `Accept: application/json` because some eHUB
 *     endpoints can emit XML.
 *
 * Hard rules (same as Awin):
 *   1. Do NOT call `fetch` from `adapter.ts` or anywhere else in this folder.
 *   2. Do NOT add a second client that skips `withResilience`.
 *   3. On a non-2xx response, throw `HttpStatusError` so the resilience layer
 *      applies its retry policy uniformly (PRD §15.5).
 *   4. Preserve the raw response body verbatim on failure (`networkErrorBody`).
 *
 * Docs: https://ehub.docs.apiary.io/ and https://ehubv3.docs.apiary.io/
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('ehub.client');

/**
 * The eHUB API root. Centralised so a test harness or staging environment can
 * override it without touching adapter code. Hard-coded for v0.1.
 */
export const EHUB_BASE_URL = 'https://api.ehub.cz/v3';

export interface EhubRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to `EHUB_BASE_URL`. */
  path: string;
  /**
   * The eHUB API key. eHUB authenticates via an `apiKey` query parameter, so
   * the key is injected into the query string by `buildUrl` rather than into a
   * header. Passed in so callers fetch from `requireCredential` once.
   */
  apiKey: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Query string parameters. Values with `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Body for POST/PUT/PATCH requests; serialised as JSON. */
  body?: unknown;
  /** Resilience knobs for this specific call. Required so each op picks its own profile. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single eHUB API request under the resilience policy.
 *
 * Why the response is typed as `T` with no runtime validation: same reasoning
 * as Awin — over-specifying a schema here forces the client into "is this a
 * valid eHUB response?" decisions that belong in the adapter's transformers,
 * which can interpret missing fields with context. Transformers MUST tolerate
 * missing keys defensively.
 */
export async function ehubRequest<T>(input: EhubRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'ehub', operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input.path, input.apiKey, input.query);
      const init: RequestInit = {
        method: input.method ?? 'GET',
        headers: buildHeaders(input.body !== undefined),
      };
      if (input.body !== undefined) {
        init.body = JSON.stringify(input.body);
      }
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ method: init.method, operation: input.operation }, 'ehub request');

      const res = await fetch(url, init);

      // Read the body once: needed for success (decode JSON) and failure
      // (surface the raw text on the envelope). eHUB error bodies are JSON but
      // preserving the raw text means the user sees the actual content.
      const rawBody = await res.text();

      if (!res.ok) {
        // Throw HttpStatusError so the resilience layer applies its retry /
        // no-retry decision uniformly. Policy lives in resilience.ts.
        throw new HttpStatusError(
          res.status,
          rawBody,
          `eHUB ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
        );
      }

      if (rawBody.trim() === '') {
        return {} as T;
      }

      try {
        return JSON.parse(rawBody) as T;
      } catch (err) {
        // PRD §4.1: preserve the verbatim body even for 2xx-with-non-JSON.
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: 'ehub',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `eHUB ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Build request headers.
 *
 * eHUB does not authenticate via headers (the key is a query parameter), so the
 * only headers are `Accept` (force JSON; some endpoints can return XML) and
 * `Content-Type` when there is a body.
 */
function buildHeaders(hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

/**
 * Compose the full URL, injecting the `apiKey` query parameter alongside any
 * caller-supplied query values.
 *
 * We use `URL` + `URLSearchParams` rather than string concatenation because
 * eHUB query values include ISO dates and free-text filters that must be
 * URL-encoded.
 */
function buildUrl(
  pathname: string,
  apiKey: string,
  query?: Record<string, string | number | undefined>,
): string {
  const base = EHUB_BASE_URL.endsWith('/') ? EHUB_BASE_URL : `${EHUB_BASE_URL}/`;
  const url = new URL(pathname.startsWith('/') ? pathname.slice(1) : pathname, base);
  url.searchParams.set('apiKey', apiKey);
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
