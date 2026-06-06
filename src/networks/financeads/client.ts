/**
 * financeAds HTTP client — the ONLY path financeAds adapter methods use for
 * network I/O.
 *
 * financeAds is a DACH (Germany / Austria / Switzerland) finance-vertical
 * affiliate network. Its publisher reporting API is authenticated with two
 * query parameters supplied on every call: an API key and the publisher's
 * numeric user (publisher) ID. There is no Bearer header and no OAuth flow —
 * the credentials ride in the query string. Centralising that here keeps the
 * adapter readable and the resilience layer applied uniformly.
 *
 * --- UNVERIFIED SHAPE WARNING -----------------------------------------------
 *
 * The full request/response shape of the financeAds publisher API is only
 * partly documented in public sources; the canonical docs are gated behind the
 * publisher dashboard. The exact endpoint paths, parameter names, and whether
 * the API returns JSON, XML, or CSV could not be confirmed against a live
 * account at commit time. This client is written defensively:
 *   - credentials and request parameters are passed as query params (the
 *     pattern every public description of the financeAds API agrees on);
 *   - the client tolerates an empty body and a non-JSON body without
 *     collapsing the upstream content;
 *   - every endpoint path used by the adapter is marked `// TODO(verify)` at
 *     its call site so a future contributor with live access can confirm it.
 *
 * Public sources consulted (2026-06-05):
 *   - https://strackr.com/docs/financeads
 *   - https://wecantrack.com/financeads-integration/
 *   - https://www.financeads.com/ (network home; "API for sales, merchants and
 *     daily statistics (3 access have to be enabled)")
 *   - https://www.financeads.net/ (publisher network home; tracking-link format)
 *
 * --- Hard rules (mirrored from Awin client.ts; read that file for the full
 * rationale) -----------------------------------------------------------------
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

const log = createLogger('financeads.client');

/**
 * financeAds publisher API root.
 *
 * The publisher-facing network operates on `www.financeads.net`; the same host
 * serves the documented tracking redirect (`/tc.php`). Public integration
 * descriptions place the reporting webservice under this host. Centralised so a
 * test harness can override it without touching adapter code.
 *
 * UNVERIFIED: the exact reporting path under this host (e.g. `/ws/`) is gated
 * behind the dashboard and not confirmed; adapter call sites carry the path.
 */
export const FINANCEADS_BASE_URL = 'https://www.financeads.net';

export interface FinanceadsRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to `FINANCEADS_BASE_URL`. */
  path: string;
  /** API key. Sent as the `key` query parameter (financeAds auth is query-param based). */
  apiKey: string;
  /** Publisher (user) ID. Sent as the `userid` query parameter. */
  userId: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Additional query string parameters. Values with `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Body for POST/PUT requests; serialised as JSON. */
  body?: unknown;
  /** Resilience knobs for this specific call. Required so each op picks its own profile. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single financeAds API request under the resilience policy.
 *
 * Auth: financeAds threads the API key and publisher ID through the query
 * string (`key` + `userid`) rather than an Authorization header — confirmed by
 * every public description of the API and by the documented tracking-link
 * scheme on the same host. The credentials are passed in from the adapter so
 * credential reads happen once per operation in the adapter, not deep inside
 * the HTTP layer.
 *
 * Why the response is typed as `T` with no runtime validation: the financeAds
 * surface is weakly documented and may return JSON or XML/CSV depending on the
 * endpoint and account settings. We request JSON via `Accept` and parse it when
 * present; if the body is not JSON we surface the verbatim text on the envelope
 * rather than guessing (principle 4.1). Adapter transformers tolerate missing
 * keys defensively.
 */
export async function financeadsRequest<T>(input: FinanceadsRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'financeads', operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input.path, {
        // financeAds auth: API key + publisher (user) ID as query params.
        // UNVERIFIED parameter names (`key`, `userid`) — the most consistent
        // naming across public sources. A future contributor with live access
        // should confirm and adjust here in one place.
        key: input.apiKey,
        userid: input.userId,
        ...input.query,
      });

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

      log.debug({ url, method: init.method, operation: input.operation }, 'financeads request');

      const res = await fetch(url, init);

      // Read the body once. We need it both for success (decode JSON) and for
      // failure (surface the raw text on the envelope).
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `financeAds ${input.operation} ${init.method ?? 'GET'} ${input.path} → HTTP ${res.status}`,
        );
      }

      if (rawBody.trim() === '') {
        return {} as T;
      }

      try {
        return JSON.parse(rawBody) as T;
      } catch (err) {
        // financeAds endpoints may return XML or CSV depending on account
        // settings. We do not silently guess: surface the verbatim body on a
        // network_api_error envelope so the user sees exactly what came back
        // (principle 4.1). A future contributor confirming the response format
        // can add a parser here.
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: 'financeads',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `financeAds ${input.operation} returned HTTP ${res.status} with a non-JSON body (parse error: ${(err as Error).message}). The financeAds API response format is not yet verified against a live account; it may return XML or CSV.`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Build the request headers.
 *
 * financeAds authentication is query-param based, so no Authorization header is
 * set. We request JSON via `Accept`; the endpoint may still return XML/CSV (see
 * the parse-failure path above).
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
 * Compose the full URL with query string, using `URL` + `URLSearchParams`.
 */
function buildUrl(pathname: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, FINANCEADS_BASE_URL);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

// Re-export so adapter code can throw HttpStatusError without importing from
// shared/resilience directly. The boundary stays clean.
export { HttpStatusError };
