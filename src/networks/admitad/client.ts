/**
 * Admitad HTTP client — the ONLY path Admitad adapter methods use for network I/O.
 *
 * Why this file exists separately from `adapter.ts`:
 *   - Adapter methods speak in normalised domain types; URL construction, header
 *     building, JSON parsing, and status handling live here.
 *   - The resilience layer (timeout, retry policy, circuit breaker — see
 *     `src/shared/resilience.ts`) is applied uniformly, exactly once per call.
 *   - The OAuth2 token endpoint and the data API share one host
 *     (https://api.admitad.com); both are centralised here.
 *
 * Hard rules:
 *   1. Do NOT call `fetch` from adapter.ts or anywhere else in this folder.
 *   2. Do NOT bypass `withResilience` for any call.
 *   3. On non-2xx, throw `HttpStatusError` so the resilience layer retries uniformly.
 *   4. Preserve the raw response body verbatim on failure (`networkErrorBody`).
 *
 * Admitad API surface (verified against public docs + the official/forked Python
 * wrapper, 2026-06-04):
 *   - Authentication: POST https://api.admitad.com/token/
 *       Header: Authorization: Basic base64(client_id:client_secret)
 *       Body (form-encoded): grant_type=client_credentials&client_id=...&scope=...
 *       Response: { access_token, token_type, expires_in, scope }
 *       Source: https://developers.admitad.com/knowledge-base/article/client-authorization_2
 *   - Data API base: https://api.admitad.com
 *       GET /statistics/actions/   scope: statistics   (date_start/date_end as DD.MM.YYYY)
 *       GET /statistics/dates/      scope: statistics
 *       GET /advcampaigns/          scope: advcampaigns
 *       GET /advcampaigns/{id}/     scope: advcampaigns
 *       GET /me/                    scope: private_data
 *       GET /deeplink/{website_id}/advcampaign/{campaign_id}/?ulp=...  scope: deeplink_generator
 *       Responses paginate as { results: [...], _meta: { count, limit, offset } }
 *       Source: https://developers.admitad.com/en/doc/api_en/methods/statistics/statistics-actions/
 *               (Python wrapper: trezorg/admitad-python-api pyadmitad/items/*.py)
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('admitad.client');

/**
 * The Admitad OAuth2 token endpoint.
 * Source: https://developers.admitad.com/knowledge-base/article/client-authorization_2
 */
export const ADMITAD_TOKEN_URL = 'https://api.admitad.com/token/';

/**
 * The Admitad data API base URL.
 * Source: https://developers.admitad.com/
 */
export const ADMITAD_BASE_URL = 'https://api.admitad.com';

export interface AdmitadRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to the base URL. */
  path: string;
  /** Bearer access token from OAuth2 token exchange. */
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

/**
 * Issue a single Admitad data API request under the resilience policy.
 *
 * Why we don't validate response shapes with Zod: Admitad documents field names
 * but the field set can vary across endpoints and over time. Treating every field
 * as possibly absent and preserving `rawNetworkData` is more robust than a schema
 * that breaks on drift.
 */
export async function admitadRequest<T>(input: AdmitadRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'admitad', operation: input.operation };
  const base = input.baseUrl ?? ADMITAD_BASE_URL;

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

      log.debug({ url, method: init.method, operation: input.operation }, 'admitad request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Admitad ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
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
            network: 'admitad',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Admitad ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Fetch an Admitad OAuth2 access token via the client_credentials grant.
 *
 * POST https://api.admitad.com/token/
 *   Header: Authorization: Basic base64(client_id:client_secret)
 *   Body: grant_type=client_credentials&client_id=...&scope=<space-separated scopes>
 *   Response: { access_token, token_type, expires_in, scope }
 *
 * Why we POST form-encoded with a Basic auth header: the Admitad client
 * authorization article documents exactly this shape — the client_id/client_secret
 * pair is base64-encoded into the Authorization header, and the body carries
 * grant_type, client_id, and the space-separated scope list.
 * Source: https://developers.admitad.com/knowledge-base/article/client-authorization_2
 *
 * This function is called only from auth.ts (the token cache). Adapter operations
 * use the cached token via `getAccessToken()`.
 */
export async function fetchAccessToken(
  clientId: string,
  clientSecret: string,
  scope: string,
  resilience: ResilienceConfig,
): Promise<{ accessToken: string; expiresAt: number }> {
  const ctx: WithResilienceContext = { network: 'admitad', operation: 'fetchAccessToken' };

  return withResilience(
    ctx,
    async () => {
      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        scope,
      });

      const res = await fetch(ADMITAD_TOKEN_URL, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
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
          `Admitad token exchange → HTTP ${res.status}`,
        );
      }

      let parsed: { access_token?: string; expires_in?: number };
      try {
        parsed = JSON.parse(rawBody) as typeof parsed;
      } catch {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'auth_error',
            network: 'admitad',
            operation: 'fetchAccessToken',
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: 'Admitad token endpoint returned non-JSON body.',
            hint: 'Check ADMITAD_CLIENT_ID and ADMITAD_CLIENT_SECRET are correct.',
          }),
        );
      }

      if (!parsed.access_token) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'auth_error',
            network: 'admitad',
            operation: 'fetchAccessToken',
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: 'Admitad token endpoint returned a response with no access_token field.',
            hint: 'Verify ADMITAD_CLIENT_ID and ADMITAD_CLIENT_SECRET and that the requested scopes are enabled for the API application.',
          }),
        );
      }

      // Admitad tokens carry an `expires_in` (seconds). We subtract a 60s buffer
      // so we refresh before the upstream actually expires.
      const expiresIn = typeof parsed.expires_in === 'number' ? parsed.expires_in : 3600;
      const expiresAt = Date.now() + (expiresIn - 60) * 1000;

      log.debug({ expiresIn }, 'admitad access token fetched');
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
