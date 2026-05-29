/**
 * mrge HTTP client — the ONLY path mrge adapter methods use for network I/O.
 *
 * mrge is the rebranded Yieldkit/Metapic platform. The public API uses a
 * custom key-based authentication scheme (api_key + api_secret passed as
 * query parameters). This client targets the Yieldkit API surface because
 * the publisher-api.mrge.com documentation is not publicly accessible as of
 * 2026-05-28 (returns 403 to automated fetches).
 *
 * Auth model: api_key + api_secret + site_id as query parameters (CONFIRMED).
 * Source: public.yieldkit.com documentation example (api_key=c5c2398597…,
 * api_secret=74607007…, site_id=51e8ee76…) and live API call captures.
 * Chosen auth_model in network.json is "custom" because the credentials are
 * not carried in an Authorization header.
 *
 * BLOCKED(verify): confirm whether publisher-api.mrge.com accepts a Bearer
 *   token in the Authorization header and, if so, migrate auth_model to
 *   "bearer" and move credential injection to a header. Requires live
 *   credentials; publisher-api.mrge.com returns HTTP 403 to automated fetches.
 *
 * Base URLs:
 *   - Yieldkit advertiser API:  https://api.yieldkit.com  [CONFIRMED active]
 *   - Yieldkit reporting API:   https://reporting-api.yieldkit.com [BLOCKED: unverified host]
 *   - mrge publisher API (new): https://publisher-api.mrge.com  [BLOCKED: 403 to all fetches]
 *
 * Cardinal rules (see awin/client.ts for the full reasoning):
 *   1. Never call fetch from adapter.ts. Call mrgeRequest here.
 *   2. On non-2xx, throw HttpStatusError so the resilience layer retries.
 *   3. Preserve the verbatim body for the error envelope.
 *   4. Wrap every call in withResilience.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('mrge.client');

/**
 * The Yieldkit advertiser API base URL.
 * CONFIRMED: api.yieldkit.com/v2/advertiser/terms is documented in
 * public.yieldkit.com and confirmed in live API call captures.
 * Source: https://yieldkit.com/knowledge/commission-terms/ snippet +
 *   any.run captures of Yieldkit API calls (2024).
 */
export const MRGE_BASE_URL = 'https://api.yieldkit.com';

/**
 * The reporting API base URL. Used for commission/click data.
 * BLOCKED: The host reporting-api.yieldkit.com is derived from
 * search snippets referencing the Reporting API V3 docs. The exact host
 * cannot be confirmed without live credentials accessing the documentation
 * at https://yieldkit.com/knowledge/reporting-api-v3/ (returns 403).
 * Exact credential/tier needed: any live mrge publisher account.
 */
export const MRGE_REPORTING_URL = 'https://reporting-api.yieldkit.com';

export interface MrgeRequestInput {
  /** The canonical operation name — used as the breaker key and in error envelopes. */
  operation: string;
  /** Full URL base (e.g. MRGE_BASE_URL or MRGE_REPORTING_URL). */
  baseUrl?: string;
  /** Path beginning with `/`. */
  path: string;
  /** Query string parameters. Credentials are injected here by this function. */
  query?: Record<string, string | number | undefined>;
  /** API key credential. */
  apiKey: string;
  /** API secret credential. */
  apiSecret: string;
  method?: 'GET' | 'POST';
  /** Body for POST requests; serialised as JSON. */
  body?: unknown;
  resilience: ResilienceConfig;
  signal?: AbortSignal;
}

/**
 * Issue a single mrge API request under the resilience policy.
 *
 * Credentials (api_key, api_secret, site_id) are injected as query parameters,
 * matching the confirmed Yieldkit authentication scheme.
 * Source: Yieldkit documentation + live API call captures (any.run 2024).
 *
 * BLOCKED: if publisher-api.mrge.com uses Bearer auth, refactor to
 * inject credentials as an Authorization header instead. Cannot verify
 * without live credentials (publisher-api.mrge.com returns 403 to all
 * automated fetches as of 2026-05-28).
 */
export async function mrgeRequest<T>(input: MrgeRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'mrge', operation: input.operation };
  const effectiveBase = input.baseUrl ?? MRGE_BASE_URL;

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(effectiveBase, input.path, {
        ...input.query,
        api_key: input.apiKey,
        api_secret: input.apiSecret,
      });

      const init: RequestInit = {
        method: input.method ?? 'GET',
        headers: {
          Accept: 'application/json',
          ...(input.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
      };
      if (input.body !== undefined) {
        init.body = JSON.stringify(input.body);
      }
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ url: redactUrl(url), method: init.method, operation: input.operation }, 'mrge request');

      const res = await fetch(url, init);

      // Read the body once — needed for both success (JSON parse) and error
      // (preserve verbatim for envelope per PRD principle 4.1).
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `mrge ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
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
            network: 'mrge',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `mrge ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Build the full URL with query string, filtering out undefined values.
 *
 * We use URL + URLSearchParams to correctly percent-encode all values —
 * the api_key and api_secret may contain characters that need encoding.
 */
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

/**
 * Remove credential values from a URL string for log output.
 * We redact api_key and api_secret so they don't appear in debug logs.
 */
function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.searchParams.has('api_key')) u.searchParams.set('api_key', '[REDACTED]');
    if (u.searchParams.has('api_secret')) u.searchParams.set('api_secret', '[REDACTED]');
    return u.toString();
  } catch {
    return url;
  }
}

export { HttpStatusError };
