/**
 * Yieldkit HTTP client — the ONLY path Yieldkit adapter methods use for network I/O.
 *
 * Yieldkit authenticates with an API key + API secret passed as query
 * parameters (`api_key` and `api_secret`), not an HTTP header. This is
 * documented behaviour: the Advertiser/Commission-terms API is reached as
 * `GET http://api.yieldkit.com/v2/advertiser/terms?api_key=...&api_secret=...&site_id=...`
 * (https://yieldkit.com/knowledge/commission-terms/). We force HTTPS and add
 * `format=json` to every call because Yieldkit defaults some endpoints to XML.
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

const log = createLogger('yieldkit.client');

/**
 * The Yieldkit API root. Centralised so a test harness or staging environment
 * can override it without touching adapter code. Hard-coded for v0.1.
 *
 * Source: https://yieldkit.com/knowledge/commission-terms/ documents
 * `api.yieldkit.com`; we pin HTTPS.
 */
export const YIELDKIT_BASE_URL = 'https://api.yieldkit.com';

/**
 * The Yieldkit redirect/link host. Tracking links are minted against this
 * host, not the API host. Source: https://yieldkit.com/knowledge/redirect-api/
 *   GET https://r.srvtrck.com/v1/redirect?url=...&api_key=...&type=url&source=...&yk_tag=...
 */
export const YIELDKIT_REDIRECT_BASE_URL = 'https://r.srvtrck.com';

export interface YieldkitRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to `YIELDKIT_BASE_URL`. */
  path: string;
  /** API key. Sent as the `api_key` query parameter. */
  apiKey: string;
  /** API secret. Sent as the `api_secret` query parameter. */
  apiSecret: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Query string parameters. Values with `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Body for POST/PUT requests; serialised as JSON. */
  body?: unknown;
  /** Resilience knobs for this specific call. Required so each op picks its own profile. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
  /** Override the host (used for the redirect/link host). Defaults to the API host. */
  baseUrl?: string;
}

/**
 * Issue a single Yieldkit API request under the resilience policy.
 *
 * Auth: the `api_key` and `api_secret` query parameters are injected here so
 * credential reads happen once per operation in the adapter, not deep inside
 * the HTTP layer. `format=json` is appended unconditionally because Yieldkit
 * defaults some endpoints to XML.
 *
 * Why the response is typed as `T` with no runtime validation: Yieldkit's REST
 * surface drifts and is weakly documented; over-specifying a schema here forces
 * the client into "is this a valid Yieldkit response?" which belongs in the
 * adapter transformers (where missing fields can be interpreted with context).
 */
export async function yieldkitRequest<T>(input: YieldkitRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'yieldkit', operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input.baseUrl ?? YIELDKIT_BASE_URL, input.path, {
        ...input.query,
        api_key: input.apiKey,
        api_secret: input.apiSecret,
        format: 'json',
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

      log.debug({ method: init.method, operation: input.operation }, 'yieldkit request');

      const res = await fetch(url, init);

      // Read the body once. We need it both for success (decode JSON) and for
      // failure (surface the raw text on the envelope). Yieldkit error bodies
      // are typically JSON-shaped but may be plain text or XML on CDN errors —
      // preserving the raw text means the user sees the actual content.
      const rawBody = await res.text();

      if (!res.ok) {
        // Throw HttpStatusError so the resilience layer applies its retry/no-retry
        // decision uniformly. Do NOT inspect `res.status` here to decide retries —
        // policy lives in one place (resilience.ts).
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Yieldkit ${input.operation} ${init.method ?? 'GET'} ${input.path} → HTTP ${res.status}`,
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
            network: 'yieldkit',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Yieldkit ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
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
 * Auth travels in the query string for Yieldkit, so the only header we set is
 * `Accept: application/json` to coax JSON out of endpoints that default to XML.
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
 *
 * Yieldkit query values include destination URLs and ISO timestamps that MUST
 * be URL-encoded; `URLSearchParams` is the right tool rather than string
 * concatenation.
 */
function buildUrl(
  base: string,
  pathname: string,
  query?: Record<string, string | number | undefined>,
): string {
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, base);
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
