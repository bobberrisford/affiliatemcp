/**
 * Webgains HTTP client — the ONLY path Webgains adapter methods use for network I/O.
 *
 * Why this file exists separately from `adapter.ts`:
 *   - Adapter methods speak in normalised domain types; URL construction, header
 *     building, JSON parsing, and status handling live here.
 *   - The resilience layer (timeout, retry policy, circuit breaker — see
 *     `src/shared/resilience.ts`) is applied uniformly, exactly once per call.
 *
 * Hard rules:
 *   1. Do NOT call `fetch` from adapter.ts or anywhere else in this folder.
 *   2. Do NOT bypass `withResilience` for any call.
 *   3. On non-2xx, throw `HttpStatusError` so the resilience layer retries uniformly.
 *   4. Preserve the raw response body verbatim on failure (`networkErrorBody`).
 *
 * --- Webgains API surface (verified against public docs index, 2026-06-04) -----
 *
 * Authentication: OAuth2 "Personal Access Token". The publisher generates a
 * token self-serve in the Webgains Smart Publisher Platform and passes it as a
 * standard bearer token:
 *   Authorization: Bearer {personalAccessToken}
 *   Source: https://docs.webgains.dev/docs/platform-api-1/yhwhwxlbhc1zv-authentication-with-personal-access-tokens
 *           https://docs.webgains.dev/docs/platform-api-1/g9w1vaa6wyll3-quick-start-with-the-webgains-smart-platform-api
 *
 * Base URL: BLOCKED(verify). The Stoplight docs at docs.webgains.dev and the
 * interactive console at https://platform.webgains.io/docs/ were not retrievable
 * from this environment (HTTP 403 to the doc host), so the exact REST host could
 * not be confirmed verbatim. The Smart Publisher Platform is served from
 * `platform.webgains.io`; the REST base is taken as `https://platform.webgains.io`
 * pending live confirmation. The earlier-generation endpoints used
 * `api.webgains.com`. Confirm against a live account before promoting beyond
 * `experimental`.
 *
 * Endpoints (existence verified from the docs index; exact paths BLOCKED(verify)):
 *   - Get Publisher        (identity)               — used by verifyAuth.
 *   - Get Programs         (joined programmes)       — listProgrammes / getProgramme.
 *   - Get Transaction Report (multi-row reporting)   — listTransactions.
 *       Max date range per the docs index: 1 year.
 *   - Get Transaction      (single transaction)
 *   - Smart Commission     (publisher-source commissions)
 *   - Offers / Vouchers
 *   Source: https://docs.webgains.dev/docs/platform-api-1/4fa03e3e0149a-get-publisher
 *           https://docs.webgains.dev/docs/platform-api-1/5a04fe3173176-get-programs
 *           https://docs.webgains.dev/docs/platform-api-1/4e131c6a36cca-get-transaction-report
 *           https://docs.webgains.dev/docs/platform-api-1/a1fe424db425f-get-transaction
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('webgains.client');

/**
 * The Webgains Smart Platform API base URL.
 *
 * BLOCKED(verify): the documentation host returned HTTP 403 from this
 * environment, so the REST base could not be confirmed verbatim. The Smart
 * Publisher Platform is served from `platform.webgains.io`; this is the most
 * likely REST host and is used pending a live-account check. If a live account
 * reveals a distinct host (e.g. `https://api.webgains.com`), update this
 * constant and `network.json` together.
 * Source: https://docs.webgains.dev/ , https://platform.webgains.io/docs/
 */
export const WEBGAINS_BASE_URL = 'https://platform.webgains.io';

export interface WebgainsRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to the base URL. */
  path: string;
  /** The publisher's Personal Access Token (bearer). */
  token: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Query string parameters. Values with `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Body for POST/PUT requests; serialised as JSON. */
  body?: unknown;
  /** Resilience knobs for this specific call. */
  resilience: ResilienceConfig;
  /** Override base URL. */
  baseUrl?: string;
  /** Optional AbortSignal for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single Webgains Platform API request under the resilience policy.
 *
 * Why we don't validate response shapes with Zod: the Webgains docs document
 * field names but the field set varies across API generations (Legacy / 2023 /
 * V3). Treating every field as possibly absent and preserving `rawNetworkData`
 * is more robust than a schema that breaks on drift.
 */
export async function webgainsRequest<T>(input: WebgainsRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'webgains', operation: input.operation };
  const base = input.baseUrl ?? WEBGAINS_BASE_URL;

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(base, input.path, input.query);
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

      log.debug({ url, method: init.method, operation: input.operation }, 'webgains request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Webgains ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
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
            network: 'webgains',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Webgains ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

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

function buildUrl(
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
