/**
 * Adcell HTTP client — the ONLY path Adcell adapter methods use for network I/O.
 *
 * Adcell is a DACH performance network (now part of the mrge holding group, but
 * this adapter is standalone and distinct from `src/networks/mrge`). The
 * publisher API is dashboard-gated: full reference documentation is only
 * reachable from inside an authenticated Adcell account, so the endpoint shapes
 * below are reconstructed from public sources and MUST be treated as
 * unverified until exercised against a live account.
 *
 * Public sources used (recorded for the next contributor):
 *   - https://strackr.com/docs/adcell
 *   - https://wecantrack.com/adcell-integration/
 *   - https://affiliatetheme.io/en/doc/apis-adcell/
 *   - https://couponapi.org/help/knowledgebase.php?article=92 (legacy CSV iface)
 *
 * Auth (best-effort, unverified): Adcell issues an API password / key from
 * "My ADCELL → Settings → API-Password" and pairs it with the publisher
 * (affiliate) account ID. We send the key as a custom `X-API-Key` header and
 * the account id as `X-Account-Id`. If a live account shows a different scheme
 * (e.g. query-param credentials, Basic auth) this is the one file to change.
 *
 * Hard rules (mirrored from `src/networks/awin/client.ts` and
 * `src/networks/everflow/client.ts` — read those for the full rationale):
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
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('adcell.client');

/**
 * The Adcell API root.
 *
 * `api.adcell.com` is the host referenced by the modern v2 integration in
 * public third-party docs. UNVERIFIED — Adcell's own documentation is
 * dashboard-gated. Centralised here so a future contributor patches one place
 * once a live account confirms the real host.
 */
export const ADCELL_BASE_URL = 'https://api.adcell.com';

export interface AdcellRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /** Path beginning with `/` — joined to `ADCELL_BASE_URL`. */
  path: string;
  /** API key / password. Passed in from auth helpers. */
  apiKey: string;
  /** Publisher (affiliate) account id. Sent as a header for account scoping. */
  affiliateId?: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Query string parameters. Values with `undefined` are skipped. */
  query?: Record<string, string | number | undefined>;
  /** Body for POST/PUT requests; serialised as JSON. */
  body?: unknown;
  /** Resilience knobs for this specific call. Required so each op picks its own profile. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single Adcell API request under the resilience policy.
 *
 * Why the response is typed as `T` with no runtime validation: Adcell's public
 * surface is undocumented outside the dashboard, so over-specifying a schema
 * here would be guesswork. The adapter's transformers read every field
 * defensively and preserve the verbatim payload under `rawNetworkData`.
 */
export async function adcellRequest<T>(input: AdcellRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'adcell', operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input.path, input.query);
      const init: RequestInit = {
        method: input.method ?? 'GET',
        headers: buildHeaders(input.apiKey, input.affiliateId, input.body !== undefined),
      };
      if (input.body !== undefined) {
        init.body = JSON.stringify(input.body);
      }
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ url, method: init.method, operation: input.operation }, 'adcell request');

      const res = await fetch(url, init);

      // Read the body once: needed for success (decode JSON) and for failure
      // (surface the raw text on the envelope). Adcell error bodies may be JSON
      // or plain text / HTML when fronted by a CDN — preserving the raw text
      // means the user sees the actual content.
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Adcell ${input.operation} ${init.method ?? 'GET'} ${input.path} → HTTP ${res.status}`,
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
            network: 'adcell',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `Adcell ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Build the Adcell auth headers.
 *
 * UNVERIFIED scheme: API key as `X-API-Key`, account id as `X-Account-Id`.
 * Adcell does not publish its auth header convention outside the dashboard.
 * The `Accept: application/json` header forces JSON in case Adcell defaults to
 * an HTML or CSV representation (the legacy interface returned CSV).
 */
function buildHeaders(
  apiKey: string,
  affiliateId: string | undefined,
  hasBody: boolean,
): Record<string, string> {
  const headers: Record<string, string> = {
    'X-API-Key': apiKey,
    Accept: 'application/json',
  };
  if (affiliateId) {
    headers['X-Account-Id'] = affiliateId;
  }
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

/**
 * Compose the full URL with query string, using `URL` + `URLSearchParams`.
 */
function buildUrl(pathname: string, query?: Record<string, string | number | undefined>): string {
  const url = new URL(pathname.startsWith('/') ? pathname : `/${pathname}`, ADCELL_BASE_URL);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

// Re-export so adapter code can throw HttpStatusError without importing from
// shared/resilience directly.
export { HttpStatusError };
