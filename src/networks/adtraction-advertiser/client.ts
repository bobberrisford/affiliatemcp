/**
 * Adtraction advertiser HTTP client — the ONLY path adapter methods use for
 * network I/O.
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
 * --- READ-ONLY NUANCE (important — differs from impact-advertiser) -------------
 *
 * Adtraction's reporting endpoints are POST-with-JSON-body BY DESIGN: filters
 * (date window, channelId, status code) travel in the body even though the call
 * only READS data. impact-advertiser can therefore enforce read-only by refusing
 * every non-GET; Adtraction cannot — refusing POST would block all reads.
 *
 * Instead this client enforces read-only via an ALLOWLIST of documented
 * data-READ endpoints (PATH_ALLOWLIST below). Any request whose path is not on
 * the allowlist is refused with a `config_error` envelope before the network
 * call goes out. Every Adtraction write/mutation surface (creating claims,
 * approving/rejecting transactions, editing programme terms) lives at a path
 * that is NOT on the allowlist, so it is structurally unreachable through this
 * client. A future PR enabling writes must consciously add the path AND the
 * operator must rotate to a read-write token. The spirit matches
 * impact-advertiser: only data-read endpoints are callable.
 *
 * --- Adtraction advertiser API surface ----------------------------------------
 *
 * Auth: a single API access token generated inside the Adtraction ADVERTISER
 * account, supplied as a `token` QUERY parameter on every request (NOT a header).
 *   Source: https://help.adtraction.com/en/articles/1563159-get-started-with-the-adtraction-api
 *
 * Advertiser endpoints (POST with a JSON body of filters; token as ?token=...).
 * The advertiser surface mirrors the documented v2 partner surface
 * (`/v2/partner/transactions/`, `/v2/partner/programs/`) under an `advertiser`
 * segment, and Apiary documents an "#reference/advertiser" section:
 *     POST /v3/advertiser/transactions/   (JSON body)
 *     POST /v3/advertiser/programs/       (JSON body)
 *   Source: search snippets of https://apidocs.adtraction.net/v2/ and
 *           https://adtractionapi.docs.apiary.io/#reference/advertiser
 *
 * BLOCKED(verify): both Apiary docs sites returned HTTP 403 to automated fetch
 * during this PR. The exact v3 advertiser paths (`/v3/advertiser/transactions/`
 * vs `/v2/advertiser/transactions/`), the request/response field names, and the
 * base host (api.adtraction.com vs api.adtraction.net) are inferred from public
 * docs and the v2 partner pattern; they have not been confirmed against a live
 * advertiser account. We default to the documented `api.adtraction.com` host and
 * allow a per-call `baseUrl` override so a future fix needs no structural change.
 *
 * Rate limit: most endpoints ~30 requests/minute (some 10/minute).
 *   Source: search snippets of the Adtraction API docs.
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

import { SLUG } from './auth.js';

const log = createLogger('adtraction-advertiser.client');

/**
 * The Adtraction API base URL.
 * Source: https://help.adtraction.com/en/articles/1563159-get-started-with-the-adtraction-api
 * BLOCKED(verify): confirm v3 advertiser endpoints are served from this host
 * (v2 integration examples use api.adtraction.net).
 */
export const ADTRACTION_ADV_BASE_URL = 'https://api.adtraction.com';

/** Advertiser transactions endpoint. BLOCKED(verify) against a live account. */
export const ADV_TRANSACTIONS_PATH = '/v3/advertiser/transactions/';

/** Advertiser programmes endpoint. BLOCKED(verify) against a live account. */
export const ADV_PROGRAMMES_PATH = '/v3/advertiser/programs/';

/**
 * Read-only ALLOWLIST. Only these documented data-READ endpoints may be
 * requested through this client. Anything else is refused before the network
 * call goes out (see the read-only nuance in the file header). Add a path here
 * ONLY when introducing another verified READ endpoint — never a mutation.
 */
export const PATH_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  ADV_TRANSACTIONS_PATH,
  ADV_PROGRAMMES_PATH,
]);

