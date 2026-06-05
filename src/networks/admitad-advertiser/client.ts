/**
 * Admitad advertiser HTTP client — the ONLY path adapter methods use for I/O.
 *
 * Read-only by design: the client refuses any non-GET method at runtime so the
 * adapter cannot accidentally ship a write operation. This is belt-and-braces:
 * the Admitad advertiser surface DOES expose mutation endpoints (campaign
 * connection management, tariff edits) and we want zero risk of one going out.
 *
 * Path construction:
 *
 *   - brand-scoped: /advertiser/{advertiserId}/...   e.g. /advertiser/6/statistics/actions/
 *   - account-level: /me/                             (identity probe)
 *
 * Adapter code calls `admitadAdvRequest({ ..., operation, brandPath: '/statistics/actions/',
 * networkBrandId })` with a brand-relative path; the client prepends
 * `/advertiser/{networkBrandId}`. Account-level paths (e.g. `/me/`) are passed via
 * `path` and used verbatim.
 *
 * Admitad advertiser API surface (corroborated against public docs + the public
 * Python wrapper, 2026-06-04; docs host 403'd to automated fetch):
 *   - Auth: POST https://api.admitad.com/token/  (Basic base64(id:secret), form body)
 *       scopes: advertiser_statistics advertiser_info advertiser_websites
 *       Source: https://developers.admitad.com/knowledge-base/article/client-authorization_2
 *   - Data API base: https://api.admitad.com
 *       GET /advertiser/{id}/info/                  scope advertiser_info
 *       GET /advertiser/{id}/statistics/actions/    scope advertiser_statistics
 *           (date_start/date_end as DD.MM.YYYY; rows carry webmaster/website info)
 *       GET /advertiser/{id}/websites/              scope advertiser_websites
 *       GET /me/                                    (identity)
 *       Responses paginate as { results: [...], _meta: { count, limit, offset } }
 *       Sources:
 *         https://developers.admitad.com/en/doc/advertiser-api_en/methods/statistics/statistics-actions/
 *         https://developers.admitad.com/en/doc/advertiser-api_en/methods/advertiser_info/advertiser_info/
 *         https://developers.admitad.com/knowledge-base/articles/advertiser-api-methods
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

import { SLUG } from './auth.js';

const log = createLogger('admitad-advertiser.client');

/**
 * The Admitad OAuth2 token endpoint.
 * Source: https://developers.admitad.com/knowledge-base/article/client-authorization_2
 */
export const ADMITAD_ADV_TOKEN_URL = 'https://api.admitad.com/token/';

/**
 * The Admitad data API base URL.
 * Source: https://developers.admitad.com/
 */
export const ADMITAD_ADV_BASE_URL = 'https://api.admitad.com';

export interface AdmitadAdvRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /**
   * Brand-relative path under `/advertiser/{networkBrandId}`. Example:
   * `/statistics/actions/` resolves to
   * `/advertiser/{networkBrandId}/statistics/actions/`. Requires `networkBrandId`.
   */
  brandPath?: string;
  /**
   * Absolute account-level path used verbatim (e.g. `/me/`). Use this for calls
   * that are not scoped to a single advertiser id.
   */
  path?: string;
  /** The advertiser id whose data we want — `ctx.networkBrandId` from the resolver. */
  networkBrandId?: string;
  /** Bearer access token from OAuth2 token exchange. */
  token: string;
  /** Method. Always `GET` at v0.1; passing anything else throws. */
  method?: 'GET';
  /** Query string parameters. Values with `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Resilience knobs for this specific call. */
  resilience: ResilienceConfig;
  /** Override base URL (tests). */
  baseUrl?: string;
}

/**
 * Issue a single Admitad advertiser data API request under the resilience policy.
 *
 * Cardinal: only GET is permitted. Any other method throws a `config_error`
 * before the network call goes out.
 */
