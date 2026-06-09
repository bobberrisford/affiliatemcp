/**
 * Affilae HTTP client — the ONLY path Affilae adapter methods use for network I/O.
 *
 * Affilae's current API (the REST surface documented at
 * https://rest.affilae.com/reference) uses a standard bearer token:
 * `Authorization: Bearer <token>`. The token is generated from the dashboard
 * "API Tokens" menu. All credential reading happens in the adapter/auth layer;
 * the token is passed in here so this file stays a thin transport.
 *
 * Hard rules (mirrored from Awin client.ts — read that file for the full
 * rationale):
 *   1. Do NOT call `fetch` from `adapter.ts` or anywhere else in this folder.
 *   2. Do NOT add a second client that skips `withResilience`.
 *   3. On a non-2xx response, throw `HttpStatusError` so the resilience layer
 *      applies its retry policy uniformly (never retry 4xx other than 429;
 *      Affilae rate-limits at 100 req/s and returns 429).
 *   4. Preserve the raw response body verbatim on failure (principle 4.1).
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('affilae.client');

/**
 * The Affilae API root.
 *
 * Centralised so a test harness or staging environment can override it without
 * touching adapter code. Hard-coded for v0.1. Publisher endpoints live under
 * `/publisher/` (advertiser endpoints under `/advertiser/`, unused here).
 */
export const AFFILAE_BASE_URL = 'https://rest.affilae.com';

export interface AffilaeRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to `AFFILAE_BASE_URL`. */
  path: string;
  /** Bearer token. Passed in so callers fetch from `requireCredential` once. */
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
 * Issue a single Affilae API request under the resilience policy.
 *
 * The response is typed as `T` with no runtime validation: Affilae's public
 * field documentation is thin (the reference site gates fetchers), so the
 * adapter transformers read keys defensively and preserve the verbatim payload
 * under `rawNetworkData`. Over-specifying a schema here would break first on
 * any upstream drift.
 */
export async function affilaeRequest<T>(input: AffilaeRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'affilae', operation: input.operation };

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

      log.debug({ url, method: init.method, operation: input.operation }, 'affilae request');

      const res = await fetch(url, init);

      // Read the body once. We need it both for success (decode JSON) and for
      // failure (surface the raw text on the envelope). Affilae error bodies are
      // JSON-shaped but may be plain text/HTML when fronted by a CDN.
      const rawBody = await res.text();

      if (!res.ok) {
        // Throw HttpStatusError so the resilience layer applies its retry/no-retry
        // decision uniformly. Policy lives in resilience.ts, not here.
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Affilae ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
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
            network: 'affilae',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Affilae ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Build the Authorization headers.
 *
 * Affilae uses the standard `Authorization: Bearer <token>` scheme. `Accept`
 * is set to JSON because every documented endpoint returns JSON.
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
 * Compose the full URL with query string, using `URL` + `URLSearchParams`.
 *
 * Affilae date params are UTC ISO-8601 timestamps which contain characters
 * (`:`, `+`) that MUST be URL-encoded — `URLSearchParams` does this correctly
 * where hand-rolled concatenation would not.
 */
function buildUrl(pathname: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, AFFILAE_BASE_URL);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

// Re-export so adapter code can throw HttpStatusError without importing from
// shared/resilience directly. The boundary stays clean: "everything network
// goes through ./client".
export { HttpStatusError };
