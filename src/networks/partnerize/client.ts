/**
 * Partnerize HTTP client — the ONLY path Partnerize adapter methods use for network I/O.
 *
 * Why this file exists separately from `adapter.ts`: see `src/networks/awin/client.ts`
 * for the full rationale. The short version: every `fetch` call goes through
 * `withResilience` so timeout, retry, and circuit-breaker policies apply uniformly.
 *
 * Auth model: HTTP Basic, where the Base64-encoded credential is formed from
 * `application_key:user_api_key`. This is Partnerize's documented auth scheme —
 * the application_key identifies the network partition and the user_api_key
 * identifies the user. Both are read at call time from the config layer rather
 * than baked in at module load.
 *
 * Base URL: https://api.partnerize.com (no version prefix — Partnerize exposes
 * both /v2 and versioned legacy paths; the reporting endpoints used in this
 * adapter live directly under `/reporting/...`).
 *
 * Hard rules:
 *   1. Do NOT call `fetch` from `adapter.ts`. Call `partnerizeRequest` instead.
 *   2. Do NOT bypass `withResilience` for "just one call".
 *   3. On a non-2xx response throw `HttpStatusError` so the resilience layer
 *      applies its retry/no-retry decision uniformly.
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

const log = createLogger('partnerize.client');

/**
 * Partnerize API base URL.
 *
 * Centralised here so a test harness or staging environment can override it
 * without touching adapter code. Hard-coded for v0.1.
 */
export const PARTNERIZE_BASE_URL = 'https://api.partnerize.com';

export interface PartnerizeRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /**
   * Path beginning with `/` — joined to `PARTNERIZE_BASE_URL`.
   * Example: `/reporting/report_publisher/publisher/{id}/conversion`
   */
  path: string;
  /** Partnerize application_key. Passed in so callers can fetch from `requireCredential` once. */
  applicationKey: string;
  /** Partnerize user_api_key. Passed in so callers can fetch from `requireCredential` once. */
  userApiKey: string;
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
 * A decoded Partnerize response plus the pagination cursor, when present.
 *
 * Partnerize's granular reporting endpoints paginate with a `cursor_id`
 * RESPONSE HEADER (granular_reporting.apib: "if the result set includes a
 * `cursor_id` header attribute"); the caller passes it back as a `cursor_id`
 * query parameter to fetch the next page. The header, not the body, carries
 * the cursor, so the client must surface it alongside the decoded body.
 */
export interface PartnerizeCursorResponse<T> {
  body: T;
  /** The `cursor_id` response header, present when another page is available. */
  cursorId?: string;
}

/**
 * Issue a single Partnerize API request under the resilience policy.
 *
 * Why the response is typed as `T` with no runtime validation: Partnerize's
 * response shapes drift over time; over-specifying a Zod schema would force
 * the client into "is this a valid response?" work that belongs in the adapter
 * transformer (where missing fields can be interpreted with context). The cost
 * is that adapter transformers MUST tolerate missing keys defensively.
 */
export async function partnerizeRequest<T>(input: PartnerizeRequestInput): Promise<T> {
  const { body } = await partnerizeRequestWithCursor<T>(input);
  return body;
}

/**
 * Issue a single Partnerize API request and surface the `cursor_id` response
 * header alongside the decoded body. Adapter pagination loops use this to
 * follow cursor continuation on the granular reporting endpoints; callers that
 * do not paginate should use `partnerizeRequest` instead.
 */
export async function partnerizeRequestWithCursor<T>(
  input: PartnerizeRequestInput,
): Promise<PartnerizeCursorResponse<T>> {
  const ctx: WithResilienceContext = { network: 'partnerize', operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input.path, input.query);
      const init: RequestInit = {
        method: input.method ?? 'GET',
        headers: buildHeaders(input.applicationKey, input.userApiKey, input.body !== undefined),
      };
      if (input.body !== undefined) {
        init.body = JSON.stringify(input.body);
      }
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ url, method: init.method, operation: input.operation }, 'partnerize request');

      const res = await fetch(url, init);

      // Read the body once. We need it both for success (decode JSON) and for
      // failure (surface the raw text on the envelope). Partnerize can serve
      // an HTML error page from its CDN on gateway errors — preserving the raw
      // text means the user sees the actual content rather than a paraphrase.
      const rawBody = await res.text();

      if (!res.ok) {
        // Throw HttpStatusError so the resilience layer applies its retry/no-retry
        // decision uniformly. Policy lives in resilience.ts; never inspect the
        // status here to decide retries.
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Partnerize ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
        );
      }

      // Pagination cursor: Partnerize returns `cursor_id` as a response header
      // on paginated result sets (see PartnerizeCursorResponse).
      const cursorId = res.headers.get('cursor_id') ?? undefined;

      // Empty body — return as the empty object. Adapters that legitimately
      // expect a payload will detect the missing fields and throw a meaningful
      // envelope.
      if (rawBody.trim() === '') {
        return { body: {} as T, cursorId };
      }

      try {
        return { body: JSON.parse(rawBody) as T, cursorId };
      } catch (err) {
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: 'partnerize',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message:
              `Partnerize ${input.operation} returned HTTP ${res.status} with non-JSON body ` +
              `(parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Build the Authorization + Accept headers.
 *
 * Partnerize Basic auth: base64(`application_key:user_api_key`).
 * We always send `Accept: application/json` because Partnerize endpoints can
 * default to XML in some configurations — being explicit removes that failure mode.
 *
 * Buffer is available in Node.js. This file does not run in the browser.
 */
function buildHeaders(
  applicationKey: string,
  userApiKey: string,
  hasBody: boolean,
): Record<string, string> {
  const credentials = Buffer.from(`${applicationKey}:${userApiKey}`).toString('base64');
  const headers: Record<string, string> = {
    Authorization: `Basic ${credentials}`,
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
 * Partnerize's query values include ISO timestamps with `+`/`:` that MUST be
 * URL-encoded. Hand-rolled string building is unreliable here.
 */
function buildUrl(pathname: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, PARTNERIZE_BASE_URL);
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
