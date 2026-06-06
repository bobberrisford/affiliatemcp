/**
 * Tapfiliate REST API HTTP client — the ONLY path this adapter uses for network
 * I/O. Structurally a copy of `src/networks/rewardful/client.ts`; read that file
 * (and `src/networks/awin/client.ts`) for the rationale behind the hard rules.
 *
 * --- Tapfiliate REST API surface (verify against ---------------------------
 *     https://tapfiliate.com/docs/rest/) -----------------------------------
 *
 *   Host:    https://api.tapfiliate.com
 *   Prefix:  /1.6
 *   Auth:    custom header `X-Api-Key: <key>` on every request.
 *   Paging:  page-based — `?page=N` (1-based, 25 items / page by default). The
 *            response is a bare JSON array; the next/last page links live in the
 *            `Link` response header (rel="next" / rel="last"). We follow the
 *            presence of a rel="next" link to decide whether to fetch more.
 *   Dates:   ISO-8601 `created_at` etc.; list filters use `date_from` /
 *            `date_to` (YYYY-MM-DD). Amounts are decimal major units
 *            (e.g. "amount": 100.0), NOT minor units.
 *   Limits:  documented rate limiting → HTTP 429 (the resilience layer retries
 *            429 only).
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('tapfiliate.client');

export const TAPFILIATE_BASE_URL = 'https://api.tapfiliate.com';
export const TAPFILIATE_PATH_PREFIX = '/1.6';
export const SLUG = 'tapfiliate';

/** A parsed response: the JSON body plus whether a rel="next" page link exists. */
export interface TapfiliateResponse<T> {
  body: T;
  hasNextPage: boolean;
}

export interface TapfiliateRequestInput {
  operation: string;
  /** Resource path beginning with `/`, relative to the `/1.6` prefix (e.g. `/conversions/`). */
  path: string;
  /** Tapfiliate API key — sent verbatim as the `X-Api-Key` header. */
  apiKey: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  resilience: ResilienceConfig;
  signal?: AbortSignal;
}

/**
 * Make a single Tapfiliate request and return both the parsed body and a flag
 * indicating whether the `Link` header advertised a further page. Tapfiliate
 * list endpoints return a bare JSON array, so pagination state lives only in
 * the header — the adapter's `fetchAll` loop reads `hasNextPage` to decide
 * whether to request the next `page`.
 */
export async function tapfiliateRequest<T>(
  input: TapfiliateRequestInput,
): Promise<TapfiliateResponse<T>> {
  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input.path, input.query);
      const init: RequestInit = {
        method: input.method ?? 'GET',
        headers: buildHeaders(input.apiKey, input.body !== undefined),
      };
      if (input.body !== undefined) {
        init.body = JSON.stringify(input.body);
      }
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ url, method: init.method, operation: input.operation }, 'tapfiliate request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Tapfiliate ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
        );
      }

      const hasNextPage = linkHeaderHasNext(res.headers.get('link'));

      if (rawBody.trim() === '') {
        return { body: {} as T, hasNextPage };
      }

      try {
        return { body: JSON.parse(rawBody) as T, hasNextPage };
      } catch (err) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: SLUG,
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Tapfiliate ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Tapfiliate authenticates with a single API key sent as the `X-Api-Key`
 * header — not a bearer token and not Basic auth. Documented scheme.
 */
function buildHeaders(apiKey: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Api-Key': apiKey,
    Accept: 'application/json',
  };
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

/** True if the `Link` header advertises a rel="next" page. */
export function linkHeaderHasNext(linkHeader: string | null | undefined): boolean {
  if (!linkHeader) return false;
  return /rel="?next"?/i.test(linkHeader);
}

function buildUrl(
  pathname: string,
  query?: Record<string, string | number | boolean | undefined>,
): string {
  const rel = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const url = new URL(`${TAPFILIATE_PATH_PREFIX}${rel}`, TAPFILIATE_BASE_URL);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export { HttpStatusError };
