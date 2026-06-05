/**
 * Adtraction HTTP client — the ONLY path Adtraction adapter methods use for network I/O.
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
 * --- Adtraction API surface (verified against public docs / integration guides) -
 *
 * Adtraction is a Nordic affiliate network. Most v3 endpoints are POST with a
 * JSON body of filters; the API access token is supplied as a `token` QUERY
 * parameter (NOT an Authorization header — hence `auth_model: 'custom'`).
 *   Source: https://help.adtraction.com/en/articles/1563159-get-started-with-the-adtraction-api
 *           ("find or generate your unique API access token ... inside your
 *            Adtraction account"; requests carry `?token=...`)
 *   Live request shape observed in third-party integrations, e.g.:
 *     GET  https://api.adtraction.net/v2/partner/programs/commissions/{a}/{b}/?token=...
 *     POST https://api.adtraction.net/v2/partner/statistics/?token=...   (JSON body)
 *   Source: search snippets of https://apidocs.adtraction.net/v2/
 *
 * Base URL: https://api.adtraction.com (the canonical API host referenced by the
 * help centre). BLOCKED(verify): the v2 examples above resolve to the
 * `api.adtraction.net` host; whether v3 affiliate endpoints are served from
 * `api.adtraction.com` or `api.adtraction.net` must be confirmed against a live
 * account. We default to the documented `api.adtraction.com` host and allow a
 * per-call `baseUrl` override so a future fix needs no structural change.
 *
 * Rate limit: most endpoints ~30 requests/minute (some 10/minute); the response
 * carries limit/remaining/reset headers.
 *   Source: search snippets of the Adtraction API v3 docs.
 */

import {
  HttpStatusError,
  withResilience,
  DEFAULT_RESILIENCE,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('adtraction.client');

/**
 * The Adtraction API base URL.
 * Source: https://help.adtraction.com/en/articles/1563159-get-started-with-the-adtraction-api
 * BLOCKED(verify): confirm v3 affiliate endpoints are served from this host (v2
 * integration examples use api.adtraction.net).
 */
export const ADTRACTION_BASE_URL = 'https://api.adtraction.com';

export interface AdtractionRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to the base URL. */
  path: string;
  /** The Adtraction API access token. Sent as the `token` query parameter. */
  token: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Additional query string parameters. Values with `undefined` are skipped. */
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
 * Issue a single Adtraction API request under the resilience policy.
 *
 * Why we don't validate response shapes with Zod: Adtraction's exact v3 field
 * names are not fully documented publicly. Treating every field as possibly
 * absent and preserving `rawNetworkData` is more robust than a schema that
 * breaks on drift.
 */
export async function adtractionRequest<T>(input: AdtractionRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'adtraction', operation: input.operation };
  const base = input.baseUrl ?? ADTRACTION_BASE_URL;

  return withResilience(
    ctx,
    async () => {
      // Adtraction carries the access token as a query parameter, not a header.
      const query = { ...(input.query ?? {}), token: input.token };
      const url = buildUrl(base, input.path, query);
      const init: RequestInit = {
        method: input.method ?? 'GET',
        headers: buildHeaders(input.body !== undefined),
      };
      if (input.body !== undefined) {
        init.body = JSON.stringify(input.body);
      }
      if (input.signal) {
        init.signal = input.signal;
      }

      // Note: the token lives in the query string; the logger never logs full
      // URLs at info level. We log path + method only here.
      log.debug({ path: input.path, method: init.method, operation: input.operation }, 'adtraction request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Adtraction ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
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
            network: 'adtraction',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Adtraction ${input.operation} returned HTTP ${res.status} with a non-JSON body (parse error: ${(err as Error).message}).`,
          }),
        );
      }
    },
    input.resilience,
  );
}

// ---------------------------------------------------------------------------
// Approved-programmes raw fetch
//
// Lives in client.ts (the network-I/O module) so both auth.ts (verifyAuth
// probe) and adapter.ts (listProgrammes / getProgramme) can call it without a
// circular import between adapter and auth.
//
// Endpoint:
//   POST /v3/affiliate/programs/      (token as ?token=... query parameter)
//   Body (JSON): { market?, channelId?, programId? }
//
// BLOCKED(verify): the exact v3 path (`/v3/affiliate/programs/` vs the v2
// `/v2/partner/programs/`) and the request/response field names are taken from
// the public Adtraction API docs and third-party integration guides; they have
// not been confirmed against a live account.
//   Sources: https://apidocs.adtraction.net/v2/
//            https://help.adtraction.com/en/articles/1563159-get-started-with-the-adtraction-api
// ---------------------------------------------------------------------------

/** Approved-programmes endpoint path. BLOCKED(verify) against a live account. */
export const APPROVED_PROGRAMMES_PATH = '/v3/affiliate/programs/';

/** Transactions endpoint path. BLOCKED(verify) against a live account. */
export const TRANSACTIONS_PATH = '/v3/affiliate/transactions/';

/**
 * A single programme row as returned by Adtraction. Deliberately permissive:
 * every field is optional and the raw payload is preserved by the caller.
 *
 * BLOCKED(verify): field names below are inferred from the v2 docs and
 * third-party guides; confirm against a live v3 response.
 */
export interface AdtractionProgrammeRaw {
  programId?: number | string;
  programName?: string;
  programURL?: string;
  currency?: string;
  market?: string;
  category?: string;
  categoryName?: string;
  /** Adtraction approval/relationship status; varies by API version. */
  approvalStatus?: string;
  status?: number | string;
  commission?: number | string;
  commissionType?: string;
  trackingURL?: string;
  feed?: number | string;
  [key: string]: unknown;
}

export interface ProgrammeFilter {
  /** ISO 3166-1 Alpha-2 market/country code. */
  market?: string;
  /** Numeric Adtraction channel id. */
  channelId?: number | string;
  /** Single programme id (used by getProgramme). */
  programId?: number | string;
}

/**
 * Issue the approved-programmes request and return the raw programme rows.
 * Adtraction may return a bare array or an enveloping object; both are
 * normalised to an array.
 */
export async function listApprovedProgrammesRaw(
  token: string,
  operation: string,
  filter: ProgrammeFilter = {},
): Promise<AdtractionProgrammeRaw[]> {
  const body: Record<string, unknown> = {};
  if (filter.market) body['market'] = filter.market;
  if (filter.channelId !== undefined) body['channelId'] = filter.channelId;
  if (filter.programId !== undefined) body['programId'] = filter.programId;

  const response = await adtractionRequest<unknown>({
    operation,
    path: APPROVED_PROGRAMMES_PATH,
    token,
    method: 'POST',
    body,
    resilience: DEFAULT_RESILIENCE,
  });

  return coerceArray<AdtractionProgrammeRaw>(response, ['programs', 'programmes']);
}

/**
 * Adtraction may return a bare array or an object wrapping the rows. Normalise
 * both into an array; anything else becomes an empty list.
 */
export function coerceArray<T>(response: unknown, keys: string[]): T[] {
  if (Array.isArray(response)) return response as T[];
  if (response && typeof response === 'object') {
    const obj = response as Record<string, unknown>;
    for (const key of [...keys, 'data', 'result', 'results']) {
      const v = obj[key];
      if (Array.isArray(v)) return v as T[];
    }
  }
  return [];
}

function buildHeaders(hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (hasBody) {
    headers['Content-Type'] = 'application/json;charset=UTF-8';
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
