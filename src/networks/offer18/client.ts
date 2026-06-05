/**
 * Offer18 HTTP client — the ONLY path Offer18 adapter methods use for network I/O.
 *
 * Offer18 is a tenant network engine: one parameterised API surface powers every
 * Offer18-hosted network. There is therefore NO single fixed base URL. The base
 * is the per-tenant instance host (e.g. `https://api.offer18.com`, or a network's
 * own white-label API host). It is read from the OFFER18_BASE_URL credential and
 * validated as a URL — see `requireBaseUrl` below. This is the "multiplier"
 * base-URL pattern: the same adapter addresses any Offer18 instance.
 *
 * Auth is NOT a Bearer token. Affiliate-side endpoints (`/api/af/...`) take three
 * query parameters carried on every request:
 *   - `key` : the affiliate API key      (OFFER18_API_KEY)
 *   - `aid` : the affiliate account id    (OFFER18_SECRET_KEY — see auth.ts mapping)
 *   - `mid` : the network/advertiser MID  (OFFER18_MID)
 *
 * Hard rules (mirrored from Everflow / Awin client.ts — read those for the full
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
import { requireCredential } from '../../shared/config.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('offer18.client');

export const SLUG = 'offer18';

/**
 * Resolve and validate the per-tenant Offer18 base URL from OFFER18_BASE_URL.
 *
 * There is no sensible default: an Offer18 network runs on its own instance
 * host, and guessing `api.offer18.com` would silently address the wrong tenant.
 * We therefore require the credential and validate it parses as an absolute URL.
 */
export function requireBaseUrl(operation: string): string {
  const raw = requireCredential('OFFER18_BASE_URL', {
    network: SLUG,
    operation,
    hint:
      'Set OFFER18_BASE_URL to your Offer18 instance API host, e.g. https://api.offer18.com ' +
      "(or your network operator's white-label API host). This is per-tenant; there is no default.",
  });

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation,
        message: `OFFER18_BASE_URL is not a valid URL: "${raw}".`,
        hint: 'Provide an absolute URL, e.g. https://api.offer18.com',
      }),
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation,
        message: `OFFER18_BASE_URL must use http or https; received "${parsed.protocol}".`,
        hint: 'Provide an absolute URL, e.g. https://api.offer18.com',
      }),
    );
  }
  // Strip any trailing slash so path joining is predictable.
  return raw.replace(/\/+$/, '');
}

export interface Offer18RequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** The per-tenant base URL (from requireBaseUrl). */
  baseUrl: string;
  /** Path beginning with `/` — joined to `baseUrl`. */
  path: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Query string parameters. Values that are `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Body for POST/PUT requests; serialised as JSON. */
  body?: unknown;
  /** Resilience knobs for this specific call. Required so each op picks its profile. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single Offer18 API request under the resilience policy.
 *
 * Auth: Offer18 affiliate endpoints carry `key` / `aid` / `mid` as query
 * parameters (not headers). The adapter assembles them and passes them in
 * `query`, so the client stays a thin transport.
 */
export async function offer18Request<T>(input: Offer18RequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input.baseUrl, input.path, input.query);
      const init: RequestInit = {
        method: input.method ?? 'GET',
        headers: buildHeaders(input.body !== undefined),
      };
      if (input.body !== undefined) {
        init.body = JSON.stringify(input.body);
      }
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ url, method: init.method, operation: input.operation }, 'offer18 request');

      const res = await fetch(url, init);

      // Read the body once: needed both for success (decode JSON) and failure
      // (surface the verbatim text on the envelope). Offer18 error bodies are
      // typically JSON but may be plain text on gateway errors.
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Offer18 ${input.operation} ${init.method ?? 'GET'} ${input.path} → HTTP ${res.status}`,
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
            message: `Offer18 ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Build request headers. Offer18 auth travels in the query string, so we only
 * set Accept (and Content-Type when there is a body).
 */
function buildHeaders(hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

/**
 * Compose the full URL with query string, using `URL` + `URLSearchParams`.
 */
function buildUrl(
  baseUrl: string,
  pathname: string,
  query?: Record<string, string | number | undefined>,
): string {
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, baseUrl);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

// Re-export so adapter code can throw HttpStatusError without importing from
// shared/resilience directly.
export { HttpStatusError };
