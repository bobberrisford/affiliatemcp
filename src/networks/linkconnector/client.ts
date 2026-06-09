/**
 * LinkConnector HTTP client — the ONLY path the adapter uses for network I/O.
 *
 * LinkConnector's API is a single endpoint (`/api/`) that dispatches on a
 * `Function` query parameter. Authentication is a `Key` parameter carrying the
 * API key the publisher generates in-dashboard (Tools > API > Create API Key).
 * Every call sets `Format=JSON` so the endpoint returns JSON rather than the
 * default CSV/XML.
 *
 * Reference: src/networks/awin/client.ts (the canonical pattern — read it for
 * the full rationale) and src/networks/everflow/client.ts (custom auth header).
 *
 * Hard rules (mirrored from Awin client.ts):
 *   1. Do NOT call `fetch` from `adapter.ts` or anywhere else in this folder.
 *   2. Do NOT add a second client that skips `withResilience`.
 *   3. On a non-2xx response, throw `HttpStatusError` so the resilience layer
 *      applies its retry policy uniformly.
 *   4. Preserve the raw response body verbatim on failure.
 *
 * Why credentials (the `Key`) are passed in rather than read here: the adapter
 * reads them once per operation via `requireCredential`, so a missing key
 * surfaces as a `config_error` envelope before any HTTP is attempted.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('linkconnector.client');

/**
 * LinkConnector API root. All functions dispatch through `/api/` on this host.
 * Centralised so a test harness or staging environment can override it without
 * touching adapter code. Hard-coded for v0.1.
 *
 * The documented endpoint is `http://www.linkconnector.com/api/`. We use HTTPS
 * (the host serves the same endpoint over TLS) so credentials are never sent
 * in clear text.
 */
export const LINKCONNECTOR_BASE_URL = 'https://www.linkconnector.com';

/** The single dispatch path; the `Function` query param selects the operation. */
export const LINKCONNECTOR_API_PATH = '/api/';

export interface LinkConnectorRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /**
   * The LinkConnector API function name, e.g. `getFeedPromotion`,
   * `getReportTransaction`, `getReportTransactionDelta`. Sent verbatim as the
   * `Function` query parameter.
   */
  func: string;
  /** API key. Passed in from auth helpers; sent as the `Key` query parameter. */
  apiKey: string;
  method?: 'GET' | 'POST';
  /**
   * Function-specific query parameters (date filters, pagination, etc). Values
   * with `undefined` are skipped. `Key`, `Function`, and `Format` are added by
   * the client and must not be supplied here.
   */
  query?: Record<string, string | number | undefined>;
  /** Resilience knobs for this specific call. Required so each op picks its own profile. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single LinkConnector API request under the resilience policy.
 *
 * LinkConnector accepts the request as an HTTP POST whose parameters live in
 * the query string (the documented `HTTP POST to .../api/ passing your API key
 * and the API function`). We build the full URL with `Key`, `Function`, and
 * `Format=JSON` always present, then append the operation's own parameters.
 *
 * Why the response is typed as `T` with no runtime validation: LinkConnector's
 * surface is weakly documented and the JSON field-name casing is not published
 * (the public help pages are not crawlable). Over-specifying a schema here
 * would break first; adapter transformers read keys defensively and preserve
 * the original under `rawNetworkData`.
 */
export async function linkconnectorRequest<T>(input: LinkConnectorRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'linkconnector', operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input.apiKey, input.func, input.query);
      const init: RequestInit = {
        method: input.method ?? 'POST',
        headers: { Accept: 'application/json' },
      };
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ func: input.func, method: init.method, operation: input.operation }, 'linkconnector request');

      const res = await fetch(url, init);

      // Read the body once: needed for success (decode JSON) and for failure
      // (surface the raw text on the envelope). LinkConnector error bodies are
      // typically JSON when Format=JSON, but may be plain text on CDN errors.
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `LinkConnector ${input.operation} (${input.func}) → HTTP ${res.status}`,
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
            network: 'linkconnector',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `LinkConnector ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Compose the full URL with `Key`, `Function`, `Format=JSON`, and the call's
 * own query parameters.
 *
 * We use `URL` + `URLSearchParams` rather than string concatenation because
 * LinkConnector's date and URL parameters need URL-encoding.
 */
function buildUrl(
  apiKey: string,
  func: string,
  query?: Record<string, string | number | undefined>,
): string {
  const url = new URL(LINKCONNECTOR_API_PATH, LINKCONNECTOR_BASE_URL);
  url.searchParams.set('Key', apiKey);
  url.searchParams.set('Function', func);
  url.searchParams.set('Format', 'JSON');
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
