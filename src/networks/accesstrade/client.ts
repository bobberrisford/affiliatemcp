/**
 * AccessTrade HTTP client — the ONLY path AccessTrade adapter methods use for
 * network I/O.
 *
 * AccessTrade (Interspace) is the largest CPA affiliate network in Japan and
 * South-East Asia. The publisher API authenticates with a custom header
 * `Authorization: Token <access_key>` rather than the HTTP `Bearer` convention
 * (confirmed: support.accesstrade.global/api/how-do-i-authenticate-publisher-api-requests.html,
 * 2026-06-05). All credential reading and header construction is centralised here
 * so the adapter stays readable and the resilience layer applies uniformly to
 * every outgoing call.
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

const log = createLogger('accesstrade.client');

/**
 * AccessTrade publisher API base URL.
 *
 * The endpoint host differs by country (confirmed:
 * support.accesstrade.global/api/api-endpoints.html, 2026-06-05):
 *   - Indonesia / Malaysia / Singapore: https://gurkha.accesstrade.global
 *   - Thailand:                          https://gurkha.accesstrade.in.th
 *   - Vietnam (separate platform):       https://api.accesstrade.vn
 *
 * We default to the Indonesia/Malaysia/Singapore host. A publisher in another
 * country must override this via the `ACCESSTRADE_BASE_URL` env var. Hard-coded
 * default for v0.1; see `known_limitations` in network.json.
 */
export const ACCESSTRADE_DEFAULT_BASE_URL = 'https://gurkha.accesstrade.global';

export function resolveBaseUrl(): string {
  const override = process.env['ACCESSTRADE_BASE_URL'];
  return override && override.trim() !== '' ? override.trim() : ACCESSTRADE_DEFAULT_BASE_URL;
}

export interface AccessTradeRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to the resolved base URL. */
  path: string;
  /** Access key. Passed in from auth helpers / the adapter so reads happen once per op. */
  accessKey: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Query string parameters. Values with `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Body for POST/PUT requests; serialised as JSON. */
  body?: unknown;
  /** Resilience knobs for this specific call. Required so each op picks its own profile. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single AccessTrade API request under the resilience policy.
 *
 * Auth: AccessTrade uses `Authorization: Token <access_key>` (custom header,
 * not Bearer). The key is passed in from the adapter so credential reads happen
 * once per operation in the adapter, not deep inside the HTTP layer.
 */
export async function accessTradeRequest<T>(input: AccessTradeRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'accesstrade', operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input.path, input.query);
      const init: RequestInit = {
        method: input.method ?? 'GET',
        headers: buildHeaders(input.accessKey, input.body !== undefined),
      };
      if (input.body !== undefined) {
        init.body = JSON.stringify(input.body);
      }
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ url, method: init.method, operation: input.operation }, 'accesstrade request');

      const res = await fetch(url, init);

      // Read the body once. We need it both for success (decode JSON) and for
      // failure (surface the raw text on the envelope). AccessTrade error bodies
      // are typically JSON but may be plain text or HTML behind a CDN.
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `AccessTrade ${input.operation} ${init.method ?? 'GET'} ${input.path} → HTTP ${res.status}`,
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
            network: 'accesstrade',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `AccessTrade ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Build the AccessTrade auth headers.
 *
 * AccessTrade uses `Authorization: Token <access_key>` (confirmed:
 * support.accesstrade.global/api/how-do-i-authenticate-publisher-api-requests.html,
 * 2026-06-05) rather than the `Authorization: Bearer ...` convention. `Accept`
 * and `Content-Type` are set to `application/json` per the same documentation.
 */
function buildHeaders(accessKey: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Token ${accessKey}`,
    Accept: 'application/json',
  };
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

/**
 * Compose the full URL with query string, using `URL` + `URLSearchParams`.
 * The base URL is resolved per call so an `ACCESSTRADE_BASE_URL` override set
 * after module load (e.g. in tests) is respected.
 */
function buildUrl(pathname: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, resolveBaseUrl());
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
