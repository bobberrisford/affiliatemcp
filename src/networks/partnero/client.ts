/**
 * Partnero REST API HTTP client — the ONLY path this adapter uses for network
 * I/O. Structurally a copy of `src/networks/awin/client.ts`; read that file for
 * the rationale behind the hard rules.
 *
 * --- Partnero REST API surface (verify against -----------------------------
 *     https://developers.partnero.com/reference/general.html) ----------------
 *
 *   Host:    https://api.partnero.com
 *   Prefix:  /v1
 *   Auth:    Bearer token — `Authorization: Bearer <token>`. The token is
 *            generated per programme (Programs › Integration › API). One token
 *            therefore scopes one programme, which is why this adapter is
 *            advertiser + single-brand.
 *   Paging:  page-based — list responses carry a `data` array plus a
 *            pagination block (`current_page`, `per_page`, `from`, `to`,
 *            `path`, and where present `total`/`last_page`). Page size is set
 *            with `limit`; the page index with `page`.
 *   Dates:   ISO 8601 (`created_at`, `deleted_at`).
 *   Amounts: transaction / reward amounts are in MAJOR currency units
 *            (e.g. 99.99) with `amount_units` naming the currency and
 *            `is_currency` flagging currency-denominated amounts. This is the
 *            opposite of Rewardful, which uses minor units (cents). TODO(verify).
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('partnero.client');

export const PARTNERO_BASE_URL = 'https://api.partnero.com';
export const PARTNERO_PATH_PREFIX = '/v1';
export const SLUG = 'partnero';

export interface PartneroRequestInput {
  operation: string;
  /** Resource path beginning with `/`, relative to the `/v1` prefix (e.g. `/transactions`). */
  path: string;
  /** Partnero API token — sent as a Bearer token. */
  token: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  resilience: ResilienceConfig;
  signal?: AbortSignal;
}

export async function partneroRequest<T>(input: PartneroRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };

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

      log.debug({ url, method: init.method, operation: input.operation }, 'partnero request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Partnero ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
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
            network: SLUG,
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Partnero ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/** Bearer auth: `Authorization: Bearer <token>`. Documented Partnero scheme. */
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

function buildUrl(pathname: string, query?: Record<string, string | number | undefined>): string {
  const rel = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const url = new URL(`${PARTNERO_PATH_PREFIX}${rel}`, PARTNERO_BASE_URL);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export { HttpStatusError };
