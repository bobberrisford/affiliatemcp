/**
 * Skimlinks HTTP client — the ONLY path Skimlinks adapter methods use for network I/O.
 *
 * Why this file exists separately from `adapter.ts`:
 *   - Adapter methods speak in normalised domain types; URL construction, header
 *     building, JSON parsing, and status handling live here.
 *   - The resilience layer (timeout, retry policy, circuit breaker — see
 *     `src/shared/resilience.ts`) is applied uniformly, exactly once per call.
 *   - Skimlinks uses two distinct base URLs: the authentication endpoint for token
 *     fetching and the Reporting API for data retrieval. Both are centralised here.
 *
 * Hard rules:
 *   1. Do NOT call `fetch` from adapter.ts or anywhere else in this folder.
 *   2. Do NOT bypass `withResilience` for any call.
 *   3. On non-2xx, throw `HttpStatusError` so the resilience layer retries uniformly.
 *   4. Preserve the raw response body verbatim on failure (`networkErrorBody`).
 *
 * Skimlinks API surface (verified against public docs, 2026-05-28):
 *   - Authentication: POST https://authentication.skimapis.com/access_token
 *       with form-encoded client_id + client_secret → { access_token, token_type, expires_in }
 *   - Reporting API base: https://api-reports.skimlinks.com
 *       GET /publishers/{publisherId}/commissions?date_from=YYYY-MM-DD&date_to=YYYY-MM-DD
 *       Response: { count, commissions: [...] }
 *   - Merchant API: https://api-merchants.skimlinks.com — requires Product Key (managed accounts only)
 *       Source: https://blog.rapidapi.com/directory/skimlinks-merchant/
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('skimlinks.client');

/**
 * The Skimlinks OAuth2 token endpoint.
 * Verified from public Skimlinks documentation and integration guides.
 * Source: https://developers.skimlinks.com/reporting.html
 */
export const SKIMLINKS_AUTH_URL = 'https://authentication.skimapis.com/access_token';

/**
 * The Skimlinks Reporting API base URL.
 * Source: https://api-reports.skimlinks.com
 */
export const SKIMLINKS_REPORTING_BASE_URL = 'https://api-reports.skimlinks.com';

/**
 * The Skimlinks Merchant API base URL (managed accounts only, requires Product Key).
 * Confirmed base URL from multiple sources including RapidAPI directory and the
 * Skimlinks Merchant API Apiary documentation which references api-merchants.skimlinks.com.
 * The earlier placeholder `merchants.skimapis.com` was unverified; this is the
 * documented domain.
 * Source: https://blog.rapidapi.com/directory/skimlinks-merchant/
 *         https://skimlinksmerchantapi.docs.apiary.io/
 */
export const SKIMLINKS_MERCHANT_BASE_URL = 'https://api-merchants.skimlinks.com';

export interface SkimlinksRequestInput {
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
  /** Override base URL (e.g. merchant vs reporting endpoint). */
  baseUrl?: string;
  /** Optional AbortSignal for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single Skimlinks Reporting API request under the resilience policy.
 *
 * Why we don't validate response shapes with Zod: Skimlinks' docs document field
 * names but the field set can vary. Treating every field as possibly absent and
 * preserving `rawNetworkData` is more robust than a schema that breaks on drift.
 */
export async function skimlinksRequest<T>(input: SkimlinksRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'skimlinks', operation: input.operation };
  const base = input.baseUrl ?? SKIMLINKS_REPORTING_BASE_URL;

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

      log.debug({ url, method: init.method, operation: input.operation }, 'skimlinks request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Skimlinks ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
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
            network: 'skimlinks',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Skimlinks ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Fetch a Skimlinks OAuth2 access token via the client_credentials grant.
 *
 * POST https://authentication.skimapis.com/access_token
 *   Body: form-encoded client_id + client_secret + grant_type=client_credentials
 *   Response: { access_token, token_type, expires_in }
 *
 * Why we POST form-encoded rather than JSON: the Skimlinks OAuth2 endpoint follows
 * the OAuth2 spec (RFC 6749 §4.4) which specifies application/x-www-form-urlencoded
 * for the token endpoint. JSON bodies are not accepted.
 *
 * This function is called only from auth.ts (the token cache). Adapter operations
 * use the cached token via `getAccessToken()`.
 */
export async function fetchAccessToken(
  clientId: string,
  clientSecret: string,
  resilience: ResilienceConfig,
): Promise<{ accessToken: string; expiresAt: number }> {
  const ctx: WithResilienceContext = { network: 'skimlinks', operation: 'fetchAccessToken' };

  return withResilience(
    ctx,
    async () => {
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      });

      const res = await fetch(SKIMLINKS_AUTH_URL, {
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
          `Skimlinks token exchange → HTTP ${res.status}`,
        );
      }

      let parsed: { access_token?: string; expires_in?: number };
      try {
        parsed = JSON.parse(rawBody) as typeof parsed;
      } catch {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'auth_error',
            network: 'skimlinks',
            operation: 'fetchAccessToken',
            networkErrorBody: rawBody,
            message: 'Skimlinks token endpoint returned non-JSON body.',
            hint: 'Check SKIMLINKS_CLIENT_ID and SKIMLINKS_CLIENT_SECRET are correct.',
          }),
        );
      }

      if (!parsed.access_token) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'auth_error',
            network: 'skimlinks',
            operation: 'fetchAccessToken',
            networkErrorBody: rawBody,
            message: 'Skimlinks token endpoint returned a response with no access_token field.',
            hint: 'Verify SKIMLINKS_CLIENT_ID and SKIMLINKS_CLIENT_SECRET are correct.',
          }),
        );
      }

      // Skimlinks docs state tokens expire after a limited time (typically 1 hour).
      // We subtract a 60s buffer so we refresh before the upstream actually expires.
      const expiresIn = typeof parsed.expires_in === 'number' ? parsed.expires_in : 3600;
      const expiresAt = Date.now() + (expiresIn - 60) * 1000;

      log.debug({ expiresIn }, 'skimlinks access token fetched');
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
