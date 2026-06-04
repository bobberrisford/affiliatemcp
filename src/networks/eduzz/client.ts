/**
 * Eduzz HTTP client — the ONLY path Eduzz adapter methods use for network I/O.
 *
 * Why this file exists separately from `adapter.ts`:
 *   - Adapter methods speak in normalised domain types; URL construction, header
 *     building, JSON parsing, and status handling live here.
 *   - The resilience layer (timeout, retry policy, circuit breaker — see
 *     `src/shared/resilience.ts`) is applied uniformly, exactly once per call.
 *   - Eduzz uses a single base URL for both the token exchange and the data
 *     endpoints; both are centralised here.
 *
 * Hard rules:
 *   1. Do NOT call `fetch` from adapter.ts or anywhere else in this folder.
 *   2. Do NOT bypass `withResilience` for any call.
 *   3. On non-2xx, throw `HttpStatusError` so the resilience layer retries uniformly.
 *   4. Preserve the raw response body verbatim on failure (`networkErrorBody`).
 *
 * --- Eduzz API surface (verified against public docs, 2026-06-04) -------------
 *
 * Auth (token exchange):
 *   POST https://api2.eduzz.com/credential/generate_token
 *     form fields: email, publickey, apikey
 *   → { profile: { token, token_valid_until, ... }, data?: {...} }
 *   The JWT is valid for ~15 minutes (renewed automatically near expiry).
 *   The JWT is then sent as the `token` header on every subsequent request.
 *   Source: https://api2.eduzz.com/  and  https://developers.eduzz.com/docs/api/user-token
 *
 * Sales (transactions):
 *   GET https://api2.eduzz.com/sale/get_sale_list?date_start=YYYY-MM-DD&date_end=YYYY-MM-DD
 *   → { profile: {...}, data: [ { sale_id, sale_status, content_id, content_title,
 *        value, currency, affiliate_value, date_create, date_payment, ... } ] }
 *   BLOCKED(verify): exact query-parameter and item field names could not be read
 *   from the live reference (developers.eduzz.com returns HTTP 403 to automated
 *   fetches). The route, the date_start/date_end window params, and the response
 *   envelope ({ profile, data }) are documented on https://api2.eduzz.com/ and in
 *   the eduzz/ecommerce-integration-samples repository; the precise field set is
 *   read defensively and the verbatim payload is preserved in `rawNetworkData`.
 *
 * Products (programmes):
 *   GET https://api2.eduzz.com/product/get_product_list
 *   → { profile: {...}, data: [ { content_id, title, price, ... } ] }
 *   Source: https://api2.eduzz.com/
 *
 * Eduzz wraps every response in `{ profile, data }`; the payload of interest is
 * always `data`. We unwrap defensively in the adapter.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('eduzz.client');

/**
 * The Eduzz API base URL (legacy api2 host — the self-serve, documented surface
 * for the email + PublicKey + APIKey token-exchange flow).
 * Source: https://api2.eduzz.com/
 */
export const EDUZZ_BASE_URL = 'https://api2.eduzz.com';

/**
 * The Eduzz token-exchange endpoint.
 * Source: https://api2.eduzz.com/  and  https://developers.eduzz.com/docs/api/user-token
 */
export const EDUZZ_TOKEN_PATH = '/credential/generate_token';

