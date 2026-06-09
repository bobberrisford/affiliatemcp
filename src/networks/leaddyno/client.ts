/**
 * LeadDyno REST API HTTP client — the ONLY path this adapter uses for network
 * I/O. Structurally a copy of `src/networks/rewardful/client.ts`; read that file
 * (and `src/networks/awin/client.ts`) for the rationale behind the hard rules.
 *
 * --- LeadDyno REST API surface (verify against -----------------------------
 *     https://app.theneo.io/leaddyno/leaddyno-rest-api) ----------------------
 *
 *   Host:    https://api.leaddyno.com
 *   Prefix:  /v1
 *   Auth:    a private API key passed as the `key` query parameter on every
 *            request (auth_model: custom). The docs allow the key as a header
 *            or a query-string param; we use the query param, the form the docs
 *            use throughout. The key is found in Account → Profile.
 *   Paging:  page-based — `?page=N`, 100 records per page, sorted oldest-first
 *            (most recent last). List endpoints return a bare JSON array (no
 *            pagination envelope).
 *   Dates:   ISO 8601 (`created_at`, `updated_at`). `GET /purchases` supports
 *            `created_after` / `created_before` filters.
 *   Limits:  HTTP 429 on rate limiting (the resilience layer retries 429).
 *
 * The `key` is never logged: `log.debug` records the path, method and operation
 * only — never the constructed URL, which carries the key.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('leaddyno.client');

export const LEADDYNO_BASE_URL = 'https://api.leaddyno.com';
export const LEADDYNO_PATH_PREFIX = '/v1';
export const SLUG = 'leaddyno';

export interface LeadDynoRequestInput {
  operation: string;
  /** Resource path beginning with `/`, relative to the `/v1` prefix (e.g. `/purchases`). */
  path: string;
  /** LeadDyno private API key — sent as the `key` query parameter. */
  apiKey: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  resilience: ResilienceConfig;
  signal?: AbortSignal;
}

export async function leaddynoRequest<T>(input: LeadDynoRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input.path, input.apiKey, input.query);
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

      // Note: the URL carries the private key in the `key` query param, so it is
      // deliberately NOT logged. Path + method + operation are enough to debug.
      log.debug(
        { path: input.path, method: init.method, operation: input.operation },
        'leaddyno request',
      );

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `LeadDyno ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
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
            message: `LeadDyno ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

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
 * LeadDyno authenticates with the private key in the `key` query parameter. We
 * set it first, then layer the operation's own query params on top.
 */
function buildUrl(
  pathname: string,
  apiKey: string,
  query?: Record<string, string | number | boolean | undefined>,
): string {
  const rel = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const url = new URL(`${LEADDYNO_PATH_PREFIX}${rel}`, LEADDYNO_BASE_URL);
  url.searchParams.set('key', apiKey);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export { HttpStatusError };
