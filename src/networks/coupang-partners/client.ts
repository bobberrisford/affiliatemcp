/**
 * Coupang Partners HTTP client — the ONLY path Coupang Partners adapter methods
 * use for network I/O.
 *
 * Why this file exists separately from `adapter.ts`:
 *   - Adapter methods speak in normalised domain types; URL construction, the
 *     per-request HMAC header, JSON parsing, and status handling live here.
 *   - The resilience layer (timeout, retry policy, circuit breaker — see
 *     `src/shared/resilience.ts`) is applied uniformly, exactly once per call.
 *
 * Hard rules (same as every adapter):
 *   1. Do NOT call `fetch` from `adapter.ts` directly — go through `coupangRequest`.
 *   2. Do NOT bypass `withResilience` for any call.
 *   3. On a non-2xx response throw `HttpStatusError` so the resilience layer
 *      applies its retry policy uniformly.
 *   4. Preserve the raw response body verbatim on failure (`networkErrorBody`).
 *
 * --- Coupang Partners API surface (verified against public docs, 2026-06-04) ---
 *
 * Base host: https://api-gateway.coupang.com
 *
 * Reports / commission (publisher conversions + commission, daily rows):
 *   GET /v2/providers/affiliate_open_api/apis/openapi/v1/reports/commission
 *       ?startDate=YYYYMMDD&endDate=YYYYMMDD&page=N
 *   → { data: [ { date, clickCount, orderCount, gmv, commission, ... } ] }
 *   Source: https://github.com/nicecoding1/python_example/blob/main/coupang_commission.py
 *
 * Deeplink (tracking-link generation, REAL API call):
 *   POST /v2/providers/affiliate_open_api/apis/openapi/v1/deeplink
 *       body: { coupangUrls: string[], subId?: string }
 *   → { data: [ { originalUrl, shortenUrl, landingUrl } ] }
 *   Source: https://github.com/JEJEMEME/PCoupangAPI (create_deeplink)
 *
 * Authentication: HMAC-SHA256 via the CEA scheme. See `auth.ts` for the exact
 * message construction and `Authorization` header format.
 *
 * Auth scheme + base URL source:
 *   https://partner-developers.coupangcorp.com/hc/en-us/articles/360053719371-Create-HMAC-Signature
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';
import { buildAuthorizationHeader } from './auth.js';

const log = createLogger('coupang-partners.client');

const SLUG = 'coupang-partners';

/** Coupang's API gateway host. Verified from public docs + reference clients. */
export const COUPANG_BASE_URL = 'https://api-gateway.coupang.com';

/** Reports / commission endpoint path (publisher conversions + commission). */
export const REPORTS_COMMISSION_PATH =
  '/v2/providers/affiliate_open_api/apis/openapi/v1/reports/commission';

/** Deeplink (tracking-link) endpoint path. */
export const DEEPLINK_PATH = '/v2/providers/affiliate_open_api/apis/openapi/v1/deeplink';

export interface CoupangRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  method?: 'GET' | 'POST';
  /** Path beginning with `/`, WITHOUT host. */
  path: string;
  /** Query string parameters. Values with `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Body for POST requests; serialised as JSON. */
  body?: unknown;
  /** Coupang Partners Access Key. */
  accessKey: string;
  /** Coupang Partners Secret Key — used to sign the request. */
  secretKey: string;
  /** Resilience knobs for this specific call. */
  resilience: ResilienceConfig;
  /**
   * Injectable clock for deterministic signing in tests. Threaded straight
   * through to the HMAC builder.
   */
  now?: Date;
  /** Override the signed-date directly (tests). */
  signedDate?: string;
  /** Optional AbortSignal for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Build the canonical query string Coupang signs over.
 *
 * The signature must match the query string actually sent, byte for byte.
 * We build the query string once here, sign it, then append it to the URL —
 * guaranteeing the signed message and the wire query agree.
 *
 * Coupang's reference clients do NOT URL-encode the report query values
 * (dates and integer pages need no encoding) and join with `&`. We mirror that
 * for the values that never need encoding, but encode each value defensively
 * for safety on free-text params (e.g. nothing today, but future-proof). For
 * the values used by this adapter (dates, integers) the two are identical.
 */
export function buildQueryString(
  query?: Record<string, string | number | undefined>,
): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    parts.push(`${k}=${encodeURIComponent(String(v))}`);
  }
  return parts.join('&');
}

/**
 * Issue a single Coupang Partners API request under the resilience policy.
 *
 * The HMAC `Authorization` header is built here, per request, from the path +
 * query string + method + credentials. This is NOT a bearer token; the
 * signature changes on every call (it embeds the signed-date), which is why
 * the header is constructed in the client rather than cached.
 *
 * Why we don't validate response shapes with Zod: Coupang documents field
 * names in Korean and the field set varies across report types. Treating every
 * field as possibly absent and preserving `rawNetworkData` is more robust.
 */
export async function coupangRequest<T>(input: CoupangRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };
  const method = input.method ?? 'GET';

  return withResilience(
    ctx,
    async () => {
      const queryString = buildQueryString(input.query);
      const { authorization } = buildAuthorizationHeader({
        method,
        path: input.path,
        query: queryString,
        accessKey: input.accessKey,
        secretKey: input.secretKey,
        now: input.now,
        signedDate: input.signedDate,
      });

      const url = queryString
        ? `${COUPANG_BASE_URL}${input.path}?${queryString}`
        : `${COUPANG_BASE_URL}${input.path}`;

      const headers: Record<string, string> = {
        Authorization: authorization,
        Accept: 'application/json',
        // Coupang Open API requires an X-Requested-By header on its requests.
        'X-Requested-By': 'affiliate-mcp',
      };
      const init: RequestInit = { method, headers };
      if (input.body !== undefined) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(input.body);
      }
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ url, method, operation: input.operation }, 'coupang-partners request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Coupang Partners ${input.operation} ${method} ${input.path} → HTTP ${res.status}`,
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
            message: `Coupang Partners ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

export { HttpStatusError };
