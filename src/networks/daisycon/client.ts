/**
 * Daisycon HTTP client — the ONLY path Daisycon adapter methods use for network I/O.
 *
 * Why this file exists separately from `adapter.ts`:
 *   - Adapter methods speak in normalised domain types; URL construction, header
 *     building, JSON parsing, and status handling live here.
 *   - The resilience layer (timeout, retry policy, circuit breaker — see
 *     `src/shared/resilience.ts`) is applied uniformly, exactly once per call.
 *   - Daisycon uses two distinct base hosts: the OAuth host for token exchange
 *     and the services host for data retrieval. Both are centralised here.
 *
 * Hard rules:
 *   1. Do NOT call `fetch` from adapter.ts or anywhere else in this folder.
 *   2. Do NOT bypass `withResilience` for any call.
 *   3. On non-2xx, throw `HttpStatusError` so the resilience layer retries uniformly.
 *   4. Preserve the raw response body verbatim on failure (`networkErrorBody`).
 *
 * --- Daisycon API surface (verified against public sources, 2026-06-04) --------
 *
 *   OAuth host: https://login.daisycon.com
 *     POST /oauth/access-token
 *       Daisycon's documented interactive grant is authorization_code with PKCE;
 *       once a refresh token has been obtained (one-time, via Daisycon's own
 *       console / CLI), the non-interactive grant is `refresh_token`. This adapter
 *       uses the refresh_token grant — it is the only documented self-serve flow
 *       that returns an access token without a browser redirect.
 *       Source: https://github.com/DaisyconBV/oauth-examples (PHP cli-client.php)
 *               https://github.com/whitelabeled/daisycon-api-client
 *                 (refreshAccessToken → grant_type=refresh_token at this URL)
 *     BLOCKED(verify): whether Daisycon also exposes a pure client_credentials
 *     grant for first-party publisher accounts is not documented publicly; if it
 *     does, DAISYCON_REFRESH_TOKEN could be dropped. Confirm against a live account.
 *
 *   Services host: https://services.daisycon.com
 *     GET /publishers/{publisherId}/transactions
 *       ?page=N&per_page=N&date_modified_start=YYYY-MM-DD[&date_modified_end=YYYY-MM-DD]
 *       [&currency_code=ISO4217][&status=open|approved|disapproved|paid|pending]
 *       [&program_id=N][&media_id=N]
 *       Total row count is returned in the `x-total-count` response header.
 *       Source: https://github.com/whitelabeled/daisycon-api-client
 *                 (DaisyconClient::getTransactions; base host + path + per_page=200
 *                  + page-based pagination + x-total-count header confirmed)
 *               https://strackr.com/docs/daisycon (publisher_id required; status
 *                 values open/approved/disapproved; program_id/media_id filters)
 *     GET /publishers/{publisherId}/programs
 *       ?page=N&per_page=N[&media_id=N]
 *       BLOCKED(verify): the exact programmes path and its parameter set are
 *       documented only via secondary sources; confirm against a live account.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('daisycon.client');

/**
 * The Daisycon OAuth2 token endpoint.
 * Source: https://github.com/DaisyconBV/oauth-examples (urlAccessToken in cli-client.php)
 */
export const DAISYCON_AUTH_URL = 'https://login.daisycon.com/oauth/access-token';

/**
 * The Daisycon services (data) API base host.
 * Source: https://github.com/whitelabeled/daisycon-api-client
 */
export const DAISYCON_SERVICES_BASE_URL = 'https://services.daisycon.com';

