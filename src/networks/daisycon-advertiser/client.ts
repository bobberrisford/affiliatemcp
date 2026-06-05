/**
 * Daisycon advertiser HTTP client — the ONLY path this adapter uses for I/O.
 *
 * READ-ONLY by design: the client refuses any non-GET method at runtime so a
 * future contributor cannot accidentally ship a write operation against the
 * advertiser surface. This is belt-and-braces alongside the read-only OAuth
 * scope we recommend in the setup notes (Daisycon's advertiser scope can be
 * limited to reading advertiser, campaign and user-profile data).
 *
 * Hard rules:
 *   1. Do NOT call `fetch` from adapter.ts or anywhere else in this folder.
 *   2. Do NOT bypass `withResilience` for any call.
 *   3. On non-2xx, throw `HttpStatusError` so the resilience layer retries uniformly.
 *   4. Preserve the raw response body verbatim on failure (`networkErrorBody`).
 *   5. NEVER issue a non-GET request — the guard below refuses it.
 *
 * --- Daisycon advertiser API surface (verified against public sources) ---------
 *
 *   OAuth host: https://login.daisycon.com
 *     POST /oauth/access-token   (grant_type=refresh_token)
 *       Source: https://github.com/DaisyconBV/oauth-examples (cli-client.php)
 *               https://github.com/aiwha-dev/DaisyconApi (RestClient.php)
 *
 *   Services host: https://services.daisycon.com
 *     GET /advertisers
 *       Lists the advertiser accounts the credential is connected to.
 *       Source: https://github.com/aiwha-dev/DaisyconApi (RestClient.php
 *                 getAdvertisers() → /advertisers; API_BASE_URL =
 *                 https://services.daisycon.com; Bearer token header)
 *     GET /advertisers/{advertiserId}/transactions
 *       ?page=N&per_page=N[&start=YYYY-MM-DD][&end=YYYY-MM-DD]
 *       [&status=open|approved|disapproved][&media_id=N][&program_id=N]
 *       Advertiser-scoped transactions. The transactions resource exposes
 *       advertiser_id / media_id / program_id filters and statuses
 *       open|approved|disapproved.
 *       Source: https://github.com/aiwha-dev/DaisyconApi (RestClient.php
 *                 documents getAdvertisersTransactions(ADVERTISERID, [filters])
 *                 → /advertisers/{advertiser_id}/transactions)
 *               https://docs.datavirtuality.com/connectors/daisycon-api-reference
 *                 (transactions filter set + status enum)
 *               https://strackr.com/docs/daisycon
 *       Total row count is returned in the `x-total-count` response header
 *       (same pagination convention as the publisher transactions resource).
 *     BLOCKED(verify): the exact advertiser transactions query parameter names
 *     (page size cap, date-filter field names) and whether Daisycon exposes a
 *     dedicated advertiser-scoped statistics/grouping endpoint are documented
 *     only via secondary sources; confirm against a live advertiser account.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { AnyOperation, ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

import { SLUG } from './auth.js';

const log = createLogger('daisycon-advertiser.client');

/**
 * The Daisycon OAuth2 token endpoint.
 * Source: https://github.com/DaisyconBV/oauth-examples (urlAccessToken in cli-client.php)
 */
export const DAISYCON_AUTH_URL = 'https://login.daisycon.com/oauth/access-token';

/**
 * The Daisycon services (data) API base host.
 * Source: https://github.com/aiwha-dev/DaisyconApi (RestClient.php API_BASE_URL)
 */
export const DAISYCON_SERVICES_BASE_URL = 'https://services.daisycon.com';

export interface DaisyconAdvRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: AnyOperation;
  /** Path beginning with `/` — joined to the base URL. */
  path: string;
  /** Bearer access token from the OAuth2 token exchange. */
  token: string;
  /** Method. Always `GET` at v0.1; passing anything else throws. */
  method?: 'GET';
  /** Query string parameters. Values with `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Resilience knobs for this specific call. */
  resilience: ResilienceConfig;
  /** Override base URL. */
  baseUrl?: string;
}

export interface DaisyconAdvResponse<T> {
  body: T;
  /** Total row count across all pages, read from the `x-total-count` header (NaN if absent). */
  totalCount: number;
}

/**
 * Issue a single Daisycon advertiser services API request under the resilience
 * policy.
 *
 * Cardinal: only GET is permitted. Any other method throws a `config_error`
 * before the network call goes out.
 */
export async function daisyconAdvRequest<T>(
  input: DaisyconAdvRequestInput,
): Promise<DaisyconAdvResponse<T>> {
  // Hard read-only guard. This adapter ships read-only at v0.1 and a future
  // contributor must consciously remove this throw to enable writes.
  const method = input.method ?? 'GET';
  if (method !== 'GET') {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation: input.operation,
        message: `Daisycon advertiser adapter is read-only at v0.1; refusing ${method}.`,
        hint:
          'This adapter only issues GET requests. To enable writes a future PR must lift this ' +
          'guard explicitly AND the operator must rotate to a read-write Daisycon OAuth scope.',
      }),
    );
  }

  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };
  const base = input.baseUrl ?? DAISYCON_SERVICES_BASE_URL;

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(base, input.path, input.query);
      const init: RequestInit = {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${input.token}`,
          Accept: 'application/json',
        },
      };

      log.debug({ url, operation: input.operation }, 'daisycon-advertiser request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Daisycon advertiser ${input.operation} GET ${input.path} → HTTP ${res.status}`,
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
            network: SLUG,
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Daisycon advertiser ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
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
 * This function is called only from auth.ts (the token cache). Adapter
 * operations use the cached token via `getAccessToken()`.
 */
export async function fetchAccessToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  resilience: ResilienceConfig,
): Promise<{ accessToken: string; expiresAt: number }> {
  const ctx: WithResilienceContext = { network: SLUG, operation: 'fetchAccessToken' };

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
          `Daisycon advertiser token exchange → HTTP ${res.status}`,
        );
      }

      let parsed: { access_token?: string; expires_in?: number };
      try {
        parsed = JSON.parse(rawBody) as typeof parsed;
      } catch {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'auth_error',
            network: SLUG,
            operation: 'fetchAccessToken',
            networkErrorBody: rawBody,
            message: 'Daisycon token endpoint returned non-JSON body.',
            hint: 'Check DAISYCON_ADVERTISER_CLIENT_ID, DAISYCON_ADVERTISER_CLIENT_SECRET and DAISYCON_ADVERTISER_REFRESH_TOKEN are correct.',
          }),
        );
      }

      if (!parsed.access_token) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'auth_error',
            network: SLUG,
            operation: 'fetchAccessToken',
            networkErrorBody: rawBody,
            message: 'Daisycon token endpoint returned a response with no access_token field.',
            hint: 'Verify DAISYCON_ADVERTISER_REFRESH_TOKEN has not expired; re-run the Daisycon authorisation step if it has.',
          }),
        );
      }

      // Daisycon access tokens are short-lived. We subtract a 60s buffer so we
      // refresh before the upstream actually expires.
      const expiresIn = typeof parsed.expires_in === 'number' ? parsed.expires_in : 3600;
      const expiresAt = Date.now() + (expiresIn - 60) * 1000;

      log.debug({ expiresIn }, 'daisycon-advertiser access token fetched');
      return { accessToken: parsed.access_token, expiresAt };
    },
    resilience,
  );
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
