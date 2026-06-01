/**
 * Sovrn Commerce HTTP client — the ONLY path adapter methods use for I/O.
 *
 * Sovrn Commerce (formerly VigLink) exposes reporting APIs at:
 *   https://viglink.io/v1/reports/...
 *
 * Authentication (from public docs at developer.sovrn.com / support.viglink.com):
 *   Authorization: secret {SECRET_KEY}
 *
 * The "secret" prefix is literal — the header value is "secret <key>", not
 * "Bearer <key>". This is Sovrn's custom auth model. The site API key is used
 * for generating tracking links (redirect.viglink.com?key=...) and is distinct
 * from the Secret key used for reporting API calls.
 *
 * Hard rules (per cardinal rule 1):
 *   1. Do NOT call `fetch` from adapter.ts or any other file in this folder.
 *   2. Do NOT add a second client that skips `withResilience`.
 *   3. On a non-2xx response, throw `HttpStatusError`.
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

const log = createLogger('sovrn-commerce.client');

/**
 * The Sovrn Commerce API base URL.
 *
 * Sovrn's reporting APIs are served from viglink.io (the original VigLink
 * domain), even after the rebrand to Sovrn Commerce. The developer portal
 * at developer.sovrn.com documents endpoints with example curl calls against
 * https://viglink.io/v1/... — we use this host for all reporting calls.
 *
 * The tracking redirect host (redirect.viglink.com) is used only in
 * generateTrackingLink, which is deterministic and does not call fetch.
 */
export const SOVRN_BASE_URL = 'https://viglink.io';

export interface SovrnRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to SOVRN_BASE_URL. */
  path: string;
  /** Secret key for Authorization header. */
  secretKey: string;
  method?: 'GET' | 'POST';
  /** Query string parameters. Undefined values are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Body for POST requests; serialised as JSON. */
  body?: unknown;
  /** Resilience profile for this specific call. */
  resilience: ResilienceConfig;
  /** Optional AbortSignal for cooperative cancellation. */
  signal?: AbortSignal;
}

/**
 * Issue a single Sovrn Commerce API request under the resilience policy.
 *
 * Why typed as T with no runtime validation: Sovrn's surface is partially
 * documented; adapters must treat every field as possibly absent and preserve
 * originals under rawNetworkData. See Awin client.ts for the rationale.
 */
export async function sovrnRequest<T>(input: SovrnRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'sovrn-commerce', operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input.path, input.query);
      const init: RequestInit = {
        method: input.method ?? 'GET',
        headers: buildHeaders(input.secretKey, input.body !== undefined),
      };
      if (input.body !== undefined) {
        init.body = JSON.stringify(input.body);
      }
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ url, method: init.method, operation: input.operation }, 'sovrn-commerce request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Sovrn Commerce ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
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
            network: 'sovrn-commerce',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message:
              `Sovrn Commerce ${input.operation} returned HTTP ${res.status} with non-JSON body ` +
              `(parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Build the Authorization header.
 *
 * Sovrn Commerce uses a custom auth scheme: the header value is literally
 * "secret {SECRET_KEY}" (the word "secret" followed by a space and the key).
 * This is documented at support.viglink.com and developer.sovrn.com. It is
 * distinct from "Bearer" and must be reproduced exactly or the API returns 401.
 *
 * The site API key is NOT used in reporting API calls — it is only needed for
 * constructing tracking links via redirect.viglink.com.
 *
 * Source: https://developer.sovrn.com/ and
 *         https://knowledge.sovrn.com/how-to-implement-sovrn-commerce-apis
 */
function buildHeaders(secretKey: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    // The word "secret" followed by a space is part of the protocol.
    Authorization: `secret ${secretKey}`,
    Accept: 'application/json',
  };
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

function buildUrl(pathname: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, SOVRN_BASE_URL);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export { HttpStatusError };
