/**
 * Affise HTTP client — the ONLY path Affise adapter methods use for network I/O.
 *
 * Affise is a multi-tenant CPA "tenant engine": many independent networks each
 * run their own Affise instance under their own host. There is no single shared
 * API host. Each network's API base is its tracking domain
 * (Settings › Tracking domains), e.g. `https://api-yournetwork.affise.com`.
 *
 * KEY DEVIATION from `src/networks/everflow/client.ts`: the base URL is NOT
 * hard-coded. It is read from the `AFFISE_BASE_URL` credential and validated as
 * a URL here. A malformed or missing base surfaces as a `config_error` envelope
 * — never a silent default to some other tenant.
 *
 * Auth: Affise uses a custom `API-Key` header (the affiliate-panel key from
 * Settings › Security). This is not the HTTP `Authorization` convention, hence
 * `auth_model: custom` in `network.json`.
 *
 * Hard rules (mirrored from Awin/Everflow client.ts — read those for the full
 * rationale):
 *   1. Do NOT call `fetch` from `adapter.ts` or anywhere else in this folder.
 *   2. Do NOT add a second client that skips `withResilience`.
 *   3. On a non-2xx response, throw `HttpStatusError` so the resilience layer
 *      can apply its retry policy uniformly.
 *   4. Preserve the raw response body verbatim on failure.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import { requireCredential } from '../../shared/config.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('affise.client');

const SLUG = 'affise';

/**
 * Resolve and validate the per-tenant Affise base URL from credentials.
 *
 * Affise has no canonical shared host: each network's API base is its own
 * tracking domain. We read `AFFISE_BASE_URL` and validate it with the WHATWG
 * `URL` parser. Anything that is not a syntactically valid absolute URL becomes
 * a `config_error` envelope so the user gets an actionable message rather than a
 * confusing fetch failure later.
 *
 * Exported so `auth.ts` and tests can validate the same value the client uses.
 */
export function resolveBaseUrl(operation: string): string {
  const raw = requireCredential('AFFISE_BASE_URL', {
    network: SLUG,
    operation,
    hint:
      'Set AFFISE_BASE_URL to your network\'s tracking domain (Settings → Tracking domains), ' +
      'e.g. https://api-yournetwork.affise.com.',
  });

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation,
        message: `AFFISE_BASE_URL is not a valid URL: "${raw}".`,
        hint:
          'Provide the full origin of your network\'s tracking domain, ' +
          'including the scheme, e.g. https://api-yournetwork.affise.com.',
      }),
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation,
        message: `AFFISE_BASE_URL must use http or https; received "${parsed.protocol}".`,
        hint: 'Use the https origin of your Affise tracking domain.',
      }),
    );
  }

  // Normalise to the origin: we always append a `/3.0/...` path ourselves, so we
  // drop any trailing path / query the user may have pasted.
  return parsed.origin;
}

export interface AffiseRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to the resolved per-tenant base URL. */
  path: string;
  /** Affise API key. Passed in from auth helpers / the adapter. */
  apiKey: string;
  /** Per-tenant base origin, already resolved + validated via `resolveBaseUrl`. */
  baseUrl: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /**
   * Query string parameters. Values with `undefined` are skipped. Array values
   * are emitted as repeated `key[]=v` pairs — Affise uses bracketed array params
   * (e.g. `status[]=1&offer[]=123`).
   */
  query?: Record<string, string | number | Array<string | number> | undefined>;
  /** Body for POST/PUT requests; serialised as JSON. */
  body?: unknown;
  /** Resilience knobs for this specific call. Required so each op picks its own profile. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single Affise API request under the resilience policy.
 *
 * Auth: Affise uses `API-Key: <key>` (custom header, not Bearer). The key and
 * the resolved base URL are passed in from the adapter so credential reads happen
 * once per operation, not deep inside the HTTP layer.
 */
export async function affiseRequest<T>(input: AffiseRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input.baseUrl, input.path, input.query);
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

      log.debug({ url, method: init.method, operation: input.operation }, 'affise request');

      const res = await fetch(url, init);

      // Read the body once. We need it both for success (decode JSON) and for
      // failure (surface the raw text on the envelope). Affise error bodies are
      // typically JSON-shaped but may be plain text on CDN / gateway errors.
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Affise ${input.operation} ${init.method ?? 'GET'} ${input.path} → HTTP ${res.status}`,
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
            message: `Affise ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Build the Affise auth headers.
 *
 * Affise uses a custom header `API-Key` rather than `Authorization: Bearer ...`.
 * The key is also accepted as an `api-key` query parameter, but a header keeps
 * the secret out of any URL logging.
 */
function buildHeaders(apiKey: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    'API-Key': apiKey,
    Accept: 'application/json',
  };
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

/**
 * Compose the full URL against the per-tenant base, using `URL` +
 * `URLSearchParams`. Array values become repeated `key[]=v` pairs to match
 * Affise's bracketed-array query convention.
 */
function buildUrl(
  baseUrl: string,
  pathname: string,
  query?: Record<string, string | number | Array<string | number> | undefined>,
): string {
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, baseUrl);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) {
        for (const item of v) {
          url.searchParams.append(`${k}[]`, String(item));
        }
      } else {
        url.searchParams.set(k, String(v));
      }
    }
  }
  return url.toString();
}

// Re-export so adapter code can throw HttpStatusError without importing from
// shared/resilience directly.
export { HttpStatusError };
