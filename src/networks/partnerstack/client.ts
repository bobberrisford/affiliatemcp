/**
 * PartnerStack Partner API HTTP client — the ONLY path this adapter uses for
 * network I/O. Structurally a copy of `src/networks/awin/client.ts` (bearer
 * token, REST, JSON); read that file for the rationale behind every rule.
 *
 * --- PartnerStack Partner API surface (verify against ----------------------
 *     https://docs.partnerstack.com/docs/partner-api) -----------------------
 *
 *   Host:    https://api.partnerstack.com
 *   Prefix:  /api/v2   (the Partner API; distinct from the Vendor API's `/v2`)
 *   Auth:    Authorization: Bearer {PARTNERSTACK_API_KEY}
 *   Envelope: { "data": ..., "message": "...", "status": "2xx" }
 *   Paging:  cursor — `starting_after` / `ending_before` (mutually exclusive),
 *            `limit` (default 10); response carries `has_more`.
 *   Dates:   epoch milliseconds.
 *
 * `// TODO(verify)`: the exact path prefix (`/api/v2` for the Partner API) and
 * the precise envelope key names (`data` vs `data.items`) are documented but
 * have not been confirmed against a live partner account at commit time. The
 * prefix is centralised in `PARTNERSTACK_PATH_PREFIX` so a future contributor
 * patches one line. The adapter's `extractList`/`unwrapData` helpers read the
 * envelope defensively so a drift in key names degrades gracefully.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('partnerstack.client');

/** The PartnerStack API root. Centralised for test/staging override. */
export const PARTNERSTACK_BASE_URL = 'https://api.partnerstack.com';

/**
 * Path prefix for the Partner API. `// TODO(verify)`: the Partner API is
 * documented under `/api/v2`; the Vendor API uses `/v2`. Confirm against a live
 * partner account and adjust this single constant if it differs.
 */
export const PARTNERSTACK_PATH_PREFIX = '/api/v2';

export const SLUG = 'partnerstack';

export interface PartnerstackRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Resource path beginning with `/`, relative to the Partner API prefix (e.g. `/partnerships`). */
  path: string;
  /** Bearer API key. Passed in so callers fetch from `requireCredential` once. */
  apiKey: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Query string parameters. Values with `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Body for POST/PUT requests; serialised as JSON. */
  body?: unknown;
  /** Resilience knobs for this specific call. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single PartnerStack Partner API request under the resilience policy.
 *
 * Returns the parsed response body of type `T` (the full envelope —
 * `{ data, message, status }`). The adapter unwraps `data` itself so the
 * envelope's `message`/`status` remain available for error context.
 */
export async function partnerstackRequest<T>(input: PartnerstackRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input.path, input.query);
      const init: RequestInit = {
        method: input.method ?? 'GET',
        headers: buildHeaders(input.apiKey, input.body !== undefined),
      };
      if (input.body !== undefined) {
        init.body = JSON.stringify(input.body);
      }
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ url, method: init.method, operation: input.operation }, 'partnerstack request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `PartnerStack ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
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
            message: `PartnerStack ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

function buildHeaders(apiKey: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
  };
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

/**
 * Compose the full URL with the Partner API prefix and query string.
 * `URLSearchParams` handles encoding of cursor tokens and epoch-ms values.
 */
function buildUrl(pathname: string, query?: Record<string, string | number | undefined>): string {
  const rel = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const url = new URL(`${PARTNERSTACK_PATH_PREFIX}${rel}`, PARTNERSTACK_BASE_URL);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export { HttpStatusError };
