/**
 * Amazon Creators API HTTP client — the ONLY path the Amazon Creators adapter
 * uses for network I/O.
 *
 * The Amazon Creators API is the successor to the Product Advertising API
 * (PA-API 5.0). PA-API deprecates on 30 April 2026 and the endpoint retires on
 * 15 May 2026; new integrations target the Creators API.
 *
 * --- Auth model (verified against public sources, NOT a live tenant) ---------
 *
 * The Creators API does NOT use the old PA-API AWS SigV4 signing. It uses
 * OAuth 2.0 client-credentials issued from Associates Central (a "Credential ID"
 * / "Credential Secret" pair, v3.x "Login with Amazon" style). The flow is:
 *
 *   1. POST the token endpoint with `grant_type=client_credentials`,
 *      `client_id`, `client_secret`, `scope=creatorsapi::default`. The token
 *      endpoint is region-grouped (see `tokenEndpointForMarketplace`):
 *        North America        → https://api.amazon.com/auth/o2/token
 *        Europe / ME / India  → https://api.amazon.co.uk/auth/o2/token
 *        Far East             → https://api.amazon.co.jp/auth/o2/token
 *      Response: `{ access_token, token_type: "bearer", expires_in }`.
 *
 *   2. Call the catalog API at the single global host
 *        https://creatorsapi.amazon
 *      with `Authorization: Bearer <access_token>`, `Content-Type:
 *      application/json`, and an `x-marketplace` header (e.g. `www.amazon.com`)
 *      that selects the marketplace. Catalog operations:
 *        POST /catalog/v1/getItems
 *        POST /catalog/v1/searchItems
 *      The request body carries `partnerTag`, `partnerType: "Associates"`, and
 *      `marketplace`.
 *
 * Because Amazon's docs host (affiliate-program.amazon.com/creatorsapi/docs)
 * returns 403 to unauthenticated fetches, the host, paths, scope and headers
 * above were reconstructed from multiple independent client libraries and
 * migration write-ups (recorded in docs/networks/amazon-creators.md). They have
 * NOT been confirmed against a live Creators API account. Treat the shapes as
 * defensive: every transformer tolerates missing keys.
 *
 * We sign nothing here — OAuth bearer replaces SigV4, so Node `crypto` is not
 * needed (no new dependency either way).
 *
 * Hard rules (mirrored from Awin client.ts — read that file for the full
 * rationale):
 *   1. Do NOT call `fetch` from `adapter.ts` or anywhere else in this folder.
 *   2. Do NOT add a second client that skips `withResilience`.
 *   3. On a non-2xx response, throw `HttpStatusError` so the resilience layer
 *      applies its retry policy uniformly.
 *   4. Preserve the raw response body verbatim on failure.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { DEFAULT_RESILIENCE } from '../../shared/resilience.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('amazon-creators.client');

export const AMAZON_CREATORS_SLUG = 'amazon-creators';

/**
 * The Creators API catalog host. A single global host for every marketplace;
 * the marketplace is selected by the `x-marketplace` header, not the host.
 * Centralised so a test harness can override it without touching adapter code.
 */
export const AMAZON_CREATORS_BASE_URL = 'https://creatorsapi.amazon';

/** OAuth2 scope for v3.x ("Login with Amazon") Creators API credentials. */
export const AMAZON_CREATORS_SCOPE = 'creatorsapi::default';

/** Catalog operation paths. */
export const CATALOG_GET_ITEMS_PATH = '/catalog/v1/getItems';
export const CATALOG_SEARCH_ITEMS_PATH = '/catalog/v1/searchItems';

/**
 * Default marketplace if the user has not configured one. `www.amazon.com` is
 * the North America default and the most common Associates marketplace.
 */
export const DEFAULT_MARKETPLACE = 'www.amazon.com';

export interface AmazonCreatorsCredentials {
  /** The OAuth2 client id ("Credential ID" in Associates Central). */
  clientId: string;
  /** The OAuth2 client secret ("Credential Secret"). Never sent to the catalog host. */
  clientSecret: string;
  /** The Associates partner tag, e.g. `yoursite-20`. */
  partnerTag: string;
  /** The Amazon marketplace domain, e.g. `www.amazon.com`. */
  marketplace: string;
}

/**
 * Map an Amazon marketplace domain to the OAuth2 token endpoint for its
 * credential region group.
 *
 * v3.x Creators API credentials are issued per region group:
 *   - North America (US/CA/MX/BR) → api.amazon.com
 *   - Europe / ME / India          → api.amazon.co.uk
 *   - Far East (JP/AU/SG)          → api.amazon.co.jp
 *
 * We pick the endpoint from the marketplace TLD. When the marketplace is
 * unrecognised we fall back to the North America endpoint, which is the most
 * common, rather than guess. This mapping is documented but UNVERIFIED against
 * a live tenant; if it is wrong, this is the one function to fix.
 */
export function tokenEndpointForMarketplace(marketplace: string): string {
  const m = marketplace.toLowerCase();
  // Far East.
  if (m.endsWith('.co.jp') || m.endsWith('.com.au') || m.endsWith('.sg')) {
    return 'https://api.amazon.co.jp/auth/o2/token';
  }
  // Europe / Middle East / India.
  if (
    m.endsWith('.co.uk') ||
    m.endsWith('.de') ||
    m.endsWith('.fr') ||
    m.endsWith('.it') ||
    m.endsWith('.es') ||
    m.endsWith('.nl') ||
    m.endsWith('.se') ||
    m.endsWith('.pl') ||
    m.endsWith('.com.tr') ||
    m.endsWith('.ae') ||
    m.endsWith('.sa') ||
    m.endsWith('.eg') ||
    m.endsWith('.in')
  ) {
    return 'https://api.amazon.co.uk/auth/o2/token';
  }
  // North America (default).
  return 'https://api.amazon.com/auth/o2/token';
}