export interface DaisyconRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to the base URL. */
  path: string;
  /** Bearer access token from the OAuth2 token exchange. */
  token: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Query string parameters. Values with `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Body for POST/PUT requests; serialised as JSON. */
  body?: unknown;
  /** Resilience knobs for this specific call. */
  resilience: ResilienceConfig;
  /** Override base URL. */
  baseUrl?: string;
  /** Optional AbortSignal for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

export interface DaisyconResponse<T> {
  body: T;
  /** Total row count across all pages, read from the `x-total-count` header (NaN if absent). */
  totalCount: number;
}

/**
 * Issue a single Daisycon services API request under the resilience policy.
 *
 * Why we don't validate response shapes with Zod: Daisycon's field set varies
 * across resources and account types. Treating every field as possibly absent
 * and preserving `rawNetworkData` is more robust than a schema that breaks on
 * drift. The `x-total-count` header is surfaced so callers can paginate.
 */
export async function daisyconRequest<T>(
  input: DaisyconRequestInput,
): Promise<DaisyconResponse<T>> {
  const ctx: WithResilienceContext = { network: 'daisycon', operation: input.operation };
  const base = input.baseUrl ?? DAISYCON_SERVICES_BASE_URL;

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

      log.debug({ url, method: init.method, operation: input.operation }, 'daisycon request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Daisycon ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
        );
      }

      const totalCountHeader = res.headers.get('x-total-count');
      const totalCount = totalCountHeader === null ? NaN : Number(totalCountHeader);

      if (rawBody.trim() === '') {
        return { body: [] as unknown as T, totalCount };
      }

      try {
        return { body: JSON.parse(rawBody) as T, totalCount };
      } catch (err) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: 'daisycon',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Daisycon ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Fetch a Daisycon OAuth2 access token via the refresh_token grant.
 *
 * POST https://login.daisycon.com/oauth/access-token
 *   Body (form-encoded): grant_type=refresh_token&client_id=...&client_secret=...
 *                        &refresh_token=...
 *   Response: { access_token, token_type, expires_in, refresh_token? }
 *
 * Why form-encoded: Daisycon follows the OAuth2 spec (RFC 6749), whose token
 * endpoint requires application/x-www-form-urlencoded.
 *
 * Why the refresh_token grant rather than client_credentials: Daisycon's
 * documented machine flow is authorization_code + PKCE for the one-time consent,
 * then refresh_token for every subsequent token. The user obtains the initial
 * refresh token once via Daisycon's console / CLI; the adapter never performs
 * the interactive redirect.
 *
 * This function is called only from auth.ts (the token cache). Adapter operations
 * use the cached token via `getAccessToken()`.
 */
export async function fetchAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  resilience: ResilienceConfig,
): Promise<{ accessToken: string; expiresAt: number }> {
  const ctx: WithResilienceContext = { network: 'daisycon', operation: 'fetchAccessToken' };

  return withResilience(
    ctx,
    async () => {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
      });

      const res = await fetch(DAISYCON_AUTH_URL, {
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
          `Daisycon token exchange → HTTP ${res.status}`,
        );
      }

      let parsed: { access_token?: string; expires_in?: number };
      try {
        parsed = JSON.parse(rawBody) as typeof parsed;
      } catch {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'auth_error',
            network: 'daisycon',
            operation: 'fetchAccessToken',
            networkErrorBody: rawBody,
            message: 'Daisycon token endpoint returned non-JSON body.',
            hint: 'Check DAISYCON_CLIENT_ID, DAISYCON_CLIENT_SECRET and DAISYCON_REFRESH_TOKEN are correct.',
          }),
        );
      }

      if (!parsed.access_token) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'auth_error',
            network: 'daisycon',
            operation: 'fetchAccessToken',
            networkErrorBody: rawBody,
            message: 'Daisycon token endpoint returned a response with no access_token field.',
            hint: 'Verify DAISYCON_REFRESH_TOKEN has not expired; re-run the Daisycon authorisation step if it has.',
          }),
        );
      }

      // Daisycon access tokens are short-lived. We subtract a 60s buffer so we
      // refresh before the upstream actually expires.
      const expiresIn = typeof parsed.expires_in === 'number' ? parsed.expires_in : 3600;
      const expiresAt = Date.now() + (expiresIn - 60) * 1000;

      log.debug({ expiresIn }, 'daisycon access token fetched');
      return { accessToken: parsed.access_token, expiresAt };
    },
    resilience,
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
