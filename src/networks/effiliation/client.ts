/**
 * Effiliation HTTP client — the ONLY path Effiliation adapter methods use for
 * network I/O.
 *
 * Effiliation (the legacy Effinity publisher API, host `apiv2.effiliation.com`)
 * authenticates with a single API key passed as the `key` query-string
 * parameter rather than an HTTP header. Credential reading is done by the
 * adapter / auth helpers; this file only stitches the key onto the query and
 * applies the resilience policy.
 *
 * Endpoints used by this adapter return JSON when the `.json` resource suffix
 * is requested (the same resource is also available as `.xml` / `.csv`; we only
 * ever ask for JSON):
 *
 *   GET /apiv2/programs.json?key=...     → programmes the publisher works with
 *   GET /apiv2/transaction.json?key=...  → transactions (sales / leads)
 *
 * Hard rules (mirrored from Awin client.ts — read that file for the full
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
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('effiliation.client');

/**
 * The Effiliation API host. The publisher-facing v2 API lives under `/apiv2/`;
 * the adapter supplies that prefix in the `path`, so this constant is the bare
 * origin. Centralised so a future `EFFILIATION_BASE_URL` override touches one
 * place. Hard-coded for v0.1.
 */
export const EFFILIATION_BASE_URL = 'https://apiv2.effiliation.com';

export interface EffiliationRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to `EFFILIATION_BASE_URL`. */
  path: string;
  /** API key. Sent as the `key` query parameter (not a header). */
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
 * Issue a single Effiliation API request under the resilience policy.
 *
 * Auth: the API key is appended to the query string as `key=<apiKey>`. We do
 * this here (not in the adapter) so the key never leaks into adapter-level URL
 * building and the HTTP seam stays in one file.
 *
 * Why the response is typed as `T` with no runtime validation: Effiliation's
 * surface is weakly documented and field-selectable (a `fields=` mask changes
 * the response shape). Over-specifying a schema here would break first; adapter
 * transformers tolerate missing keys defensively and keep the raw body on
 * `rawNetworkData`.
 */
export async function effiliationRequest<T>(input: EffiliationRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'effiliation', operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input.path, { ...input.query, key: input.apiKey });
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

      // The key travels in the query string. We deliberately log only the path
      // and operation, never the assembled URL, to keep the key out of the
      // breadcrumb.
      log.debug(
        { method: init.method, operation: input.operation, path: input.path },
        'effiliation request',
      );

      const res = await fetch(url, init);

      // Read the body once. We need it both for success (decode JSON) and for
      // failure (surface the raw text on the envelope). Effiliation error
      // bodies are typically JSON but can be plain text behind a CDN.
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Effiliation ${input.operation} ${init.method ?? 'GET'} ${input.path} → HTTP ${res.status}`,
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
            network: 'effiliation',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Effiliation ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Build the request headers.
 *
 * Effiliation uses no auth header (the key is in the query string). We send
 * `Accept: application/json` because the same resource is available as XML/CSV
 * and we always want JSON.
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
 * Effiliation date params use the `DD/MM/YYYY` form, which contains `/` and so
 * must be URL-encoded — `URLSearchParams` handles that for us.
 */
function buildUrl(pathname: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, EFFILIATION_BASE_URL);
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
