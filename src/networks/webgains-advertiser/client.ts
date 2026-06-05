/**
 * Webgains advertiser HTTP client — the ONLY path advertiser adapter methods
 * use for network I/O.
 *
 * Read-only by design: the client refuses any non-GET method at runtime so the
 * adapter cannot accidentally ship a write operation. This is belt-and-braces
 * alongside the read-only credential we recommend in the setup notes. The
 * defence-in-depth matters because the Webgains advertiser surface DOES expose
 * mutation endpoints (commission validation, transaction approvals) and we want
 * zero risk of one accidentally going out.
 *
 * Hard rules:
 *   1. Do NOT call `fetch` from adapter.ts or anywhere else in this folder.
 *   2. Do NOT bypass `withResilience` for any call.
 *   3. Only GET is permitted — any other method throws a `config_error` before
 *      the network call goes out.
 *   4. On non-2xx, throw `HttpStatusError` so the resilience layer retries
 *      uniformly (never on 4xx except 429).
 *   5. Preserve the raw response body verbatim on failure (`networkErrorBody`).
 *
 * --- Webgains advertiser API surface ------------------------------------------
 *
 * Authentication: OAuth2 "Personal Access Token". The advertiser generates a
 * token self-serve in the Webgains advertiser dashboard and passes it as a
 * standard bearer token:
 *   Authorization: Bearer {personalAccessToken}
 *   Source: https://docs.webgains.dev/docs/platform-api-1/yhwhwxlbhc1zv-authentication-with-personal-access-tokens
 *           https://knowledgehub.webgains.com/home/what-api-connections-do-webgains-offer-for-adverti
 *
 * Base URL: BLOCKED(verify). The Stoplight docs at docs.webgains.dev returned
 * HTTP 403 to automated fetch from this environment, so the exact REST host
 * could not be confirmed verbatim. The Smart Platform is served from
 * `platform.webgains.io`; the REST base is taken as `https://platform.webgains.io`
 * pending live confirmation (matching the publisher adapter). The
 * earlier-generation endpoints used `api.webgains.com`. Confirm against a live
 * account before promoting beyond `experimental`.
 *
 * Endpoints (existence verified from the docs/knowledge hub; exact paths
 * BLOCKED(verify)):
 *   - Get Programs           (the advertiser's programmes/campaigns)
 *       → listBrands / listProgrammes.
 *   - Get Transaction Report (advertiser transactions, configurable programmes,
 *       date range, max 1 year) → getProgrammePerformance / listTransactions.
 *       Source: https://docs.webgains.dev/docs/platform-api-1/4e131c6a36cca-get-transaction-report
 *               https://knowledgehub.webgains.com/home/advertiser-performance-reports
 *               (Performance report "breaks down performance by publisher").
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

import { SLUG } from './auth.js';

const log = createLogger('webgains-advertiser.client');

/**
 * The Webgains Smart Platform API base URL.
 *
 * BLOCKED(verify): the documentation host returned HTTP 403 from this
 * environment, so the REST base could not be confirmed verbatim. The Smart
 * Platform is served from `platform.webgains.io`; this is the most likely REST
 * host and is used pending a live-account check. If a live account reveals a
 * distinct host (e.g. `https://api.webgains.com`), update this constant and
 * `network.json` together.
 * Source: https://docs.webgains.dev/ , https://platform.webgains.io/docs/
 */
export const WEBGAINS_ADV_BASE_URL = 'https://platform.webgains.io';

export interface WebgainsAdvRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to the base URL. */
  path: string;
  /** The advertiser's Personal Access Token (bearer). */
  token: string;
  /** Method. Always `GET` at v0.1; passing anything else throws. */
  method?: 'GET';
  /** Query string parameters. Values with `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Resilience knobs for this specific call. */
  resilience: ResilienceConfig;
  /** Override base URL. */
  baseUrl?: string;
  /** Optional AbortSignal for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single Webgains advertiser API request under the resilience policy.
 *
 * Cardinal: only GET is permitted. Any other method throws a `config_error`
 * before the network call goes out.
 *
 * Why we don't validate response shapes with Zod: the Webgains docs document
 * field names but the field set varies across API generations (Legacy / 2023 /
 * V3). Treating every field as possibly absent and preserving `rawNetworkData`
 * is more robust than a schema that breaks on drift.
 */
export async function webgainsAdvRequest<T>(input: WebgainsAdvRequestInput): Promise<T> {
  // Hard read-only guard. This adapter ships read-only at v0.1 and a future
  // contributor must consciously remove this throw to enable writes.
  const method = input.method ?? 'GET';
  if (method !== 'GET') {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation: input.operation,
        message: `Webgains advertiser adapter is read-only at v0.1; refusing ${method}.`,
        hint:
          'This adapter only issues GET requests. To enable writes a future PR must lift this ' +
          'guard explicitly AND the operator must rotate to a read-write Webgains token.',
      }),
    );
  }

  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };
  const base = input.baseUrl ?? WEBGAINS_ADV_BASE_URL;

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

      log.debug({ url, operation: input.operation }, 'webgains-adv request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Webgains advertiser ${input.operation} GET ${input.path} → HTTP ${res.status}`,
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
            message: `Webgains advertiser ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Compose the absolute URL for a path + query. Exported (and re-exported on
 * `_internals` in the adapter) so tests can assert URL shape directly.
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
