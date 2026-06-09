/**
 * Scaleo HTTP client — the ONLY path Scaleo adapter methods use for network I/O.
 *
 * Scaleo is a tenant affiliate-platform engine: every Scaleo-powered network
 * runs on the same API shape but at a different per-tenant host. Two things are
 * therefore credentials, not constants:
 *
 *   1. The base URL — the network's own tracking URL / domain
 *      (e.g. `https://sandbox.scaletrk.com`). Supplied via SCALEO_BASE_URL.
 *   2. The API key — passed as the `api-key` query parameter on every request
 *      (Scaleo does NOT use an Authorization header). Supplied via SCALEO_API_KEY.
 *
 * Confirmed against the public docs (2026-06-05):
 *   - developers.scaleo.io documents the request format
 *     `https://<tracking-url>/api/v2/network/affiliates?api-key=<key>`; the
 *     tracking URL is the credential, the `api-key` query param is the auth.
 *   - Affiliate-side resources sit under `/api/v2/affiliate/...`
 *     (offers, reports/conversions, reports/clicks) — confirmed via the
 *     community PHP client github.com/jakuborava/scaleo-io-client.
 *
 * Hard rules (mirrored from Awin/Everflow client.ts — read those for the full
 * rationale):
 *   1. Do NOT call `fetch` from `adapter.ts` or anywhere else in this folder.
 *   2. Do NOT add a second client that skips `withResilience`.
 *   3. On a non-2xx response, throw `HttpStatusError` so the resilience layer
 *      can apply its retry policy uniformly.
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

const log = createLogger('scaleo.client');

const SLUG = 'scaleo';

/** Affiliate-side API path prefix. */
const API_PREFIX = '/api/v2/affiliate';

/**
 * Resolve and validate the per-tenant base URL from SCALEO_BASE_URL.
 *
 * Scaleo has no fixed API host; the base is the network's own tracking URL.
 * We require it as a credential and validate that it parses as an absolute URL
 * so a typo surfaces as a `config_error` rather than an opaque fetch failure.
 */
export function requireBaseUrl(operation: string): string {
  const raw = requireCredential('SCALEO_BASE_URL', {
    network: SLUG,
    operation,
    hint:
      'Set SCALEO_BASE_URL to your network\'s tracking URL (e.g. https://yournetwork.scaletrk.com). ' +
      'Administrators find it under Settings → General → Domain for Tracking.',
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
        message: `SCALEO_BASE_URL is not a valid URL: "${raw}".`,
        hint: 'Provide the full tracking URL including scheme, e.g. https://yournetwork.scaletrk.com.',
      }),
    );
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation,
        message: `SCALEO_BASE_URL must be an http(s) URL: "${raw}".`,
        hint: 'Provide the full tracking URL including scheme, e.g. https://yournetwork.scaletrk.com.',
      }),
    );
  }
  // Normalise away any trailing slash so path joining is predictable.
  return `${parsed.protocol}//${parsed.host}`;
}

export function requireApiKey(operation: string): string {
  return requireCredential('SCALEO_API_KEY', {
    network: SLUG,
    operation,
    hint:
      'Ask your Scaleo administrator to enable API Access on your affiliate profile ' +
      '(profile edit page → API Access switcher), then copy the API key shown under ' +
      'Account → API and set SCALEO_API_KEY in ~/.affiliate-mcp/.env.',
  });
}

export interface ScaleoRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/`, relative to the affiliate API prefix (e.g. `/offers`). */
  path: string;
  /** Per-tenant base URL (from requireBaseUrl). */
  baseUrl: string;
  /** API key (from requireApiKey). Sent as the `api-key` query parameter. */
  apiKey: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Query string parameters. Values with `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Body for POST/PUT requests; serialised as JSON. */
  body?: unknown;
  /** Resilience knobs for this specific call. Required so each op picks its own profile. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single Scaleo affiliate API request under the resilience policy.
 *
 * Auth: the `api-key` query parameter is appended to every request. The key is
 * passed in from the adapter so credential reads happen once per operation.
 */
export async function scaleoRequest<T>(input: ScaleoRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input.baseUrl, input.path, input.apiKey, input.query);
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

      log.debug({ method: init.method, operation: input.operation, path: input.path }, 'scaleo request');

      const res = await fetch(url, init);

      // Read the body once: needed for success (decode JSON) and failure
      // (surface the raw text on the envelope). Scaleo errors are JSON-shaped
      // but may be plain text on CDN / gateway errors.
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Scaleo ${input.operation} ${init.method ?? 'GET'} ${API_PREFIX}${input.path} → HTTP ${res.status}`,
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
            message: `Scaleo ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Build the Scaleo request headers.
 *
 * Scaleo authenticates via the `api-key` query parameter, not a header, so the
 * only headers we set are `Accept` (always JSON) and `Content-Type` when a body
 * is present.
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
 * Compose the full URL: `<baseUrl>/api/v2/affiliate<path>?api-key=<key>&...`.
 */
function buildUrl(
  baseUrl: string,
  pathname: string,
  apiKey: string,
  query?: Record<string, string | number | undefined>,
): string {
  const rel = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const url = new URL(`${API_PREFIX}${rel}`, baseUrl);
  url.searchParams.set('api-key', apiKey);
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
