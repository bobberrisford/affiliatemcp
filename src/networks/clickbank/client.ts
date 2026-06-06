/**
 * ClickBank HTTP client — the ONLY path ClickBank adapter methods use for
 * network I/O.
 *
 * ClickBank does not use a standard `Authorization: Bearer` token. It uses a
 * custom header that concatenates two keys with a colon:
 *
 *   Authorization: <DEVELOPER-KEY>:<CLERK-KEY>
 *
 * Both keys are minted in the account's Settings → API Management screen (the
 * developer key is account-wide; the clerk key is per-user). See `auth.ts` for
 * the credential-loading rationale. All header construction is centralised here
 * so the adapter stays readable and the resilience layer applies uniformly to
 * every outgoing call.
 *
 * Hard rules (mirrored from Awin client.ts — read that file for the full
 * rationale):
 *   1. Do NOT call `fetch` from `adapter.ts` or anywhere else in this folder.
 *   2. Do NOT add a second client that skips `withResilience`.
 *   3. On a non-2xx response, throw `HttpStatusError` so the resilience layer
 *      can apply its retry policy uniformly.
 *   4. Preserve the raw response body verbatim on failure.
 *
 * Docs: https://support.clickbank.com/en/articles/10535397-clickbank-api-specifications
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('clickbank.client');

/**
 * ClickBank REST API base URL. The API is versioned in the path (`/rest/1.3`),
 * so the base includes the version segment. Centralised so a test harness can
 * reason about the full URL in one place.
 *
 * Confirmed: https://api.clickbank.com/rest/1.3/ is the documented root for
 * orders2, analytics, quickstats, and products (ClickBank API Specifications).
 */
export const CLICKBANK_BASE_URL = 'https://api.clickbank.com/rest/1.3';

export interface ClickBankRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to `CLICKBANK_BASE_URL`. */
  path: string;
  /** Developer (account-wide) API key. Passed in from auth helpers. */
  developerKey: string;
  /** Clerk (per-user) API key. Passed in from auth helpers. */
  clerkKey: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Query string parameters. Values with `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /**
   * 1-based page number. ClickBank paginates list endpoints via a `Page`
   * REQUEST header (not a query parameter) and answers with HTTP 206 when
   * more pages remain. Omitted when undefined.
   */
  page?: number;
  /** Body for POST/PUT requests; serialised as JSON. */
  body?: unknown;
  /** Resilience knobs for this specific call. Required so each op picks its own profile. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single ClickBank API request under the resilience policy.
 *
 * Why the response is typed as `T` with no runtime validation: ClickBank's
 * REST surface returns deeply nested JSON whose field names drift between
 * order types. Over-specifying a schema here would force the client into the
 * business of "is this a valid ClickBank response?", which belongs in the
 * adapter's transformer (where missing fields can be interpreted with context).
 * The cost is that adapter transformers MUST tolerate missing keys defensively.
 */
export async function clickbankRequest<T>(input: ClickBankRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'clickbank', operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input.path, input.query);
      const init: RequestInit = {
        method: input.method ?? 'GET',
        headers: buildHeaders(input.developerKey, input.clerkKey, {
          hasBody: input.body !== undefined,
          page: input.page,
        }),
      };
      if (input.body !== undefined) {
        init.body = JSON.stringify(input.body);
      }
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ url, method: init.method, operation: input.operation }, 'clickbank request');

      const res = await fetch(url, init);

      // Read the body once. We need it both for success (decode JSON) and for
      // failure (surface the raw text on the envelope). ClickBank error bodies
      // are typically JSON-shaped but can be XML or plain text on CDN errors —
      // preserving the raw text means the user sees the actual content.
      const rawBody = await res.text();

      if (!res.ok) {
        // Throw HttpStatusError so the resilience layer applies its retry /
        // no-retry decision uniformly. Do NOT inspect `res.status` here.
        //
        // Note: ClickBank answers list endpoints with HTTP 206 (Partial
        // Content) when more pages remain. `res.ok` is true for 206, so a
        // 206 does NOT land here — see the success path below.
        throw new HttpStatusError(
          res.status,
          rawBody,
          `ClickBank ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
        );
      }

      // Empty body — returned as the empty object. Adapters that legitimately
      // expect a payload detect the missing fields and throw a meaningful
      // envelope.
      if (rawBody.trim() === '') {
        return {} as T;
      }

      try {
        return JSON.parse(rawBody) as T;
      } catch (err) {
        // PRD §4.1 — preserve the verbatim upstream body even for a 2xx with a
        // non-JSON payload (ClickBank can return XML if the Accept header is
        // ignored upstream). Surface it on the envelope rather than collapsing
        // to a generic error.
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: 'clickbank',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `ClickBank ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Build the ClickBank auth + request headers.
 *
 * Auth: `Authorization: <DEVELOPER-KEY>:<CLERK-KEY>` — a colon-joined pair, NOT
 * a Bearer token. Confirmed against ClickBank's published client examples and
 * the API Specifications page.
 *
 * `Accept: application/json` is set unconditionally: ClickBank defaults to XML
 * for several endpoints and only returns JSON when the Accept header asks for
 * it.
 *
 * `Page` is a REQUEST header (1-based) used to walk paginated list endpoints.
 */
function buildHeaders(
  developerKey: string,
  clerkKey: string,
  opts: { hasBody: boolean; page?: number },
): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `${developerKey}:${clerkKey}`,
    Accept: 'application/json',
  };
  if (opts.page !== undefined) {
    headers['Page'] = String(opts.page);
  }
  if (opts.hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

/**
 * Compose the full URL with query string, using `URL` + `URLSearchParams` so
 * date values and other reserved characters are encoded correctly.
 */
function buildUrl(pathname: string, query?: Record<string, string | number | undefined>): string {
  // Preserve the `/rest/1.3` base path: build relative to the base URL with a
  // leading-slash-trimmed pathname so URL resolution does not discard the
  // version segment.
  const base = CLICKBANK_BASE_URL.endsWith('/') ? CLICKBANK_BASE_URL : `${CLICKBANK_BASE_URL}/`;
  const rel = pathname.startsWith('/') ? pathname.slice(1) : pathname;
  const url = new URL(rel, base);
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
