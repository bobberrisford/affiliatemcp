/**
 * Kwanko advertiser HTTP client — the ONLY path Kwanko advertiser adapter
 * methods use for network I/O.
 *
 * Read-only by design: the client refuses any non-GET method at runtime so the
 * adapter cannot accidentally ship a write operation. This is belt-and-braces
 * alongside the read-only token we recommend in the setup notes. Defence in
 * depth matters because the Kwanko advertiser surface can expose mutation
 * endpoints (campaign edits, validation changes) and we want zero risk of one
 * accidentally going out.
 *
 * Why this file exists separately from `adapter.ts`:
 *   - Adapter methods speak in normalised domain types; URL construction, header
 *     building, JSON parsing, and status handling live here.
 *   - The resilience layer (timeout, retry policy, circuit breaker — see
 *     `src/shared/resilience.ts`) is applied uniformly, exactly once per call.
 *
 * --- Kwanko advertiser API surface ---------------------------------------------
 *
 * Base URL: https://api.kwanko.com  (Bearer token in the Authorization header)
 *   Sources: https://developers.kwanko.com/ ;
 *            https://helpdesk-advertiser.kwanko.com/ (advertiser API: retrieve
 *            your statistics and conversions);
 *            dltHub Kwanko source config (base_url https://api.kwanko.com,
 *            bearer auth, resources "conversions" + "statistics").
 *
 *   GET /advertiser/campaigns       list the advertiser's campaigns (programmes)
 *   GET /advertiser/conversions     conversions (leads / sales / downloads)
 *       ?debut=YYYY-MM-DD&fin=YYYY-MM-DD
 *   GET /advertiser/statistics      aggregated statistics by campaign, website
 *       (publisher), and date range (clicks, conversions, spending, bonuses)
 *       ?debut=YYYY-MM-DD&fin=YYYY-MM-DD&camp={campaignId}
 *
 * BLOCKED(verify): developers.kwanko.com and the advertiser help desk return
 * HTTP 403 to automated fetch, so the exact path segments, query-parameter
 * names (`debut`/`fin`/`camp`/`champs` are taken from public summaries of the
 * advertiser statistics API), and JSON field names are NOT machine-readable.
 * The adapter reads every field defensively and preserves the verbatim payload
 * in `rawNetworkData`; a live-account test is required before promoting beyond
 * `experimental`.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { AnyOperation, ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

import { SLUG } from './auth.js';

const log = createLogger('kwanko-advertiser.client');

/**
 * The Kwanko Web Service API base URL.
 * Source: dltHub Kwanko source (base_url "https://api.kwanko.com");
 *         https://developers.kwanko.com/
 */
export const KWANKO_ADV_BASE_URL = 'https://api.kwanko.com';

export interface KwankoAdvRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: AnyOperation | 'verifyAuth';
  /** Path beginning with `/` — joined to the base URL. */
  path: string;
  /** Bearer API token issued in the Kwanko platform. */
  token: string;
  /** Method. Always `GET` at v0.1; passing anything else throws. */
  method?: 'GET';
  /** Query string parameters. Values with `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Resilience knobs for this specific call. */
  resilience: ResilienceConfig;
  /** Override base URL (kept for symmetry with other adapters). */
  baseUrl?: string;
  /** Optional AbortSignal for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single Kwanko advertiser API request under the resilience policy.
 *
 * Cardinal: only GET is permitted. Any other method throws a `config_error`
 * before the network call goes out.
 *
 * Why we don't validate response shapes with Zod: Kwanko's developer reference
 * is not machine-readable, so field names are not certain. Treating every field
 * as possibly absent and preserving `rawNetworkData` is more robust than a
 * schema that breaks on the first naming surprise.
 */
export async function kwankoAdvRequest<T>(input: KwankoAdvRequestInput): Promise<T> {
  // Hard read-only guard. This adapter ships read-only at v0.1 and a future
  // contributor must consciously remove this throw to enable writes.
  const method = input.method ?? 'GET';
  if (method !== 'GET') {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation: input.operation,
        message: `Kwanko advertiser adapter is read-only at v0.1; refusing ${method}.`,
        hint:
          'This adapter only issues GET requests. To enable writes a future PR must lift this ' +
          'guard explicitly AND the operator must rotate to a read-write Kwanko token.',
      }),
    );
  }

  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };
  const base = input.baseUrl ?? KWANKO_ADV_BASE_URL;

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(base, input.path, input.query);
      const init: RequestInit = {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${input.token}`,
          Accept: 'application/json',
        },
      };
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ url, operation: input.operation }, 'kwanko-advertiser request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Kwanko advertiser ${input.operation} GET ${input.path} → HTTP ${res.status}`,
        );
      }

      const trimmed = rawBody.trim();
      if (trimmed === '' || trimmed === 'null') {
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
            message: `Kwanko advertiser ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Compose the absolute URL for a path + query.
 *
 * Exported (and re-exported on the adapter's `_internals`) so tests can assert
 * URL shape directly.
 */
export function buildUrl(
  base: string,
  pathname: string,
  query?: Record<string, string | number | undefined>,
): string {
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, base);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export { HttpStatusError };
