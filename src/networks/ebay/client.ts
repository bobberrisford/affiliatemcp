/**
 * eBay Partner Network HTTP client — the ONLY path the eBay adapter uses for
 * network I/O.
 *
 * Why this file is structurally identical to `src/networks/awin/client.ts`:
 * eBay's API surface for EPN is a clean REST/JSON one (with an OAuth2 bearer
 * token attached). Apart from the token-acquisition seam (which lives in
 * `auth.ts`), the request mechanics are the same as Awin's — and the project
 * convention is that all adapter clients follow the same shape so future
 * contributors can read any one of them as the pattern.
 *
 * Hard rules (same as every adapter):
 *   1. Do NOT call `fetch` from `adapter.ts`. Use `ebayRequest`.
 *   2. Do NOT add a second client that bypasses `withResilience`.
 *   3. On a non-2xx response throw `HttpStatusError` so the resilience layer
 *      applies its retry policy uniformly.
 *   4. Preserve the raw response body verbatim on failure (PRD principle 4.1).
 *
 * --- The marketplace header --------------------------------------------------
 *
 * Many eBay APIs require an `X-EBAY-C-MARKETPLACE-ID` header (e.g.
 * `EBAY_US`, `EBAY_GB`). EPN reporting + Smart Link endpoints inherit the
 * same convention. We default the marketplace to `EBAY_GB` (UK English
 * project, UK reporting is the most common default) and let callers override
 * via the `EBAY_MARKETPLACE_ID` env var or the per-request override.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { getCredential } from '../../shared/config.js';
import type { AnyOperation, ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';
import { getAccessToken } from './auth.js';

const log = createLogger('ebay.client');

/**
 * The production eBay API root. EPN reporting + the Smart Link / Buy
 * Marketing surfaces all live under this host. Sandbox uses
 * `https://api.sandbox.ebay.com`; we expose a runtime override via the
 * `EBAY_BASE_URL` env var so the wizard can switch tenants in tests.
 */
export const EBAY_BASE_URL = 'https://api.ebay.com';

/**
 * Default marketplace. UK English project, UK default. Override per-process
 * via EBAY_MARKETPLACE_ID, per-call via `ebayRequest({ marketplaceId })`.
 */
export const EBAY_DEFAULT_MARKETPLACE = 'EBAY_GB';

export interface EbayRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: AnyOperation;
  /** Path beginning with `/` — joined to the resolved eBay base URL. */
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Query string parameters. Values with `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Body for POST/PUT requests; serialised as JSON. */
  body?: unknown;
  /** Per-call marketplace override. Defaults to EBAY_MARKETPLACE_ID env / EBAY_GB. */
  marketplaceId?: string;
  /** Resilience knobs for this specific call. Required so each op picks its own profile. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single eBay API request under the resilience policy.
 *
 * Acquires (or reuses) an OAuth2 access token via `auth.ts::getAccessToken`
 * before each call. The cache means most calls do not perform a token
 * exchange; only the first call per process (and every two hours after) pays
 * the OAuth round trip.
 *
 * The response type `T` is not validated at runtime — same rationale as Awin:
 * eBay's surface drifts (esp. across API versions, e.g. `v1_beta` → `v1`),
 * and defensive transformers in the adapter handle missing fields better
 * than a hard schema rejection here.
 */
export async function ebayRequest<T>(input: EbayRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'ebay', operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      // Token is acquired INSIDE the resilience wrapper so a transient OAuth
      // failure (e.g. 503 on the token endpoint) is retried alongside the
      // API call itself, rather than failing fast outside the retry budget.
      const token = await getAccessToken();
      const url = buildUrl(input.path, input.query);
      const init: RequestInit = {
        method: input.method ?? 'GET',
        headers: buildHeaders(token, input.body !== undefined, input.marketplaceId),
      };
      if (input.body !== undefined) {
        init.body = JSON.stringify(input.body);
      }
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ url, method: init.method, operation: input.operation }, 'ebay request');

      const res = await fetch(url, init);

      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `eBay ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
        );
      }

      // Empty body — return an empty object so adapters that expect an envelope
      // can still read defensive keys without an undefined access.
      if (rawBody.trim() === '') {
        return {} as T;
      }

      try {
        return JSON.parse(rawBody) as T;
      } catch (err) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: 'ebay',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `eBay ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Build the standard eBay request headers.
 *
 * `X-EBAY-C-MARKETPLACE-ID` is set on every call. eBay's reporting endpoints
 * tolerate the header on calls where it has no semantic effect; sending it
 * always means we never debug a "missing marketplace" 400 from a tenant where
 * the API decided the header had become mandatory.
 */
function buildHeaders(
  token: string,
  hasBody: boolean,
  marketplaceOverride?: string,
): Record<string, string> {
  const marketplace =
    marketplaceOverride ?? getCredential('EBAY_MARKETPLACE_ID') ?? EBAY_DEFAULT_MARKETPLACE;
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'X-EBAY-C-MARKETPLACE-ID': marketplace,
  };
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

/**
 * Compose the full URL with query string. Uses `URL` + `URLSearchParams` for
 * the same reasons as the Awin client (ISO timestamps + offsets need correct
 * percent-encoding).
 */
function buildUrl(pathname: string, query?: Record<string, string | number | undefined>): string {
  const base = getCredential('EBAY_BASE_URL') ?? EBAY_BASE_URL;
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
