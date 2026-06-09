/**
 * Post Affiliate Pro REST API v3 HTTP client — the ONLY path this adapter uses
 * for network I/O. Structurally a copy of `src/networks/rewardful/client.ts`
 * and `src/networks/everflow/client.ts`; read those files for the rationale
 * behind the hard rules.
 *
 * --- Post Affiliate Pro API v3 surface -------------------------------------
 *     (https://support.qualityunit.com/868880-API-v3-documentation-overview)
 *
 *   Host:   PER-TENANT. Post Affiliate Pro is a SaaS platform; every merchant
 *           account is its own subdomain. The base URL is therefore a
 *           CREDENTIAL, not a fixed constant:
 *             https://{account}.postaffiliatepro.com/api/v3
 *           The full base URL (including `/api/v3`) is read from the
 *           POST_AFFILIATE_PRO_BASE_URL env var.
 *   Auth:   Bearer API key. The key is created in the merchant panel under
 *           Configuration > Tools > Integration > API v3 and sent as
 *             Authorization: Bearer {key}
 *   Paging: offset / limit query parameters.
 *   Dates:  ISO 8601 / `YYYY-MM-DD HH:MM:SS`.
 *
 * Hard rules (mirrored from Awin / Rewardful client.ts):
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

const log = createLogger('post-affiliate-pro.client');

export const SLUG = 'post-affiliate-pro';

/**
 * Resolve the per-tenant base URL from POST_AFFILIATE_PRO_BASE_URL.
 *
 * Unlike a fixed-host network, the subdomain (and therefore the whole base
 * URL) varies per merchant account. We validate it parses as a URL so a
 * malformed value surfaces as a `config_error` rather than a later opaque
 * fetch failure.
 */
export function requireBaseUrl(operation: string): string {
  const raw = requireCredential('POST_AFFILIATE_PRO_BASE_URL', {
    network: SLUG,
    operation,
    hint:
      'Set POST_AFFILIATE_PRO_BASE_URL to your account API base, e.g. ' +
      'https://demo.postaffiliatepro.com/api/v3 (replace `demo` with your account subdomain).',
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
        message: `POST_AFFILIATE_PRO_BASE_URL is not a valid URL: "${raw}".`,
        hint:
          'It must be a full URL including the scheme and the /api/v3 path, e.g. ' +
          'https://demo.postaffiliatepro.com/api/v3',
      }),
    );
  }
  // Strip a trailing slash so path joining is predictable.
  return parsed.toString().replace(/\/+$/, '');
}

export interface PapRequestInput {
  operation: string;
  /** Resource path beginning with `/`, relative to the per-tenant base URL (e.g. `/transactions`). */
  path: string;
  /** The per-tenant base URL (validated by `requireBaseUrl`). */
  baseUrl: string;
  /** Bearer API key. */
  apiKey: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  resilience: ResilienceConfig;
  signal?: AbortSignal;
}

export async function papRequest<T>(input: PapRequestInput): Promise<T> {
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

      log.debug({ url, method: init.method, operation: input.operation }, 'post-affiliate-pro request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Post Affiliate Pro ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
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
            message: `Post Affiliate Pro ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Bearer API key in the `Authorization` header — the documented API v3 scheme.
 */
function buildHeaders(apiKey: string, hasBody: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
  };
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

function buildUrl(
  baseUrl: string,
  pathname: string,
  query?: Record<string, string | number | undefined>,
): string {
  const rel = pathname.startsWith('/') ? pathname : `/${pathname}`;
  // baseUrl already carries the /api/v3 prefix; append the resource path.
  const url = new URL(`${baseUrl}${rel}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export { HttpStatusError };
