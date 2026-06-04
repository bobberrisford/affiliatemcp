/**
 * Indoleads HTTP client — the ONLY path Indoleads adapter methods use for network I/O.
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
 * Indoleads API surface (confirmed against public docs, 2026-06-04):
 *   - Base route: https://app.indoleads.com/api
 *       Source: https://indoleads.atlassian.net/wiki/spaces/PUB/pages/53476781/API
 *               (confirmed via search-engine snippets + https://strackr.com/docs/indoleads)
 *   - Authentication: a single self-issued API token, retrieved from
 *       Account → API Settings. It may be sent either as an
 *       `Authorization: Bearer {token}` header OR as a `?token={token}` GET
 *       parameter. This client uses the Authorization header.
 *       Confirmed verbatim curl example from the public docs:
 *         curl -H 'Accept: application/json' \
 *              -H "Authorization: Bearer ${TOKEN}" \
 *              https://app.indoleads.com/api/offers
 *   - Offers: GET /api/offers  (confirmed verbatim path)
 *       Filters: type, category, status, geo, keyword; pass `source_id` to
 *       include tracking links in the response.
 *   - Conversions report: a "Get conversions report" endpoint is documented as
 *       a self-serve publisher endpoint. Its exact path and response field names
 *       are not visible in the public snippets (the full Confluence page is
 *       access-gated). This client targets GET /api/conversions.
 *       BLOCKED(verify): confirm path + payload against a live account.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('indoleads.client');

/**
 * The Indoleads API base route.
 * Source: https://indoleads.atlassian.net/wiki/spaces/PUB/pages/53476781/API
 */
export const INDOLEADS_BASE_URL = 'https://app.indoleads.com/api';

export interface IndoleadsRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to the base URL. */
  path: string;
  /** Self-issued API token from Account → API Settings. */
  token: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Query string parameters. Values with `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Body for POST/PUT requests; serialised as JSON. */
  body?: unknown;
  /** Resilience knobs for this specific call. */
  resilience: ResilienceConfig;
  /** Override base URL (rarely needed; defaults to INDOLEADS_BASE_URL). */
  baseUrl?: string;
  /** Optional AbortSignal for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single Indoleads API request under the resilience policy.
 *
 * Why we don't validate response shapes with Zod: the public documentation
 * snippets do not pin down every field name, and the conversions payload shape
 * is unverified against a live account. Treating every field as possibly absent
 * and preserving `rawNetworkData` is more robust than a schema that breaks on
 * drift.
 */
export async function indoleadsRequest<T>(input: IndoleadsRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'indoleads', operation: input.operation };
  const base = input.baseUrl ?? INDOLEADS_BASE_URL;

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

      log.debug({ url, method: init.method, operation: input.operation }, 'indoleads request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Indoleads ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
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
            network: 'indoleads',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Indoleads ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
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
  // Indoleads base ends in `/api`; preserve it by ensuring the base has a
  // trailing slash before resolving the (relative) path. Using a leading-slash
  // path against `https://app.indoleads.com/api` would otherwise drop `/api`.
  const baseWithSlash = base.endsWith('/') ? base : `${base}/`;
  const relPath = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  const url = new URL(relPath, baseWithSlash);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export { HttpStatusError };
