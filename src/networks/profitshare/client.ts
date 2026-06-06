/**
 * Profitshare HTTP client — the ONLY path Profitshare adapter methods use for
 * network I/O.
 *
 * Why this file exists separately from `adapter.ts` (mirrors Awin's client.ts —
 * read that file for the full rationale):
 *   - Adapter methods speak in normalised domain types; they must not be
 *     entangled with URL construction, header building, JSON parsing, or
 *     status handling.
 *   - The resilience layer (timeout, retry, circuit breaker) wraps every
 *     outgoing call exactly once, here, so no adapter method can bypass it.
 *
 * --- The Profitshare auth quirk: HMAC-signed requests -----------------------
 *
 * Profitshare does NOT use a bearer token. Every request carries four headers
 * and a per-request signature:
 *
 *   Date:        RFC 1123 GMT timestamp, e.g. "Mon, 15 Jan 2024 10:30:45 GMT".
 *   X-PS-Client: the API user (the public half of the credential pair).
 *   X-PS-Accept: "json".
 *   X-PS-Auth:   HMAC-SHA1 hex digest over a canonical signature string, keyed
 *                with the API key (the secret half).
 *
 * The signature string is, verbatim from the reference PHP client
 * (https://github.com/ConversionMarketing/profitshare-api):
 *
 *   {METHOD}{resource}/?{query_string}/{api_user}{date}
 *
 * where:
 *   - METHOD       is the upper-case HTTP method ("GET" / "POST").
 *   - resource     is the endpoint WITHOUT a leading slash, e.g.
 *                  "affiliate-advertisers".
 *   - query_string is the URL-decoded query string (PHP builds it with
 *                  http_build_query then urldecode; for our purposes the
 *                  key=value&... form using the SAME ordering we send on the
 *                  wire, un-percent-encoded). Empty for endpoints with no query.
 *   - api_user     is X-PS-Client.
 *   - date         is the exact Date header value (so the two MUST be computed
 *                  once and reused — see `signRequest`).
 *
 * The signature is therefore deterministic for a fixed (method, resource,
 * query, api_user, api_key, date) tuple. The unit test pins this.
 *
 * We use Node's built-in `crypto` (`createHmac`) — no new dependency.
 *
 * Hard rules (mirrored from Awin client.ts):
 *   1. Do NOT call `fetch` from `adapter.ts` or anywhere else in this folder.
 *   2. Do NOT add a second client that skips `withResilience`.
 *   3. On a non-2xx response, throw `HttpStatusError` so the resilience layer
 *      can apply its retry policy uniformly.
 *   4. Preserve the raw response body verbatim on failure.
 */

import { createHmac } from 'node:crypto';

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('profitshare.client');

export const PROFITSHARE_SLUG = 'profitshare';

/**
 * The Profitshare affiliate API root.
 *
 * The reference PHP client uses `http://api.profitshare.ro`. We upgrade to
 * HTTPS: the API answers on TLS and shipping a plain-HTTP base URL would send
 * the signed credentials in clear text. Centralised so a test harness can
 * override it without touching adapter code.
 */
export const PROFITSHARE_BASE_URL = 'https://api.profitshare.ro';

export interface ProfitshareCredentials {
  /** The API user — the public half. Sent as `X-PS-Client`. */
  apiUser: string;
  /** The API key — the secret half. Used as the HMAC key; never sent. */
  apiKey: string;
}

export interface ProfitshareRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /**
   * Resource path WITHOUT a leading slash, e.g. "affiliate-advertisers".
   * The signature string and the URL are both built from this exact value.
   */
  resource: string;
  /** API credential pair. Passed in so the read happens once in the adapter. */
  credentials: ProfitshareCredentials;
  method?: 'GET' | 'POST';
  /**
   * Query string parameters for GET requests. Values that are `undefined` are
   * skipped. The SAME object is used to build both the signed query string and
   * the URL so the two cannot drift.
   */
  query?: Record<string, string | number | undefined>;
  /** Body for POST requests; serialised as form-encoded (Profitshare expects this). */
  body?: Record<string, string | number | undefined>;
  /** Resilience knobs for this specific call. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
  /**
   * Test-only: pin the Date used for signing so the signature is deterministic.
   * Production callers never set this — the live Date is generated per call.
   */
  now?: Date;
}

