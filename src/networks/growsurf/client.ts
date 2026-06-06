/**
 * GrowSurf REST API HTTP client — the ONLY path this adapter uses for network
 * I/O. Structurally a copy of `src/networks/rewardful/client.ts`; read that file
 * (and `src/networks/awin/client.ts`) for the rationale behind the hard rules.
 *
 * --- GrowSurf REST API surface (verify against -----------------------------
 *     https://docs.growsurf.com/developer-tools/rest-api/api-reference) -------
 *
 *   Host:    https://api.growsurf.com
 *   Prefix:  /v2
 *   Auth:    bearer — header `Authorization: Bearer <GROWSURF_API_KEY>`.
 *   Scope:   campaign-scoped. Most routes embed a campaign id:
 *              GET  /campaign/:id                       — the programme.
 *              GET  /campaign/:id/participants          — participant list.
 *              GET  /campaign/:id/participant/:pid       — one participant.
 *              POST /campaign/:id/participant/:email/ref — trigger a referral.
 *   Paging:  cursor-based on the participants list — pass `nextId` (the id of
 *            the participant to start the next page with) and `limit` (≤ 100);
 *            the response carries `nextId` (null when exhausted) and `more`.
 *   Dates:   epoch milliseconds (e.g. `createdAt: 1552404738928`).
 *   Limits:  HTTP 429 on rate limit (the resilience layer retries 429).
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('growsurf.client');

export const GROWSURF_BASE_URL = 'https://api.growsurf.com';
export const GROWSURF_PATH_PREFIX = '/v2';
export const SLUG = 'growsurf';

export interface GrowSurfRequestInput {
  operation: string;
  /** Resource path beginning with `/`, relative to the `/v2` prefix (e.g. `/campaign/abc/participants`). */
  path: string;
  /** GrowSurf API key — sent as the bearer token. */
  apiKey: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  resilience: ResilienceConfig;
  signal?: AbortSignal;
}

export async function growsurfRequest<T>(input: GrowSurfRequestInput): Promise<T> {
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

      log.debug({ url, method: init.method, operation: input.operation }, 'growsurf request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `GrowSurf ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
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
            message: `GrowSurf ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/** Bearer auth — `Authorization: Bearer <key>`. Documented GrowSurf scheme. */
function buildHeaders(apiKey: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
  };
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

function buildUrl(pathname: string, query?: Record<string, string | number | undefined>): string {
  const rel = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const url = new URL(`${GROWSURF_PATH_PREFIX}${rel}`, GROWSURF_BASE_URL);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export { HttpStatusError };
