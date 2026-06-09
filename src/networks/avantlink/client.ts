/**
 * AvantLink HTTP client — the ONLY path AvantLink adapter methods use for
 * network I/O.
 *
 * AvantLink exposes a single REST "report framework" endpoint
 * (`https://classic.avantlink.com/api.php`). Every operation is selected by a
 * `module=` query parameter; authentication and account scoping travel as
 * further query parameters (`affiliate_id`, `auth_key`, `website_id`) rather
 * than as HTTP headers. There is no Authorization header and no token-exchange
 * flow — the credentials are static query values minted in the dashboard.
 *
 * Because of that, this client centralises query-string assembly (including
 * the auth params) so the adapter never hand-builds a URL or leaks a secret
 * into a log line. The resilience layer wraps every call exactly once.
 *
 * Hard rules (mirrored from Awin client.ts — read that file for the full
 * rationale):
 *   1. Do NOT call `fetch` from `adapter.ts` or anywhere else in this folder.
 *   2. Do NOT add a second client that skips `withResilience`.
 *   3. On a non-2xx response, throw `HttpStatusError` so the resilience layer
 *      can apply its retry policy uniformly.
 *   4. Preserve the raw response body verbatim on failure.
 *
 * Docs:
 *   - API Module Documentation: https://support.avantlink.com/hc/en-us/sections/200985665-API-Module-Documentation
 *   - Affiliate API Technical Integration: https://support.avantlink.com/hc/en-us/articles/203644699-Affiliate-API-Technical-Integration
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('avantlink.client');

/**
 * The AvantLink API root. Every module is reached at this single endpoint with
 * a `module=` query parameter. Centralised so a test harness can override the
 * base without touching adapter code. Hard-coded for v0.1.
 */
export const AVANTLINK_BASE_URL = 'https://classic.avantlink.com';

/** The single endpoint path for the report framework. */
export const AVANTLINK_API_PATH = '/api.php';

export interface AvantLinkRequestInput {
  /** The canonical operation name. Used as the breaker key and in error envelopes. */
  operation: string;
  /**
   * The AvantLink `module` value (e.g. `AssociationFeed`, `AffiliateReport`,
   * `CustomLink`). Selects which report the single endpoint runs.
   */
  module: string;
  /**
   * Query string parameters beyond `module`/`output`. Includes the auth params
   * (`affiliate_id`, `auth_key`, `website_id`) for modules that require them.
   * Values that are `undefined` are skipped.
   */
  query?: Record<string, string | number | undefined>;
  /**
   * Output format. AvantLink's newer Affiliate Network API modules accept
   * `json`; some legacy report modules historically defaulted to `xml`.
   * Defaults to `json` here — callers that need the verbatim body set
   * `expectText` and read the raw string.
   */
  output?: 'json' | 'xml' | 'csv' | 'tab' | 'html' | 'text';
  /**
   * When true the helper returns the verbatim response body as a string rather
   * than parsing JSON. Used for the `CustomLink` module, which returns a bare
   * tracking URL (not a JSON document).
   */
  expectText?: boolean;
  /** Resilience knobs for this specific call. Required so each op picks its own profile. */
  resilience: ResilienceConfig;
  /** Optional `AbortSignal` for cooperative cancellation in tests. */
  signal?: AbortSignal;
}

/**
 * Issue a single AvantLink API request under the resilience policy.
 *
 * Auth: AvantLink threads `affiliate_id` + `auth_key` through the query string
 * (the caller passes them in `query`). There is no Authorization header.
 *
 * The response is typed `T` with no runtime validation, for the same reason as
 * Awin: AvantLink's report shapes drift and a hard schema would break first.
 * Adapter transformers must read every field defensively.
 */
export async function avantlinkRequest<T>(input: AvantLinkRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: 'avantlink', operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input);
      const init: RequestInit = {
        method: 'GET',
        headers: { Accept: 'application/json' },
      };
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ url, module: input.module, operation: input.operation }, 'avantlink request');

      const res = await fetch(url, init);

      // Read the body once. We need it both for success (decode JSON / return
      // text) and for failure (surface the raw text on the envelope). AvantLink
      // error bodies vary by module and output format, so preserving the raw
      // text means the user sees the actual content.
      const rawBody = await res.text();

      if (!res.ok) {
        // Throw HttpStatusError so the resilience layer applies its retry/no-retry
        // decision uniformly. Do NOT inspect `res.status` here to decide retries.
        throw new HttpStatusError(
          res.status,
          rawBody,
          `AvantLink ${input.operation} module=${input.module} GET ${AVANTLINK_API_PATH} → HTTP ${res.status}`,
        );
      }

      // The CustomLink module returns a bare URL string, not JSON. Callers set
      // `expectText` and receive the verbatim body.
      if (input.expectText) {
        return rawBody as unknown as T;
      }

      // Empty body — return the empty object so adapters that expect a payload
      // detect the missing fields and throw a meaningful envelope.
      if (rawBody.trim() === '') {
        return {} as T;
      }

      try {
        return JSON.parse(rawBody) as T;
      } catch (err) {
        // Preserve the verbatim body so PRD §4.1 holds even for a 2xx that is
        // not JSON (e.g. a legacy module that ignored `output=json` and
        // returned XML).
        throw new NetworkError(
          buildErrorEnvelope({
            type: 'network_api_error',
            network: 'avantlink',
            operation: input.operation,
            httpStatus: res.status,
            networkErrorBody: rawBody,
            message: `AvantLink ${input.operation} (module=${input.module}) returned HTTP ${res.status} with a non-JSON body (parse error: ${(err as Error).message}). The module may not honour output=json.`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Compose the full URL with the module/output/auth query string.
 *
 * We use `URL` + `URLSearchParams` rather than string concatenation because
 * AvantLink query values include destination URLs and date strings that MUST
 * be percent-encoded.
 */
function buildUrl(input: AvantLinkRequestInput): string {
  const url = new URL(AVANTLINK_API_PATH, AVANTLINK_BASE_URL);
  url.searchParams.set('module', input.module);
  url.searchParams.set('output', input.output ?? 'json');
  if (input.query) {
    for (const [k, v] of Object.entries(input.query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

// Re-export so adapter code can throw HttpStatusError without importing from
// shared/resilience directly.
export { HttpStatusError };
