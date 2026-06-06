/**
 * Addrevenue HTTP client — the ONLY path Addrevenue adapter methods use for
 * network I/O.
 *
 * Addrevenue (a Nordic network, primary market SE) exposes a REST API
 * authenticated with a long-lived OAuth2 "lifetime" token that the publisher
 * generates by hand under Tools → API Tokens. The token does not auto-rotate,
 * so for v0.1 we treat it exactly like a static bearer secret — there is no
 * refresh flow to manage (contrast Rakuten's client-credentials cache). If
 * Addrevenue ever moves to rotating tokens, this file and `auth.ts` are the
 * only places that change.
 *
 * Hard rules for future contributors (mirrored from Awin's client.ts — read
 * that file for the full rationale):
 *   1. Do NOT call `fetch` from `adapter.ts` or anywhere else in this folder.
 *   2. Do NOT add a second client that skips `withResilience`.
 *   3. On a non-2xx response, throw `HttpStatusError` so the resilience layer
 *      applies its retry policy uniformly (PRD §15.5). Never inspect the status
 *      here to decide retries — that policy lives in `resilience.ts`.
 *   4. Preserve the raw response body verbatim on failure (principle 4.1).
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('addrevenue.client');

/**
 * The Addrevenue API root.
 *
 * The public developer reference lives at https://addrevenue.io/en/developers
 * and documents a versioned REST surface served under `/api/v2`. Centralised
 * here so a test harness can override it without touching adapter code.
 * Hard-coded for v0.1.
 */
export const ADDREVENUE_BASE_URL = 'https://addrevenue.io/api/v2';

export interface AddrevenueRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to `ADDREVENUE_BASE_URL`. */
  path: string;
  /** Bearer token. Passed in so callers fetch from `requireCredential` once per op. */
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
 * Issue a single Addrevenue API request under the resilience policy.
 *
 * Why the response is typed as `T` with no runtime validation: as with Awin,
 * over-specifying a Zod schema here forces the client into "is this a valid
 * response?" business that belongs in the adapter's transformer, where missing
 * fields can be interpreted with context. The cost is that transformers MUST
 * tolerate missing keys defensively — they do.
 */
export async function addrevenueRequest<T>(input: AddrevenueRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'addrevenue', operation: input.operation };

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

      log.debug({ url, method: init.method, operation: input.operation }, 'addrevenue request');

      const res = await fetch(url, init);

      // Read the body once. We need it both for success (decode JSON) and for
      // failure (surface the raw text on the envelope). Preserving the raw text
      // means the user sees the actual upstream content, JSON or not.
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Addrevenue ${input.operation} ${init.method ?? 'GET'} ${input.path} → HTTP ${res.status}`,
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
            network: 'addrevenue',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Addrevenue ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
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
 * Addrevenue's lifetime token is a standard `Authorization: Bearer <token>`
 * credential. `Accept: application/json` is set unconditionally because every
 * documented endpoint returns JSON.
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
 * Compose the full URL with query string, using `URL` + `URLSearchParams` so
 * date values and channel IDs are encoded correctly.
 */
function buildUrl(pathname: string, query?: Record<string, string | number | undefined>): string {
  const base = ADDREVENUE_BASE_URL.endsWith('/') ? ADDREVENUE_BASE_URL : `${ADDREVENUE_BASE_URL}/`;
  const url = new URL(pathname.startsWith('/') ? pathname.slice(1) : pathname, base);
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
