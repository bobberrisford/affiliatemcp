/**
 * Rewardful REST API HTTP client — the ONLY path this adapter uses for network
 * I/O. Structurally a copy of `src/networks/awin/client.ts`; read that file for
 * the rationale behind the hard rules.
 *
 * --- Rewardful REST API surface (verify against ----------------------------
 *     https://developers.rewardful.com/rest-api/overview) --------------------
 *
 *   Host:    https://api.getrewardful.com
 *   Prefix:  /v1
 *   Auth:    HTTP Basic — the API Secret is the username, password is empty:
 *            base64("{REWARDFUL_API_SECRET}:")
 *   Paging:  page-based — response carries a `pagination` object
 *            ({ current_page, next_page, previous_page, count, limit,
 *               total_pages, total_count }) plus a `data` array.
 *   Dates:   ISO 8601. Primary keys are UUID strings.
 *   Limits:  45 requests / 30s → HTTP 429 (the resilience layer retries 429).
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('rewardful.client');

export const REWARDFUL_BASE_URL = 'https://api.getrewardful.com';
export const REWARDFUL_PATH_PREFIX = '/v1';
export const SLUG = 'rewardful';

export interface RewardfulRequestInput {
  operation: string;
  /** Resource path beginning with `/`, relative to the `/v1` prefix (e.g. `/commissions`). */
  path: string;
  /** Rewardful API Secret — used as the Basic-auth username (empty password). */
  apiSecret: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  resilience: ResilienceConfig;
  signal?: AbortSignal;
}

export async function rewardfulRequest<T>(input: RewardfulRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input.path, input.query);
      const init: RequestInit = {
        method: input.method ?? 'GET',
        headers: buildHeaders(input.apiSecret, input.body !== undefined),
      };
      if (input.body !== undefined) {
        init.body = JSON.stringify(input.body);
      }
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ url, method: init.method, operation: input.operation }, 'rewardful request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Rewardful ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
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
            message: `Rewardful ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * HTTP Basic with the API Secret as the username and an empty password —
 * base64("secret:"). Documented Rewardful auth scheme.
 */
function buildHeaders(apiSecret: string, hasBody: boolean): Record<string, string> {
  const credentials = Buffer.from(`${apiSecret}:`).toString('base64');
  const headers: Record<string, string> = {
    Authorization: `Basic ${credentials}`,
    Accept: 'application/json',
  };
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

function buildUrl(pathname: string, query?: Record<string, string | number | undefined>): string {
  const rel = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const url = new URL(`${REWARDFUL_PATH_PREFIX}${rel}`, REWARDFUL_BASE_URL);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export { HttpStatusError };
