/**
 * Affiliate Future HTTP client — the ONLY path Affiliate Future adapter methods
 * use for network I/O.
 *
 * Affiliate Future exposes a set of dated WCF (`.svc`) publisher endpoints under
 * `https://api.affiliatefuture.com/PublisherService.svc/`. Authentication is by
 * two query parameters carried on every call: `key` (the publisher API key) and
 * `passcode` (the publisher API password). There are no auth headers and no
 * token exchange — the credentials travel on the query string of each request.
 *
 * The `.svc` host is a WCF service that can serialise either XML or JSON. We set
 * `Accept: application/json` so the service returns the JSON variant, which is
 * the shape every transformer in `adapter.ts` reads. See the file-level
 * known-limitation note: the JSON shapes are inferred from public documentation
 * and have not been confirmed against a live publisher account.
 *
 * Hard rules (mirrored from Awin client.ts — read that file for the full
 * rationale):
 *   1. Do NOT call `fetch` from `adapter.ts` or anywhere else in this folder.
 *   2. Do NOT add a second client that skips `withResilience`.
 *   3. On a non-2xx response, throw `HttpStatusError` so the resilience layer
 *      can apply its retry policy uniformly.
 *   4. Preserve the raw response body verbatim on failure.
 *
 * Reference: src/networks/awin/client.ts and src/networks/everflow/client.ts.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('affiliate-future.client');

/**
 * The Affiliate Future API root. The publisher endpoints live under the
 * `/PublisherService.svc/` path on this host; callers pass the path beginning
 * with `/PublisherService.svc/...`. Hard-coded for v0.1.
 */
export const AFFILIATE_FUTURE_BASE_URL = 'https://api.affiliatefuture.com';

export interface AffiliateFutureRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to `AFFILIATE_FUTURE_BASE_URL`. */
  path: string;
  /** Publisher API key — sent as the `key` query parameter. */
  key: string;
  /** Publisher API password — sent as the `passcode` query parameter. */
  passcode: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /**
   * Additional query string parameters. Values with `undefined` are skipped.
   * `key` and `passcode` are merged in by this client; callers must not set
   * them in `query`.
   */
  query?: Record<string, string | number | undefined>;
  /** Body for POST/PUT requests; serialised as JSON. */
  body?: unknown;
  /** Resilience knobs for this specific call. Required so each op picks its own profile. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single Affiliate Future API request under the resilience policy.
 *
 * Why the response is typed as `T` with no runtime validation: the WCF service
 * surface is weakly documented and the JSON shapes vary by endpoint. Defensive
 * transformers in `adapter.ts` read keys individually and preserve the raw
 * payload under `rawNetworkData`, which is more honest than a schema-mismatch
 * error when Affiliate Future returns something we did not anticipate.
 */
export async function affiliateFutureRequest<T>(input: AffiliateFutureRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'affiliate-future', operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      // The credentials travel on the query string. We merge them here so the
      // adapter never assembles the auth itself.
      const url = buildUrl(input.path, {
        key: input.key,
        passcode: input.passcode,
        ...(input.query ?? {}),
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

      log.debug({ method: init.method, operation: input.operation }, 'affiliate-future request');

      const res = await fetch(url, init);

      // Read the body once. We need it both for success (decode JSON) and for
      // failure (surface the raw text on the envelope). Affiliate Future error
      // bodies may be JSON or a WCF fault string; preserving the raw text means
      // the user sees the actual content.
      const rawBody = await res.text();

      if (!res.ok) {
        // Throw HttpStatusError so the resilience layer applies its retry/no-retry
        // decision uniformly. Do NOT inspect `res.status` here to decide retries.
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Affiliate Future ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
        );
      }

      // Empty body is returned as the empty object — adapters that legitimately
      // expect a payload will detect the missing fields and throw a meaningful
      // envelope.
      if (rawBody.trim() === '') {
        return {} as T;
      }

      try {
        return JSON.parse(rawBody) as T;
      } catch (err) {
        // A 2xx response with a non-JSON body (e.g. the WCF service fell back to
        // XML, or fronted by an HTML error page). Surface the verbatim body so
        // PRD §4.1 (preserve raw upstream body) holds.
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: 'affiliate-future',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Affiliate Future ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
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
 * Affiliate Future's `.svc` endpoint can serialise XML or JSON. We force JSON
 * via `Accept: application/json`; without it the WCF service defaults to XML,
 * which the transformers do not parse.
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
 * Compose the full URL with query string.
 *
 * We use `URL` + `URLSearchParams` rather than string concatenation because the
 * query values include the publisher passcode and `DD-MMM-YYYY` date strings
 * that must be URL-encoded.
 */
function buildUrl(pathname: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(
    pathname.startsWith('/') ? pathname : `/${pathname}`,
    AFFILIATE_FUTURE_BASE_URL,
  );
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
