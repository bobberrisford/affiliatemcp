/**
 * Hotmart HTTP client — the ONLY path Hotmart adapter methods use for network I/O.
 *
 * Why this file exists separately from `adapter.ts`:
 *   - Adapter methods speak in normalised domain types; URL construction, header
 *     building, JSON parsing, and status handling live here.
 *   - The resilience layer (timeout, retry policy, circuit breaker — see
 *     `src/shared/resilience.ts`) is applied uniformly, exactly once per call.
 *   - Hotmart uses two distinct hosts: the OAuth security host for token
 *     exchange and the developers host for the data APIs. Both are centralised
 *     here.
 *
 * Hard rules:
 *   1. Do NOT call `fetch` from adapter.ts or anywhere else in this folder.
 *   2. Do NOT bypass `withResilience` for any call.
 *   3. On non-2xx, throw `HttpStatusError` so the resilience layer retries uniformly.
 *   4. Preserve the raw response body verbatim on failure (`networkErrorBody`).
 *
 * --- Hotmart API surface (verified against public documentation, 2026-06-04) ---
 *
 * OAuth2 token exchange (2-legged client-credentials):
 *   POST https://api-sec-vlc.hotmart.com/security/oauth/token
 *     Headers: Authorization: Basic {base64(client_id:client_secret)}
 *     Query:   grant_type=client_credentials&client_id=...&client_secret=...
 *   → { access_token, token_type, expires_in, scope, jti }
 *   Source: https://developers.hotmart.com/docs/en/ (Start → Credentials/OAuth)
 *           https://help.hotmart.com/en/article/4403617024013/discover-hotmart-s-apis
 *           Corroborated by the public hotmart-python client README, which
 *           documents the `basic` credential as the Base64 client_id:client_secret
 *           string and a 24-hour token lifetime.
 *   BLOCKED(verify): whether the credentials must ALSO be passed in the query
 *           string when the Basic header is present, or whether the Basic header
 *           alone suffices, is ambiguous across third-party guides. We send both
 *           (Basic header + query params) because every public example does so
 *           and Hotmart's endpoint accepts the redundant parameters. Confirm
 *           against a live account before promoting claim_status.
 *
 * Data APIs (base: https://developers.hotmart.com):
 *   GET /payments/api/v1/sales/history
 *     ?start_date={epoch_ms}&end_date={epoch_ms}
 *     [&transaction_status=APPROVED|COMPLETE|REFUNDED|...]
 *     [&product_id={id}][&max_results=N][&page_token={token}]
 *   Response: { items: [{ purchase, product, buyer, producer, commissions[] }],
 *               page_info: { total_results, next_page_token, prev_page_token, results_per_page } }
 *   Source: https://developers.hotmart.com/docs/en/v1/sales/sales-history
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('hotmart.client');

/**
 * The Hotmart OAuth2 token endpoint (2-legged client-credentials).
 * Source: https://help.hotmart.com/en/article/4403617024013/discover-hotmart-s-apis
 */
export const HOTMART_AUTH_URL = 'https://api-sec-vlc.hotmart.com/security/oauth/token';

/**
 * The Hotmart developers API base host. Data endpoints hang off
 * `/payments/api/v1/...`.
 * Source: https://developers.hotmart.com/docs/en/v1/sales/sales-history
 */
export const HOTMART_API_BASE_URL = 'https://developers.hotmart.com';

export interface HotmartRequestInput {
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
 * Issue a single Hotmart data API request under the resilience policy.
 *
 * Why we don't validate response shapes with Zod: Hotmart's documented field
 * set is large and varies by transaction type (single vs subscription, with or
 * without coproducers). Treating every field as possibly absent and preserving
 * `rawNetworkData` is more robust than a schema that breaks on drift.
 */
export async function hotmartRequest<T>(input: HotmartRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'hotmart', operation: input.operation };
  const base = input.baseUrl ?? HOTMART_API_BASE_URL;

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

      log.debug({ url, method: init.method, operation: input.operation }, 'hotmart request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Hotmart ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
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
            network: 'hotmart',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Hotmart ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Fetch a Hotmart OAuth2 access token via the 2-legged client-credentials grant.
 *
 * POST https://api-sec-vlc.hotmart.com/security/oauth/token
 *   Headers: Authorization: Basic {base64(client_id:client_secret)}
 *   Query:   grant_type=client_credentials&client_id=...&client_secret=...
 *   Response: { access_token, token_type, expires_in, ... }
 *
 * Why the Basic header AND the query parameters: Hotmart's published examples
 * use a Base64 `client_id:client_secret` Basic header while also repeating the
 * id/secret in the query string. We replicate both; the endpoint tolerates the
 * redundancy. See the BLOCKED(verify) note in this file's header.
 *
 * This function is called only from auth.ts (the token cache). Adapter
 * operations use the cached token via `getAccessToken()`.
 */
export async function fetchAccessToken(
  clientId: string,
  clientSecret: string,
  resilience: ResilienceConfig,
  basicTokenOverride?: string,
): Promise<{ accessToken: string; expiresAt: number }> {
  const ctx: WithResilienceContext = { network: 'hotmart', operation: 'fetchAccessToken' };

  return withResilience(
    ctx,
    async () => {
      // The Basic credential is base64(client_id:client_secret). Hotmart's
      // Developer Tools page shows this value precomputed as the "Basic" token;
      // if the user supplied it explicitly we use it verbatim, otherwise we
      // derive it from the id/secret so callers need not paste a third value.
      const basic =
        basicTokenOverride && basicTokenOverride.trim() !== ''
          ? basicTokenOverride.trim()
          : Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

      const url = buildUrl(HOTMART_AUTH_URL, '', {
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      });

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${basic}`,
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
      });

      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Hotmart token exchange → HTTP ${res.status}`,
        );
      }

      let parsed: { access_token?: string; expires_in?: number };
      try {
        parsed = JSON.parse(rawBody) as typeof parsed;
      } catch {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'auth_error',
            network: 'hotmart',
            operation: 'fetchAccessToken',
            networkErrorBody: rawBody,
            message: 'Hotmart token endpoint returned a non-JSON body.',
            hint: 'Check HOTMART_CLIENT_ID and HOTMART_CLIENT_SECRET are correct.',
          }),
        );
      }

      if (!parsed.access_token) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'auth_error',
            network: 'hotmart',
            operation: 'fetchAccessToken',
            networkErrorBody: rawBody,
            message: 'Hotmart token endpoint returned a response with no access_token field.',
            hint: 'Verify HOTMART_CLIENT_ID and HOTMART_CLIENT_SECRET are correct.',
          }),
        );
      }

      // Hotmart tokens are documented as valid for 24 hours. We subtract a
      // 60s buffer so we refresh before the upstream actually expires.
      const expiresIn = typeof parsed.expires_in === 'number' ? parsed.expires_in : 86_400;
      const expiresAt = Date.now() + (expiresIn - 60) * 1000;

      log.debug({ expiresIn }, 'hotmart access token fetched');
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
  const url = pathname
    ? new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, base)
    : new URL(base);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export { HttpStatusError };