export async function admitadAdvRequest<T>(input: AdmitadAdvRequestInput): Promise<T> {
  // Hard read-only guard. A future contributor must consciously remove this
  // throw to enable writes.
  const method = input.method ?? 'GET';
  if (method !== 'GET') {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation: input.operation,
        message: `Admitad advertiser adapter is read-only at v0.1; refusing ${method}.`,
        hint:
          'This adapter only issues GET requests. To enable writes a future PR must lift this ' +
          'guard explicitly AND the operator must use an API application scoped for writes.',
      }),
    );
  }

  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };
  const base = input.baseUrl ?? ADMITAD_ADV_BASE_URL;

  return withResilience(
    ctx,
    async () => {
      const fullPath = buildPath(input.brandPath, input.path, input.networkBrandId);
      const url = buildUrl(base, fullPath, input.query);
      const init: RequestInit = {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${input.token}`,
          Accept: 'application/json',
        },
      };

      log.debug({ url, operation: input.operation }, 'admitad-adv request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Admitad advertiser ${input.operation} GET ${fullPath} → HTTP ${res.status}`,
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
            message: `Admitad advertiser ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
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
 * Source: https://developers.admitad.com/knowledge-base/article/client-authorization_2
 *
 * Called only from auth.ts (the token cache).
 */
export async function fetchAdvAccessToken(
  clientId: string,
  clientSecret: string,
  scope: string,
  resilience: ResilienceConfig,
): Promise<{ accessToken: string; expiresAt: number }> {
  const ctx: WithResilienceContext = { network: SLUG, operation: 'fetchAccessToken' };

  return withResilience(
    ctx,
    async () => {
      const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        scope,
      });

      const res = await fetch(ADMITAD_ADV_TOKEN_URL, {
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
        throw new HttpStatusError(res.status, rawBody, `Admitad token exchange → HTTP ${res.status}`);
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
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: 'Admitad token endpoint returned non-JSON body.',
            hint: 'Check ADMITAD_ADVERTISER_CLIENT_ID and ADMITAD_ADVERTISER_CLIENT_SECRET are correct.',
          }),
        );
      }

      if (!parsed.access_token) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'auth_error',
            network: SLUG,
            operation: 'fetchAccessToken',
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: 'Admitad token endpoint returned a response with no access_token field.',
            hint: 'Verify the credentials and that the requested advertiser scopes are enabled for the API application.',
          }),
        );
      }

      // Admitad tokens carry an `expires_in` (seconds). Subtract a 60s buffer so
      // we refresh before the upstream actually expires.
      const expiresIn = typeof parsed.expires_in === 'number' ? parsed.expires_in : 3600;
      const expiresAt = Date.now() + (expiresIn - 60) * 1000;

      log.debug({ expiresIn }, 'admitad advertiser access token fetched');
      return { accessToken: parsed.access_token, expiresAt };
    },
    resilience,
  );
}

/**
 * Compose the request path from either a brand-relative path (prefixed with
 * `/advertiser/{networkBrandId}`) or an absolute account-level path.
 *
 * Exported (and re-exported on `_internals` in the adapter) so tests can assert
 * the brand pathing directly — it is the highest-risk piece of this adapter.
 */
export function buildPath(
  brandPath: string | undefined,
  absolutePath: string | undefined,
  networkBrandId: string | undefined,
): string {
  if (brandPath && absolutePath) {
    throw new Error('admitadAdvRequest: pass exactly one of brandPath or path, not both.');
  }
  if (!brandPath && !absolutePath) {
    throw new Error('admitadAdvRequest: one of brandPath / path is required.');
  }
  if (absolutePath) {
    return absolutePath.startsWith('/') ? absolutePath : `/${absolutePath}`;
  }
  const bp = brandPath as string;
  if (!networkBrandId) {
    throw new Error('admitadAdvRequest: networkBrandId is required with brandPath.');
  }
  const rel = bp.startsWith('/') ? bp : `/${bp}`;
  return `/advertiser/${encodeURIComponent(networkBrandId)}${rel}`;
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