export interface EduzzRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to the base URL. */
  path: string;
  /** JWT token obtained from the token exchange; sent as the `token` header. */
  token: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Query string parameters. Values with `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Body for POST/PUT requests; serialised as JSON. */
  body?: unknown;
  /** Resilience knobs for this specific call. */
  resilience: ResilienceConfig;
  /** Optional AbortSignal for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single Eduzz API request under the resilience policy.
 *
 * Why we don't validate response shapes with Zod: Eduzz's legacy api2 docs
 * document field names but the field set varies across products and is partly
 * locale-specific. Treating every field as possibly absent and preserving
 * `rawNetworkData` is more robust than a schema that breaks on drift.
 */
export async function eduzzRequest<T>(input: EduzzRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'eduzz', operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(EDUZZ_BASE_URL, input.path, input.query);
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

      log.debug({ url, method: init.method, operation: input.operation }, 'eduzz request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Eduzz ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
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
            network: 'eduzz',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Eduzz ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Exchange email + PublicKey + APIKey for a short-lived JWT token.
 *
 * POST https://api2.eduzz.com/credential/generate_token
 *   form-encoded: email, publickey, apikey
 *   Response: { profile: { token, token_valid_until }, ... }
 *
 * Why form-encoded rather than JSON: the documented examples on
 * https://api2.eduzz.com/ post the credentials as form fields (`-F publickey=...`).
 *
 * This function is called only from auth.ts (the token cache). Adapter operations
 * use the cached token via `getToken()`.
 */
export async function fetchToken(
  email: string,
  publicKey: string,
  apiKey: string,
  resilience: ResilienceConfig,
): Promise<{ token: string; expiresAt: number }> {
  const ctx: WithResilienceContext = { network: 'eduzz', operation: 'fetchToken' };

  return withResilience(
    ctx,
    async () => {
      const body = new URLSearchParams({
        email,
        publickey: publicKey,
        apikey: apiKey,
      });

      const res = await fetch(`${EDUZZ_BASE_URL}${EDUZZ_TOKEN_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: body.toString(),
      });

      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Eduzz token exchange → HTTP ${res.status}`,
        );
      }

      let parsed: EduzzTokenResponse;
      try {
        parsed = JSON.parse(rawBody) as EduzzTokenResponse;
      } catch {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'auth_error',
            network: 'eduzz',
            operation: 'fetchToken',
            networkErrorBody: rawBody,
            message: 'Eduzz token endpoint returned a non-JSON body.',
            hint: 'Check EDUZZ_EMAIL, EDUZZ_PUBLIC_KEY and EDUZZ_API_KEY are correct.',
          }),
        );
      }

      const token = parsed.profile?.token;
      if (!token) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'auth_error',
            network: 'eduzz',
            operation: 'fetchToken',
            networkErrorBody: rawBody,
            message: 'Eduzz token endpoint returned a response with no profile.token field.',
            hint: 'Verify EDUZZ_EMAIL, EDUZZ_PUBLIC_KEY and EDUZZ_API_KEY are correct.',
          }),
        );
      }

      // Eduzz JWTs are valid for ~15 minutes. We compute the expiry from
      // token_valid_until when present, otherwise assume 15 minutes, and subtract a
      // 60s buffer so we refresh before the upstream actually expires.
      const expiresAt = computeExpiry(parsed.profile?.token_valid_until);

      log.debug({ expiresAt: new Date(expiresAt).toISOString() }, 'eduzz token fetched');
      return { token, expiresAt };
    },
    resilience,
  );
}

interface EduzzTokenResponse {
  profile?: {
    token?: string;
    /** ISO-8601 or unix timestamp string; format varies. */
    token_valid_until?: string | number;
  };
}

/**
 * Compute the cache expiry (ms since epoch) for an Eduzz token.
 *
 * `token_valid_until` may be an ISO string, a unix-seconds number, or absent.
 * When it cannot be parsed we fall back to 15 minutes from now (the documented
 * Eduzz JWT lifetime). A 60-second safety buffer is always subtracted.
 */
function computeExpiry(validUntil: string | number | undefined): number {
  const FIFTEEN_MIN_MS = 15 * 60 * 1000;
  const BUFFER_MS = 60 * 1000;
  const fallback = Date.now() + FIFTEEN_MIN_MS - BUFFER_MS;

  if (validUntil === undefined || validUntil === null) return fallback;

  if (typeof validUntil === 'number') {
    // Heuristic: seconds vs milliseconds.
    const ms = validUntil < 1e12 ? validUntil * 1000 : validUntil;
    return ms - BUFFER_MS;
  }

  const parsedMs = Date.parse(validUntil);
  if (!Number.isNaN(parsedMs)) return parsedMs - BUFFER_MS;

  return fallback;
}

function buildHeaders(token: string, hasBody: boolean): Record<string, string> {
  // Eduzz api2 expects the JWT in a `token` header (not Authorization: Bearer).
  // Source: https://api2.eduzz.com/ — "use this JWT Token (as 'token') in the header".
  const headers: Record<string, string> = {
    token,
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