/**
 * Build the canonical, un-percent-encoded query string used BOTH on the wire
 * and inside the signature string. Order follows insertion order of `query`
 * (the same order the adapter declares it), which keeps the signed string and
 * the request URL byte-for-byte consistent.
 */
function buildQueryString(query?: Record<string, string | number | undefined>): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue;
    parts.push(`${k}=${String(v)}`);
  }
  return parts.join('&');
}

/**
 * Format a Date as the RFC 1123 GMT string Profitshare expects in the `Date`
 * header and inside the signature. Node's `toUTCString()` produces exactly the
 * `gmdate('D, d M Y H:i:s T')` shape the reference client uses, e.g.
 * "Mon, 15 Jan 2024 10:30:45 GMT".
 */
export function formatProfitshareDate(d: Date): string {
  return d.toUTCString();
}

/**
 * Compute the four Profitshare auth headers for a request.
 *
 * Exported (and pure) so the unit test can assert the signature and Date header
 * are present and deterministic for a fixed input without any HTTP.
 */
export function signRequest(input: {
  method: 'GET' | 'POST';
  resource: string;
  queryString: string;
  credentials: ProfitshareCredentials;
  date: Date;
}): Record<string, string> {
  const dateHeader = formatProfitshareDate(input.date);
  // Signature string: METHOD + resource + '/?' + query_string + '/' + api_user + date
  const signatureString =
    input.method +
    input.resource +
    '/?' +
    input.queryString +
    '/' +
    input.credentials.apiUser +
    dateHeader;
  const auth = createHmac('sha1', input.credentials.apiKey)
    .update(signatureString)
    .digest('hex');
  return {
    Date: dateHeader,
    'X-PS-Client': input.credentials.apiUser,
    'X-PS-Accept': 'json',
    'X-PS-Auth': auth,
  };
}

/**
 * Issue a single Profitshare API request under the resilience policy.
 *
 * Why the response is typed as `T` with no runtime validation: Profitshare's
 * surface is weakly documented and the affiliate endpoints have not been
 * verified against a live account at commit time. Over-specifying a schema here
 * would force the client into the business of "is this a valid response?",
 * which belongs in the adapter's defensive transformers. Adapter transformers
 * MUST tolerate missing keys.
 */
export async function profitshareRequest<T>(input: ProfitshareRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: PROFITSHARE_SLUG, operation: input.operation };
  const method = input.method ?? 'GET';

  return withResilience(
    ctx,
    async () => {
      // GET requests sign + send the query string; POST requests sign with an
      // empty query string (the reference client only signs query params for
      // GET) and carry the payload form-encoded in the body.
      const queryString = method === 'GET' ? buildQueryString(input.query) : '';
      const date = input.now ?? new Date();
      const headers = signRequest({
        method,
        resource: input.resource,
        queryString,
        credentials: input.credentials,
        date,
      });

      const url =
        `${PROFITSHARE_BASE_URL}/${input.resource}/?` + (queryString ? queryString : '');

      const init: RequestInit = { method, headers };
      if (method === 'POST' && input.body) {
        const form = buildQueryString(input.body);
        init.body = form;
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
      }
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ url, method, operation: input.operation }, 'profitshare request');

      const res = await fetch(url, init);

      // Read the body once: needed both for success (decode JSON) and failure
      // (surface verbatim on the envelope).
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Profitshare ${input.operation} ${method} ${input.resource} → HTTP ${res.status}`,
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
            network: PROFITSHARE_SLUG,
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Profitshare ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

// Re-export so adapter code can throw HttpStatusError without importing from
// shared/resilience directly.
export { HttpStatusError };