export interface AdtractionAdvRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to the base URL. MUST be on PATH_ALLOWLIST. */
  path: string;
  /** The Adtraction API access token. Sent as the `token` query parameter. */
  token: string;
  /**
   * HTTP method. Adtraction reporting reads are POST-with-body by design, so
   * POST is permitted — but only for an allowlisted READ path. The allowlist,
   * not the method, is the read-only guard here.
   */
  method?: 'GET' | 'POST';
  /** Additional query string parameters. Values with `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Body for POST requests; serialised as JSON. */
  body?: unknown;
  /** Resilience knobs for this specific call. */
  resilience: ResilienceConfig;
  /** Override base URL. */
  baseUrl?: string;
  /** Optional AbortSignal for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single Adtraction advertiser API request under the resilience policy.
 *
 * Read-only guard: the request `path` must be on `PATH_ALLOWLIST`. Adtraction
 * reads happen over POST, so we cannot refuse by method; we refuse by path.
 */
export async function adtractionAdvRequest<T>(input: AdtractionAdvRequestInput): Promise<T> {
  // Hard read-only guard (allowlist). A future contributor must consciously add
  // a path here to reach any new endpoint, and would only ever add READ paths.
  if (!PATH_ALLOWLIST.has(input.path)) {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation: input.operation,
        message: `Adtraction advertiser adapter is read-only at v0.1; refusing request to non-allowlisted path "${input.path}".`,
        hint:
          'This adapter only calls Adtraction advertiser data-READ endpoints (advertiser transactions ' +
          'and advertiser programmes), which are POST-with-body by design. Any write/mutation endpoint ' +
          'is intentionally unreachable. To enable a new endpoint a future PR must add its path to ' +
          'PATH_ALLOWLIST explicitly (READ endpoints only) AND the operator must rotate to a read-write token.',
      }),
    );
  }

  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };
  const base = input.baseUrl ?? ADTRACTION_ADV_BASE_URL;

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

      // Note: the token lives in the query string; we log path + method only.
      log.debug(
        { path: input.path, method: init.method, operation: input.operation },
        'adtraction-advertiser request',
      );

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Adtraction advertiser ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
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
            message: `Adtraction advertiser ${input.operation} returned HTTP ${res.status} with a non-JSON body (parse error: ${(err as Error).message}).`,
          }),
        );
      }
    },
    input.resilience,
  );
}

// ---------------------------------------------------------------------------
// Advertiser programmes raw fetch
//
// Lives in client.ts (the network-I/O module) so both auth.ts (verifyAuth
// probe) and adapter.ts (listBrands / listProgrammes) can call it without a
// circular import between adapter and auth.
//
// Endpoint:
//   POST /v3/advertiser/programs/      (token as ?token=... query parameter)
//   Body (JSON): { market?, programId? }
//
// BLOCKED(verify): the exact v3 path and field names are inferred from the v2
// partner pattern and public docs; confirm against a live advertiser account.
// ---------------------------------------------------------------------------

/**
 * A single advertiser programme row as returned by Adtraction. Deliberately
 * permissive: every field is optional and the raw payload is preserved by the
 * caller.
 *
 * BLOCKED(verify): field names below are inferred; confirm against a live v3
 * advertiser response.
 */
export interface AdtractionAdvProgrammeRaw {
  programId?: number | string;
  programName?: string;
  programURL?: string;
  currency?: string;
  market?: string;
  category?: string;
  categoryName?: string;
  /** Programme lifecycle status; varies by API version. */
  status?: number | string;
  programStatus?: string;
  /** Whether the programme is live/addressable via the API. */
  active?: boolean;
  [key: string]: unknown;
}

export interface AdvProgrammeFilter {
  /** ISO 3166-1 Alpha-2 market/country code. */
  market?: string;
  /** Single programme id (used by getProgramme-style lookups). */
  programId?: number | string;
}

/**
 * Issue the advertiser-programmes request and return the raw programme rows.
 * Adtraction may return a bare array or an enveloping object; both are
 * normalised to an array.
 */
export async function listAdvertiserProgrammesRaw(
  token: string,
  operation: string,
  filter: AdvProgrammeFilter = {},
): Promise<AdtractionAdvProgrammeRaw[]> {
  const body: Record<string, unknown> = {};
  if (filter.market) body['market'] = filter.market;
  if (filter.programId !== undefined) body['programId'] = filter.programId;

  const response = await adtractionAdvRequest<unknown>({
    operation,
    path: ADV_PROGRAMMES_PATH,
    token,
    method: 'POST',
    body,
    resilience: DEFAULT_RESILIENCE,
  });

  return coerceArray<AdtractionAdvProgrammeRaw>(response, ['programs', 'programmes']);
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
