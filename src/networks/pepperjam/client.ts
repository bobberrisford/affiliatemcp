/**
 * Pepperjam (Ascend by Partnerize) HTTP client — the ONLY path Pepperjam
 * adapter methods use for network I/O.
 *
 * Pepperjam authenticates with a self-issued `apiKey` passed as a QUERY
 * PARAMETER (not a header), and a `format=json` query parameter to force JSON.
 * Centralising both here means the adapter stays readable and the resilience
 * layer applies uniformly to every outgoing call.
 *
 * NOTE: this is a DISTINCT API from the Partnerize Reporting API. Ascend is the
 * current Partnerize-owned brand for the network formerly known as Pepperjam,
 * but the API surface here (versioned `/20120402/` REST under
 * api.pepperjamnetwork.com with a `meta`/`data` envelope) is unrelated to
 * Partnerize's own API. A separate adapter exists for Partnerize; the two
 * share no code by design.
 *
 * Hard rules for future contributors (mirrored from Awin client.ts — read that
 * file for the full rationale):
 *   1. Do NOT call `fetch` from `adapter.ts` or anywhere else in this folder.
 *   2. Do NOT add a second client that skips `withResilience` "just for one
 *      call". The policy is the contract.
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
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('pepperjam.client');

const SLUG = 'pepperjam';

/**
 * Pepperjam / Ascend API root. Centralised so a test harness or staging
 * environment can override it without touching adapter code. Hard-coded for
 * v0.1.
 */
export const PEPPERJAM_BASE_URL = 'https://api.pepperjamnetwork.com';

/**
 * Versioned path segment. Ascend versions the API by date string; `20120402`
 * is the only published, current publisher API version. It sits between the
 * base URL and the resource: `{base}/{version}/{resource}`.
 */
export const PEPPERJAM_API_VERSION = '20120402';

/**
 * The standard Ascend response envelope. Every GET wraps its payload in
 * `meta` + `data`:
 *
 *   {
 *     "meta": {
 *       "status":     { "code": 200, "message": "OK" },
 *       "pagination": { "total_results": 1234, "total_pages": 1 },
 *       "requests":   { "current": 1, "maximum": 1000 }
 *     },
 *     "data": [ ... ]
 *   }
 *
 * We model it loosely (every field optional) and read defensively — see the
 * Awin client for why we do not impose a strict schema.
 */
export interface PepperjamMeta {
  status?: { code?: number; message?: string };
  pagination?: { total_results?: number; total_pages?: number };
  requests?: { current?: number; maximum?: number };
}

export interface PepperjamEnvelope<T> {
  meta?: PepperjamMeta;
  data?: T[];
}

export interface PepperjamRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /**
   * Resource path AFTER the version segment, beginning with `/`. For example
   * `/publisher/advertiser` becomes
   * `https://api.pepperjamnetwork.com/20120402/publisher/advertiser`.
   */
  resource: string;
  /** Self-issued API key. Passed in so callers fetch from `requireCredential` once. */
  apiKey: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /**
   * Query string parameters. `apiKey` and `format` are added automatically; do
   * not pass them here. Values with `undefined` are skipped.
   */
  query?: Record<string, string | number | undefined>;
  /** Body for POST/PUT requests; serialised as JSON. */
  body?: unknown;
  /** Resilience knobs for this specific call. Required so each op picks its own profile. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single Pepperjam API request under the resilience policy.
 *
 * Auth: the `apiKey` is appended to the query string (Ascend's scheme), and
 * `format=json` forces a JSON response. Both are injected here so adapter code
 * never has to remember them.
 *
 * The response is typed as `T` with no runtime validation — see Awin's client
 * for the rationale. Adapter transformers MUST tolerate missing keys
 * defensively.
 */
export async function pepperjamRequest<T>(input: PepperjamRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input.resource, input.apiKey, input.query);
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

      // The URL carries the apiKey in its query string; log the resource +
      // method rather than the full URL so the key is not written even at
      // debug level.
      log.debug(
        { resource: input.resource, method: init.method, operation: input.operation },
        'pepperjam request',
      );

      const res = await fetch(url, init);

      // Read the body once. We need it both for success (decode JSON) and for
      // failure (surface the raw text on the envelope). Ascend error bodies are
      // typically the same `meta`/`data` envelope JSON, but may be plain text or
      // HTML when fronted by a CDN — preserving the raw text is the honest path.
      const rawBody = await res.text();

      if (!res.ok) {
        // Throw HttpStatusError so the resilience layer applies its retry/no-retry
        // decision uniformly. Do NOT inspect `res.status` here.
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Pepperjam ${input.operation} ${init.method} ${input.resource} → HTTP ${res.status}`,
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
            message: `Pepperjam ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Build request headers.
 *
 * Pepperjam authenticates via the query string, so there is no Authorization
 * header. We still send `Accept: application/json` to be explicit, even though
 * `format=json` already forces JSON.
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
 * Compose the full URL: `{base}/{version}/{resource}?apiKey=...&format=json&...`.
 *
 * We use `URL` + `URLSearchParams` rather than string concatenation because
 * query values (date strings, search terms) must be URL-encoded.
 */
function buildUrl(
  resource: string,
  apiKey: string,
  query?: Record<string, string | number | undefined>,
): string {
  const path = resource.startsWith('/') ? resource : `/${resource}`;
  const url = new URL(`/${PEPPERJAM_API_VERSION}${path}`, PEPPERJAM_BASE_URL);
  url.searchParams.set('apiKey', apiKey);
  url.searchParams.set('format', 'json');
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
