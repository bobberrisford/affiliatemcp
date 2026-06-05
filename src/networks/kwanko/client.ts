/**
 * Kwanko HTTP client — the ONLY path Kwanko adapter methods use for network I/O.
 *
 * Why this file exists separately from `adapter.ts`:
 *   - Adapter methods speak in normalised domain types; URL construction, header
 *     building, JSON parsing, and status handling live here.
 *   - The resilience layer (timeout, retry policy, circuit breaker — see
 *     `src/shared/resilience.ts`) is applied uniformly, exactly once per call.
 *
 * Hard rules:
 *   1. Do NOT call `fetch` from adapter.ts or anywhere else in this folder.
 *   2. Do NOT bypass `withResilience` for any call.
 *   3. On non-2xx, throw `HttpStatusError` so the resilience layer retries uniformly.
 *   4. Preserve the raw response body verbatim on failure (`networkErrorBody`).
 *
 * --- Kwanko API surface (verified against public docs, 2026-06-04) -------------
 *
 * Kwanko launched a RESTful "Web Service API" returning JSON. Confirmed facts:
 *   - Base URL: https://api.kwanko.com
 *       Sources: dltHub Kwanko source config (base_url "https://api.kwanko.com",
 *                bearer auth, resources "conversions" + "statistics");
 *                https://developers.kwanko.com/ ; corroborated by multiple
 *                third-party integration summaries.
 *   - Auth: a single API token issued in the Kwanko platform (Features and API),
 *           sent as `Authorization: Bearer {token}`. The token is NOT obtained
 *           via an OAuth exchange; it is copied directly from the dashboard.
 *   - Publisher capabilities (per https://developers.kwanko.com/): retrieve
 *           statistics, list campaigns and their information, list conversions
 *           (leads, sales, downloads with status).
 *
 * BLOCKED(verify): the exact path segments below and their query-parameter /
 * response-field names are NOT machine-readable from the developer reference
 * (developers.kwanko.com returns 403 to automated fetch). The adapter reads
 * every field defensively and preserves the verbatim payload in
 * `rawNetworkData`; a live-account test is required before promoting beyond
 * `experimental`.
 *
 *   GET /publisher/campaigns                  list campaigns (programmes)
 *   GET /publisher/campaigns/{campaignId}     single campaign info
 *   GET /publisher/conversions                conversions (transactions)
 *       ?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
 *   GET /publisher/statistics                 aggregate statistics (clicks etc.)
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('kwanko.client');

/**
 * The Kwanko Web Service API base URL.
 * Source: dltHub Kwanko source (base_url "https://api.kwanko.com");
 *         https://developers.kwanko.com/
 */
export const KWANKO_BASE_URL = 'https://api.kwanko.com';

export interface KwankoRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to the base URL. */
  path: string;
  /** Bearer API token issued in the Kwanko platform. */
  token: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Query string parameters. Values with `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Body for POST/PUT requests; serialised as JSON. */
  body?: unknown;
  /** Resilience knobs for this specific call. */
  resilience: ResilienceConfig;
  /** Override base URL (kept for symmetry with other adapters). */
  baseUrl?: string;
  /** Optional AbortSignal for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single Kwanko Web Service API request under the resilience policy.
 *
 * Why we don't validate response shapes with Zod: Kwanko's developer reference
 * is not machine-readable, so field names are not certain. Treating every field
 * as possibly absent and preserving `rawNetworkData` is more robust than a
 * schema that breaks on the first naming surprise.
 */
export async function kwankoRequest<T>(input: KwankoRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'kwanko', operation: input.operation };
  const base = input.baseUrl ?? KWANKO_BASE_URL;

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(base, input.path, input.query);
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

      log.debug({ url, method: init.method, operation: input.operation }, 'kwanko request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Kwanko ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
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
            network: 'kwanko',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Kwanko ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

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

export { HttpStatusError };
