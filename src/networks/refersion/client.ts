/**
 * Refersion REST API HTTP client — the ONLY path this adapter uses for network
 * I/O. Structurally a copy of `src/networks/rewardful/client.ts`; read that file
 * (and `src/networks/awin/client.ts`) for the rationale behind the hard rules.
 *
 * --- Refersion REST API surface (verify against ----------------------------
 *     https://www.refersion.dev/reference/welcome-to-refersion) --------------
 *
 *   Host:    https://api.refersion.com
 *   Prefix:  /v2
 *   Auth:    Two custom headers carrying the merchant API key pair:
 *              Refersion-Public-Key: <REFERSION_API_KEY>
 *              Refersion-Secret-Key: <REFERSION_SECRET_KEY>
 *            Both are found in the Refersion dashboard under Account > Settings.
 *   Paging:  page-based — list endpoints accept `page` and `per_page`
 *            (max 200) and return a `results` array alongside a `count` /
 *            `total_pages` style envelope. The exact envelope key names are
 *            read defensively in the adapter. TODO(verify).
 *   Verbs:   list endpoints are POST (e.g. POST /v2/affiliate/list); paging
 *            params travel in the JSON body.
 *   Dates:   list filters use `created_after` / `created_before`; timestamps
 *            come back as strings the adapter parses with Date.parse.
 *   Limits:  the API rate-limits; 429s are retried by the resilience layer.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('refersion.client');

export const REFERSION_BASE_URL = 'https://api.refersion.com';
export const REFERSION_PATH_PREFIX = '/v2';
export const SLUG = 'refersion';

export interface RefersionCredentials {
  apiKey: string;
  secretKey: string;
}

export interface RefersionRequestInput {
  operation: string;
  /** Resource path beginning with `/`, relative to the `/v2` prefix (e.g. `/affiliate/list`). */
  path: string;
  /** Refersion API key pair — sent as the two custom auth headers. */
  credentials: RefersionCredentials;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  resilience: ResilienceConfig;
  signal?: AbortSignal;
}

export async function refersionRequest<T>(input: RefersionRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input.path, input.query);
      const init: RequestInit = {
        method: input.method ?? 'GET',
        headers: buildHeaders(input.credentials, input.body !== undefined),
      };
      if (input.body !== undefined) {
        init.body = JSON.stringify(input.body);
      }
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ url, method: init.method, operation: input.operation }, 'refersion request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Refersion ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
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
            message: `Refersion ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Refersion authenticates with two custom headers carrying the key pair.
 * Documented header names: `Refersion-Public-Key` and `Refersion-Secret-Key`.
 */
function buildHeaders(credentials: RefersionCredentials, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'Refersion-Public-Key': credentials.apiKey,
    'Refersion-Secret-Key': credentials.secretKey,
    Accept: 'application/json',
  };
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

function buildUrl(pathname: string, query?: Record<string, string | number | undefined>): string {
  const rel = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const url = new URL(`${REFERSION_PATH_PREFIX}${rel}`, REFERSION_BASE_URL);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export { HttpStatusError };