// ---------------------------------------------------------------------------
// Access-token cache
// ---------------------------------------------------------------------------
//
// This is the ONLY module-level mutable state in the adapter folder. The OAuth2
// client-credentials token is short-lived; we cache it keyed by client id +
// token endpoint and refresh 60 seconds before expiry to avoid a round-trip on
// every catalog call. Mirrors the Rakuten OAuth cache pattern.

interface CachedToken {
  accessToken: string;
  /** Epoch ms after which the cached token must not be used. */
  expiresAtMs: number;
}

const tokenCache = new Map<string, CachedToken>();

/** Test-only: clear the cached tokens so each case starts clean. */
export function _resetTokenCache(): void {
  tokenCache.clear();
}

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

/**
 * Obtain an OAuth2 access token via the client-credentials grant.
 *
 * Cached per (clientId, tokenEndpoint). On a cache miss (or near-expiry) we POST
 * the token endpoint with a JSON body. The token endpoint is hit through the
 * resilience layer under the `verifyAuth`/calling operation's name so a flaky
 * auth host still retries on 502/503.
 */
export async function getAccessToken(input: {
  operation: string;
  credentials: AmazonCreatorsCredentials;
  resilience: ResilienceConfig;
  signal?: AbortSignal;
  forceRefresh?: boolean;
}): Promise<string> {
  const tokenEndpoint = tokenEndpointForMarketplace(input.credentials.marketplace);
  const cacheKey = `${input.credentials.clientId}::${tokenEndpoint}`;

  if (!input.forceRefresh) {
    const cached = tokenCache.get(cacheKey);
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached.accessToken;
    }
  }

  const ctx: WithResilienceContext = {
    network: AMAZON_CREATORS_SLUG,
    operation: input.operation,
  };

  const token = await withResilience(
    ctx,
    async () => {
      const init: RequestInit = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          grant_type: 'client_credentials',
          client_id: input.credentials.clientId,
          client_secret: input.credentials.clientSecret,
          scope: AMAZON_CREATORS_SCOPE,
        }),
      };
      if (input.signal) init.signal = input.signal;

      log.debug({ tokenEndpoint, operation: input.operation }, 'amazon-creators token request');

      const res = await fetch(tokenEndpoint, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Amazon Creators ${input.operation} token POST ${tokenEndpoint} → HTTP ${res.status}`,
        );
      }

      let parsed: TokenResponse;
      try {
        parsed = JSON.parse(rawBody) as TokenResponse;
      } catch (err) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'auth_error',
            network: AMAZON_CREATORS_SLUG,
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Amazon Creators token endpoint returned a non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }

      if (!parsed.access_token) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'auth_error',
            network: AMAZON_CREATORS_SLUG,
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: 'Amazon Creators token endpoint returned no access_token.',
            hint: 'Check the Credential ID and Credential Secret in Associates Central → Creators API.',
          }),
        );
      }

      // Refresh 60s before the stated expiry; default to 60 minutes if the
      // endpoint omits expires_in.
      const expiresInSec = typeof parsed.expires_in === 'number' ? parsed.expires_in : 3600;
      const expiresAtMs = Date.now() + Math.max(0, expiresInSec - 60) * 1000;
      tokenCache.set(cacheKey, { accessToken: parsed.access_token, expiresAtMs });
      return parsed.access_token;
    },
    input.resilience,
  );

  return token;
}

export interface CatalogRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Catalog path beginning with `/` — joined to `AMAZON_CREATORS_BASE_URL`. */
  path: string;
  /** Credential set. Passed in so the read happens once in the adapter. */
  credentials: AmazonCreatorsCredentials;
  /** JSON request body for the catalog POST. */
  body: unknown;
  /** Resilience knobs for this specific call. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single Creators API catalog request under the resilience policy.
 *
 * Acquires (or reuses a cached) OAuth2 bearer token, then POSTs the catalog
 * endpoint with the `x-marketplace` header. The response is typed `T` with no
 * runtime validation — the catalog surface is reconstructed from public
 * sources, so adapter transformers MUST tolerate missing keys.
 */
export async function amazonCreatorsCatalogRequest<T>(input: CatalogRequestInput): Promise<T> {
  const accessToken = await getAccessToken({
    operation: input.operation,
    credentials: input.credentials,
    resilience: input.resilience,
    signal: input.signal,
  });

  const ctx: WithResilienceContext = {
    network: AMAZON_CREATORS_SLUG,
    operation: input.operation,
  };

  return withResilience(
    ctx,
    async () => {
      const url = new URL(
        input.path.startsWith('/') ? input.path : `/${input.path}`,
        AMAZON_CREATORS_BASE_URL,
      ).toString();

      const init: RequestInit = {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-marketplace': input.credentials.marketplace,
        },
        body: JSON.stringify(input.body),
      };
      if (input.signal) init.signal = input.signal;

      log.debug({ url, operation: input.operation }, 'amazon-creators catalog request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Amazon Creators ${input.operation} POST ${input.path} → HTTP ${res.status}`,
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
            network: AMAZON_CREATORS_SLUG,
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Amazon Creators ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

// Keep DEFAULT_RESILIENCE referenced for callers that import only the client.
void DEFAULT_RESILIENCE;

// Re-export so adapter code can throw HttpStatusError without importing from
// shared/resilience directly.
export { HttpStatusError };
