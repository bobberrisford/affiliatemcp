/**
 * Everflow advertiser HTTP client.
 *
 * All outbound requests go through `everflowAdvRequest` which wraps `fetch` in
 * `withResilience`. The client supports GET (query-string params) and POST
 * (JSON body) — the Everflow reporting endpoints use POST.
 *
 * Auth header:  X-Eflow-API-Key: <api_key>
 * Base URL:     https://api.eflow.team/v1
 *
 * Refs:
 *   https://developers.everflow.io/docs/user-guide/authentication/
 *   https://developers.everflow.io/user-guide/request-response-format
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { AnyOperation, ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';
import { apiKeyHeader, requireApiKey, SLUG, BASE_URL } from './auth.js';

const log = createLogger('everflow-advertiser.client');

export interface EverflowAdvRequestInput {
  operation: AnyOperation;
  /** Relative path under BASE_URL, e.g. "/networks/advertisers". Must start with "/". */
  path: string;
  /** GET query string params. */
  query?: Record<string, string | number | undefined>;
  /** POST request body. When present the request uses POST; otherwise GET. */
  body?: unknown;
  resilience: ResilienceConfig;
}

/**
 * Issue a single Everflow Network API request under the resilience policy.
 *
 * Uses GET for listing/query operations (query params on the URL).
 * Uses POST for reporting operations (body as JSON).
 *
 * Throws `HttpStatusError` on non-2xx so the retry policy inside
 * `withResilience` can inspect the status code.
 */
export async function everflowAdvRequest<T>(input: EverflowAdvRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const apiKey = requireApiKey(input.operation);
      const method = input.body !== undefined ? 'POST' : 'GET';
      const url = buildUrl(input.path, method === 'GET' ? input.query : undefined);

      const init: RequestInit = {
        method,
        headers: apiKeyHeader(apiKey),
      };
      if (method === 'POST' && input.body !== undefined) {
        init.body = JSON.stringify(input.body);
      }

      log.debug({ url, method, operation: input.operation }, 'everflow-adv request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Everflow advertiser ${input.operation} ${method} ${url} → HTTP ${res.status}`,
        );
      }

      const trimmed = rawBody.trim();
      if (trimmed === '' || trimmed === 'null') return {} as T;

      try {
        return JSON.parse(rawBody) as T;
      } catch (err) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: SLUG,
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message:
              `Everflow advertiser ${input.operation} returned HTTP ${res.status} ` +
              `with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Build the absolute URL for a given path + optional query params.
 * Exported for test assertions on URL shape.
 *
 * BASE_URL is https://api.eflow.team/v1 — note the path prefix `/v1`.
 * We cannot use `new URL(relativePath, base)` with an absolute path like
 * `/networks/advertisers` because the URL constructor resolves absolute
 * paths against the origin only, stripping the `/v1` prefix. Instead
 * we concatenate BASE_URL + the relative path directly.
 */
export function buildUrl(
  path: string,
  query?: Record<string, string | number | undefined>,
): string {
  // Normalise: strip leading slash from path so we can concatenate cleanly.
  const rel = path.startsWith('/') ? path.slice(1) : path;
  const base = BASE_URL.endsWith('/') ? BASE_URL.slice(0, -1) : BASE_URL;
  const url = new URL(`${base}/${rel}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export { HttpStatusError };
