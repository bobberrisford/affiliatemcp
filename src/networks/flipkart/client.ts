/**
 * Flipkart Affiliate HTTP client — the ONLY path Flipkart adapter methods use
 * for network I/O.
 *
 * Flipkart uses two custom request headers rather than a standard Authorization
 * header:
 *   Fk-Affiliate-Id:    the affiliate tracking ID
 *   Fk-Affiliate-Token: the self-generated API token
 * Both are required on every call. Credential reading happens in the adapter /
 * auth helpers; the constructed headers are passed in here so the resilience
 * layer applies uniformly to every outgoing call.
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

const log = createLogger('flipkart.client');

/**
 * The Flipkart Affiliate API root. All affiliate endpoints (product feeds,
 * offers, order reports) live under this host. Centralised so a test harness
 * can reason about the URL without touching adapter code. Hard-coded for v0.1.
 */
export const FLIPKART_BASE_URL = 'https://affiliate-api.flipkart.net';

export interface FlipkartRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to `FLIPKART_BASE_URL`. */
  path: string;
  /** Flipkart affiliate tracking ID — sent as the `Fk-Affiliate-Id` header. */
  affiliateId: string;
  /** Flipkart API token — sent as the `Fk-Affiliate-Token` header. */
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
 * Issue a single Flipkart Affiliate API request under the resilience policy.
 *
 * Auth: Flipkart uses the two custom headers `Fk-Affiliate-Id` and
 * `Fk-Affiliate-Token`. Both are passed in from the adapter so credential
 * reads happen once per operation in the adapter, not deep inside the HTTP
 * layer.
 */
export async function flipkartRequest<T>(input: FlipkartRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'flipkart', operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input.path, input.query);
      const init: RequestInit = {
        method: input.method ?? 'GET',
        headers: buildHeaders(input.affiliateId, input.token, input.body !== undefined),
      };
      if (input.body !== undefined) {
        init.body = JSON.stringify(input.body);
      }
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ url, method: init.method, operation: input.operation }, 'flipkart request');

      const res = await fetch(url, init);

      // Read the body once. We need it both for success (decode JSON) and for
      // failure (surface the raw text on the envelope). Flipkart error bodies
      // are typically JSON-shaped but may be plain text / HTML on a CDN error —
      // preserving the raw text means the user sees the actual content.
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Flipkart ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
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
            network: 'flipkart',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Flipkart ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Build the Flipkart auth headers.
 *
 * Flipkart uses two custom headers rather than the HTTP `Authorization`
 * convention. `Accept` is set to `application/json` because the report and
 * offer endpoints have JSON variants we always target (the path carries the
 * `/json` suffix; the header is belt-and-braces).
 */
function buildHeaders(
  affiliateId: string,
  token: string,
  hasBody: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    'Fk-Affiliate-Id': affiliateId,
    'Fk-Affiliate-Token': token,
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
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, FLIPKART_BASE_URL);
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
