/**
 * Connexity HTTP client — the ONLY path Connexity adapter methods use for
 * network I/O.
 *
 * Connexity (the US CPC-commerce network behind ShopYourLikes) authenticates
 * publisher API calls with a pair of QUERY parameters — `publisherId` and
 * `apiKey` — rather than an `Authorization` header. Both are appended to every
 * request here so the adapter never builds the auth itself, and the resilience
 * layer applies uniformly to every call.
 *
 * Two hosts are in play, both using the same publisherId + apiKey auth:
 *   - Publisher Reporting + Merchant Match: `https://publisher-api.connexity.com`
 *     (earnings reports, merchant match / programmes).
 *   - Deep Link / monetisation: `https://api.cnnx.link` (turn a destination URL
 *     into a monetised tracking link). The adapter selects the host per call
 *     via `host`; the default is the reporting host.
 *
 * Docs:
 *   - https://pubresources.connexity.com/hc/en-us/articles/24602346033053-Publisher-API-Reference
 *   - https://pubresources.connexity.com/hc/en-us/articles/17357975725085-Merchant-Match-API
 *   - http://api.cnnx.link/docs/api/overview
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

const log = createLogger('connexity.client');

/**
 * Publisher Reporting + Merchant Match host. This is the canonical base URL in
 * `network.json` — earnings, adjustments, and merchant match all live here.
 */
export const CONNEXITY_BASE_URL = 'https://publisher-api.connexity.com';

/**
 * Deep Link / monetisation host. A separate service that turns a destination
 * URL into a monetised tracking link (`GET /api/link/generate`).
 */
export const CONNEXITY_DEEPLINK_BASE_URL = 'https://api.cnnx.link';

export type ConnexityHost = 'reporting' | 'deeplink';

export interface ConnexityRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to the selected host. */
  path: string;
  /** Connexity publisher ID. Appended as the `publisherId` query param. */
  publisherId: string;
  /** Connexity API key. Appended as the `apiKey` query param. */
  apiKey: string;
  /** Which host to address. Defaults to the reporting host. */
  host?: ConnexityHost;
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
 * Issue a single Connexity API request under the resilience policy.
 *
 * Auth: `publisherId` and `apiKey` are appended to the query string of every
 * request. They are passed in from the adapter so credential reads happen once
 * per operation, not deep inside the HTTP layer.
 */
export async function connexityRequest<T>(input: ConnexityRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'connexity', operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const base = input.host === 'deeplink' ? CONNEXITY_DEEPLINK_BASE_URL : CONNEXITY_BASE_URL;
      const url = buildUrl(base, input.path, {
        ...input.query,
        publisherId: input.publisherId,
        apiKey: input.apiKey,
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

      log.debug({ method: init.method, operation: input.operation }, 'connexity request');

      const res = await fetch(url, init);

      // Read the body once. We need it both for success (decode JSON) and for
      // failure (surface the raw text on the envelope). Connexity error bodies
      // are typically JSON-shaped but may be plain text on CDN errors.
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Connexity ${input.operation} ${init.method ?? 'GET'} ${input.path} → HTTP ${res.status}`,
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
            network: 'connexity',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Connexity ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
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
 * Connexity authenticates via query parameters, not headers, so there is no
 * `Authorization` line. We force `Accept: application/json` because the
 * reporting endpoints can otherwise default to other content types.
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
 * The deep-link endpoint takes a fully-formed destination URL as the `url`
 * query value, which contains its own `?`/`&`/`:` characters; `URLSearchParams`
 * percent-encodes those correctly where hand-rolled concatenation would not.
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
// shared/resilience directly.
export { HttpStatusError };
