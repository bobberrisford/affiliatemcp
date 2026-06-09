/**
 * Tolt REST API HTTP client — the ONLY path this adapter uses for network I/O.
 * Structurally a copy of `src/networks/awin/client.ts` (and the Rewardful
 * client); read either for the rationale behind the hard rules.
 *
 * --- Tolt REST API surface (verify against ---------------------------------
 *     https://docs.tolt.com/introduction) ----------------------------------
 *
 *   Host:    https://api.tolt.com
 *   Prefix:  /v1
 *   Auth:    Bearer — `Authorization: Bearer <TOLT_API_KEY>`. The key is on
 *            the dashboard under Settings → Integrations.
 *   Envelope: list + single responses are wrapped: `{ success: boolean,
 *             data: [...] | {...} }`. Monetary amounts are integer minor units
 *             (cents). TODO(verify) against a live account.
 *   Paging:  cursor-based — `limit` (default 10, max 100) + `starting_after`
 *            (an object id cursor, Stripe-style); a `has_more` flag signals a
 *            further page. The adapter loops on the last id while `has_more`.
 *   Limits:  per-API-key rate limit → HTTP 429 (the resilience layer retries
 *            429). See https://docs.tolt.com/rate-limit.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('tolt.client');

export const TOLT_BASE_URL = 'https://api.tolt.com';
export const TOLT_PATH_PREFIX = '/v1';
export const SLUG = 'tolt';

export interface ToltRequestInput {
  operation: string;
  /** Resource path beginning with `/`, relative to the `/v1` prefix (e.g. `/commissions`). */
  path: string;
  /** Tolt API key — sent as the Bearer token. */
  token: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  resilience: ResilienceConfig;
  signal?: AbortSignal;
}

export async function toltRequest<T>(input: ToltRequestInput): Promise<T> {
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

      log.debug({ url, method: init.method, operation: input.operation }, 'tolt request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Tolt ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
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
            message: `Tolt ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/** Bearer auth — `Authorization: Bearer <key>`. Documented Tolt auth scheme. */
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
  const url = new URL(`${TOLT_PATH_PREFIX}${rel}`, TOLT_BASE_URL);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export { HttpStatusError };
