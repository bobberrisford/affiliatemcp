/**
 * Digistore24 HTTP client — the ONLY path Digistore24 adapter methods use for
 * network I/O.
 *
 * Digistore24 exposes a single-endpoint, function-style REST API. Every call
 * is `GET https://www.digistore24.com/api/call/{function}` with arguments as
 * query parameters and the API key in a custom `X-DS-API-KEY` header (not a
 * standard `Authorization: Bearer`).
 *
 * Reference: src/networks/awin/client.ts (full rationale) and
 *            src/networks/everflow/client.ts (custom-header pattern).
 *
 * Hard rules for future contributors (mirrored from Awin client.ts):
 *   1. Do NOT call `fetch` from `adapter.ts` or anywhere else in this folder.
 *   2. Do NOT add a second client that skips `withResilience`.
 *   3. On a non-2xx response, throw `HttpStatusError` so the resilience layer
 *      can apply its retry policy uniformly.
 *   4. Preserve the raw response body verbatim on failure.
 *
 * --- Digistore24 envelope quirk ---------------------------------------------
 *
 * Digistore24 wraps every response in an envelope:
 *
 *   { "api_version": "...", "result": "success", "data": { ... } }
 *
 * Crucially, application-level errors (bad API key, unknown function, missing
 * argument) frequently arrive as HTTP 200 with `result: "error"` and a
 * `message` field rather than a 4xx/5xx status. The client therefore inspects
 * the envelope after a successful HTTP read: if `result` is not `"success"` we
 * raise a `NetworkError` carrying the verbatim body, so principle 4.1 holds
 * even when the transport status was 200. The unwrapped `data` payload is
 * returned to the adapter.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('digistore24.client');

/**
 * The Digistore24 API root. Centralised so a test harness can override it
 * without touching adapter code. Hard-coded for v0.1. Functions are appended
 * as a path segment: `${DIGISTORE24_BASE_URL}/api/call/{function}`.
 */
export const DIGISTORE24_BASE_URL = 'https://www.digistore24.com';

/** Shape of the Digistore24 response envelope (read defensively). */
interface Digistore24Envelope {
  api_version?: string;
  result?: string;
  message?: string;
  data?: unknown;
}

export interface Digistore24RequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** The Digistore24 API function name, e.g. `listTransactions`, `ping`. */
  function: string;
  /** API key. Passed in from auth helpers so credential reads happen once per op. */
  apiKey: string;
  /** Query string parameters. Values with `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Resilience knobs for this specific call. Required so each op picks its own profile. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single Digistore24 API request under the resilience policy and
 * return the unwrapped `data` payload typed as `T`.
 *
 * Why no runtime schema validation: Digistore24's surface is large and its
 * field set drifts. Over-specifying a Zod schema would force this layer into
 * the business of "is this a valid response?", which belongs in the adapter's
 * transformer where missing fields can be interpreted with context. The cost
 * is that adapter transformers MUST tolerate missing keys defensively.
 */
export async function digistore24Request<T>(input: Digistore24RequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'digistore24', operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input.function, input.query);
      const init: RequestInit = {
        method: 'GET',
        headers: buildHeaders(input.apiKey),
      };
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ url, operation: input.operation, fn: input.function }, 'digistore24 request');

      const res = await fetch(url, init);

      // Read the body once. We need it both for success (decode JSON) and for
      // failure (surface the raw text on the envelope). Digistore24 error
      // bodies are JSON-shaped but may be HTML when fronted by a CDN —
      // preserving the raw text means the user sees the actual content.
      const rawBody = await res.text();

      if (!res.ok) {
        // Throw HttpStatusError so the resilience layer applies its retry /
        // no-retry decision uniformly. Policy lives in resilience.ts.
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Digistore24 ${input.operation} GET /api/call/${input.function} → HTTP ${res.status}`,
        );
      }

      if (rawBody.trim() === '') {
        return {} as T;
      }

      let parsed: Digistore24Envelope;
      try {
        parsed = JSON.parse(rawBody) as Digistore24Envelope;
      } catch (err) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: 'digistore24',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Digistore24 ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }

      // Digistore24 surfaces application-level errors as HTTP 200 with
      // `result: "error"`. Treat anything other than an explicit "success" as a
      // failure so principle 4.1 holds — the verbatim body travels on the
      // envelope rather than the adapter silently mapping an error payload as
      // if it were data.
      if (parsed.result !== undefined && parsed.result !== 'success') {
        const message = parsed.message ?? `Digistore24 ${input.operation} returned result="${parsed.result}"`;
        throw new NetworkError(
          buildErrorEnvelope({
            // A bad/expired key reports result="error" on a 200; classify by
            // message so the wizard can hint actionably.
            type: /api[\s_-]?key|auth|permission|access|token/i.test(message)
              ? 'auth_error'
              : 'network_api_error',
            network: 'digistore24',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Digistore24 ${input.operation}: ${message}`,
          }),
        );
      }

      // Return the unwrapped `data` payload. When the envelope is absent (some
      // functions reply with a bare object) fall back to the whole body.
      return (parsed.data !== undefined ? parsed.data : parsed) as T;
    },
    input.resilience,
  );
}

/**
 * Build the Digistore24 auth headers.
 *
 * Digistore24 uses a custom `X-DS-API-KEY` header rather than the HTTP
 * `Authorization: Bearer ...` convention. `Accept: application/json` selects
 * the JSON serialiser (the API can also return XML or PHP-serialised arrays).
 */
function buildHeaders(apiKey: string): Record<string, string> {
  return {
    'X-DS-API-KEY': apiKey,
    Accept: 'application/json',
  };
}

/**
 * Compose the full URL for an API function call with its query string.
 *
 * We use `URL` + `URLSearchParams` rather than string concatenation because
 * Digistore24's `from`/`to` values and bracketed `search[...]` keys must be
 * URL-encoded correctly.
 */
function buildUrl(fn: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(`/api/call/${encodeURIComponent(fn)}`, DIGISTORE24_BASE_URL);
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
