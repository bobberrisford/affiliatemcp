/**
 * FlexOffers HTTP client — the ONLY path FlexOffers adapter methods use for I/O.
 *
 * Why this file exists separately from `adapter.ts`:
 *   - Adapter methods speak normalised domain types; URL construction, header
 *     building, JSON parsing, and status handling live here.
 *   - The resilience layer (timeout, retry policy, circuit breaker — see
 *     `src/shared/resilience.ts`) is applied uniformly, exactly once per call.
 *
 * --- FlexOffers API surface (verified against public documentation, 2026-06-04) -
 *
 *   Base URL: https://api.flexoffers.com
 *     The public REST API (a Swagger/OpenAPI surface) is served from this host.
 *     Source: https://api.flexoffers.com/ (FlexOffers.Services.RestApi)
 *             https://supportpro.flexoffers.com/flexoffers-api/
 *
 *   Authentication: a single API Key tied to the publisher account. The Swagger
 *     "Authorize" affordance takes the raw API key (no "Bearer" prefix), which
 *     the API expects as a request header named `apiKey`.
 *     Source: https://supportpro.flexoffers.com/flexoffers-api-authentication/
 *             https://supportbeta.flexoffers.com/knowledge/how-to-access-api-data-with-the-flexoffers-web-services-tool
 *     BLOCKED(verify): the exact header casing (`apiKey`) is taken from public
 *     integration write-ups; a live account is required to confirm the header
 *     name and that the key is header-borne rather than a query parameter. The
 *     header name is centralised in `FLEXOFFERS_API_KEY_HEADER` so a single edit
 *     corrects it if a live test disagrees.
 *
 *   Sales / transaction reporting:
 *     GET /allsales?reportType=details&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD
 *         [&status=pending|approved|canceled|bonus|non-commissionable]
 *         &page=N&pageSize=M
 *     Source: https://www.flexoffers.com/new-features/sales-api-and-transaction-reporting-updates/
 *             https://www.flexoffers.com/new-features/api-endpoints-update/
 *     Pagination confirmed by the #316 investigation: a 1-based `page` plus
 *     `pageSize`; the adapter always sends both explicitly and never relies on
 *     the unconfirmed server default page size. The response envelope key is
 *     still not fully documented publicly; the transformer reads the rows
 *     defensively from several candidate shapes.
 *
 *   Payments: GET /payments/summary , GET /payments/details?paymentId=N
 *     Source: https://www.flexoffers.com/new-features/performance-report-enhancement-and-payments-api/
 *
 * Hard rules (per cardinal rule 1):
 *   1. Do NOT call `fetch` from adapter.ts or any other file in this folder.
 *   2. Do NOT add a second client that skips `withResilience`.
 *   3. On a non-2xx response, throw `HttpStatusError`.
 *   4. Preserve the raw response body verbatim on failure (`networkErrorBody`).
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('flexoffers.client');

/**
 * The FlexOffers REST API base URL.
 * Source: https://api.flexoffers.com/ (FlexOffers.Services.RestApi Swagger surface)
 */
export const FLEXOFFERS_BASE_URL = 'https://api.flexoffers.com';

/**
 * The request header that carries the publisher API key.
 *
 * FlexOffers' Swagger "Authorize" dialog accepts the raw API key and sends it
 * as a custom header (not an `Authorization: Bearer` token). Public integration
 * guides name this header `apiKey`. Centralised here so a single edit fixes it
 * if a live account proves the casing or location differs.
 * BLOCKED(verify): confirm against a live account.
 */
export const FLEXOFFERS_API_KEY_HEADER = 'apiKey';

export interface FlexOffersRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to FLEXOFFERS_BASE_URL. */
  path: string;
  /** The publisher API key, sent in the `apiKey` header. */
  apiKey: string;
  method?: 'GET' | 'POST';
  /** Query string parameters. Undefined values are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Body for POST requests; serialised as JSON. */
  body?: unknown;
  /** Resilience profile for this specific call. */
  resilience: ResilienceConfig;
  /** Optional AbortSignal for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single FlexOffers API request under the resilience policy.
 *
 * Why typed as T with no runtime validation: FlexOffers' field set is only
 * partially documented publicly and has drifted across API versions. Adapters
 * treat every field as possibly absent and preserve originals under
 * `rawNetworkData`. See Awin/Skimlinks client.ts for the rationale.
 */
export async function flexoffersRequest<T>(input: FlexOffersRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'flexoffers', operation: input.operation };

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

      log.debug({ url, method: init.method, operation: input.operation }, 'flexoffers request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `FlexOffers ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
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
            network: 'flexoffers',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message:
              `FlexOffers ${input.operation} returned HTTP ${res.status} with non-JSON body ` +
              `(parse error: ${(err as Error).message})`,
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
 * FlexOffers authenticates with a single account API key sent in a custom
 * header (`apiKey`), not an `Authorization: Bearer` token. Reproduced exactly
 * or the API returns 401.
 * Source: https://supportpro.flexoffers.com/flexoffers-api-authentication/
 */
function buildHeaders(apiKey: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    [FLEXOFFERS_API_KEY_HEADER]: apiKey,
    Accept: 'application/json',
  };
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

function buildUrl(pathname: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, FLEXOFFERS_BASE_URL);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export { HttpStatusError };
