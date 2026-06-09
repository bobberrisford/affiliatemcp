/**
 * Travelpayouts HTTP client — the ONLY path Travelpayouts adapter methods use
 * for network I/O.
 *
 * Travelpayouts authenticates with a custom `X-Access-Token` header carrying
 * the partner's personal API token (Profile -> API token). It is not an HTTP
 * Bearer token, so we model it the same way the Everflow client models its
 * `X-Eflow-API-Key` header. Centralising credential reading and header
 * construction here keeps the adapter readable and applies the resilience
 * layer uniformly to every outgoing call.
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

const log = createLogger('travelpayouts.client');

/**
 * Travelpayouts API root.
 *
 * Every documented Travelpayouts API surface (statistics, finance, travel
 * data) lives under this host. The finance/v2 endpoints (`get_user_balance`,
 * `get_user_actions_affecting_balance`) are the publisher-side calls this
 * adapter uses; the statistics/v1 and v1/v2 travel-data endpoints share the
 * same host and auth.
 *
 * Centralised so a test harness can override it without touching adapter code.
 * Hard-coded for v0.1.
 */
export const TRAVELPAYOUTS_BASE_URL = 'https://api.travelpayouts.com';

export interface TravelpayoutsRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to `TRAVELPAYOUTS_BASE_URL`. */
  path: string;
  /** Personal API token. Passed in from auth helpers so reads happen once per op. */
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
 * Issue a single Travelpayouts API request under the resilience policy.
 *
 * Auth: Travelpayouts uses `X-Access-Token: <token>` (custom header, not
 * Bearer). The token is passed in from the adapter so credential reads happen
 * once per operation in the adapter, not deep inside the HTTP layer.
 *
 * Why the response is typed as `T` with no runtime validation: the
 * Travelpayouts surface drifts and is weakly documented; over-specifying a Zod
 * schema would force the client into the business of "is this valid?", which
 * belongs in the adapter's transformer (where missing fields can be
 * interpreted with context). The cost is that transformers MUST tolerate
 * missing keys defensively.
 */
export async function travelpayoutsRequest<T>(input: TravelpayoutsRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'travelpayouts', operation: input.operation };

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

      log.debug({ url, method: init.method, operation: input.operation }, 'travelpayouts request');

      const res = await fetch(url, init);

      // Read the body once. We need it both for success (decode JSON) and for
      // failure (surface the raw text on the envelope). Travelpayouts error
      // bodies are typically JSON-shaped but may be plain text on CDN errors —
      // preserving the raw text means the user sees the actual content.
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Travelpayouts ${input.operation} ${init.method ?? 'GET'} ${input.path} → HTTP ${res.status}`,
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
            network: 'travelpayouts',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Travelpayouts ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Build the Travelpayouts auth headers.
 *
 * Travelpayouts uses a custom header `X-Access-Token` rather than the HTTP
 * `Authorization: Bearer ...` convention. The token can also be supplied as a
 * `token` query parameter, but the header is preferred so the secret does not
 * land in URL/access logs. `Accept` is set to `application/json`
 * unconditionally because every endpoint this adapter calls returns JSON.
 */
function buildHeaders(token: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Access-Token': token,
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
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, TRAVELPAYOUTS_BASE_URL);
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
