/**
 * Awin HTTP client — the ONLY path Awin adapter methods use for network I/O.
 *
 * Why this file exists separately from `adapter.ts`:
 *   - Adapter methods speak in normalised domain types and stay readable as
 *     "describe what an operation does"; they must not be entangled with URL
 *     construction, header building, JSON parsing, or status handling.
 *   - The resilience layer (timeout, retry policy, circuit breaker — see
 *     `src/shared/resilience.ts`) is sanctioned to wrap any callable. Centralising
 *     `fetch` here means the policy is applied uniformly, exactly once per
 *     network call, with no chance of an adapter method bypassing it.
 *   - The HTTP↔domain seam is one of the most-mutated lines in any adapter when
 *     a network's API drifts (and Awin's does). Keeping it in one file means a
 *     future contributor patches one place, not seven.
 *
 * Hard rules for future contributors (Awin and pattern-matched networks alike):
 *   1. Do NOT call `fetch` from `adapter.ts` or anywhere else in this folder.
 *   2. Do NOT add a second client that skips `withResilience` "just for one
 *      call". The policy is the contract — debugging an adapter is impossible
 *      when half its calls retry and half do not.
 *   3. On a non-2xx response, throw `HttpStatusError` so the resilience layer
 *      can apply its retry policy uniformly (PRD §15.5).
 *   4. Preserve the raw response body verbatim on failure (`networkErrorBody`
 *      in the envelope downstream). Never paraphrase, never collapse to "an
 *      error occurred" (PRD principle 4.1).
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { AnyOperation, ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('awin.client');

/**
 * The Awin API root. Centralised so a test harness or staging environment can
 * override it without touching adapter code (future: an `AWIN_BASE_URL` env
 * var). Hard-coded for v0.1.
 */
export const AWIN_BASE_URL = 'https://api.awin.com';

export interface AwinRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: AnyOperation;
  /** Path beginning with `/` — joined to `AWIN_BASE_URL`. */
  path: string;
  /** Bearer token. Passed in so callers can fetch from `requireCredential` once. */
  token: string;
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
 * Issue a single Awin API request under the resilience policy.
 *
 * Why the response is typed as `T` with no runtime validation: Awin's REST
 * surface is large and weakly documented; over-specifying a Zod schema here
 * would force the client into the business of "is this a valid Awin response?",
 * which belongs in the adapter's transformer (where we can interpret missing
 * fields with context — e.g. `dateApproved` is absent for pending transactions
 * and that's fine). The cost is that adapter transformers MUST tolerate missing
 * keys defensively.
 */
export async function awinRequest<T>(input: AwinRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'awin', operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input.path, input.query);
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

      log.debug({ url, method: init.method, operation: input.operation }, 'awin request');

      const res = await fetch(url, init);

      // Read the body once. We need it both for success (decode JSON) and for
      // failure (surface the raw text on the envelope). Awin's error bodies are
      // typically JSON-shaped but occasionally HTML when fronted by a CDN —
      // preserving the raw text means the user sees the actual content.
      const rawBody = await res.text();

      if (!res.ok) {
        // Throw HttpStatusError so the resilience layer applies its retry/no-retry
        // decision uniformly. Do NOT inspect `res.status` here to decide retries —
        // policy lives in one place (resilience.ts).
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Awin ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
        );
      }

      // Empty body (rare for Awin, common pattern in other networks) is
      // returned as the empty object — adapters that legitimately expect a
      // payload will detect the missing fields and throw a meaningful envelope.
      if (rawBody.trim() === '') {
        return {} as T;
      }

      try {
        return JSON.parse(rawBody) as T;
      } catch (err) {
        // Polish (Chunk 10): emit a NetworkError carrying a verbatim
        // networkErrorBody so PRD §4.1 (preserve raw upstream body) holds even
        // for 2xx-with-non-JSON. Previously we threw a generic Error which the
        // resilience layer would classify as network_api_error but with no
        // networkErrorBody attached.
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: 'awin',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Awin ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Build the Authorization headers.
 *
 * Why no `User-Agent`: Awin doesn't require it and overspecifying default
 * headers makes the client harder to mock in tests. Future networks that
 * require an identifying UA (eBay does) override locally.
 */
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

/**
 * Compose the full URL with query string.
 *
 * We use `URL` + `URLSearchParams` rather than string concatenation because
 * Awin's query values include ISO timestamps with `+`/`:`/timezone offsets
 * that MUST be URL-encoded. Hand-rolled string building has bitten me before
 * — `URLSearchParams` is the right tool.
 */
function buildUrl(pathname: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, AWIN_BASE_URL);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

// Re-export so adapter code can throw HttpStatusError without importing from
// shared/resilience directly. The boundary stays clean: "everything network
// goes through ./client".
export { HttpStatusError };
