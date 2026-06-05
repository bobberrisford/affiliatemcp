/**
 * PartnerStack Vendor API HTTP client — the ONLY path this adapter uses for
 * network I/O. Structurally a copy of `src/networks/impact/client.ts` (HTTP
 * Basic auth) without Impact's per-endpoint workarounds; read Awin's client for
 * the rationale behind the hard rules.
 *
 * --- PartnerStack Vendor API surface (verify against -----------------------
 *     https://docs.partnerstack.com/reference) -------------------------------
 *
 *   Host:    https://api.partnerstack.com
 *   Prefix:  /v2   (the Vendor API; distinct from the Partner API's `/api/v2`)
 *   Auth:    HTTP Basic — base64("{PUBLIC_KEY}:{SECRET_KEY}")
 *            `// TODO(verify)`: the public/secret key-pair Basic scheme is the
 *            documented Vendor API auth, but the dashboard renders keys
 *            client-side and the exact header could not be confirmed at commit
 *            time. Centralised in `buildHeaders` so it is a one-line change.
 *   Envelope: { "data": ..., "message": "...", "status": "2xx" }
 *   Paging:  cursor — `starting_after` / `ending_before`, `limit`; `has_more`.
 *   Dates:   epoch milliseconds.
 */

import {
  HttpStatusError,
  withResilience,
  type WithResilienceContext,
} from '../../shared/resilience.js';
import { buildErrorEnvelope, NetworkError } from '../../shared/errors.js';
import type { ResilienceConfig } from '../../shared/types.js';
import { createLogger } from '../../shared/logging.js';

const log = createLogger('partnerstack-advertiser.client');

export const PARTNERSTACK_BASE_URL = 'https://api.partnerstack.com';

/**
 * Vendor API path prefix. `// TODO(verify)`: the Vendor API is documented under
 * `/v2` (the Partner API uses `/api/v2`). Confirm against a live vendor account.
 */
export const PARTNERSTACK_PATH_PREFIX = '/v2';

export const SLUG = 'partnerstack-advertiser';

export interface PartnerstackAdvRequestInput {
  operation: string;
  /** Resource path beginning with `/`, relative to the Vendor API prefix. */
  path: string;
  /** Vendor API public key (the Basic-auth username). */
  publicKey: string;
  /** Vendor API secret key (the Basic-auth password). */
  secretKey: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  resilience: ResilienceConfig;
  signal?: AbortSignal;
}

export async function partnerstackAdvRequest<T>(input: PartnerstackAdvRequestInput): Promise<T> {
  const ctx: WithResilienceContext = { network: SLUG, operation: input.operation };

  return withResilience(
    ctx,
    async () => {
      const url = buildUrl(input.path, input.query);
      const init: RequestInit = {
        method: input.method ?? 'GET',
        headers: buildHeaders(input.publicKey, input.secretKey, input.body !== undefined),
      };
      if (input.body !== undefined) {
        init.body = JSON.stringify(input.body);
      }
      if (input.signal) {
        init.signal = input.signal;
      }

      log.debug({ url, method: init.method, operation: input.operation }, 'partnerstack-advertiser request');

      const res = await fetch(url, init);
      const rawBody = await res.text();

      if (!res.ok) {
        throw new HttpStatusError(
          res.status,
          rawBody,
          `PartnerStack vendor ${input.operation} ${init.method} ${input.path} → HTTP ${res.status}`,
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
            message: `PartnerStack vendor ${input.operation} returned HTTP ${res.status} with non-JSON body (parse error: ${(err as Error).message})`,
          }),
        );
      }
    },
    input.resilience,
  );
}

function buildHeaders(publicKey: string, secretKey: string, hasBody: boolean): Record<string, string> {
  // HTTP Basic: base64("publicKey:secretKey"). Buffer is available in Node.js.
  const credentials = Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
  const headers: Record<string, string> = {
    Authorization: `Basic ${credentials}`,
    Accept: 'application/json',
  };
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

function buildUrl(pathname: string, query?: Record<string, string | number | undefined>): string {
  const rel = pathname.startsWith('/') ? pathname : `/${pathname}`;
  const url = new URL(`${PARTNERSTACK_PATH_PREFIX}${rel}`, PARTNERSTACK_BASE_URL);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, String(v));
    }
  }
  return url.toString();
}

export { HttpStatusError };
