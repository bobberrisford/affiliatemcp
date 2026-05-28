/**
 * Partnerize (Advertiser) — HTTP client.
 *
 * This is the only sanctioned `fetch` site for the partnerize-advertiser adapter.
 * Every outbound call goes through `partnerizeAdvRequest`, which wraps the call
 * in `withResilience` so the project's timeout / retry / circuit-breaker policy
 * applies uniformly.
 *
 * Auth: HTTP Basic — Authorization: Basic base64(application_key:user_api_key).
 * Base URL: https://api.partnerize.com (v3 Brand API).
 *
 * All paths are relative to the base URL. The adapter passes brand-relative
 * paths such as:
 *   /v3/brand/campaigns
 *   /v3/brand/campaigns/{campaignId}/publishers
 *   /v3/brand/campaigns/{campaignId}/conversions
 *   /v3/brand/analytics/metrics
 *
 * TODO(verify): query-parameter names and pagination semantics from a live
 * account — the API docs site returned 403 to automated fetch during this PR.
 * Pagination assumed to be `limit` + `page` or cursor-based.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { AnyOperation, ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';
import { basicAuthHeader, loadCredentials, SLUG, BASE_URL } from './auth.js';

const log = createLogger('partnerize-advertiser.client');

export interface PartnerizeAdvRequestInput {
  operation: AnyOperation;
  /** URL path relative to the base URL, e.g. `/v3/brand/campaigns`. */
  path: string;
  /** Optional query parameters. Undefined values are omitted. */
  query?: Record<string, string | number | undefined>;
  /** HTTP method. Always GET at v0.1 (read-only adapter). */
  method?: 'GET';
  resilience: ResilienceConfig;
}

/**
 * Issue a single Partnerize Brand API request under the resilience policy.
 *
 * Read-only at v0.1 — the client refuses any non-GET method so a future
 * contributor must consciously remove the guard to enable writes.
 */
export async function partnerizeAdvRequest<T>(input: PartnerizeAdvRequestInput): Promise<T> {
  const method = input.method ?? 'GET';
  if (method !== 'GET') {
    throw new NetworkError(
      buildErrorEnvelope({
        type: 'config_error',
        network: SLUG,
        operation: input.operation,
        message: `Partnerize advertiser adapter is read-only at v0.1; refusing ${method}.`,
        hint: 'This adapter only issues GET requests. To enable writes, lift this guard and use a read-write token.',
      }),
    );
  }

  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const creds = loadCredentials(input.operation);
      const url = buildUrl(input.path, input.query);

      log.debug({ url, operation: input.operation }, 'partnerize-adv request');

      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: basicAuthHeader(creds.applicationKey, creds.userApiKey),
          Accept: 'application/json',
        },
      });
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `Partnerize advertiser ${input.operation} GET ${url} → HTTP ${res.status}`,
        );
      }

      const trimmed = rawBody.trim();
      if (trimmed === '' || trimmed === 'null') return {} as T;

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
            message: `Partnerize advertiser ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

/**
 * Compose the full URL from a path and optional query parameters.
 * Exported for unit testing URL construction.
 */
export function buildUrl(
  path: string,
  query?: Record<string, string | number | undefined>,
): string {
  const rel = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(rel, BASE_URL);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export { HttpStatusError };
